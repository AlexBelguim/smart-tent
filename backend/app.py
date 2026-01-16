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

from backend.devices import get_wiz_status, get_dreo_status, get_tapo_status, get_fan_status, get_fan_device
from backend.runtime_stats import RuntimeTracker
from backend.push_notifications import (
    get_public_key, add_subscription, remove_subscription, send_push_notification
)

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
            
            # Check humidity override for fan control
            check_humidity_override(status)
            
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
    global last_wiz_state, last_power_above_threshold, last_water_notification_time
    
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


def check_humidity_override(status):
    """Check humidity levels and auto-set fan to 100% if too high (with hysteresis)."""
    global humidity_override_active
    
    devices = status.get('devices', {})
    dreo = devices.get('dreo', {})
    fan = devices.get('fan', {})
    
    if not dreo.get('available') or not fan.get('available'):
        return
    
    current = dreo.get('current_humidity')
    target = dreo.get('target_humidity')
    
    if current is None or target is None:
        return
    
    # Get thresholds from env
    on_threshold = int(os.getenv('FAN_HUMIDITY_ON', 10))
    off_threshold = int(os.getenv('FAN_HUMIDITY_OFF', 5))
    
    trigger_level = target + on_threshold
    release_level = target + off_threshold
    
    fan_device = get_fan_device()
    
    if humidity_override_active:
        # Currently overriding - check if we should turn off
        if current < release_level:
            humidity_override_active = False
            print(f"[FAN] Humidity override OFF: {current}% < {release_level}%")
            # Note: Don't auto-set speed here, let user's day/night settings take over
    else:
        # Not overriding - check if we should trigger
        if current >= trigger_level:
            humidity_override_active = True
            print(f"[FAN] Humidity override ON: {current}% >= {trigger_level}% -> Setting fan to 100%")
            # Use the PIN from .env to set fan to 100%
            result = fan_device.set_speed(100)
            if result.get('success'):
                print("[FAN] Successfully set to 100%")
            else:
                print(f"[FAN] Failed to set speed: {result.get('error')}")
    
    # Add override state to fan status for frontend
    status['devices']['fan']['humidity_override'] = humidity_override_active


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
