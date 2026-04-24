from datetime import datetime, timedelta
import schedule
from mail_sender import send_email


def set_reminder(event_time_str, reminder_value, html_content, to_email, subject, reminder_unit='minutes'):
    """
    Schedule a one-off reminder for an event today.

    Parameters
    - `event_time_str` (str): event time in "%H:%M" (24h) format.
    - `reminder_value` (int): numeric amount of lead time. For backward compatibility
      this was previously minutes when passed positionally.
    - `reminder_unit` (str): unit for `reminder_value`: one of
      'minutes'|'mins'|'min'|'hours'|'hrs'|'hr'|'hour'. Default is 'minutes'.

    Legacy callers that pass an integer as the second positional argument
    will continue to be interpreted as minutes.

    Examples:
    - Legacy: `set_reminder("14:30", 30, html, "a@b.com", "Subject")` (30 minutes)
    - Hours:  `set_reminder("14:30", 2, html, "a@b.com", "Subject", reminder_unit='hours')`
    """

    # parse event time (HH:MM)
    event_time = datetime.strptime(event_time_str, "%H:%M")

    now = datetime.now()
    event_today = now.replace(hour=event_time.hour, minute=event_time.minute, second=0, microsecond=0)

    # Normalize unit and map to timedelta args
    unit = (reminder_unit or 'minutes').strip().lower()
    minutes_units = {'minutes', 'minute', 'mins', 'min'}
    hours_units = {'hours', 'hour', 'hrs', 'hr'}

    try:
        value = int(reminder_value) if reminder_value is not None else 0
    except (TypeError, ValueError):
        # fallback: treat invalid value as 0
        value = 0

    if unit in minutes_units:
        reminder_time = event_today - timedelta(minutes=value)
    elif unit in hours_units:
        reminder_time = event_today - timedelta(hours=value)
    else:
        # unknown unit: default to minutes
        reminder_time = event_today - timedelta(minutes=value)

    print(f"Event: {event_today}, Reminder: {reminder_time} (value={value}, unit='{unit}')")

    def check_and_send():
        now = datetime.now().replace(second=0, microsecond=0)
        if now == reminder_time:
            send_email(
                to_email=to_email,
                subject=subject,
                html_content=html_content
            )
            return schedule.CancelJob

    # Check every minute
    schedule.every(1).minutes.do(check_and_send)
