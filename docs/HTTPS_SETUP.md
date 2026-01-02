# HTTPS Setup Guide

This guide explains how to enable HTTPS for the Smart Tent Dashboard to get full PWA support (standalone mode without address bar).

## Why HTTPS?

PWAs require HTTPS to work properly. Without it:
- The address bar remains visible in installed PWAs
- Some features may be restricted
- Browsers treat HTTP as "insecure"

---

## Option 1: mkcert (Local Network)

Best for: **Local network access only** (e.g., `192.168.1.50`)

### Setup on Windows PC

1. **Download mkcert** (if not already done):
   ```powershell
   # Already downloaded to project root as mkcert.exe
   # Or install via chocolatey:
   choco install mkcert -y
   ```

2. **Install the root CA**:
   ```powershell
   .\mkcert.exe -install
   ```
   This creates a trusted root certificate on your PC.

3. **Generate certificates** for your hosts:
   ```powershell
   .\mkcert.exe localhost 192.168.1.50
   ```
   This creates `localhost+1.pem` and `localhost+1-key.pem`.

4. **The app is already configured** to use these certificates.

### Setup on Android Phone

You must install the root CA on your phone for HTTPS to work without warnings:

1. **Find the root CA file**:
   ```powershell
   .\mkcert.exe -CAROOT
   # Shows: C:\Users\<username>\AppData\Local\mkcert
   ```

2. **Transfer `rootCA.pem`** to your phone (USB, email, or cloud)

3. **Install on Android**:
   - Settings → Security → Encryption & credentials
   - Install a certificate → CA certificate
   - Select the `rootCA.pem` file
   - Confirm the warning

4. **Access**: `https://192.168.1.50:5000`

### Setup on iOS

1. Transfer `rootCA.pem` via AirDrop or email
2. Open the file → Install Profile
3. Settings → General → About → Certificate Trust Settings
4. Enable full trust for the mkcert certificate

---

## Option 2: Cloudflare Tunnel (Remote Access)

Best for: **Accessing from anywhere** with a real HTTPS domain

### Prerequisites
- A Cloudflare account (free)
- A domain managed by Cloudflare (or use their free `*.trycloudflare.com` subdomain)

### Quick Setup (No Domain Required)

1. **Install cloudflared**:
   ```powershell
   # Windows
   choco install cloudflared -y
   # Or download from: https://github.com/cloudflare/cloudflared/releases
   ```

2. **Start a quick tunnel**:
   ```powershell
   cloudflared tunnel --url http://localhost:5000
   ```
   This gives you a temporary `https://random-name.trycloudflare.com` URL.

3. **Access from anywhere** using the HTTPS URL provided.

> **Note**: The URL changes each time you restart the tunnel.

### Persistent Tunnel (With Your Domain)

1. **Login to Cloudflare**:
   ```powershell
   cloudflared tunnel login
   ```

2. **Create a named tunnel**:
   ```powershell
   cloudflared tunnel create smart-tent
   ```

3. **Configure the tunnel** - create `~/.cloudflared/config.yml`:
   ```yaml
   tunnel: smart-tent
   credentials-file: ~/.cloudflared/<tunnel-id>.json

   ingress:
     - hostname: tent.yourdomain.com
       service: http://localhost:5000
     - service: http_status:404
   ```

4. **Create DNS record**:
   ```powershell
   cloudflared tunnel route dns smart-tent tent.yourdomain.com
   ```

5. **Run the tunnel**:
   ```powershell
   cloudflared tunnel run smart-tent
   ```

6. **Access**: `https://tent.yourdomain.com`

### Run as Windows Service

To keep the tunnel running in the background:

```powershell
cloudflared service install
```

---

## Switching Between Modes

### To use HTTP (no HTTPS):
Edit `backend/app.py` and change:
```python
socketio.run(app, host='0.0.0.0', port=5000, debug=False, use_reloader=False)
```

### To use HTTPS with mkcert:
```python
socketio.run(app, host='0.0.0.0', port=5000, debug=False, use_reloader=False,
             ssl_context=(cert_path, key_path))
```

### To use Cloudflare Tunnel:
Keep the app on HTTP (port 5000), and let cloudflared handle HTTPS.

---

## Troubleshooting

### "Certificate not trusted" on phone
- Make sure you installed `rootCA.pem`, not the server certificate
- On Android, check: Settings → Security → Trusted credentials → User tab

### PWA still shows address bar
- Uninstall the old PWA completely
- Clear browser cache for the site
- Reinstall fresh after HTTPS is working

### Cloudflare tunnel not connecting
- Check firewall settings
- Make sure the app is running on the correct port
- Try `cloudflared tunnel --url http://127.0.0.1:5000`
