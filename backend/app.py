"""Smart Tent Dashboard - Flask + Socket.IO Server with real-time updates."""
import os
import sys
import asyncio
from datetime import datetime, timedelta
from threading import Thread, Event
import time

from flask import Flask, jsonify, send_from_directory, request, Response, stream_with_context
import subprocess
from flask_socketio import SocketIO
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.devices import get_wiz_status, get_wiz_light_device, get_wiz_heater_status, get_wiz_heater_device, get_dreo_status, get_tapo_status, get_fan_status, get_fan_device, get_tapo_device, get_temp_status, get_temp_device
from backend.runtime_stats import RuntimeTracker
from backend.push_notifications import (
    get_public_key, add_subscription, remove_subscription, send_push_notification
)
from backend.setup_notes import get_notes, add_note, delete_note

app = Flask(__name__, static_folder='../frontend', static_url_path='')
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

# Update interval in seconds
# Update interval in seconds
UPDATE_INTERVAL = int(os.getenv('POLLING_INTERVAL', 5))

# Runtime Tracker
runtime_tracker = RuntimeTracker()
last_save_time = time.time()

# Background thread control
stop_event = Event()

# Push notification state tracking
last_wiz_state = None
last_power_above_threshold = False
last_water_notification_time = 0
last_humidity_low_notification_time = 0
POWER_THRESHOLD = 200  # Watts
RTSP_URL = "rtsp://192.168.1.246:554/Streaming/Channels/101"

# Humidity override state
humidity_override_active = False

# Heater control state
last_heater_check_time = 0
HEATER_CHECK_INTERVAL = 5 * 60  # 5 minutes
TEMP_LOG_INTERVAL = 5 * 60      # 5 minutes
last_temp_log_time = 0

# Settings file paths
HEATER_SETTINGS_FILE = os.path.join(os.path.dirname(__file__), 'heater_settings.json')
LIGHT_SCHEDULE_FILE = os.path.join(os.path.dirname(__file__), 'light_schedule.json')



def gen_frames_ffmpeg():
    """Stream directly from ffmpeg using mpjpeg format which includes boundaries."""
    cmd = [
        'ffmpeg',
        '-rtsp_transport', 'tcp',
        '-i', RTSP_URL,
        '-c:v', 'mjpeg',      # Transcode to MJPEG
        '-q:v', '10',         # Quality
        '-r', '15',           # Limit framerate
        '-f', 'mpjpeg',       # Multipart JPEG format
        '-boundary_tag', 'ffmpeg', # Custom boundary string
        '-'
    ]
    
    process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    
    try:
        # Stream stdout directly to the client
        while True:
            # Read small chunks
            data = process.stdout.read(1024)
            if not data:
                break
            yield data
    except GeneratorExit:
        process.terminate()
        process.wait()
    except Exception as e:
        print(f"Stream error: {e}")
        process.terminate()



def get_temp_status_with_names():
    """Get temp status and merge with saved names."""
    status = get_temp_status()
    if status.get('available'):
        settings = load_temp_settings()
        # Map address -> name
        name_map = {s['address']: s['name'] for s in settings.get('sensors', [])}
        
        for sensor in status.get('sensors', []):
            addr = sensor.get('address')
            if addr and addr in name_map:
                sensor['name'] = name_map[addr]
    return status

def get_all_device_status():
    """Fetch status from all devices."""
    dreo_status = get_dreo_status()
    
    # Inject runtime stats
    dreo_status['runtime_stats'] = runtime_tracker.get_metrics()
    
    return {
        'timestamp': datetime.now().isoformat(),
        'devices': {
            'wiz': get_wiz_status(),
            'heater': get_wiz_heater_status(),
            'dreo': dreo_status,
            'tapo': get_tapo_status(),
            'fan': get_fan_status(),
            'temp': get_temp_status_with_names()
        }
    }


