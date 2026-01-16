"""ESP32 PWM Fan Controller integration for Smart Tent Dashboard."""
import hashlib
import os
from typing import Optional
import requests


class FanDevice:
    """Interface for ESP32 PWM fan controller."""
    
    TIMEOUT = 5  # seconds
    
    def __init__(self, ip_address: Optional[str] = None, auth_code: Optional[str] = None):
        self.ip = ip_address or os.getenv('ESP32_FAN_IP')
        self._auth_code = auth_code or os.getenv('FAN_AUTH_CODE', '4444')
        
    def _get_auth_hash(self) -> str:
        """Generate SHA-256 hash of the auth code."""
        return hashlib.sha256(self._auth_code.encode()).hexdigest()
    
    def _get_base_url(self) -> str:
        """Get base URL for ESP32."""
        return f"http://{self.ip}"
    
    def get_status(self) -> dict:
        """Get current fan status from ESP32."""
        if not self.ip:
            return {
                'available': False,
                'error': 'ESP32_FAN_IP not configured',
                'device': 'PWM Fan'
            }
        
        try:
            response = requests.get(
                f"{self._get_base_url()}/status",
                timeout=self.TIMEOUT
            )
            response.raise_for_status()
            data = response.json()
            data['device'] = 'PWM Fan'
            # Add humidity override thresholds from env
            data['humidity_on'] = int(os.getenv('FAN_HUMIDITY_ON', 10))
            data['humidity_off'] = int(os.getenv('FAN_HUMIDITY_OFF', 5))
            return data
            
        except requests.Timeout:
            return {
                'available': False,
                'device': 'PWM Fan',
                'error': 'Connection timeout',
                'ip': self.ip
            }
        except requests.ConnectionError:
            return {
                'available': False,
                'device': 'PWM Fan',
                'error': 'Cannot connect to ESP32',
                'ip': self.ip
            }
        except Exception as e:
            return {
                'available': False,
                'device': 'PWM Fan',
                'error': f'[FAN] {str(e)}',
                'ip': self.ip
            }
    
    def set_speed(self, speed: int, code: Optional[str] = None) -> dict:
        """Set fan speed (0-100%)."""
        if not self.ip:
            return {'success': False, 'error': 'ESP32_FAN_IP not configured'}
        
        # Hash the provided code or use stored code
        auth_hash = hashlib.sha256((code or self._auth_code).encode()).hexdigest()
        
        try:
            response = requests.post(
                f"{self._get_base_url()}/speed",
                json={'speed': speed, 'auth_hash': auth_hash},
                timeout=self.TIMEOUT
            )
            
            if response.status_code == 403:
                return {'success': False, 'error': 'Invalid authentication code'}
            
            response.raise_for_status()
            return response.json()
            
        except requests.Timeout:
            return {'success': False, 'error': 'Connection timeout'}
        except requests.ConnectionError:
            return {'success': False, 'error': 'Cannot connect to ESP32'}
        except Exception as e:
            return {'success': False, 'error': str(e)}
    
    def get_schedule(self) -> dict:
        """Get schedule entries from ESP32."""
        if not self.ip:
            return {'success': False, 'error': 'ESP32_FAN_IP not configured'}
        
        try:
            response = requests.get(
                f"{self._get_base_url()}/schedule",
                timeout=self.TIMEOUT
            )
            response.raise_for_status()
            return response.json()
            
        except Exception as e:
            return {'success': False, 'error': str(e)}
    
    def set_schedule(self, schedules: list, code: Optional[str] = None) -> dict:
        """Set schedule entries on ESP32."""
        if not self.ip:
            return {'success': False, 'error': 'ESP32_FAN_IP not configured'}
        
        # Hash the provided code or use stored code
        auth_hash = hashlib.sha256((code or self._auth_code).encode()).hexdigest()
        
        try:
            response = requests.post(
                f"{self._get_base_url()}/schedule",
                json={'schedules': schedules, 'auth_hash': auth_hash},
                timeout=self.TIMEOUT
            )
            
            if response.status_code == 403:
                return {'success': False, 'error': 'Invalid authentication code'}
            
            response.raise_for_status()
            return response.json()
            
        except requests.Timeout:
            return {'success': False, 'error': 'Connection timeout'}
        except requests.ConnectionError:
            return {'success': False, 'error': 'Cannot connect to ESP32'}
        except Exception as e:
            return {'success': False, 'error': str(e)}
    
    def verify_auth(self, code: str) -> bool:
        """Verify authentication code with ESP32."""
        if not self.ip:
            return False
        
        auth_hash = hashlib.sha256(code.encode()).hexdigest()
        
        try:
            response = requests.post(
                f"{self._get_base_url()}/auth",
                json={'auth_hash': auth_hash},
                timeout=self.TIMEOUT
            )
            return response.status_code == 200
            
        except Exception:
            return False


# Singleton instance
_fan_instance: Optional[FanDevice] = None


def get_fan_status(ip_address: Optional[str] = None) -> dict:
    """Get fan status with singleton instance."""
    global _fan_instance
    if _fan_instance is None:
        _fan_instance = FanDevice(ip_address)
    return _fan_instance.get_status()


def get_fan_device() -> FanDevice:
    """Get the singleton FanDevice instance."""
    global _fan_instance
    if _fan_instance is None:
        _fan_instance = FanDevice()
    return _fan_instance
