# Windows Service Deployment (NSSM)

Run GioJS as a Windows Service using NSSM (Non-Sucking Service Manager). The service survives reboots and is managed via PowerShell or Services MMC.

## Prerequisites

- Windows Server 2019 or Windows 10/11
- Node.js 20+ (`node --version`) - install via `winget install OpenJS.NodeJS.LTS`
- NSSM - install via `scoop install nssm` or download from nssm.cc
- `giojs-server.exe` binary from the GitHub release

## 1. Deploy the app

```powershell
# Create the app directory
New-Item -ItemType Directory -Force -Path C:\apps\my-app
Copy-Item -Recurse .\* C:\apps\my-app\

# Install Node dependencies - there is no build step (routes and client
# bundles are built at server startup)
Set-Location C:\apps\my-app
npm ci --omit=dev
```

## 2. Install the Windows service

Run PowerShell **as Administrator**:

```powershell
$AppDir   = "C:\apps\my-app"
$Binary   = "$AppDir\giojs-server.exe"
$SvcName  = "MyGioApp"
$SvcDesc  = "My GioJS Application"

# Register the service
nssm install $SvcName $Binary

# Set the working directory
nssm set $SvcName AppDirectory $AppDir

# Environment variables (the listen port comes from gio.toml [server])
nssm set $SvcName AppEnvironmentExtra `
    "NODE_ENV=production"

# Restart on failure
nssm set $SvcName AppThrottle 5000
nssm set $SvcName AppRestartDelay 5000

# Log stdout and stderr to files
New-Item -ItemType Directory -Force -Path C:\logs\my-app
nssm set $SvcName AppStdout C:\logs\my-app\stdout.log
nssm set $SvcName AppStderr C:\logs\my-app\stderr.log
nssm set $SvcName AppRotateFiles 1
nssm set $SvcName AppRotateBytes 10485760   # 10 MB

# Set service description
nssm set $SvcName Description $SvcDesc

# Start the service
nssm start $SvcName
```

## 3. Verify

```powershell
# Check service status
nssm status MyGioApp
# → SERVICE_RUNNING

# Health check
Invoke-WebRequest -Uri http://localhost:3000/_gio/health -UseBasicParsing
```

## Managing the service

```powershell
# Start / stop / restart
Start-Service MyGioApp
Stop-Service MyGioApp
Restart-Service MyGioApp

# View current status
Get-Service MyGioApp

# Remove the service entirely
nssm remove MyGioApp confirm
```

## Viewing logs

**NSSM log files:**
```powershell
# Follow stdout log (tail -f equivalent)
Get-Content C:\logs\my-app\stdout.log -Wait -Tail 50
```

**Event Viewer:**

NSSM also writes to the Windows Event Log. Open Event Viewer → Windows Logs → Application, then filter by source `MyGioApp`.

```powershell
# From PowerShell
Get-EventLog -LogName Application -Source MyGioApp -Newest 20
```

## Updating the binary

```powershell
# Stop the service, replace the binary, start again
Stop-Service MyGioApp
Copy-Item .\giojs-server.exe C:\apps\my-app\giojs-server.exe -Force
Start-Service MyGioApp
```

## Updating the app

```powershell
Stop-Service MyGioApp
Set-Location C:\apps\my-app

# Pull new code / copy new files
# git pull  OR  robocopy \\deploy-share\my-app . /MIR

npm ci --omit=dev

Start-Service MyGioApp
```

## Multiple nodes

Each node keeps its own page cache (memory + disk) - there is no shared cache across nodes yet; cross-instance cache coherence is on the roadmap. When running the same build on several nodes behind a load balancer, set `GIO_DEPLOYMENT_ID` to the same value on every node so caches and version-skew detection agree:

```powershell
nssm set MyGioApp AppEnvironmentExtra `
    "NODE_ENV=production" `
    "GIO_DEPLOYMENT_ID=release-abc123"
Restart-Service MyGioApp
```

## Firewall

```powershell
# Allow inbound traffic on port 3000 (or use IIS/nginx as reverse proxy)
New-NetFirewallRule `
    -DisplayName "GioJS App" `
    -Direction Inbound `
    -Protocol TCP `
    -LocalPort 3000 `
    -Action Allow
```