def background_update_thread():
    """Background thread that pushes updates to all clients."""
    global last_save_time, last_wiz_state, last_power_above_threshold, last_water_notification_time, last_heater_check_time
    print(f"[INFO] Background update thread started (every {UPDATE_INTERVAL}s)")
    
    while not stop_event.is_set():
        try:
            status = get_all_device_status()
            
            # Update Runtime Tracker
            dreo = status['devices']['dreo']
            is_working = dreo.get('is_working', False)
            runtime_tracker.update(is_working)
            
            # Check for push notification triggers
            check_push_notifications(status)
            
            # Check humidity override and enforce fan speed
            check_fan_control(status)
            
            # Check heater control (every 5 min during night)
            check_heater_control(status)
            
            # Log temperature history (every 5 min)
            check_temp_logging(status)
            
            # Check light schedule automation
            check_light_schedule(status)
            
            # Track temperature readings
            temp_data = status['devices'].get('temp')
            if temp_data and temp_data.get('available'):
                settings = load_temp_settings()
                sensor_map = {s['address']: s['name'] for s in settings.get('sensors', [])}
                
                for sensor in temp_data.get('sensors', []):
                    if sensor.get('valid'):
                        address = sensor['address']
                        name = sensor_map.get(address, sensor.get('name', address))
                        add_temp_reading(address, sensor['temp_c'], name)
            
            # Save periodically (e.g., every 60s)
            if time.time() - last_save_time > 60:
                runtime_tracker.save()
                last_save_time = time.time()
            
            socketio.emit('status_update', status)
        except Exception as e:
            print(f"[ERROR] Background update failed: {e}")
        
        # Wait for next update or stop signal
        stop_event.wait(UPDATE_INTERVAL)
    
    # Save on exit
    runtime_tracker.save()
    print("[INFO] Background update thread stopped")


def check_push_notifications(status):
    """Check device states and send push notifications for important events."""
    global last_wiz_state, last_power_above_threshold, last_water_notification_time, last_humidity_low_notification_time
    
    devices = status.get('devices', {})
    wiz = devices.get('wiz', {})
    dreo = devices.get('dreo', {})
    tapo = devices.get('tapo', {})
    
    # Wiz socket on/off notification
    if wiz.get('available'):
        current_state = wiz.get('is_on')
        
        if last_wiz_state is not None and current_state != last_wiz_state:
            try:
                state_text = "ON 💡" if current_state else "OFF 🌙"
                send_push_notification("Grow Lights", f"Socket turned {state_text}", "wiz-state")
            except Exception as e:
                pass  # Push failed, continue silently
        last_wiz_state = current_state
    
    # High power notification
    if tapo.get('available'):
        power = tapo.get('current_power_w', 0)
        is_above = power > POWER_THRESHOLD
        if is_above and not last_power_above_threshold:
            try:
                send_push_notification("⚡ High Power", f"Power: {power:.0f}W (>{POWER_THRESHOLD}W)", "power-alert")
            except Exception as e:
                pass  # Push failed, continue silently
        last_power_above_threshold = is_above
    
    # Water tank empty notification (4 hour cooldown)
    if dreo.get('available') and dreo.get('water_tank_empty'):
        now = time.time()
        if now - last_water_notification_time > 4 * 60 * 60:  # 4 hours
            try:
                send_push_notification("💧 Water Empty", "Humidifier water tank is empty!", "water-alert")
            except Exception as e:
                pass  # Push failed, continue silently
            last_water_notification_time = now
    
    # Humidity low notification (15 minute cooldown)
    if dreo.get('available'):
        current_humidity = dreo.get('current_humidity')
        target_humidity = dreo.get('target_humidity')
        if current_humidity is not None and target_humidity is not None:
            if current_humidity < target_humidity - 5:
                now = time.time()
                if now - last_humidity_low_notification_time > 15 * 60:  # 15 minutes
                    try:
                        send_push_notification(
                            "🌡️ Humidity Low",
                            f"Humidity {current_humidity}% is {target_humidity - current_humidity}% below target ({target_humidity}%)",
                            "humidity-low"
                        )
                    except Exception as e:
                        pass  # Push failed, continue silently
                    last_humidity_low_notification_time = now


