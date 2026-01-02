"""Test Tapo energy data API with integers"""
import asyncio
import os
from dotenv import load_dotenv
from tapo import ApiClient
from datetime import date

load_dotenv()

async def test():
    email = os.getenv('TAPO_EMAIL')
    password = os.getenv('TAPO_PASSWORD')
    ip = os.getenv('TAPO_DEVICE_IP')
    
    client = ApiClient(email, password)
    device = await client.p110(ip)
    
    start = date(2025, 1, 1)
    
    # Try integers 0, 1, 2
    for interval in [0, 1, 2, 'Monthly']: # including string again just in case
        try:
            print(f"\nTrying interval={interval} ({type(interval)})...")
            energy_data = await device.get_energy_data(interval, start)
            print(f"Success with {interval}!")
            if hasattr(energy_data, 'data'):
                print(f"Data count: {len(energy_data.data)}")
            break
        except Exception as e:
            print(f"Error: {e}")

asyncio.run(test())
