"""Temperature sensor device interface for ESP32 DS18B20 sensors."""
import os
import requests
from datetime import datetime


class TempDevice:
    """Interface for ESP32 temperature monitoring device."""
    
    def __init__(self):
        # Use same ESP32 as fan controller
        self.ip = os.getenv('ESP32_FAN_IP', '192.168.1.50')
        self.timeout = 3
    
    def get_status(self):
        """Get current temperature readings from all sensors."""
        try:
            response = requests.get(
                f'http://{self.ip}/status',
                timeout=self.timeout
            )
            if response.status_code == 200:
                data = response.json()
                return {
                    'available': True,
                    'device': 'ESP32 Temperature Monitor',
                    'sensor_count': data.get('sensor_count', 0),
                    'sensors': data.get('sensors', []),
                    'ip': self.ip
                }
        except Exception as e:
            print(f'[TEMP] Error getting status: {e}')
        
        return {
            'available': False,
            'error': 'ESP32 unavailable',
            'sensor_count': 0,
            'sensors': []
        }
    
    def detect_sensors(self):
        """Detect all sensors on the OneWire bus."""
        try:
            response = requests.get(
                f'http://{self.ip}/detect',
                timeout=self.timeout
            )
            if response.status_code == 200:
                data = response.json()
                return {
                    'success': True,
                    'sensors': data.get('sensors', [])
                }
        except Exception as e:
            print(f'[TEMP] Error detecting sensors: {e}')
        
        return {
            'success': False,
            'error': 'Failed to detect sensors',
            'sensors': []
        }
    
    def set_name(self, address, name):
        """Set sensor name."""
        try:
            response = requests.post(
                f"{self._get_base_url()}/name",
                json={'address': address, 'name': name},
                timeout=self.timeout
            )
            response.raise_for_status()
            return response.json()
        except Exception as e:
            print(f"[TEMP] Error setting sensor name: {e}")
            return {'success': False, 'error': str(e)}
    
    def set_pin(self, pin, auth_code='4444'):
        """Set OneWire bus pin (requires ESP32 restart to take effect)."""
        try:
            import hashlib
            auth_hash = hashlib.sha256(auth_code.encode()).hexdigest()
            
            response = requests.post(
                f"{self._get_base_url()}/temp_pin",
                json={'pin': pin, 'auth_hash': auth_hash},
                timeout=self.timeout
            )
            response.raise_for_status()
            return response.json()
        except Exception as e:
            print(f"[TEMP] Error setting pin: {e}")
            return {'success': False, 'error': str(e)}


# Global instance
_temp_device = None

def get_temp_device():
    """Get the global TempDevice instance."""
    global _temp_device
    if _temp_device is None:
        _temp_device = TempDevice()
    return _temp_device

def get_temp_status():
    """Get temperature sensor status."""
    return get_temp_device().get_status()
