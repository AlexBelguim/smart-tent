"""Wiz Smart Socket integration for grow lights."""
import asyncio
from datetime import datetime
from typing import Optional
import os

try:
    from pywizlight import wizlight
    WIZ_AVAILABLE = True
except ImportError:
    WIZ_AVAILABLE = False


class WizDevice:
    """Interface for Wiz smart socket/light."""
    
    def __init__(self, ip_address: Optional[str] = None):
        self.ip = ip_address or os.getenv('WIZ_LIGHT_IP')
        self.last_state: Optional[bool] = None
        self.on_since: Optional[datetime] = None
        
    async def _get_status_async(self) -> dict:
        """Async implementation of get_status."""
        if not WIZ_AVAILABLE:
            return {
                'available': False,
                'error': 'pywizlight not installed',
                'device': 'Wiz Grow Light'
            }
            
        if not self.ip:
            return {
                'available': False,
                'error': 'WIZ_LIGHT_IP not configured',
                'device': 'Wiz Grow Light'
            }
        
        light = None
        try:
            light = wizlight(self.ip)
            state = await light.updateState()
            
            is_on = state.get_state()
            brightness = state.get_brightness() if is_on else 0
            
            # Track when light turned on for uptime calculation
            if is_on and not self.last_state:
                self.on_since = datetime.now()
            elif not is_on:
                self.on_since = None
                
            self.last_state = is_on
            
            uptime_seconds = None
            if self.on_since:
                uptime_seconds = int((datetime.now() - self.on_since).total_seconds())
            
            return {
                'available': True,
                'device': 'Wiz Grow Light',
                'is_on': is_on,
                'brightness': brightness,
                'uptime_seconds': uptime_seconds,
                'ip': self.ip
            }
            
        except Exception as e:
            return {
                'available': False,
                'device': 'Wiz Grow Light',
                'error': f'[WIZ] {str(e)}',
                'ip': self.ip
            }
        finally:
            # Properly close the light connection to avoid event loop warnings
            if light is not None:
                try:
                    await light.async_close()
                except:
                    pass
    
    def get_status(self) -> dict:
        """Synchronous wrapper for getting Wiz status."""
        try:
            # Create a new event loop for each call to avoid "Event loop is closed" errors
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                return loop.run_until_complete(self._get_status_async())
            finally:
                loop.close()
        except Exception as e:
            return {
                'available': False,
                'device': 'Wiz Grow Light',
                'error': f'[WIZ] {str(e)}',
                'ip': self.ip
            }


# Singleton instance for uptime tracking
_wiz_instance: Optional[WizDevice] = None

def get_wiz_status(ip_address: Optional[str] = None) -> dict:
    """Get Wiz status with persistent uptime tracking."""
    global _wiz_instance
    if _wiz_instance is None:
        _wiz_instance = WizDevice(ip_address)
    return _wiz_instance.get_status()
