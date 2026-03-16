"""ESP32 EC and Water Sensor integration for Smart Tent Dashboard."""
import hashlib
import os
from typing import Optional
import requests

class ECDevice:
    """Interface for ESP32 EC and Water sensor."""
    
    TIMEOUT = 5  # seconds
    
    def __init__(self, ip_address: Optional[str] = None, auth_code: Optional[str] = None):
        self.ip = ip_address or os.getenv('ESP32_EC_IP')
        self._auth_code = auth_code or os.getenv('FAN_AUTH_CODE', '4444')
        
    def _get_base_url(self) -> str:
        """Get base URL for ESP32."""
        return f"http://{self.ip}"
    
    def get_status(self) -> dict:
        """Get current EC and water status from ESP32."""
        if not self.ip:
            return {
                'available': False,
                'error': 'ESP32_EC_IP not configured',
                'device': 'EC Sensor'
            }
        
        try:
            response = requests.get(
                f"{self._get_base_url()}/status",
                timeout=self.TIMEOUT
            )
            response.raise_for_status()
            data = response.json()
            data['device'] = 'EC Sensor'
            data['available'] = True
            return data
            
        except requests.Timeout:
            return {
                'available': False,
                'device': 'EC Sensor',
                'error': 'Connection timeout',
                'ip': self.ip
            }
        except requests.ConnectionError:
            return {
                'available': False,
                'device': 'EC Sensor',
                'error': 'Cannot connect to ESP32',
                'ip': self.ip
            }
        except Exception as e:
            return {
                'available': False,
                'device': 'EC Sensor',
                'error': f'[EC] {str(e)}',
                'ip': self.ip
            }
            
    def trigger_measurement(self) -> dict:
        """Trigger an on-demand 5-sample burst measurement on ESP32."""
        if not self.ip:
            return {'success': False, 'error': 'ESP32_EC_IP not configured'}
            
        try:
            # High timeout because 5 samples * 1sec delay = 5 seconds on ESP32
            response = requests.post(
                f"{self._get_base_url()}/measure",
                timeout=15 
            )
            response.raise_for_status()
            data = response.json()
            data['success'] = True
            return data
            
        except requests.Timeout:
            return {'success': False, 'error': 'Measurement timeout (took > 15s)'}
        except requests.ConnectionError:
            return {'success': False, 'error': 'Cannot connect to ESP32'}
        except Exception as e:
            return {'success': False, 'error': str(e)}
    
    def set_kfactor(self, kfactor: float, code: Optional[str] = None) -> dict:
        """Set K-Factor on ESP32."""
        if not self.ip:
            return {'success': False, 'error': 'ESP32_EC_IP not configured'}
        
        # Hash the provided code or use stored code
        auth_hash = hashlib.sha256((code or self._auth_code).encode()).hexdigest()
        
        try:
            response = requests.post(
                f"{self._get_base_url()}/kfactor",
                json={'kfactor': kfactor, 'auth_hash': auth_hash},
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
_ec_instance: Optional[ECDevice] = None

def get_ec_status(ip_address: Optional[str] = None) -> dict:
    """Get EC status with singleton instance."""
    global _ec_instance
    if _ec_instance is None:
        _ec_instance = ECDevice(ip_address)
    return _ec_instance.get_status()

def get_ec_device() -> ECDevice:
    """Get the singleton ECDevice instance."""
    global _ec_instance
    if _ec_instance is None:
        _ec_instance = ECDevice()
    return _ec_instance
