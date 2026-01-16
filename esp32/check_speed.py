#!/usr/bin/env python3
import requests
import sys
import os

# Try to find .env in parent directory to load default IP
def get_default_ip():
    try:
        env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '.env')
        if os.path.exists(env_path):
            with open(env_path, 'r') as f:
                for line in f:
                    if line.startswith('ESP32_FAN_IP='):
                        return line.split('=')[1].strip()
    except:
        pass
    return None

def check_speed(ip):
    try:
        url = f"http://{ip}/status"
        print(f"Querying {url}...")
        response = requests.get(url, timeout=5)
        response.raise_for_status()
        data = response.json()
        
        print("-" * 30)
        print(f"FAN STATUS ({ip})")
        print("-" * 30)
        print(f"Speed: {data.get('speed', '?')}%")
        print(f"RSSI:  {data.get('rssi', '?')} dBm")
        print(f"Uptime:{data.get('uptime', '?')} ms")
        print("-" * 30)
        
    except requests.exceptions.ConnectionError:
        print(f"Error: Could not connect to {ip}. Is the ESP32 powered on?")
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    ip = None
    
    # Check args
    if len(sys.argv) > 1:
        ip = sys.argv[1]
    
    # Check env if no arg
    if not ip:
        ip = get_default_ip()
        
    if not ip:
        print("Usage: python check_speed.py <ESP32_IP>")
        print("Or set ESP32_FAN_IP in ../.env")
        sys.exit(1)
        
    check_speed(ip)
