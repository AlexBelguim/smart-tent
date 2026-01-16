# ESP32 Fan Controller Tools

## Check Fan Speed

You can check the current status of the fan using the provided Python script or standard tools like `curl`.

### Using the Python Script
This script attempts to read `ESP32_FAN_IP` from the project's `.env` file automatically.

```powershell
# Run with auto-detected IP
python check_speed.py

# Or specify IP manually
python check_speed.py 192.168.1.50
```

### Using Curl
If you prefer command line tools (IP address example: 192.168.1.50):

```powershell
curl http://192.168.1.50/status
```

### Set Speed (Advanced)
To set the speed manually via API (requires authentication hash):

```powershell
curl -X POST http://192.168.1.50/speed -H "Content-Type: application/json" -d "{\"speed\": 50, \"auth\": \"<SHA256_HASH_OF_PIN>\"}"
```
