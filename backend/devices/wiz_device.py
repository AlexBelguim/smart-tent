"""Wiz Smart Socket integration for grow lights and heater."""
import asyncio
from datetime import datetime
from typing import Optional
import os

try:
    from pywizlight import wizlight, PilotBuilder
    WIZ_AVAILABLE = True
except ImportError:
    WIZ_AVAILABLE = False


class WizDevice:
    """Interface for Wiz smart socket/light."""
    
    def __init__(self, ip_address: Optional[str] = None, device_name: str = 'Wiz Device'):
        self.ip = ip_address
        self.device_name = device_name
        self.last_state: Optional[bool] = None
        self.on_since: Optional[datetime] = None
        
    async def _get_status_async(self) -> dict:
        """Async implementation of get_status."""
        if not WIZ_AVAILABLE:
            return {
                'available': False,
                'error': 'pywizlight not installed',
                'device': self.device_name
            }
            
        if not self.ip:
            return {
                'available': False,
                'error': f'{self.device_name} IP not configured',
                'device': self.device_name
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
                'device': self.device_name,
                'is_on': is_on,
                'brightness': brightness,
                'uptime_seconds': uptime_seconds,
                'ip': self.ip
            }
            
        except Exception as e:
            return {
                'available': False,
                'device': self.device_name,
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
    
    async def _turn_on_async(self) -> dict:
        """Turn ON the Wiz socket."""
        if not WIZ_AVAILABLE or not self.ip:
            return {'success': False, 'error': 'Not available'}
        light = None
        try:
            light = wizlight(self.ip)
            await light.turn_on(PilotBuilder())
            self.last_state = True
            if self.on_since is None:
                self.on_since = datetime.now()
            return {'success': True}
        except Exception as e:
            return {'success': False, 'error': str(e)}
        finally:
            if light is not None:
                try:
                    await light.async_close()
                except:
                    pass

    async def _turn_off_async(self) -> dict:
        """Turn OFF the Wiz socket."""
        if not WIZ_AVAILABLE or not self.ip:
            return {'success': False, 'error': 'Not available'}
        light = None
        try:
            light = wizlight(self.ip)
            await light.turn_off()
            self.last_state = False
            self.on_since = None
            return {'success': True}
        except Exception as e:
            return {'success': False, 'error': str(e)}
        finally:
            if light is not None:
                try:
                    await light.async_close()
                except:
                    pass
    
    def get_status(self) -> dict:
        """Synchronous wrapper for getting Wiz status."""
        try:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                return loop.run_until_complete(self._get_status_async())
            finally:
                loop.close()
        except Exception as e:
            return {
                'available': False,
                'device': self.device_name,
                'error': f'[WIZ] {str(e)}',
                'ip': self.ip
            }

    def turn_on(self) -> dict:
        """Synchronous wrapper for turning ON."""
        try:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                return loop.run_until_complete(self._turn_on_async())
            finally:
                loop.close()
        except Exception as e:
            return {'success': False, 'error': str(e)}

    def turn_off(self) -> dict:
        """Synchronous wrapper for turning OFF."""
        try:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                return loop.run_until_complete(self._turn_off_async())
            finally:
                loop.close()
        except Exception as e:
            return {'success': False, 'error': str(e)}


# Singleton instances
_wiz_light_instance: Optional[WizDevice] = None
_wiz_heater_instance: Optional[WizDevice] = None

def get_wiz_status(ip_address: Optional[str] = None) -> dict:
    """Get Wiz grow light status with persistent uptime tracking."""
    global _wiz_light_instance
    if _wiz_light_instance is None:
        _wiz_light_instance = WizDevice(
            ip_address or os.getenv('WIZ_LIGHT_IP'),
            'Wiz Grow Light'
        )
    return _wiz_light_instance.get_status()

def get_wiz_light_device() -> WizDevice:
    """Get the singleton Wiz grow light device instance."""
    global _wiz_light_instance
    if _wiz_light_instance is None:
        _wiz_light_instance = WizDevice(
            os.getenv('WIZ_LIGHT_IP'),
            'Wiz Grow Light'
        )
    return _wiz_light_instance

def get_wiz_heater_status() -> dict:
    """Get Wiz heater socket status."""
    global _wiz_heater_instance
    if _wiz_heater_instance is None:
        _wiz_heater_instance = WizDevice(
            os.getenv('WIZ_HEATER_IP'),
            'Wiz Heater'
        )
    return _wiz_heater_instance.get_status()

def get_wiz_heater_device() -> WizDevice:
    """Get the singleton Wiz heater device instance."""
    global _wiz_heater_instance
    if _wiz_heater_instance is None:
        _wiz_heater_instance = WizDevice(
            os.getenv('WIZ_HEATER_IP'),
            'Wiz Heater'
        )
    return _wiz_heater_instance

