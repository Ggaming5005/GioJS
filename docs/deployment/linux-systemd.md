# Linux systemd Deployment

The recommended deployment method for Linux VPS and bare metal servers.

## Prerequisites

- Linux (Debian/Ubuntu/RHEL/etc.)
- Node.js 20+ (`node --version`)
- `giojs-server` binary for your architecture (from the GitHub release or `npm install giojs`)

## 1. Install the binary

```bash
# Copy the binary to a system path
sudo cp giojs-server /usr/local/bin/
sudo chmod +x /usr/local/bin/giojs-server
```

Or use the npm package (installs the binary shim):
```bash
npm install -g giojs
```

## 2. Deploy your app

```bash
sudo mkdir -p /var/www/my-app
sudo cp -r . /var/www/my-app/
sudo chown -R www-data:www-data /var/www/my-app
```

Run the build on the server or copy the pre-built `.gio/` directory:
```bash
cd /var/www/my-app
npm ci --omit=dev
gio build   # or copy .gio/ from CI
```

## 3. Create the systemd unit

```ini
# /etc/systemd/system/my-app.service
[Unit]
Description=My GioJS App
Documentation=https://giojs.dev
After=network.target
Wants=network.target

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=/var/www/my-app
ExecStart=/usr/local/bin/giojs-server
ExecStartPost=/bin/sh -c 'until curl -sf http://localhost:3000/_gio/health; do sleep 1; done'
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=my-app

Environment=NODE_ENV=production
Environment=PORT=3000
# Environment=GIO_CACHE_REDIS_URL=redis://localhost:6379

# Harden the service
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/www/my-app

[Install]
WantedBy=multi-user.target
```

## 4. Enable and start

```bash
sudo systemctl daemon-reload
sudo systemctl enable my-app
sudo systemctl start my-app
sudo systemctl status my-app
```

## Viewing logs

```bash
# Follow live logs
sudo journalctl -u my-app -f

# Last 100 lines
sudo journalctl -u my-app -n 100

# Since last boot
sudo journalctl -u my-app -b
```

## Optional: nginx reverse proxy

Put nginx in front to handle TLS and serve on port 80/443, while GioJS listens on 3000.

```nginx
# /etc/nginx/sites-available/my-app
server {
    listen 80;
    server_name example.com www.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name example.com www.example.com;

    ssl_certificate     /etc/letsencrypt/live/example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection keep-alive;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/my-app /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

> **Note:** When using nginx for TLS, keep `server.tls.enabled = false` in `gio.toml`. GioJS can also terminate TLS directly — see `gio.toml` `[server.tls]` section for that path.

## Updating

```bash
# Deploy new binary/code
sudo systemctl stop my-app
sudo cp giojs-server /usr/local/bin/
sudo cp -r .gio/ /var/www/my-app/.gio/
sudo systemctl start my-app
```