def check_fan_control(status):
    """Check humidity and grow lights to strictly enforce fan speed."""
    global humidity_override_active
    
    devices = status.get('devices', {})
    dreo = devices.get('dreo', {})
    fan = devices.get('fan', {})
    wiz = devices.get('wiz', {})
    
    if not fan.get('available'):
        return
    
    fan_device = get_fan_device()
    current_speed = fan.get('speed')
    
    # ---------------------------------------------------------
    # 1. Humidity Override Check (Highest Priority)
    # ---------------------------------------------------------
    should_override = humidity_override_active
    
    if dreo.get('available') and dreo.get('current_humidity') is not None and dreo.get('target_humidity') is not None:
        current_humidity = dreo.get('current_humidity')
        target_humidity = dreo.get('target_humidity')
        
        # Get thresholds from env
        on_threshold = int(os.getenv('FAN_HUMIDITY_ON', 10))
        off_threshold = int(os.getenv('FAN_HUMIDITY_OFF', 5))
        
        trigger_level = target_humidity + on_threshold
        release_level = target_humidity + off_threshold
        
        if humidity_override_active:
            # Check if we should exit override
            if current_humidity < release_level:
                humidity_override_active = False
                should_override = False
                print(f"[FAN] Humidity override OFF: {current_humidity}% < {release_level}%")
        else:
            # Check if we should enter override
            if current_humidity >= trigger_level:
                humidity_override_active = True
                should_override = True
                print(f"[FAN] Humidity override ON: {current_humidity}% >= {trigger_level}%")
    
    # Update status for frontend
    status['devices']['fan']['humidity_override'] = humidity_override_active
    
    # ---------------------------------------------------------
    # 2. Enforce Speed
    # ---------------------------------------------------------
    target_speed = None
    reason = ""
    
    if should_override:
        target_speed = 100
        reason = "Humidity Override"
    else:
        # Determine Day/Night speed
        is_day = wiz.get('available') and wiz.get('is_on')
        settings = load_fan_settings()
        day_speed = settings.get('day', 75)
        night_speed = settings.get('night', 30)
        
        target_speed = day_speed if is_day else night_speed
        reason = f"{'Day' if is_day else 'Night'} Mode"
    
    # Only set speed if different (and speed is known)
    if current_speed is not None and target_speed is not None:
        if current_speed != target_speed:
            print(f"[FAN] Enforcing {reason}: {current_speed}% -> {target_speed}%")
            fan_device.set_speed(target_speed)
        # Else: Speed is already correct, do nothing


# =========== HEATER & LIGHT SCHEDULE ===========

def load_heater_settings():
    """Load heater settings from file."""
    defaults = {'enabled': False, 'night_temp': 20, 'sensor_address': None}
    try:
        if os.path.exists(HEATER_SETTINGS_FILE):
            import json
            with open(HEATER_SETTINGS_FILE, 'r') as f:
                saved = json.load(f)
                return {**defaults, **saved}
    except Exception as e:
        print(f"[HEATER] Failed to load settings: {e}")
    return defaults

def save_heater_settings(new_settings):
    """Save heater settings to file."""
    try:
        current = load_heater_settings()
        current.update(new_settings)
        import json
        with open(HEATER_SETTINGS_FILE, 'w') as f:
            json.dump(current, f)
        return True
    except Exception as e:
        print(f"[HEATER] Failed to save settings: {e}")
        return False

def load_light_schedule():
    """Load light schedule settings from file."""
    defaults = {'enabled': False, 'on_time': '06:00', 'off_time': '00:00'}
    try:
        if os.path.exists(LIGHT_SCHEDULE_FILE):
            import json
            with open(LIGHT_SCHEDULE_FILE, 'r') as f:
                saved = json.load(f)
                return {**defaults, **saved}
    except Exception as e:
        print(f"[LIGHT] Failed to load schedule: {e}")
    return defaults

def save_light_schedule(new_settings):
    """Save light schedule settings to file."""
    try:
        current = load_light_schedule()
        current.update(new_settings)
        import json
        with open(LIGHT_SCHEDULE_FILE, 'w') as f:
            json.dump(current, f)
        return True
    except Exception as e:
        print(f"[LIGHT] Failed to save schedule: {e}")
        return False


