"""Test Tapo energy data API with Daily interval"""
import asyncio
import os
from dotenv import load_dotenv
from tapo import ApiClient
from tapo.requests import EnergyDataInterval
from datetime import date, timedelta

load_dotenv()

async def test():
    email = os.getenv('TAPO_EMAIL')
    password = os.getenv('TAPO_PASSWORD')
    ip = os.getenv('TAPO_DEVICE_IP')
    
    if not email or not password or not ip:
        print("Missing env vars")
        return

    print(f"Connecting to {ip}...")
    client = ApiClient(email, password)
    device = await client.p110(ip)
    
    today = date.today()
    start_date = today - timedelta(days=7)
    
    print(f"Fetching daily data from {start_date}...")
    
    try:
        energy_data = await device.get_energy_data(EnergyDataInterval.Daily, start_date)
        print(f"Result type: {type(energy_data)}")
        
        if hasattr(energy_data, 'entries'): # It seems to be 'data' in p110? or 'entries'? pydreo is confusing vs tapo.
             # Wait, the previous output showed 'entries' in dir()
             print(f"Entries: {energy_data.entries}")
        elif hasattr(energy_data, 'data'):
             print(f"Data: {energy_data.data}")
        else:
             print("No 'data' or 'entries' attribute found.")
             print(f"Dir: {dir(energy_data)}")

    except Exception as e:
        print(f"Error fetching daily data: {e}")

asyncio.run(test())
