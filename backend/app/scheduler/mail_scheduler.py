# main.py
from fastapi import FastAPI
import datetime, os, json
import requests
import sys

from google.cloud import firestore
from mail_sender import send_email

# Add parent directory to path to import reminder_mail_template
parent_dir = os.path.join(os.path.dirname(__file__), '..')
if parent_dir not in sys.path:
    sys.path.insert(0, parent_dir)
from assets.reminder_mail_template import get_reminder_mail_template

app = FastAPI()
db = firestore.Client()

# Your own backend URL (Cloud Run URL or localhost while testing)
BACKEND_BASE_URL = os.getenv("BACKEND_BASE_URL", "http://localhost:8000")


# -----------------------------
# Helper Functions
# -----------------------------
def to_utc(date_str: str, time_str: str):
    """
    Convert "2025-03-14" and "01:30:00Z" into a UTC datetime object.
    """
    iso = f"{date_str}T{time_str}".replace("Z", "+00:00")
    return datetime.datetime.fromisoformat(iso).astimezone(datetime.timezone.utc)


def should_notify(event_start_utc):
    """
    Returns True only if event is 0 < time <= 1 hour from now.
    """
    now = datetime.datetime.now(datetime.timezone.utc)
    delta = (event_start_utc - now).total_seconds()
    return 0 < delta <= 3600  # event in next 60 min


def already_sent(event_id, session_name):
    doc_id = f"{event_id}__{session_name}"
    doc = db.collection("notifications").document(doc_id).get()
    return doc.exists


def mark_sent(event_id, session_name):
    doc_id = f"{event_id}__{session_name}"
    db.collection("notifications").document(doc_id).set({
        "sent_at": datetime.datetime.utcnow().isoformat()
    })


# ----------------------------------------
# Convert Ergast race object -> session list
# ----------------------------------------
def extract_sessions(race):
    sessions = []

    possible_sessions = {
        "FirstPractice": "Practice 1",
        "SecondPractice": "Practice 2",
        "ThirdPractice": "Practice 3",
        "Qualifying": "Qualifying",
        "Sprint": "Sprint",
        "SprintQualifying": "Sprint Qualifying",
        # Main race:
        "Race": "Race"
    }

    # Add Race manually to match Ergast fields
    race["Race"] = {"date": race["date"], "time": race["time"]}

    for key, display_name in possible_sessions.items():
        if key in race:
            s = race[key]
            sessions.append({
                "name": display_name,
                "utc_start": to_utc(s["date"], s["time"])
            })

    return sessions


# -----------------------------
# Main Event Checker
# -----------------------------
@app.get("/check-events")
def check_events():

    # Fetch all races with all fields
    try:
        url = f"{BACKEND_BASE_URL}/api/races?year=2025&fields=races"
        response = requests.get(url, timeout=10)
        data = response.json()
    except Exception as e:
        return {"error": "Failed to fetch races", "message": str(e)}

    races = data.get("races", [])
    sent_notifications = []

    for race in races:
        event_id = f"{race.get('season')}_{race.get('round')}"
        event_name = race.get("raceName", "")

        user_email = os.getenv("USER_EMAIL")  # Your recipient / DB lookup

        # Convert Ergast into sessions
        sessions = extract_sessions(race)

        for session in sessions:
            session_name = session["name"]
            session_start = session["utc_start"]

            if should_notify(session_start) and not already_sent(event_id, session_name):
                # Extract country from race data
                circuit = race.get("Circuit", {})
                location = circuit.get("Location", {})
                country = location.get("country", "Unknown")
                
                # Convert UTC datetime to IST (UTC+5:30)
                ist_timezone = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
                session_start_ist = session_start.astimezone(ist_timezone)
                
                # Default session duration (in minutes)
                # Typical durations: Practice 60-90, Qualifying 60, Race 90-120, Sprint 30
                session_durations = {
                    "Practice 1": 60,
                    "Practice 2": 60,
                    "Practice 3": 60,
                    "Qualifying": 60,
                    "Sprint Qualifying": 60,
                    "Sprint": 30,
                    "Race": 90
                }
                session_duration = session_durations.get(session_name, 60)
                
                # Generate HTML using the template
                html = get_reminder_mail_template(
                    timing="1 Hour",
                    grand_prix_name=event_name,
                    grand_prix_country=country,
                    session_type=session_name,
                    session_duration=session_duration,
                    session_datetime=session_start_ist
                )
                
                subject = f"F1 Reminder — {event_name} — {session_name} in 1 hour"

                if send_email(user_email, subject, html):
                    mark_sent(event_id, session_name)
                    sent_notifications.append({
                        "event": event_name,
                        "session": session_name
                    })

    return {
        "races_checked": len(races),
        "notifications_sent": sent_notifications
    }