def check_heater_control(status):
    """Check temperature and toggle heater during night mode (every 5 min)."""
    global last_heater_check_time
    
    now = time.time()
    heater_settings = load_heater_settings()
    
    if not heater_settings.get('enabled'):
        return
    
    # Only check every HEATER_CHECK_INTERVAL (5 minutes)
    if now - last_heater_check_time < HEATER_CHECK_INTERVAL:
        return
    last_heater_check_time = now
    
    devices = status.get('devices', {})
    wiz = devices.get('wiz', {})
    temp_data = devices.get('temp', {})
    heater = devices.get('heater', {})
    
    # Only control heater during night (lights OFF)
    is_day = wiz.get('available') and wiz.get('is_on')
    if is_day:
        # Day mode: ensure heater is ON (as desired)
        if heater.get('available') and not heater.get('is_on'):
            heater_device = get_wiz_heater_device()
            result = heater_device.turn_on()
            print(f"[HEATER] Day mode - turning heater ON: {result}")
        return
    
    # Night mode: check temperature
    if not temp_data.get('available'):
        return
    
    sensors = temp_data.get('sensors', [])
    avg_temp = 0
    target_sensor_addr = heater_settings.get('sensor_address')
    
    # If a specific sensor is selected, use only that one
    if target_sensor_addr and target_sensor_addr != 'average':
        specific_sensor = next((s for s in sensors if s['address'] == target_sensor_addr), None)
        if specific_sensor and specific_sensor.get('valid'):
            avg_temp = specific_sensor['temp_c']
            print(f"[HEATER] Using sensor {specific_sensor.get('name', target_sensor_addr)}: {avg_temp}°C")
        else:
            print(f"[HEATER] Targeted sensor {target_sensor_addr} not found or invalid.")
            return
    else:
        # Use average of all valid sensors
        valid_temps = [s['temp_c'] for s in sensors if s.get('valid')]
        if not valid_temps:
            return
        avg_temp = sum(valid_temps) / len(valid_temps)

    target_temp = heater_settings.get('night_temp', 20)
    heater_device = get_wiz_heater_device()
    
    # Hysteresis: turn on 0.5° below target, off 0.5° above
    if avg_temp < target_temp - 0.5:
        if not (heater.get('available') and heater.get('is_on')):
            result = heater_device.turn_on()
            print(f"[HEATER] Temp {avg_temp:.1f}°C < {target_temp - 0.5}°C → ON: {result}")
    elif avg_temp > target_temp + 0.5:
        if heater.get('available') and heater.get('is_on'):
            result = heater_device.turn_off()
            print(f"[HEATER] Temp {avg_temp:.1f}°C > {target_temp + 0.5}°C → OFF: {result}")
    else:
        print(f"[HEATER] Temp {avg_temp:.1f}°C within range of {target_temp}°C, no action")


def check_light_schedule(status):
    """Check light schedule and toggle grow lights based on configured times."""
    schedule = load_light_schedule()
    
    if not schedule.get('enabled'):
        return
    
    on_time_str = schedule.get('on_time', '06:00')
    off_time_str = schedule.get('off_time', '00:00')
    
    try:
        now = datetime.now()
        on_hour, on_min = map(int, on_time_str.split(':'))
        off_hour, off_min = map(int, off_time_str.split(':'))
        
        on_minutes = on_hour * 60 + on_min
        off_minutes = off_hour * 60 + off_min
        now_minutes = now.hour * 60 + now.minute
        
        # Determine if lights should be on
        if on_minutes < off_minutes:
            # Simple range: e.g., 06:00 - 22:00
            should_be_on = on_minutes <= now_minutes < off_minutes
        else:
            # Overnight range: e.g., 18:00 - 06:00
            should_be_on = now_minutes >= on_minutes or now_minutes < off_minutes
        
        devices = status.get('devices', {})
        wiz = devices.get('wiz', {})
        
        if not wiz.get('available'):
            return
        
        is_on = wiz.get('is_on', False)
        light_device = get_wiz_light_device()
        
        if should_be_on and not is_on:
            result = light_device.turn_on()
            print(f"[LIGHT] Schedule ON ({on_time_str}) → {result}")
        elif not should_be_on and is_on:
            result = light_device.turn_off()
            print(f"[LIGHT] Schedule OFF ({off_time_str}) → {result}")
    except Exception as e:
        print(f"[LIGHT] Schedule check error: {e}")

@app.route('/')
def index():
    """Serve the main dashboard page."""
    return send_from_directory(app.static_folder, 'index.html')


@app.route('/api/status')
def api_get_all_status():
    """Get status of all devices (REST fallback)."""
    return jsonify(get_all_device_status())


