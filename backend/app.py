"""Smart Tent Dashboard - Flask + Socket.IO Server with real-time updates."""
import os
import sys
import asyncio
from datetime import datetime
from threading import Thread, Event
import time

from flask import Flask, jsonify, send_from_directory
from flask_socketio import SocketIO
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.devices import get_wiz_status, get_dreo_status, get_tapo_status
from backend.runtime_stats import RuntimeTracker

app = Flask(__name__, static_folder='../frontend', static_url_path='')
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

# Update interval in seconds
UPDATE_INTERVAL = 5

# Runtime Tracker
runtime_tracker = RuntimeTracker()
last_save_time = time.time()

# Background thread control
stop_event = Event()


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
            'tapo': get_tapo_status()
        }
    }


def background_update_thread():
    """Background thread that pushes updates to all clients."""
    global last_save_time
    print(f"[INFO] Background update thread started (every {UPDATE_INTERVAL}s)")
    while not stop_event.is_set():
        try:
            status = get_all_device_status()
            
            # Update Runtime Tracker
            dreo = status['devices']['dreo']
            # Only track if device is available to avoid skewing data with 'off' when actually unknown?
            # User wants "Time On". If unknown, we assume NOT on? Or just skip?
            # If we skip, we lose total time. If we assume off, we might be wrong.
            # But if offline, we generally can't confirm ON. So 'is_on' defaults to False.
            # Let's trust 'is_on'.
            is_on = dreo.get('is_on', False)
            runtime_tracker.update(is_on)
            
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


@app.route('/api/health')
def health():
    """Health check endpoint."""
    return jsonify({
        'status': 'ok',
        'timestamp': datetime.now().isoformat(),
        'update_interval': UPDATE_INTERVAL
    })


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


if __name__ == '__main__':
    print("=" * 50)
    print("Smart Tent Dashboard")
    print("=" * 50)
    print(f"\nStarting server on http://localhost:5000")
    print(f"Update interval: {UPDATE_INTERVAL} seconds")
    print("\nMake sure you have configured your .env file!")
    print("Copy config.example.env to .env and fill in your device credentials.")
    print("\n" + "=" * 50)
    
    # Start background update thread
    update_thread = Thread(target=background_update_thread, daemon=True)
    update_thread.start()
    
    try:
        socketio.run(app, host='0.0.0.0', port=5000, debug=False, use_reloader=False)
    finally:
        stop_event.set()
        update_thread.join(timeout=2)
