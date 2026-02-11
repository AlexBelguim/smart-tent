"""Smart Tent Dashboard - Flask + Socket.IO Server with real-time updates."""
import os
import sys
import asyncio
from datetime import datetime
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

from backend.devices import get_wiz_status, get_dreo_status, get_tapo_status, get_fan_status, get_fan_device, get_tapo_device
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



def get_all_device_status():
    """Fetch status from all devices."""
    dreo_status = get_dreo_status()
    
    # Inject runtime stats
    dreo_status['runtime_stats'] = runtime_tracker.get_metrics()
    
    return {
        'timestamp': datetime.now().isoformat(),
        'devices': {
            'wiz': get_wiz_status(),
            'dreo': dreo_status,
            'tapo': get_tapo_status(),
            'fan': get_fan_status()
        }
    }


def background_update_thread():
    """Background thread that pushes updates to all clients."""
    global last_save_time, last_wiz_state, last_power_above_threshold, last_water_notification_time
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
            if current_humidity < target_humidity - 10:
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
    """Load fan day/night settings from file."""
    try:
        if os.path.exists(FAN_SETTINGS_FILE):
            with open(FAN_SETTINGS_FILE, 'r') as f:
                import json
                return json.load(f)
    except Exception as e:
        print(f"[FAN] Failed to load settings: {e}")
    return {'day': 75, 'night': 30}

def save_fan_settings(day_speed, night_speed):
    """Save fan day/night settings to file."""
    try:
        import json
        with open(FAN_SETTINGS_FILE, 'w') as f:
            json.dump({'day': day_speed, 'night': night_speed}, f)
        return True
    except Exception as e:
        print(f"[FAN] Failed to save settings: {e}")
        return False

@app.route('/api/fan/settings')
def get_fan_settings():
    """Get fan day/night settings."""
    return jsonify(load_fan_settings())

@app.route('/api/fan/settings', methods=['POST'])
def set_fan_settings():
    """Save fan day/night settings."""
    data = request.get_json()
    if not data:
        return jsonify({'error': 'No data provided'}), 400
    
    day_speed = data.get('day', 75)
    night_speed = data.get('night', 30)
    
    if save_fan_settings(day_speed, night_speed):
        print(f"[FAN] Settings saved: day={day_speed}%, night={night_speed}%")
        return jsonify({'success': True, 'day': day_speed, 'night': night_speed})
    else:
        return jsonify({'error': 'Failed to save settings'}), 500


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
    
    return jsonify({
        'humidity_runtime': humidity_data,
        'energy_daily': tapo.get_all_history(),
        'energy_monthly': tapo.get_monthly_breakdown(kwh_price),
        'notes': notes,
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
