"""Setup change notes — persist dated annotations like 'added insulation' for comparison."""
import json
import os
import time
from datetime import datetime

NOTES_FILE = os.path.join(os.path.dirname(__file__), 'setup_notes.json')


def load_notes():
    """Load all setup change notes."""
    if os.path.exists(NOTES_FILE):
        try:
            with open(NOTES_FILE, 'r') as f:
                return json.load(f)
        except Exception as e:
            print(f"[NOTES] Error loading: {e}")
    return []


def save_notes(notes):
    """Save notes list to file."""
    try:
        with open(NOTES_FILE, 'w') as f:
            json.dump(notes, f, indent=2)
    except Exception as e:
        print(f"[NOTES] Error saving: {e}")


def get_notes():
    """Return all notes sorted by date."""
    notes = load_notes()
    notes.sort(key=lambda n: n.get('date', ''))
    return notes


def add_note(date_str, text):
    """Add a new setup change note. Returns the new note with id."""
    notes = load_notes()
    note = {
        'id': int(time.time() * 1000),
        'date': date_str,
        'text': text,
        'created': datetime.now().isoformat()
    }
    notes.append(note)
    save_notes(notes)
    return note


def delete_note(note_id):
    """Delete a note by its id. Returns True if found and deleted."""
    notes = load_notes()
    original_len = len(notes)
    notes = [n for n in notes if n.get('id') != note_id]
    if len(notes) < original_len:
        save_notes(notes)
        return True
    return False