@app.route('/api/wiz')
def get_wiz():
    """Get Wiz light status."""
    return jsonify(get_wiz_status())


@app.route('/api/dreo')
def get_dreo():
    """Get Dreo humidifier status."""
    return jsonify(get_dreo_status())


@app.route('/api/tapo')
def get_tapo():
    """Get Tapo energy monitor status."""
    return jsonify(get_tapo_status())


@app.route('/api/fan')
def get_fan():
    """Get PWM fan status."""
    return jsonify(get_fan_status())


@app.route('/api/fan/speed', methods=['POST'])
def set_fan_speed():
    """Set PWM fan speed (requires auth code)."""
    data = request.get_json()
    if not data:
        return jsonify({'error': 'No data provided'}), 400
    
    speed = data.get('speed')
    code = data.get('code')
    
    if speed is None:
        return jsonify({'error': 'Speed required'}), 400
    if not code:
        return jsonify({'error': 'Authentication code required'}), 401
    
    fan = get_fan_device()
    result = fan.set_speed(speed, code)
    
    if result.get('success'):
        return jsonify(result)
    else:
        status_code = 403 if 'Invalid' in result.get('error', '') else 500
        return jsonify(result), status_code


# Fan settings storage file
FAN_SETTINGS_FILE = os.path.join(os.path.dirname(__file__), 'fan_settings.json')

def load_fan_settings():
    """Load fan settings from file."""
    default_settings = {
        'day': 75, 
        'night': 30,
        # Airflow defaults
        'tent_width': 120, 'tent_depth': 120, 'tent_height': 200,
        'exhaust_count': 1, 'exhaust_size': 150, 'exhaust_max_rpm': 2500, 'exhaust_min_rpm': 0,
        'intake_count': 0, 'intake_size': 150, 'intake_max_rpm': 2500, 'intake_min_rpm': 0
    }
    try:
        if os.path.exists(FAN_SETTINGS_FILE):
            with open(FAN_SETTINGS_FILE, 'r') as f:
                import json
                saved = json.load(f)
                # Merge saved with defaults to ensure all keys exist
                return {**default_settings, **saved}
    except Exception as e:
        print(f"[FAN] Failed to load settings: {e}")
    return default_settings

def save_fan_settings(new_settings):
    """Save fan settings to file."""
    try:
        # Load existing to preserve keys not in new_settings
        current = load_fan_settings()
        current.update(new_settings)
        
        import json
        with open(FAN_SETTINGS_FILE, 'w') as f:
            json.dump(current, f)
        return True
    except Exception as e:
        print(f"[FAN] Failed to save settings: {e}")
        return False

@app.route('/api/fan/settings')
def get_fan_settings():
    """Get fan settings."""
    return jsonify(load_fan_settings())

@app.route('/api/fan/settings', methods=['POST'])
def set_fan_settings():
    """Save fan settings."""
    data = request.json
    if save_fan_settings(data):
        # Sync all exhaust fan pins to ESP32
        fan_device = get_fan_device()
        if data.get('exhaust_fans'):
            pins = [fan.get('pin', 15) for fan in data['exhaust_fans'] if fan.get('pin')]
            if pins:
                result = fan_device.set_pin(pins)
                if result.get('success'):
                    print(f"[FAN] {len(pins)} fan pin(s) synced to ESP32 (restart required)")
                else:
                    print(f"[FAN] Warning: Could not sync pins to ESP32: {result.get('error')}")
        
        return jsonify(load_fan_settings())
    return jsonify({'error': 'Failed to save'}), 500


@app.route('/api/fan/schedule')
def get_fan_schedule():
    """Get fan schedule entries."""
    fan = get_fan_device()
    return jsonify(fan.get_schedule())


@app.route('/api/fan/schedule', methods=['POST'])
def set_fan_schedule():
    """Set fan schedule entries (requires auth code)."""
    data = request.get_json()
    if not data:
        return jsonify({'error': 'No data provided'}), 400
    
    schedules = data.get('schedules')
    code = data.get('code')
    
    if schedules is None:
        return jsonify({'error': 'Schedules required'}), 400
    if not code:
        return jsonify({'error': 'Authentication code required'}), 401
    
    fan = get_fan_device()
    result = fan.set_schedule(schedules, code)
    
    if result.get('success'):
        return jsonify(result)
    else:
        status_code = 403 if 'Invalid' in result.get('error', '') else 500
        return jsonify(result), status_code


