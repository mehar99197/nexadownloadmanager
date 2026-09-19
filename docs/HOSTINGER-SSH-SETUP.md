# Hostinger SSH Key Setup Guide

## Step 1: Generate SSH Key (if not exists)

Open PowerShell and run:

```powershell
# Generate a new SSH key
ssh-keygen -t ed25519 -C "nexadownloadmanager-deploy"

# When prompted:
# - File location: Press Enter (default: C:\Users\DELL\.ssh\id_ed25519)
# - Passphrase: Press Enter twice (no passphrase for automated deployment)
```

## Step 2: Copy Your Public Key

```powershell
# Display your public key
cat ~\.ssh\id_ed25519.pub

# Or copy to clipboard
Get-Content ~\.ssh\id_ed25519.pub | Set-Clipboard
```

## Step 3: Add SSH Key to Hostinger

1. **Login to Hostinger:**
   - Go to: https://hpanel.hostinger.com/
   - Login with your credentials

2. **Navigate to SSH Keys:**
   - Click on your hosting account
   - Go to **Advanced** → **SSH Access**
   - Or direct link: Settings → SSH Access

3. **Add the SSH Key:**
   - Click **"Manage SSH Keys"** or **"Add SSH Key"**
   - Paste your public key (from Step 2)
   - Give it a name: `nexa-deployment-key`
   - Click **"Add Key"** or **"Save"**

## Step 4: Test SSH Connection

```powershell
# Test connection (from PowerShell)
ssh -p 65002 u941499432@145.79.30.42

# If it asks "Are you sure you want to continue connecting?", type: yes
# If connection successful, you'll see the Hostinger shell prompt
# Type 'exit' to close the connection
```

## Step 5: Deploy Website

Once SSH key is working, run ONE of these commands:

### Option A: Using Git Bash (Recommended)
```powershell
& "C:\Program Files\Git\bin\bash.exe" deploy/build-and-upload.sh
```

### Option B: Install rsync first, then deploy
```powershell
# Install rsync (choose one):
choco install rsync
# OR
winget install -e --id cwRsync.cwRsync

# Then deploy:
& "C:\Program Files\Git\bin\bash.exe" deploy/build-and-upload.sh
```

---

## Troubleshooting

### If SSH key doesn't work:

1. **Check file permissions (Windows):**
   ```powershell
   # The private key should be readable only by you
   icacls ~\.ssh\id_ed25519 /inheritance:r
   icacls ~\.ssh\id_ed25519 /grant:r "$($env:USERNAME):(R)"
   ```

2. **Try with explicit key path:**
   ```powershell
   ssh -i ~\.ssh\id_ed25519 -p 65002 u941499432@145.79.30.42
   ```

3. **Check if old RSA key exists:**
   ```powershell
   # If you have an older id_rsa key, use that instead:
   cat ~\.ssh\id_rsa.pub
   ```

---

## What Happens After Deployment?

The script will:
1. ✅ Build frontend (React + Vite)
2. ✅ Build admin panel
3. ✅ Stage backend with production dependencies
4. ✅ Upload frontend to: `public_html/`
5. ✅ Upload admin to: `public_html/admin/`
6. ✅ Upload backend to: `nexa-api/`
7. ✅ Restart the backend API process
8. ✅ Website live at: https://nexadownloadmanager.com

---

**Need help?** Let me know at which step you're stuck!
