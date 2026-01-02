# Smart Tent Dashboard 🌱

A beautiful web dashboard to monitor your grow tent devices in one place.

## Supported Devices

| Device | Library | Connection |
|--------|---------|------------|
| **Wiz Smart Socket** (Grow Lights) | `pywizlight` | Local Network |
| **Dreo Humidifier** | `pydreo` | Cloud API |
| **Tapo P110** (Energy Monitor) | `python-tapo` | Local Network |

## Quick Start

### 1. Install Dependencies

```bash
pip install -r requirements.txt
```

### 2. Configure Your Devices

Copy the example config and fill in your credentials:

```bash
cp config.example.env .env
```

Edit `.env` with your device information:

```env
# Wiz Smart Socket IP (find in router or Wiz app)
WIZ_LIGHT_IP=192.168.1.xxx

# Dreo Cloud Login
DREO_EMAIL=your_email@example.com
DREO_PASSWORD=your_password

# Tapo Cloud Login + Device IP
TAPO_EMAIL=your_email@example.com
TAPO_PASSWORD=your_password
TAPO_DEVICE_IP=192.168.1.xxx
```

### 3. Run the Dashboard

```bash
python backend/app.py
```

Open your browser to **http://localhost:5000**

## Features

- 🌙 **Dark Theme** - Easy on the eyes, perfect for grow room monitoring
- ⚡ **Real-time Updates** - Auto-refreshes every 10 seconds
- 📊 **Energy Monitoring** - Track power consumption from your Tapo P110
- 💧 **Humidity Tracking** - Monitor your Dreo humidifier status
- 💡 **Light Status** - See if your grow lights are on and brightness levels
- ⏱️ **Uptime Tracking** - Know how long each device has been running

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Dashboard webpage |
| `GET /api/status` | All device statuses |
| `GET /api/wiz` | Wiz light status only |
| `GET /api/dreo` | Dreo humidifier status only |
| `GET /api/tapo` | Tapo energy data only |
| `GET /api/health` | Server health check |

## Project Structure

```
smart tent/
├── backend/
│   ├── app.py              # Flask server
│   └── devices/
│       ├── wiz_device.py   # Wiz integration
│       ├── dreo_device.py  # Dreo integration
│       └── tapo_device.py  # Tapo integration
├── frontend/
│   ├── index.html          # Dashboard page
│   ├── styles.css          # Dark theme styles
│   └── app.js              # Data fetching & UI
├── requirements.txt
├── config.example.env
└── README.md
```

## Troubleshooting

**Device shows "Offline"?**
- Check that the IP address is correct
- Ensure your computer is on the same network as the devices
- For Dreo/Tapo: verify your cloud account credentials

**Can't find device IP?**
- Check your router's connected devices list
- Use the official app to find the device IP in settings
