# Kubernetes Deployment

Recommended for multi-instance deployments behind a load balancer.

Each pod keeps its own page cache (memory + disk) - there is no shared cache across pods yet; cross-instance cache coherence is on the roadmap. Set `GIO_DEPLOYMENT_ID` to the same value on every pod of a release so caches and version-skew detection stay consistent across the fleet.

## Why GioJS is stable in Kubernetes

Self-hosted Next.js has documented memory leak issues in long-running Kubernetes pods - the Node.js HTTP layer allocates on every request, and the GC pressure grows under sustained load. OOM restarts are common in production clusters with >20 req/s.

GioJS avoids this by design: Rust owns the HTTP layer, so cache hits never allocate in Node. Memory stays flat under sustained load.

See `benchmarks/memory-stability.md` for measured RSS numbers comparing GioJS vs Next.js 15 under 50 concurrent connections.

---

## ConfigMap - gio.toml

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: my-app-config
data:
  gio.toml: |
    [app]
    name = "my-app"
    router = "app"

    [server]
    host = "0.0.0.0"
    port = 3000
```

---

## Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  labels:
    app: my-app
spec:
  replicas: 3
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
        - name: giojs
          image: my-app:latest
          ports:
            - containerPort: 3000
          env:
            - name: NODE_ENV
              value: production
            # Set per release from CI (e.g. the git SHA) - identical on
            # every pod, so caches and skew detection agree fleet-wide.
            - name: GIO_DEPLOYMENT_ID
              value: "v1.1.0"
          volumeMounts:
            - name: config
              mountPath: /app/gio.toml
              subPath: gio.toml
          # /_gio/health always returns 200 (cached and static content still
          # serves while the Node worker respawns); the JSON body's nodeReady
          # field reports SSR worker state if you need a stricter probe.
          readinessProbe:
            httpGet:
              path: /_gio/health
              port: 3000
            initialDelaySeconds: 5
            periodSeconds: 10
            failureThreshold: 3
          livenessProbe:
            httpGet:
              path: /_gio/health
              port: 3000
            initialDelaySeconds: 15
            periodSeconds: 30
          # Sized for one render worker. With [server] workers = N, add
          # roughly one worker's RSS per extra worker to the memory limit.
          resources:
            requests:
              memory: "128Mi"
              cpu: "100m"
            limits:
              memory: "512Mi"
              cpu: "1000m"
      volumes:
        - name: config
          configMap:
            name: my-app-config
```

---

## Service + Ingress

```yaml
apiVersion: v1
kind: Service
metadata:
  name: my-app
spec:
  selector:
    app: my-app
  ports:
    - port: 80
      targetPort: 3000
  type: ClusterIP
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-app
  annotations:
    nginx.ingress.kubernetes.io/proxy-read-timeout: "30"
spec:
  ingressClassName: nginx
  rules:
    - host: example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: my-app
                port:
                  number: 80
  tls:
    - hosts:
        - example.com
      secretName: my-app-tls
```

ingress-nginx keeps idle connections to each pod open for 60s (`upstream-keepalive-timeout`), but GioJS closes an idle HTTP/1.1 connection after `header_read_timeout_secs` (10s by default). Without a fix, the ingress sometimes reuses a connection just as the pod closes it, and that request gets a 502. Raise both GioJS deadlines above the ingress timeout in the `gio.toml` ConfigMap:

```toml
[server]
header_read_timeout_secs = 65
idle_timeout_secs = 65
```

Alternatively, set `upstream-keepalive-timeout: "5"` in the ingress-nginx controller ConfigMap. See [Behind a reverse proxy or load balancer](README.md#behind-a-reverse-proxy-or-load-balancer).

Every request reaches the pod from the ingress controller, so trust it in the same ConfigMap - otherwise rate limits and `req.ip` see the controller instead of visitors. Use the pod CIDR the controller runs in (your cluster's may differ):

```toml
[server]
trusted_proxies = ["10.244.0.0/16"]
accept_request_id = false   # ingress-nginx reuses a client's own X-Request-ID
```

ingress-nginx sends `X-Forwarded-For`, `X-Forwarded-Proto`, `X-Forwarded-Host` and an `X-Request-ID`. That id is the client's own when the client sent one, so with `accept_request_id = false` GioJS generates every id instead; leave it on (the default) only if a client-chosen id is acceptable in your logs, in exchange for one id across the controller's and GioJS's logs. See [Client IPs, HTTPS and request IDs](README.md#client-ips-https-and-request-ids).

---

## Horizontal Pod Autoscaler

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: my-app
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: my-app
  minReplicas: 2
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
```

---

## Deploy

```bash
kubectl apply -f configmap.yaml
kubectl apply -f deployment.yaml
kubectl apply -f service.yaml
kubectl apply -f hpa.yaml

# Watch rollout
kubectl rollout status deployment/my-app

# View logs
kubectl logs -l app=my-app -f
```

## Rolling update

```bash
# Tag and push new image
docker build -t my-app:v1.2.0 .
docker push my-app:v1.2.0

# Update the deployment (bump GIO_DEPLOYMENT_ID for the new release too)
kubectl set image deployment/my-app giojs=my-app:v1.2.0
kubectl set env deployment/my-app GIO_DEPLOYMENT_ID=v1.2.0
kubectl rollout status deployment/my-app
```

GioJS's built-in version skew protection (`x-deployment-id` header) ensures clients with old JavaScript receive a `409 + hard-reload` response during the rollout window rather than a broken partial update.
