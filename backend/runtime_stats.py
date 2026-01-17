import json
import os
import time
from collections import deque
from datetime import datetime, timedelta

HISTORY_FILE = 'runtime_history.json'
MAX_HISTORY_SECONDS = 7 * 24 * 3600  # 7 Days

class RuntimeTracker:
    def __init__(self):
        self.history = deque()  # Stores (timestamp, is_on)
        self.all_time = {
            'total_seconds': 0,
            'on_seconds': 0,
            'start_time': int(time.time())
        }
        self.load()

    def load(self):
        """Load history from file."""
        if os.path.exists(HISTORY_FILE):
            try:
                with open(HISTORY_FILE, 'r') as f:
                    data = json.load(f)
                    # Convert list back to deque
                    self.history = deque(data.get('history', []))
                    self.all_time = data.get('all_time', self.all_time)
                    print(f"[RUNTIME] Loaded history: {len(self.history)} samples")
            except Exception as e:
                print(f"[RUNTIME] Error loading history: {e}")

    def save(self):
        """Save history to file."""
        try:
            # Prune before saving to keep file size managed
            self.prune()
            with open(HISTORY_FILE, 'w') as f:
                json.dump({
                    'history': list(self.history),
                    'all_time': self.all_time
                }, f)
        except Exception as e:
            print(f"[RUNTIME] Error saving history: {e}")

    def prune(self):
        """Remove samples older than MAX_HISTORY_SECONDS."""
        now = time.time()
        cutoff = now - MAX_HISTORY_SECONDS
        
        # history is strictly chronological, so we can pop from left
        while self.history and self.history[0][0] < cutoff:
            self.history.popleft()

    def update(self, is_on):
        """Record a new sample."""
        now = int(time.time())
        
        # Update history
        self.history.append((now, is_on))
        
        # Update all-time cumulative
        # We assume this update happens every ~5 seconds (or whatever interval)
        # To be accurate, we should look at delta from last update?
        # But if we just count samples, we rely on consistent sampling.
        # Better: calculate delta from last sample if exists.
        
        delta = 0
        if len(self.history) > 1:
            # The current sample covers the time since the last sample?
            # Or simplified: if we are called every 5s, we add 5s?
            # Let's use time difference from previous sample to be robust against downtime.
            prev_time = self.history[-2][0]
            delta = now - prev_time
            
            # Cap delta to avoid huge jumps if server was off for a day counting as "off" or "on"
            # If server was off, we didn't track, so we shouldn't add to all_time total ideally,
            # OR we count it as "Off" time? User said "All Time".
            # Usually "All Time" means "Since monitoring started".
            # If server is off, we don't know state. Let's only count tracked time.
            if delta > 300: # 5 minutes gap -> consider gap (don't add to total)
                delta = 0
        
        if delta > 0:
            self.all_time['total_seconds'] += delta
            # If it WAS on during this interval?
            # We use the previous state to determine the interval's state
            prev_state = self.history[-2][1]
            if prev_state:
                self.all_time['on_seconds'] += delta

    def get_metrics(self):
        """Calculate Day, Week, and All-Time duty cycles."""
        now = time.time()
        
        def calculate_window(seconds):
            cutoff = now - seconds
            on_time = 0
            total_time = 0
            
            # Iterate history (newest to oldest is effectively reversed, but deque is indexable)
            # Efficient enough for 100k items in Python?
            # optimization: iterating a list of 100k items is fast (ms).
            
            for ts, state in self.history:
                if ts >= cutoff:
                    # simplistic: count each sample as covering the interval to the *next* sample?
                    # or just count points?
                    # Counting points is easier but assumes regular sampling.
                    # Let's count points and assume uniform distribution for rolling window approx.
                    total_time += 1
                    if state:
                        on_time += 1
            
            return (on_time / total_time * 100) if total_time > 0 else 0

        # Optimization: calculating window with accurate durations is better than point counting,
        # but point counting is "good enough" if sampling is 5s steady.
        # Let's stick to point counting for the rolling windows for simplicity/speed.
        
        day_pct = calculate_window(24 * 3600)
        week_pct = calculate_window(7 * 24 * 3600)
        
        all_time_pct = 0
        if self.all_time['total_seconds'] > 0:
             all_time_pct = (self.all_time['on_seconds'] / self.all_time['total_seconds']) * 100
             
        return {
            'day': round(day_pct, 1),
            'week': round(week_pct, 1),
            'all_time': round(all_time_pct, 1),
            'history_7d': self.get_daily_history(),
            'history_7w': self.get_weekly_history()
        }

    def get_weekly_history(self, weeks=7):
        """Calculate runtime percentage for the last N weeks."""
        history_data = []
        now = datetime.now()
        # Align to start of current week (Monday) or just rolling 7-day windows?
        # Rolling 7-day windows preferred for "Last 7 Weeks"
        
        # Buckets for each week
        buckets = {} # index -> {on: 0, total: 0, label: str}
        
        for i in range(weeks):
            # Week 0 is "Current Week" (last 7 days including today)
            # Week 1 is "Last Week" (days 7-13 ago)
            end_date = now - timedelta(days=i*7)
            start_date = end_date - timedelta(days=6) # 7 day window
            
            label = f"W{i}" # placeholder
            # Better label: Start Date
            label = start_date.strftime("%b %d")
            
            buckets[i] = {
                'on': 0, 
                'total': 0, 
                'start_ts': start_date.timestamp(),
                'end_ts': end_date.timestamp() + 86399, # End of day
                'label': label
            }

        # Iterate history once
        cutoff = buckets[weeks-1]['start_ts']
        
        for ts, state in self.history:
            if ts < cutoff:
                continue
                
            # Find which bucket this sample belongs to
            # Optimization: could calculate index directly?
            # index = floor((now_ts - ts) / (7*24*3600))
            
            diff = now.timestamp() - ts
            if diff < 0: continue 
            
            idx = int(diff // (7 * 24 * 3600))
            
            if idx in buckets:
                buckets[idx]['total'] += 1
                if state:
                    buckets[idx]['on'] += 1

        # Convert to list (reverse order: oldest to newest)
        for i in range(weeks - 1, -1, -1):
            b = buckets[i]
            pct = (b['on'] / b['total'] * 100) if b['total'] > 0 else 0
            history_data.append({
                'label': b['label'],
                'percent': round(pct, 1)
            })
            
        return history_data

    def get_daily_history(self, days=7):
        """Calculate runtime percentage for the last N days."""
        history_data = []
        now = datetime.now()
        today = now.date()
        
        # We need to reconstruct the timeline from samples
        # This is expensive to do every poll, but get_metrics is called every poll?
        # Maybe we should cache it or compute only on demand?
        # For now, let's just do it, but optimize if needed.
        # Actually, iterate samples one pass.
        
        # Buckets for each day
        buckets = {} # date -> {on: 0, total: 0}
        
        # Initialize buckets
        for i in range(days):
            d = today - timedelta(days=i)
            buckets[d] = {'on': 0, 'total': 0}
            
        cutoff = time.mktime((today - timedelta(days=days-1)).timetuple()) # Start of 7th day back
        
        for ts, state in self.history:
            if ts < cutoff:
                continue
                
            try:
                dt = datetime.fromtimestamp(ts).date()
                if dt in buckets:
                    buckets[dt]['total'] += 1
                    if state:
                        buckets[dt]['on'] += 1
            except Exception:
                pass
                
        # Convert to list
        for d in sorted(buckets.keys()):
            b = buckets[d]
            pct = (b['on'] / b['total'] * 100) if b['total'] > 0 else 0
            history_data.append({
                'date': d.isoformat(),
                'percent': round(pct, 1)
            })
            
        return history_data
