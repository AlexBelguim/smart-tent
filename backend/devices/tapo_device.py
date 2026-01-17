"""Tapo P110 Smart Plug integration for energy monitoring."""
import asyncio
from datetime import datetime, date
from typing import Optional
import os

try:
    from tapo import ApiClient
    from tapo.requests import EnergyDataInterval
    from dateutil.relativedelta import relativedelta
    TAPO_AVAILABLE = True
except ImportError:
    TAPO_AVAILABLE = False


class TapoDevice:
    """Interface for Tapo P110 smart plug with energy monitoring."""
    
    def __init__(self, email: Optional[str] = None, password: Optional[str] = None, 
                 ip_address: Optional[str] = None):
        self.email = email or os.getenv('TAPO_EMAIL')
        self.password = password or os.getenv('TAPO_PASSWORD')
        self.ip = ip_address or os.getenv('TAPO_DEVICE_IP')
        self.last_state: Optional[bool] = None
        self.on_since: Optional[datetime] = None
        
        # Persistence
        self.history_file = 'energy_history.json'
        self.cached_history = []
        self.load_history()
        
    def load_history(self):
        """Load cached history from file."""
        if os.path.exists(self.history_file):
            try:
                import json
                with open(self.history_file, 'r') as f:
                    data = json.load(f)
                    self.cached_history = data.get('history_7d', [])
                    # print(f"[TAPO] Loaded {len(self.cached_history)} cached history entries")
            except Exception as e:
                print(f"[TAPO] Error loading history cache: {e}")

    def save_history(self, history):
        """Save history to file."""
        try:
            import json
            with open(self.history_file, 'w') as f:
                json.dump({
                    'updated': datetime.now().isoformat(),
                    'history_7d': history
                }, f)
            self.cached_history = history
        except Exception as e:
            print(f"[TAPO] Error saving history cache: {e}")

    async def get_status(self) -> dict:
        """Get current status and energy data from Tapo P110."""
        if not TAPO_AVAILABLE:
            return {
                'available': False,
                'error': 'python-tapo or dateutil not installed',
                'device': 'Tapo Energy Monitor'
            }
            
        if not self.email or not self.password:
            return {
                'available': False,
                'error': 'TAPO_EMAIL or TAPO_PASSWORD not configured',
                'device': 'Tapo Energy Monitor'
            }
            
        if not self.ip:
            return {
                'available': False,
                'error': 'TAPO_DEVICE_IP not configured',
                'device': 'Tapo Energy Monitor'
            }
        
        try:
            client = ApiClient(self.email, self.password)
            device = await client.p110(self.ip)
            
            # Get device info for on/off state
            device_info = await device.get_device_info()
            is_on = device_info.device_on
            
            # Get current power (returns watts directly)
            current_power_result = await device.get_current_power()
            current_power_w = current_power_result.current_power if hasattr(current_power_result, 'current_power') else 0
            
            # Get energy usage (today/month)
            energy_usage = await device.get_energy_usage()
            
            # Get yearly energy data - try rolling 12 months, fallback to current year
            year_kwh = 0
            
            async def fetch_year_data(start_date):
                try:
                    # Attempt 1: Standard call
                    try:
                        return await device.get_energy_data(EnergyDataInterval.Monthly, start_date)
                    except TypeError:
                        pass
                    # Attempt 2: Positional only
                    try:
                        return await device.get_energy_data(start_date)
                    except TypeError:
                        pass
                    # Attempt 3: Keyword args
                    return await device.get_energy_data(interval=EnergyDataInterval.Monthly, start_date=start_date)
                except Exception as e:
                    print(f"[TAPO] Fetch error for {start_date}: {e}")
                    return None

            try:
                # 1. Try Rolling 12 Months
                year_start = date.today() - relativedelta(months=12)
                year_start = date(year_start.year, year_start.month, 1)
                energy_data = await fetch_year_data(year_start)

                # 2. If empty, try Current Calendar Year (Jan 1)
                if not hasattr(energy_data, 'data') or not energy_data.data:
                    current_year_start = date(datetime.now().year, 1, 1)
                    if current_year_start != year_start:
                        # print(f"[TAPO] Rolling year empty, trying calendar year from {current_year_start}")
                        energy_data = await fetch_year_data(current_year_start)

                # Sum data if available
                if hasattr(energy_data, 'data') and energy_data.data:
                    year_kwh = sum(energy_data.data) / 1000
                    # print(f"[TAPO] Yearly data: {year_kwh:.2f} kWh")
                else:
                    # If still empty, use Monthly * 12 as rough estimate only if year_kwh is 0
                    print(f"[TAPO] No yearly data found. Object: {energy_data}")
            
            except Exception as e:
                print(f"[TAPO] Could not fetch yearly data: {e}")
                year_kwh = None
            
            
            # Track when turned on for uptime calculation
            if is_on and not self.last_state:
                self.on_since = datetime.now()
            elif not is_on:
                self.on_since = None
                
            self.last_state = is_on
            
            uptime_seconds = None
            if self.on_since:
                uptime_seconds = int((datetime.now() - self.on_since).total_seconds())
            # Get price config from env
            kwh_price = float(os.getenv('KWH_PRICE', '0.25'))
            currency = os.getenv('CURRENCY_SYMBOL', '€')
            
            # Convert Wh to kWh
            today_kwh = (energy_usage.today_energy / 1000) if hasattr(energy_usage, 'today_energy') else 0
            month_kwh = (energy_usage.month_energy / 1000) if hasattr(energy_usage, 'month_energy') else 0
            
            # Calculate yearly kWh - use actual data if available
            # If API returns 0 (no history), default to current month's usage (Year-to-Date)
            # instead of projecting (month * 12) which confuses users.
            if year_kwh is None or year_kwh == 0:
                if month_kwh > 0:
                    year_kwh = month_kwh
                    print(f"[TAPO] Using current month as yearly total (no history): {year_kwh:.2f}kWh")
                else:
                    year_kwh = 0
            
            # Calculate costs
            month_cost = month_kwh * kwh_price
            year_cost = year_kwh * kwh_price  # Price x yearly kWh
            
            # Debug output (concise)
            # print(f"[TAPO] Power: {current_power_w}W | Today: {today_kwh:.2f}kWh | Month: {month_kwh:.2f}kWh | Year: {year_kwh:.2f}kWh")
            
            return {
                'available': True,
                'device': 'Tapo Energy Monitor',
                'name': device_info.nickname if hasattr(device_info, 'nickname') else 'P110',
                'is_on': is_on,
                'ip': self.ip,
                # Energy data
                'current_power_w': current_power_w,
                'today_kwh': today_kwh,
                'month_kwh': month_kwh,
                'year_kwh': year_kwh,
                # Cost data
                'month_cost': month_cost,
                'year_cost': year_cost,
                'kwh_price': kwh_price,
                'currency': currency,
                'today_cost': today_kwh * kwh_price,
                'history_7d': await self.get_daily_history(kwh_price)
            }
            
        except Exception as e:
            error_msg = str(e)
            if 'password' in error_msg.lower() or 'auth' in error_msg.lower() or 'incorrect' in error_msg.lower():
                print(f"[TAPO] Authentication failed: {error_msg}")
            
            # Return cached data if available (fallback)
            return {
                'available': False,
                'device': 'Tapo Energy Monitor',
                'error': f'[TAPO] {error_msg}',
                'ip': self.ip,
                # Return cached history so UI isn't empty
                'history_7d': self.cached_history,
                'currency': os.getenv('CURRENCY_SYMBOL', '€')
            }

    async def get_daily_history(self, kwh_price):
        """Fetch last 7 days of energy data."""
        try:
            client = ApiClient(self.email, self.password)
            device = await client.p110(self.ip)
            
            end_date = date.today()
            start_date = end_date - relativedelta(days=6) # 7 days inclusive
            
            # Fetch Daily data
            # Note: library might return different structure for Daily
            # We use try/except to handle potential API differences
            try:
                result = await device.get_energy_data(EnergyDataInterval.Daily, start_date)
            except Exception:
                # Fallback or older version
                return []
                
            history = []
            
            # Helper to extract data from entry
            def get_entry_data(entry):
                # Try to_dict first
                if hasattr(entry, 'to_dict'):
                    d = entry.to_dict()
                    return d.get('local_date'), d.get('energy')
                # Attributes
                dt = getattr(entry, 'local_date', None) or getattr(entry, 'date', None)
                en = getattr(entry, 'energy', 0)
                return dt, en

            entries = getattr(result, 'entries', [])
            # specific fix for the library version if 'data' is used
            if not entries and hasattr(result, 'data'):
                entries = result.data

            for entry in entries:
                dt, energy_wh = get_entry_data(entry)
                if dt:
                    # Format date as YYYY-MM-DD
                    date_str = dt.isoformat() if hasattr(dt, 'isoformat') else str(dt)
                    kwh = energy_wh / 1000
                    history.append({
                        'date': date_str,
                        'kwh': round(kwh, 3),
                        'cost': round(kwh * kwh_price, 2)
                    })
            
            # Ensure we have entries for all days? 
            # The API usually returns what it has.
            # Sort by date
            history.sort(key=lambda x: x['date'])
            
            # Save to cache
            if history:
                self.save_history(history)
                
            return history
            
        except Exception as e:
            print(f"[TAPO] History fetch failed: {e}")
            # Return cached version
            return self.cached_history


# Singleton instance for uptime tracking
_tapo_instance: Optional[TapoDevice] = None

def get_tapo_status() -> dict:
    """Synchronous wrapper for getting Tapo status."""
    global _tapo_instance
    if _tapo_instance is None:
        _tapo_instance = TapoDevice()
    return asyncio.run(_tapo_instance.get_status())