@app.route('/api/fan/auth', methods=['POST'])
def verify_fan_auth():
    """Verify authentication code for fan control."""
    data = request.get_json()
    if not data or not data.get('code'):
        return jsonify({'valid': False}), 401
    
    fan = get_fan_device()
    is_valid = fan.verify_auth(data['code'])
    
    return jsonify({'valid': is_valid}), 200 if is_valid else 403

@app.route('/api/health')
def health():
    """Health check endpoint."""
    return jsonify({
        'status': 'ok',
        'timestamp': datetime.now().isoformat(),
        'update_interval': UPDATE_INTERVAL
    })


# ============== TEMPERATURE SENSOR ENDPOINTS ==============

# Temperature settings storage file
TEMP_SETTINGS_FILE = os.path.join(os.path.dirname(__file__), 'temp_settings.json')
TEMP_HISTORY_FILE = os.path.join(os.path.dirname(__file__), 'temp_history.json')

def load_temp_settings():
    """Load temperature sensor settings from file."""
    default_settings = {
        'pin': 22,
        'sensor_count': 0,
        'sensors': []
    }
    try:
        if os.path.exists(TEMP_SETTINGS_FILE):
            with open(TEMP_SETTINGS_FILE, 'r') as f:
                import json
                return json.load(f)
    except Exception as e:
        print(f'[TEMP] Failed to load settings: {e}')
    return default_settings

def save_temp_settings(settings):
    """Save temperature sensor settings to file."""
    try:
        import json
        with open(TEMP_SETTINGS_FILE, 'w') as f:
            json.dump(settings, f, indent=2)
        return True
    except Exception as e:
        print(f'[TEMP] Failed to save settings: {e}')
        return False

def load_temp_history():
    """Load temperature history from file."""
    try:
        if os.path.exists(TEMP_HISTORY_FILE):
            with open(TEMP_HISTORY_FILE, 'r') as f:
                import json
                return json.load(f)
    except Exception as e:
        print(f'[TEMP] Failed to load history: {e}')
    return []

def save_temp_history(history):
    """Save temperature history to file."""
    try:
        import json
        with open(TEMP_HISTORY_FILE, 'w') as f:
            json.dump(history, f)
        return True
    except Exception as e:
        print(f'[TEMP] Failed to save history: {e}')
        return False

def add_temp_reading(sensor_address, temp_c, sensor_name=None):
    """Add a temperature reading to history."""
    history = load_temp_history()
    
    # Add new reading
    reading = {
        'timestamp': datetime.now().isoformat(),
        'address': sensor_address,
        'name': sensor_name,
        'temp_c': temp_c
    }
    history.append(reading)
    
    # Keep only last 7 days of data
    from datetime import timedelta
    cutoff = datetime.now() - timedelta(days=7)
    history = [r for r in history if datetime.fromisoformat(r['timestamp']) > cutoff]
    
    save_temp_history(history)
    return reading

@app.route('/api/temp/settings')
def get_temp_settings():
    """Get temperature sensor settings."""
    return jsonify(load_temp_settings())

@app.route('/api/temp/settings', methods=['POST'])
def set_temp_settings():
    """Save temperature sensor settings."""
    data = request.json
    if save_temp_settings(data):
        return jsonify(load_temp_settings())
    return jsonify({'error': 'Failed to save'}), 500

@app.route('/api/temp/status')
def get_temp():
    """Get temperature sensor status."""
    return jsonify(get_temp_status_with_names())

@app.route('/api/temp/detect', methods=['POST'])
def detect_temp_sensors():
    """Detect temperature sensors on the bus."""
    temp = get_temp_device()
    
    # First try to get current status WITH NAMES merged from settings
    # This ensures consistency with dashboard cards and preserves user renaming
    status = get_temp_status_with_names()
    if status.get('available') and status.get('sensor_count', 0) > 0:
        return jsonify({
            'success': True,
            'sensors': status.get('sensors', [])
        })

    # Fallback to forcing a detection scan if no sensors are known
    result = temp.detect_sensors()
    return jsonify(result)

