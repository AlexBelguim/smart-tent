# Tent App

Grow tent dashboard, rebuilt from scratch. Runs as a single Docker container on
TrueNAS; all history lives in SQLite on a mounted volume so graphs survive
restarts and rebuilds.

The ESP32 firmware is **not** part of this repo — it reuses the existing
`esp32_fan_controller.ino` (fan PWM + DS18B20 temps, HTTP API) unchanged.

## Features

- **Device registry, no hardcoding** — add devices in Settings and give each a
  role (light, heater, humidifier, exhaust, energy). Wiz plugs can be
  auto-discovered on the LAN.
- **Persistent history** — a background poller samples every device each minute
  into SQLite: temperatures, power draw, humidity, fan speed, plus daily kWh
  totals with midnight-rollover protection.
- **Automation** — per Wiz plug: a daily on/off schedule (grow light) and/or a
  thermostat with hysteresis fed by the ESP32's temperature sensors (heater).
- **Planner** — log plants (what/when planted, medium) and events per plant:
  watering with amount, what water/nutrient mix, pH, feeding, transplants,
  harvests, notes. One watering can be logged to several plants at once.

Supported devices: ESP32 fan+temp controller (local HTTP), Wiz plugs (local
UDP), Tapo P110 (local, needs TP-Link account credentials), Dreo humidifier
(cloud, EU region).

## Run on TrueNAS

```bash
git clone <this repo> && cd tent-app
cp .env.example .env   # fill in Tapo/Dreo credentials (optional)
docker compose up -d --build
```

Open `http://<server>:8420`. Point the compose volume at a dataset
(e.g. `/mnt/tank/apps/tent-app:/data`) — that folder holds `tent.db` with all
history; back it up like any dataset.

`network_mode: host` is used so Wiz UDP broadcast discovery works. If you drop
it, map port 8420 and add Wiz plugs by IP manually.

## Development

```bash
# backend (http://127.0.0.1:8321)
python -m venv .venv && .venv/Scripts/pip install -r backend/requirements.txt
cd backend && ../.venv/Scripts/python -m uvicorn app.main:app --port 8321

# frontend dev server with proxy (http://localhost:5173)
cd frontend && npm install && npm run dev
```

## API sketch

- `GET/POST/PATCH/DELETE /api/devices` — registry; `POST /api/devices/{id}/action`
  (`on` / `off` / `speed`), `GET /api/devices/{id}/status` (live), `GET /api/discover/wiz`
- `GET /api/history?metric=temp_c|power_w|humidity|fan_speed&hours=24` — time series
- `GET /api/energy/daily?days=30` — daily kWh + cost totals
- `GET/POST /api/plants`, `POST /api/plants/{id}/events` — planner
- `GET/PUT /api/settings` — kWh price, currency, poll intervals
