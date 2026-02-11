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
        self.cached_history = []  # latest 7d for dashboard tiles
        self.all_history = {}     # date-keyed dict of ALL accumulated daily data
        self.load_history()
        
    def load_history(self):
        """Load cached history from file."""
        if os.path.exists(self.history_file):
            try:
                import json
                with open(self.history_file, 'r') as f:
                    data = json.load(f)
                    self.cached_history = data.get('history_7d', [])
                    # Load accumulated history (date -> {kwh, cost})
                    self.all_history = data.get('all_history', {})
                    # Migrate: if all_history is empty, seed from history_7d
                    if not self.all_history and self.cached_history:
                        for entry in self.cached_history:
                            self.all_history[entry['date']] = {
                                'kwh': entry['kwh'],
                                'cost': entry['cost']
                            }
            except Exception as e:
                print(f"[TAPO] Error loading history cache: {e}")

    def save_history(self, history):
        """Save history to file, merging new daily data into accumulated history."""
        try:
            import json
            # Merge new entries into all_history by date
            for entry in history:
                self.all_history[entry['date']] = {
                    'kwh': entry['kwh'],
                    'cost': entry['cost']
                }
            self._persist()
            self.cached_history = history
        except Exception as e:
            print(f"[TAPO] Error saving history cache: {e}")

    def record_daily(self, date_str, kwh, kwh_price):
        """Record a single day's energy data into the accumulated store."""
        self.all_history[date_str] = {
            'kwh': round(kwh, 3),
            'cost': round(kwh * kwh_price, 2)
        }
        self._persist()
    
    def _persist(self):
        """Write all_history to disk."""
        try:
            import json
            with open(self.history_file, 'w') as f:
                json.dump({
                    'updated': datetime.now().isoformat(),
                    'all_history': self.all_history
                }, f)
        except Exception as e:
            print(f"[TAPO] Error persisting history: {e}")

    def get_history_range(self, days=7):
        """Get daily history for the last N days from the accumulated store."""
        result = []
        for i in range(days):
            day = date.today() - relativedelta(days=days-1-i)
            day_str = day.isoformat()
            if day_str in self.all_history:
                result.append({
                    'date': day_str,
                    'kwh': self.all_history[day_str]['kwh'],
                    'cost': self.all_history[day_str]['cost']
                })
        return result

    def get_month_total(self, kwh_price=None):
        """Calculate current month's total from daily records."""
        month_prefix = date.today().strftime('%Y-%m')
        total_kwh = 0
        for day_str, data in self.all_history.items():
            if day_str.startswith(month_prefix):
                total_kwh += data['kwh']
        price = kwh_price or float(os.getenv('KWH_PRICE', '0.25'))
        return round(total_kwh, 3), round(total_kwh * price, 2)

    def get_year_total(self, kwh_price=None):
        """Calculate current year's total from daily records."""
        year_prefix = str(date.today().year)
        total_kwh = 0
        for day_str, data in self.all_history.items():
            if day_str.startswith(year_prefix):
                total_kwh += data['kwh']
        price = kwh_price or float(os.getenv('KWH_PRICE', '0.25'))
        return round(total_kwh, 3), round(total_kwh * price, 2)

    def get_monthly_breakdown(self, kwh_price=None):
        """Group daily data by month for the stats page chart."""
        from collections import defaultdict
        months = defaultdict(float)
        for day_str, data in self.all_history.items():
            month_key = day_str[:7]  # 'YYYY-MM'
            months[month_key] += data['kwh']
        
        price = kwh_price or float(os.getenv('KWH_PRICE', '0.25'))
        result = []
        for month_key in sorted(months.keys()):
            kwh = months[month_key]
            result.append({
                'month': month_key,
                'kwh': round(kwh, 3),
                'cost': round(kwh * price, 2)
            })
        return result

    def get_all_history(self):
        """Return full accumulated history sorted by date."""
        result = []
        for date_str, data in sorted(self.all_history.items()):
            result.append({
                'date': date_str,
                'kwh': data['kwh'],
                'cost': data['cost']
            })
        return result

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
            
            # Get price config from env
            kwh_price = float(os.getenv('KWH_PRICE', '0.25'))
            currency = os.getenv('CURRENCY_SYMBOL', '€')
            
            # Convert Wh to kWh (live API values)
            today_kwh = (energy_usage.today_energy / 1000) if hasattr(energy_usage, 'today_energy') else 0
            
            # Track when turned on for uptime calculation
            if is_on and not self.last_state:
                self.on_since = datetime.now()
            elif not is_on:
                self.on_since = None
                
            self.last_state = is_on
            
            uptime_seconds = None
            if self.on_since:
                uptime_seconds = int((datetime.now() - self.on_since).total_seconds())

            # --- Record today's live data into the daily store ---
            self.record_daily(date.today().isoformat(), today_kwh, kwh_price)
            
            # --- Try to backfill from API (best-effort, non-blocking) ---
            try:
                api_history = await self.get_daily_history(kwh_price)
                if api_history:
                    for entry in api_history:
                        if entry['date'] not in self.all_history:
                            self.all_history[entry['date']] = {
                                'kwh': entry['kwh'],
                                'cost': entry['cost']
                            }
                    self._persist()
            except Exception as e:
                print(f"[TAPO] Daily history backfill failed (non-critical): {e}")
            
            # Also try monthly API backfill to seed historical months
            try:
                year_start = date(datetime.now().year, 1, 1)
                energy_data = await device.get_energy_data(EnergyDataInterval.Monthly, year_start)
                if hasattr(energy_data, 'data') and energy_data.data:
                    print(f"[TAPO] Monthly API returned {len(energy_data.data)} months: {energy_data.data}")
                    # Backfill: for each month with data, spread it into a single "month-summary" entry
                    # This helps when we have no daily data for past months
                    for month_idx, month_wh in enumerate(energy_data.data):
                        if month_wh > 0:
                            month_date = year_start + relativedelta(months=month_idx)
                            # Use the 1st of each month as a summary entry if we have no daily data for that month
                            month_prefix = month_date.strftime('%Y-%m')
                            has_daily_data = any(d.startswith(month_prefix) for d in self.all_history)
                            if not has_daily_data:
                                summary_key = f"{month_prefix}-01"
                                month_kwh_val = month_wh / 1000
                                self.all_history[summary_key] = {
                                    'kwh': round(month_kwh_val, 3),
                                    'cost': round(month_kwh_val * kwh_price, 2)
                                }
                    self._persist()
            except Exception as e:
                print(f"[TAPO] Monthly backfill failed (non-critical): {e}")

            # --- All displayed values derived from daily store ---
            month_kwh, month_cost = self.get_month_total(kwh_price)
            year_kwh, year_cost = self.get_year_total(kwh_price)
            history_7d = self.get_history_range(7)
            monthly_history = self.get_monthly_breakdown(kwh_price)

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
                'today_cost': round(today_kwh * kwh_price, 2),
                'history_7d': history_7d,
                'monthly_history': monthly_history
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
            try:
                result = await device.get_energy_data(EnergyDataInterval.Daily, start_date)
            except Exception:
                return self.cached_history or []
                
            history = []
            
            # Try structured entries first (some library versions)
            entries = getattr(result, 'entries', [])
            if entries:
                for entry in entries:
                    # Try to_dict first
                    if hasattr(entry, 'to_dict'):
                        d = entry.to_dict()
                        dt = d.get('local_date')
                        energy_wh = d.get('energy', 0)
                    else:
                        dt = getattr(entry, 'local_date', None) or getattr(entry, 'date', None)
                        energy_wh = getattr(entry, 'energy', 0)
                    
                    if dt:
                        date_str = dt.isoformat() if hasattr(dt, 'isoformat') else str(dt)
                        kwh = energy_wh / 1000
                        history.append({
                            'date': date_str,
                            'kwh': round(kwh, 3),
                            'cost': round(kwh * kwh_price, 2)
                        })
            
            # Fallback: raw integer array in result.data (common format)
            if not history and hasattr(result, 'data') and result.data:
                for i, energy_wh in enumerate(result.data):
                    day_date = start_date + relativedelta(days=i)
                    kwh = energy_wh / 1000
                    history.append({
                        'date': day_date.isoformat(),
                        'kwh': round(kwh, 3),
                        'cost': round(kwh * kwh_price, 2)
                    })
            
            # Sort by date
            history.sort(key=lambda x: x['date'])
            
            # Save to cache (merges into accumulated history)
            if history:
                self.save_history(history)
                
            return history if history else (self.cached_history or [])
            
        except Exception as e:
            print(f"[TAPO] History fetch failed: {e}")
            return self.cached_history or []


# Singleton instance for uptime tracking
_tapo_instance: Optional[TapoDevice] = None

def get_tapo_status() -> dict:
    """Synchronous wrapper for getting Tapo status."""
    global _tapo_instance
    if _tapo_instance is None:
        _tapo_instance = TapoDevice()
    return asyncio.run(_tapo_instance.get_status())

def get_tapo_device() -> TapoDevice:
    """Get the Tapo device singleton instance."""
    global _tapo_instance
    if _tapo_instance is None:
        _tapo_instance = TapoDevice()
    return _tapo_instance