@app.route('/api/temp/sensor/name', methods=['POST'])
def set_temp_sensor_name():
    """Update name for a temperature sensor."""
    data = request.json
    address = data.get('address')
    name = data.get('name')
    
    if not address or not name:
        return jsonify({'error': 'Missing address or name'}), 400
        
    settings = load_temp_settings()
    sensors = settings.get('sensors', [])
    
    # Find and update
    found = False
    for sensor in sensors:
        if sensor['address'] == address:
            sensor['name'] = name
            found = True
            break
            
    if not found:
        sensors.append({'address': address, 'name': name})
        
    settings['sensors'] = sensors
    
    if save_temp_settings(settings):
        return jsonify({'success': True})
    return jsonify({'error': 'Failed to save'}), 500

def check_temp_logging(status):
    """Log temperature data periodically."""
    global last_temp_log_time
    import time
    
    now = time.time()
    if now - last_temp_log_time < TEMP_LOG_INTERVAL:
        return
    last_temp_log_time = now
    
    temp_status = status.get('devices', {}).get('temp', {})
    if not temp_status.get('available'):
        return
        
    sensors = temp_status.get('sensors', [])
    count = 0
    for sensor in sensors:
        if sensor.get('valid'):
            add_temp_reading(
                sensor['address'],
                sensor['temp_c'],
                sensor.get('name')
            )
            count += 1
    
    if count > 0:
        print(f"[TEMP] Logged history for {count} sensors")

@app.route('/api/temp/history')
def get_temp_history():
    """Get temperature history."""
    hours = int(request.args.get('hours', 24))
    history = load_temp_history()
    
    # Filter by time range
    from datetime import timedelta
    cutoff = datetime.now() - timedelta(hours=hours)
    filtered = [r for r in history if datetime.fromisoformat(r['timestamp']) > cutoff]
    
    return jsonify(filtered)


@app.route('/stats')
def stats_page():
    """Serve the stats page."""
    return send_from_directory(app.static_folder, 'stats.html')


@app.route('/api/stats')
def api_stats():
    """Get aggregated stats for the stats page."""
    period = int(request.args.get('period', 30))
    period = min(period, 365)  # cap at 1 year
    
    # Humidity runtime history
    humidity_data = runtime_tracker.get_daily_history_range(period)
    
    # Energy data — all from accumulated daily store
    tapo = get_tapo_device()
    kwh_price = float(os.getenv('KWH_PRICE', '0.25'))
    
    # Temperature history
    temp_history = load_temp_history()
    
    
    cutoff_date = datetime.now() - timedelta(days=period)
    temp_filtered = [r for r in temp_history if datetime.fromisoformat(r['timestamp']) > cutoff_date]
    
    # Current sensor names for legend
    temp_settings = load_temp_settings()
    
    return jsonify({
        'humidity_runtime': humidity_data,
        'energy_daily': tapo.get_history_range(period),
        'energy_monthly': tapo.get_monthly_breakdown(kwh_price),
        'temp_history': temp_filtered,
        'temp_sensors': temp_settings.get('sensors', []),
        'notes': get_notes(),
        'period': period,
        'kwh_price': kwh_price,
        'currency': os.getenv('CURRENCY_SYMBOL', '\u20ac')
    })


@app.route('/api/notes')
def api_get_notes():
    """Get all setup change notes."""
    return jsonify(get_notes())


@app.route('/api/notes', methods=['POST'])
def api_add_note():
    """Add a new setup change note."""
    data = request.get_json()
    if not data or not data.get('text'):
        return jsonify({'error': 'Text required'}), 400
    
    date_str = data.get('date', datetime.now().strftime('%Y-%m-%d'))
    note = add_note(date_str, data['text'])
    return jsonify(note)


@app.route('/api/notes/<int:note_id>', methods=['DELETE'])
def api_delete_note(note_id):
    """Delete a setup change note."""
    if delete_note(note_id):
        return jsonify({'success': True})
    return jsonify({'error': 'Note not found'}), 404


@app.route('/api/push/key')
def push_public_key():
    """Get the VAPID public key for push subscription."""
    return jsonify({'publicKey': get_public_key()})


