"""Dreo Humidifier integration using pydreo-cloud."""
from datetime import datetime
from typing import Optional
import os

# Try to import the pydreo-cloud package
DREO_AVAILABLE = False
DreoClientClass = None

try:
    from pydreo.client import DreoClient
    import pydreo.helpers
    
    # Aggressively patch for EU region support
    # Dreo Cloud defaults to US. We force EU URL.
    eu_url = "https://open-api-eu.dreo-tech.com"
    pydreo.helpers.BASE_URL = eu_url
    pydreo.helpers.US_BASE_URL = eu_url  # Just in case it's aliased
    print(f"[DREO] Patched API URL to: {eu_url}")
    
    DreoClientClass = DreoClient
    DREO_AVAILABLE = True
except ImportError:
    pass


class DreoDevice:
    """Interface for Dreo smart humidifier."""
    
    def __init__(self, email: Optional[str] = None, password: Optional[str] = None):
        self.email = email or os.getenv('DREO_EMAIL')
        self.password = password or os.getenv('DREO_PASSWORD')
        self.last_state: Optional[bool] = None
        self.on_since: Optional[datetime] = None
        self._client = None
        
    def get_status(self) -> dict:
        """Get current status of the Dreo humidifier."""
        if not DREO_AVAILABLE:
            return {
                'available': False,
                'error': 'pydreo-cloud not installed. Run: pip install pydreo-cloud',
                'device': 'Dreo Humidifier'
            }
            
        if not self.email or not self.password:
            return {
                'available': False,
                'error': 'DREO_EMAIL or DREO_PASSWORD not configured in .env',
                'device': 'Dreo Humidifier'
            }
        
        try:
            # Initialize client and login
            # Dreo (EU) requires password to be MD5 hashed
            import hashlib
            hashed_pw = hashlib.md5(self.password.encode('utf-8')).hexdigest()
            # print(f"[DREO] Using MD5 hashed password for EU auth")
            
            client = DreoClientClass(self.email, hashed_pw)
            login_response = client.login()
            
            # Get devices list
            devices = client.get_devices()
            
            if not devices:
                return {
                    'available': False,
                    'device': 'Dreo Humidifier',
                    'error': 'No devices found in Dreo account'
                }
            
            # Find a humidifier device
            device = None
            for d in devices:
                if isinstance(d, dict):
                     # Check type via various keys found in debug dump
                    if d.get('deviceType') == 'humidifier' or d.get('deviceName') == 'Humidifier':
                        device = d
                        break
                else:
                    try:
                        if getattr(d, 'type', '') == 'humidifier':
                            device = d
                            break
                    except: pass
            
            if not device and devices:
                device = devices[0]
            
            if not device:
                 # Logic to return error
                 return {
                    'available': False,
                    'device': 'Dreo Humidifier',
                    'error': 'No humidifier found'
                }

            # Parse dictionary state
            if isinstance(device, dict):
                state = device.get('state', {})
                is_on = state.get('power_switch', False)
                current_humidity = state.get('humidity_sensor')
                mode = state.get('mode')
                water_tank_empty = state.get('water_tank_empty', False)
                
                # Check for explicit working/misting state from API
                is_working = state.get('working', state.get('misting', None))
                
                target_humidity = state.get('rh_auto')
                if mode == 'Sleep':
                    target_humidity = state.get('rh_sleep')
                elif mode == 'Manual':
                    target_humidity = None 
                
                # If no explicit working state, infer from humidity vs target
                # Device is "working" if powered on AND (manual mode OR below target humidity)
                if is_working is None and is_on:
                    if mode == 'Manual':
                        # Manual mode - assume working if powered on
                        is_working = True
                    elif target_humidity is not None and current_humidity is not None:
                        # Auto/Sleep mode - working if current < target
                        is_working = current_humidity < target_humidity
                    else:
                        # Can't determine, fall back to power state
                        is_working = is_on
                elif is_working is None:
                    is_working = False
                    
            else:
                # Fallback
                is_on = False
                is_working = False
                current_humidity = None
                target_humidity = None
                mode = None
                water_tank_empty = False

            # Track uptime
            if is_on and not self.last_state:
                self.on_since = datetime.now()
            elif not is_on:
                self.on_since = None
            
            self.last_state = is_on
            
            uptime_seconds = None
            if is_on and self.on_since:
                uptime_seconds = int((datetime.now() - self.on_since).total_seconds())

            return {
                'available': True,
                'is_on': is_on,
                'is_working': is_working,  # True if actively misting
                'current_humidity': current_humidity,
                'target_humidity': target_humidity,
                'mode': mode,
                'water_tank_empty': water_tank_empty,
                'uptime_seconds': uptime_seconds
            }
            
            # Track when turned on for uptime calculation
            if is_on and not self.last_state:
                self.on_since = datetime.now()
            elif not is_on:
                self.on_since = None
                
            self.last_state = is_on
            
            uptime_seconds = None
            if self.on_since:
                uptime_seconds = int((datetime.now() - self.on_since).total_seconds())
            
            result = {
                'available': True,
                'device': 'Dreo Humidifier',
                'name': device_name,
                'is_on': is_on,
                'uptime_seconds': uptime_seconds
            }
            
            # Try to get additional attributes if available
            if 'humidity' in device:
                result['humidity'] = device['humidity']
            if 'targetHumidity' in device:
                result['target_humidity'] = device['targetHumidity']
            if 'mode' in device:
                result['mode'] = device['mode']
            if 'waterTankEmpty' in device or 'water_tank_empty' in device:
                result['water_tank_empty'] = device.get('waterTankEmpty', device.get('water_tank_empty', False))
                
            return result
            
        except Exception as e:
            error_msg = str(e)
            if 'password' in error_msg.lower() or 'auth' in error_msg.lower():
                print(f"[DREO] Authentication failed: {error_msg}")
            return {
                'available': False,
                'device': 'Dreo Humidifier',
                'error': f'[DREO] {error_msg}'
            }


# Singleton instance for uptime tracking
_dreo_instance: Optional[DreoDevice] = None

def get_dreo_status() -> dict:
    """Get Dreo humidifier status with persistent uptime tracking."""
    global _dreo_instance
    if _dreo_instance is None:
        _dreo_instance = DreoDevice()
    return _dreo_instance.get_status()
