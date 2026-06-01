# Kubernetes Deployment

Recommended for multi-instance deployments behind a load balancer. Use Redis for shared ISR cache across pods.

## Why GioJS is stable in Kubernetes

Self-hosted Next.js has documented memory leak issues in long-running Kubernetes pods — the Node.js HTTP layer allocates on every request, and the GC pressure grows under sustained load. OOM restarts are common in production clusters with >20 req/s.

GioJS avoids this by design: Rust owns the HTTP layer, so cache hits never allocate in Node. Memory stays flat under sustained load.

See `benchmarks/memory-stability.md` for measured RSS numbers comparing GioJS vs Next.js 15 under 50 concurrent connections.

---

## ConfigMap — gio.toml

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

    [cache]
    memory_mb = 50

    [cache.redis]
    enabled = true
    url = "redis://redis:6379"
    prefix = "gio:prod:"

    [compression]
    enabled = true
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
            - name: GIO_CACHE_REDIS_URL
              valueFrom:
                secretKeyRef:
                  name: app-secrets
                  key: redis-url
          volumeMounts:
            - name: config
              mountPath: /app/gio.toml
              subPath: gio.toml
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

---

## Redis StatefulSet

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: redis
spec:
  serviceName: redis
  replicas: 1
  selector:
    matchLabels:
      app: redis
  template:
    metadata:
      labels:
        app: redis
    spec:
      containers:
        - name: redis
          image: redis:7-alpine
          ports:
            - containerPort: 6379
          volumeMounts:
            - name: redis-data
              mountPath: /data
          readinessProbe:
            exec:
              command: ["redis-cli", "ping"]
            initialDelaySeconds: 5
            periodSeconds: 5
  volumeClaimTemplates:
    - metadata:
        name: redis-data
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 1Gi
---
apiVersion: v1
kind: Service
metadata:
  name: redis
spec:
  selector:
    app: redis
  ports:
    - port: 6379
      targetPort: 6379
  clusterIP: None
```

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

## Secrets

```bash
# Create Redis URL secret
kubectl create secret generic app-secrets \
  --from-literal=redis-url='redis://redis:6379'
```

---

## Deploy

```bash
kubectl apply -f configmap.yaml
kubectl apply -f deployment.yaml
kubectl apply -f service.yaml
kubectl apply -f redis.yaml
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

# Update the deployment (GioJS version skew protection handles in-flight requests)
kubectl set image deployment/my-app giojs=my-app:v1.2.0
kubectl rollout status deployment/my-app
```

GioJS's built-in version skew protection (`x-deployment-id` header) ensures clients with old JavaScript receive a `409 + hard-reload` response during the rollout window rather than a broken partial update.