@app.route('/api/push/subscribe', methods=['POST'])
def push_subscribe():
    """Subscribe to push notifications."""
    subscription = request.get_json()
    if not subscription:
        return jsonify({'error': 'No subscription data'}), 400
    
    add_subscription(subscription)
    return jsonify({'success': True})


@app.route('/api/push/unsubscribe', methods=['POST'])
def push_unsubscribe():
    """Unsubscribe from push notifications."""
    data = request.get_json()
    endpoint = data.get('endpoint') if data else None
    if endpoint:
        remove_subscription(endpoint)
    return jsonify({'success': True})


# =========== HEATER API ===========

@app.route('/api/heater/settings', methods=['GET', 'POST'])
def heater_settings_api():
    """Get or save heater settings."""
    if request.method == 'GET':
        return jsonify(load_heater_settings())
    
    data = request.json
    if save_heater_settings(data):
        return jsonify(load_heater_settings())
    return jsonify({'error': 'Failed to save'}), 500


@app.route('/api/heater/toggle', methods=['POST'])
def heater_toggle():
    """Manually turn heater on/off."""
    data = request.json or {}
    action = data.get('action', 'toggle')
    
    heater_device = get_wiz_heater_device()
    
    if action == 'on':
        result = heater_device.turn_on()
    elif action == 'off':
        result = heater_device.turn_off()
    else:
        status = heater_device.get_status()
        if status.get('is_on'):
            result = heater_device.turn_off()
        else:
            result = heater_device.turn_on()
    
    return jsonify(result)


# =========== LIGHT SCHEDULE API ===========

@app.route('/api/light/schedule', methods=['GET', 'POST'])
def light_schedule_api():
    """Get or save light schedule settings."""
    if request.method == 'GET':
        return jsonify(load_light_schedule())
    
    data = request.json
    if save_light_schedule(data):
        return jsonify(load_light_schedule())
    return jsonify({'error': 'Failed to save'}), 500


@app.route('/api/light/toggle', methods=['POST'])
def light_toggle():
    """Manually turn grow light on/off."""
    data = request.json or {}
    action = data.get('action', 'toggle')
    
    light_device = get_wiz_light_device()
    
    if action == 'on':
        result = light_device.turn_on()
    elif action == 'off':
        result = light_device.turn_off()
    else:
        status = light_device.get_status()
        if status.get('is_on'):
            result = light_device.turn_off()
        else:
            result = light_device.turn_on()
    
    return jsonify(result)


@socketio.on('connect')
def handle_connect():
    """Handle client connection - send initial status."""
    print("[SOCKET] Client connected")
    try:
        status = get_all_device_status()
        socketio.emit('status_update', status)
    except Exception as e:
        print(f"[ERROR] Failed to send initial status: {e}")


@socketio.on('disconnect')
def handle_disconnect():
    """Handle client disconnection."""
    print("[SOCKET] Client disconnected")


@socketio.on('request_update')
def handle_request_update():
    """Handle manual update request from client."""
    try:
        status = get_all_device_status()
        socketio.emit('status_update', status)
    except Exception as e:
        print(f"[ERROR] Failed to send requested update: {e}")


@app.route('/video_feed')
def video_feed():
    """Video streaming route."""
    return Response(
        stream_with_context(gen_frames_ffmpeg()),
        mimetype='multipart/x-mixed-replace; boundary=ffmpeg'
    )


if __name__ == '__main__':
    print("=" * 50)
    print("Smart Tent Dashboard")
    print("=" * 50)
    print(f"\nStarting server on http://localhost:5000")
    print(f"Update interval: {UPDATE_INTERVAL} seconds")
    print("\nMake sure you have configured your .env file!")
    print("Copy config.example.env to .env and fill in your device credentials.")
    print("\nTip: Use Cloudflare Tunnel for HTTPS access.")
    print("See docs/HTTPS_SETUP.md for details.")
    print("\n" + "=" * 50)
    
    # Start background update thread
    update_thread = Thread(target=background_update_thread, daemon=True)
    update_thread.start()
    
    try:
        # HTTP mode - use Cloudflare Tunnel for HTTPS
        socketio.run(app, host='0.0.0.0', port=5000, debug=False, use_reloader=False, allow_unsafe_werkzeug=True)
    finally:
        stop_event.set()
        update_thread.join(timeout=2)
