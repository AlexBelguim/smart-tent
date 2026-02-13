import asyncio
import os
import json
from datetime import date, datetime
from dateutil.relativedelta import relativedelta
from tapo import ApiClient
from tapo.requests import EnergyDataInterval

# Load env vars manually or assume they are set
if os.path.exists('.env'):
    with open('.env', 'r') as f:
        for line in f:
            if '=' in line and not line.startswith('#'):
                key, val = line.strip().split('=', 1)
                os.environ[key] = val

EMAIL = os.getenv('TAPO_EMAIL')
PASSWORD = os.getenv('TAPO_PASSWORD')
IP = os.getenv('TAPO_DEVICE_IP')
KWH_PRICE = float(os.getenv('KWH_PRICE', '0.25'))

HISTORY_FILE = 'backend/energy_history.json'

async def main():
    if not EMAIL or not PASSWORD or not IP:
        print("Error: Missing TAPO_EMAIL, TAPO_PASSWORD, or TAPO_DEVICE_IP in .env")
        return

    print(f"Connecting to Tapo P110 at {IP}...")
    client = ApiClient(EMAIL, PASSWORD)
    device = await client.p110(IP)

    # Load existing history
    all_history = {}
    if os.path.exists(HISTORY_FILE):
        try:
            with open(HISTORY_FILE, 'r') as f:
                data = json.load(f)
                all_history = data.get('all_history', {})
                print(f"Loaded {len(all_history)} existing daily records.")
        except Exception as e:
            print(f"Error loading existing history: {e}")

    # Fetch last 12 months
    today = date.today()
    
    # We want to go back 12 months
    for i in range(13):
        target_date = today - relativedelta(months=i)
        # Use 1st of month to ensure we get the whole month (though API handles any date in month usually)
        query_date = date(target_date.year, target_date.month, 1)
        
        print(f"Fetching data for {query_date.strftime('%Y-%m')}...", end=" ")
        
        try:
            result = await device.get_energy_data(EnergyDataInterval.Daily, query_date)
            
            month_count = 0
            
            # Try structured entries first
            entries = getattr(result, 'entries', [])
            if entries:
                for entry in entries:
                    # UPDATED: Use confirmed attributes
                    dt = getattr(entry, 'start_date_time', None) or getattr(entry, 'local_date', None) or getattr(entry, 'date', None)
                    energy_wh = getattr(entry, 'energy', 0)
                    
                    if dt:
                        # dt is likely a datetime or date object
                        # Fix for timezone offset: 23:00 UTC previous day -> 00:00 Local correct day
                        if hasattr(dt, 'astimezone'):
                            dt_date = dt.astimezone().date()
                        elif hasattr(dt, 'date'):
                            dt_date = dt.date()
                        else:
                            dt_date = dt
                            
                        date_str = dt_date.isoformat()
                        kwh = round(energy_wh / 1000, 3)
                        
                        # Only update if new or value is higher (to respect our local rollover protection)
                        current_val = all_history.get(date_str, {}).get('kwh', -1)
                        if kwh > current_val:
                            all_history[date_str] = {
                                'kwh': kwh,
                                'cost': round(kwh * KWH_PRICE, 2)
                            }
                            month_count += 1
            
            # Fallback: raw integer array data
            elif hasattr(result, 'data') and result.data:
                start_of_month = date(query_date.year, query_date.month, 1)
                for day_idx, energy_wh in enumerate(result.data):
                    day_date = start_of_month + relativedelta(days=day_idx)
                    # Don't add future dates OR today (to avoid overwriting live accumulation)
                    if day_date >= today:
                        continue
                        
                    date_str = day_date.isoformat()
                    kwh = round(energy_wh / 1000, 3)
                    
                    # Store if > 0 (API returns 0 for future days in month too)
                    if kwh > 0 or day_date < today:
                        current_val = all_history.get(date_str, {}).get('kwh', -1)
                        if kwh > current_val:
                            all_history[date_str] = {
                                'kwh': kwh,
                                'cost': round(kwh * KWH_PRICE, 2)
                            }
                            month_count += 1
                            
            print(f"Found {month_count} records.")
            
        except Exception as e:
            print(f"Failed: {e}")

    # Save
    print(f"Saving total {len(all_history)} records to {HISTORY_FILE}...")
    try:
        # Sort for clean file
        sorted_history = dict(sorted(all_history.items()))
        
        with open(HISTORY_FILE, 'w') as f:
            json.dump({
                'updated': datetime.now().isoformat(),
                'all_history': sorted_history
            }, f, indent=2)
        print("Done!")
    except Exception as e:
        print(f"Error saving: {e}")

if __name__ == "__main__":
    asyncio.run(main())
