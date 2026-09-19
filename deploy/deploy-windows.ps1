# Windows PowerShell Deployment Script for Nexa Website
# This is a Windows alternative to build-and-upload.sh

param(
    [switch]$SkipFrontend,
    [switch]$SkipAdmin,
    [switch]$SkipBackend,
    [switch]$NoRestart
)

$ErrorActionPreference = "Stop"

# Configuration
$SSH_USER = "u941499432"
$SSH_HOST = "145.79.30.42"
$SSH_PORT = "65002"
$REMOTE = "${SSH_USER}@${SSH_HOST}"

# Paths
$REPO_ROOT = Split-Path -Parent $PSScriptRoot
$SITE = Join-Path $REPO_ROOT "ndm-website"
$FRONTEND = Join-Path $SITE "frontend"
$ADMIN = Join-Path $SITE "admin"
$BACKEND = Join-Path $SITE "backend"

function Write-Phase {
    param([string]$Message)
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Write-Error-Exit {
    param([string]$Message)
    Write-Host "ERROR: $Message" -ForegroundColor Red
    exit 1
}

Write-Host @"
╔═══════════════════════════════════════════════════════════════╗
║        Nexa Download Manager - Windows Deployment             ║
║                                                               ║
║  This script requires rsync. Please install it first:        ║
║                                                               ║
║  Option 1: Using Chocolatey                                  ║
║    choco install rsync                                       ║
║                                                               ║
║  Option 2: Using winget                                      ║
║    winget install -e --id cwRsync.cwRsync                   ║
║                                                               ║
║  Option 3: Install WSL and use the bash script              ║
║    wsl --install                                             ║
║    wsl bash deploy/build-and-upload.sh                       ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝

Alternatively, here are the manual steps:

"@ -ForegroundColor Yellow

Write-Host @"
MANUAL DEPLOYMENT STEPS:
========================

1. Build Frontend:
   cd ndm-website/frontend
   npm ci
   npm run build

2. Build Admin:
   cd ../admin
   npm ci
   npm run build

3. Stage Backend:
   cd ../backend
   npm ci --omit=dev

4. Upload Frontend:
   scp -P 65002 -r frontend/dist/* ${REMOTE}:domains/nexadownloadmanager.com/public_html/

5. Upload Admin:
   scp -P 65002 -r admin/dist/* ${REMOTE}:domains/nexadownloadmanager.com/public_html/admin/

6. Upload Backend:
   scp -P 65002 -r backend/* ${REMOTE}:domains/nexadownloadmanager.com/nexa-api/
   (Excluding: .env, .api.pid, .run-api.lock, logs/, uploads/)

7. Restart Backend:
   ssh -p 65002 ${REMOTE} "kill `$(cat domains/nexadownloadmanager.com/nexa-api/.api.pid)"

Or use the Git Bash script (recommended):
   "C:\Program Files\Git\bin\bash.exe" deploy/build-and-upload.sh

"@ -ForegroundColor White

Write-Host "`nFor now, use Git Bash or install rsync to proceed with automated deployment.`n" -ForegroundColor Green
