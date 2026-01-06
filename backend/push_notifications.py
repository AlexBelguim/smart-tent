"""
Web Push Notification Module

Handles VAPID key generation, subscription storage, and push notifications.
"""

import json
import os
import base64
from pathlib import Path
from pywebpush import webpush, WebPushException
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.backends import default_backend

# File paths
DATA_DIR = Path(__file__).parent.parent / 'data'
VAPID_FILE = DATA_DIR / 'vapid_keys.json'
VAPID_PRIVATE_FILE = DATA_DIR / 'vapid_private.pem'
SUBSCRIPTIONS_FILE = DATA_DIR / 'push_subscriptions.json'

# VAPID claims
VAPID_CLAIMS = {
    "sub": "mailto:admin@smarttent.local"
}


def ensure_data_dir():
    """Ensure data directory exists."""
    DATA_DIR.mkdir(exist_ok=True)


def get_vapid_keys():
    """Get or generate VAPID keys using cryptography directly."""
    ensure_data_dir()
    
    if VAPID_FILE.exists() and VAPID_PRIVATE_FILE.exists():
        try:
            with open(VAPID_FILE, 'r') as f:
                keys = json.load(f)
                if 'applicationServerKey' in keys:
                    return keys
        except (json.JSONDecodeError, KeyError, ValueError, Exception):
            print("[PUSH] VAPID keys corrupted or invalid, regenerating...")
            pass
    
    # Generate new ECDSA P-256 keys
    private_key = ec.generate_private_key(ec.SECP256R1(), default_backend())
    public_key = private_key.public_key()
    
    # Get PEM encodings
    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption()
    )
    
    # Save private key to standalone file for pywebpush to use directly
    with open(VAPID_PRIVATE_FILE, 'wb') as f:
        f.write(private_pem)
    
    # Get raw public key bytes and encode as URL-safe base64 for applicationServerKey
    public_numbers = public_key.public_numbers()
    x_bytes = public_numbers.x.to_bytes(32, 'big')
    y_bytes = public_numbers.y.to_bytes(32, 'big')
    # Uncompressed point format: 0x04 || x || y
    raw_public = b'\x04' + x_bytes + y_bytes
    application_server_key = base64.urlsafe_b64encode(raw_public).rstrip(b'=').decode('utf-8')
    
    keys = {
        'applicationServerKey': application_server_key,
        'private_key_path': str(VAPID_PRIVATE_FILE)
    }
    
    with open(VAPID_FILE, 'w') as f:
        json.dump(keys, f, indent=2)
    
    print(f"[PUSH] Generated new VAPID keys, saved to {VAPID_FILE} and {VAPID_PRIVATE_FILE}")
    return keys


def get_public_key():
    """Get the public VAPID key for frontend subscription."""
    keys = get_vapid_keys()
    return keys.get('applicationServerKey', '')


def load_subscriptions():
    """Load push subscriptions from file."""
    ensure_data_dir()
    
    if SUBSCRIPTIONS_FILE.exists():
        try:
            with open(SUBSCRIPTIONS_FILE, 'r') as f:
                return json.load(f)
        except json.JSONDecodeError:
            return []
    return []


def save_subscriptions(subscriptions):
    """Save push subscriptions to file."""
    ensure_data_dir()
    
    with open(SUBSCRIPTIONS_FILE, 'w') as f:
        json.dump(subscriptions, f, indent=2)


def add_subscription(subscription_info):
    """Add a new push subscription."""
    subscriptions = load_subscriptions()
    
    # Check if already exists (by endpoint)
    endpoint = subscription_info.get('endpoint', '')
    for sub in subscriptions:
        if sub.get('endpoint') == endpoint:
            # Update existing
            sub.update(subscription_info)
            save_subscriptions(subscriptions)
            print(f"[PUSH] Updated existing subscription")
            return True
    
    # Add new
    subscriptions.append(subscription_info)
    save_subscriptions(subscriptions)
    print(f"[PUSH] Added new subscription (total: {len(subscriptions)})")
    return True


def remove_subscription(endpoint):
    """Remove a push subscription by endpoint."""
    subscriptions = load_subscriptions()
    original_count = len(subscriptions)
    subscriptions = [s for s in subscriptions if s.get('endpoint') != endpoint]
    
    if len(subscriptions) < original_count:
        save_subscriptions(subscriptions)
        print(f"[PUSH] Removed subscription (remaining: {len(subscriptions)})")
        return True
    return False


def send_push_notification(title, body, tag=None):
    """Send push notification to all subscribed clients."""
    keys = get_vapid_keys()
    subscriptions = load_subscriptions()
    
    if not subscriptions:
        return 0
    
    payload = json.dumps({
        'title': title,
        'body': body,
        'tag': tag or 'smart-tent-alert',
        'icon': '/icon.png',
        'badge': '/badge.svg'
    })
    
    success_count = 0
    failed_endpoints = []
    
    # Use the file path for the private key
    private_key_path = keys.get('private_key_path')
    if not private_key_path or not os.path.exists(private_key_path):
        # Fallback to regenerating if file missing
        print("[PUSH] Private key file missing, regenerating...")
        keys = get_vapid_keys()
        private_key_path = keys.get('private_key_path')

    for sub in subscriptions:
        try:
            webpush(
                subscription_info=sub,
                data=payload,
                vapid_private_key=private_key_path,
                vapid_claims=VAPID_CLAIMS
            )
            success_count += 1
        except WebPushException as e:
            print(f"[PUSH] Failed to send: {e}")
            # If subscription is invalid (410 Gone), mark for removal
            if e.response and e.response.status_code in (404, 410):
                failed_endpoints.append(sub.get('endpoint'))
        except Exception as e:
            print(f"[PUSH] Error: {e}")
    
    # Clean up invalid subscriptions
    if failed_endpoints:
        for endpoint in failed_endpoints:
            remove_subscription(endpoint)
    
    if success_count > 0:
        print(f"[PUSH] Sent '{title}' to {success_count} devices")
    
    return success_count
