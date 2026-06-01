#Requires -Version 5.1
<#
.SYNOPSIS
  Memory-stability benchmark: GioJS vs Next.js 15

.DESCRIPTION
  Runs autocannon (-c 50 -d 60) against each server 3 times,
  sampling WorkingSet64 every 5 s. Writes raw sample files that
  collect.js reads to produce benchmarks/memory-stability.md.

.EXAMPLE
  pwsh benchmarks/memory-stability/run-benchmark.ps1
#>
param(
    [int]   $Runs        = 3,
    [int]   $Connections = 50,
    [int]   $Duration    = 60,
    [string]$Url         = 'http://localhost:3000/posts/1',
    [int]   $SampleSecs  = 5
)

$ErrorActionPreference = 'Stop'
$Root   = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$OutDir = $PSScriptRoot

function Wait-Port {
    param([int]$Port, [int]$TimeoutSecs = 60)
    $deadline = (Get-Date).AddSeconds($TimeoutSecs)
    while ((Get-Date) -lt $deadline) {
        try {
            $tcp = [System.Net.Sockets.TcpClient]::new('127.0.0.1', $Port)
            $tcp.Close()
            return $true
        } catch { Start-Sleep -Milliseconds 500 }
    }
    return $false
}

function Sample-Memory {
    param([System.Diagnostics.Process]$Proc, [int]$DurationSecs, [int]$IntervalSecs, [string]$OutFile)
    $samples = @()
    $elapsed = 0
    while ($elapsed -le $DurationSecs) {
        try {
            $Proc.Refresh()
            $rss = $Proc.WorkingSet64
        } catch { $rss = 0 }
        $samples += "${elapsed}:${rss}"
        if ($elapsed -lt $DurationSecs) { Start-Sleep -Seconds $IntervalSecs }
        $elapsed += $IntervalSecs
    }
    $samples | Out-File -FilePath $OutFile -Encoding utf8
}

# ── autocannon check ──────────────────────────────────────────────────────────
if (-not (Get-Command autocannon -ErrorAction SilentlyContinue)) {
    Write-Host 'autocannon not found — installing globally...'
    npm install -g autocannon
}

# ── GioJS runs ────────────────────────────────────────────────────────────────
Write-Host "`n=== GioJS ($Runs runs) ===" -ForegroundColor Cyan

for ($run = 1; $run -le $Runs; $run++) {
    Write-Host "GioJS run $run/$Runs..."

    $proc = Start-Process -FilePath 'cargo' `
        -ArgumentList 'run','--release','--manifest-path',"$Root\Cargo.toml",'-p','giojs-server' `
        -WorkingDirectory $Root `
        -PassThru -WindowStyle Hidden

    if (-not (Wait-Port -Port 3000)) {
        $proc.Kill(); throw "GioJS did not start in time (run $run)"
    }

    $outFile = Join-Path $OutDir "out-giojs-$run.txt"
    $acJob = Start-Job -ScriptBlock {
        param($url, $c, $d)
        autocannon -c $c -d $d $url | Out-Null
    } -ArgumentList $Url, $Connections, $Duration

    Sample-Memory -Proc $proc -DurationSecs $Duration -IntervalSecs $SampleSecs -OutFile $outFile

    Wait-Job $acJob | Out-Null
    $proc.Kill()
    Start-Sleep -Seconds 2
}

# ── Next.js runs ──────────────────────────────────────────────────────────────
Write-Host "`n=== Next.js 15 ($Runs runs) ===" -ForegroundColor Cyan

$nextDir = Join-Path $PSScriptRoot 'next-baseline'
if (-not (Test-Path (Join-Path $nextDir 'node_modules'))) {
    Write-Host 'Installing Next.js dependencies...'
    npm install --prefix $nextDir
}
if (-not (Test-Path (Join-Path $nextDir '.next'))) {
    Write-Host 'Building Next.js app...'
    & npm run build --prefix $nextDir
}

for ($run = 1; $run -le $Runs; $run++) {
    Write-Host "Next.js run $run/$Runs..."

    $proc = Start-Process -FilePath 'node' `
        -ArgumentList (Join-Path $nextDir 'node_modules\.bin\next'), 'start' `
        -WorkingDirectory $nextDir `
        -PassThru -WindowStyle Hidden

    if (-not (Wait-Port -Port 3000)) {
        $proc.Kill(); throw "Next.js did not start in time (run $run)"
    }

    $outFile = Join-Path $OutDir "out-nextjs-$run.txt"
    $acJob = Start-Job -ScriptBlock {
        param($url, $c, $d)
        autocannon -c $c -d $d $url | Out-Null
    } -ArgumentList $Url, $Connections, $Duration

    Sample-Memory -Proc $proc -DurationSecs $Duration -IntervalSecs $SampleSecs -OutFile $outFile

    Wait-Job $acJob | Out-Null
    $proc.Kill()
    Start-Sleep -Seconds 2
}

Write-Host "`nRaw samples written to $OutDir" -ForegroundColor Green
Write-Host 'Run: node benchmarks/memory-stability/collect.js'
