# mail_sender.py
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
import os
import time
import logging

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

EMAIL = os.getenv("SMTP_EMAIL")           # put in Secret Manager / env
EMAIL_PASSWORD = os.getenv("SMTP_PASS")   # app password (Gmail) or SMTP password
SMTP_HOST = os.getenv("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.getenv("SMTP_PORT", 465))

def send_email(to_email, subject, html_content, max_retries=3, retry_delay=5):
    msg = MIMEMultipart("alternative")
    msg["From"] = EMAIL
    msg["To"] = to_email
    msg["Subject"] = subject
    msg.attach(MIMEText(html_content, "html"))

    attempt = 0
    while attempt < max_retries:
        try:
            with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, timeout=20) as server:
                server.login(EMAIL, EMAIL_PASSWORD)
                server.sendmail(EMAIL, to_email, msg.as_string())
            logger.info("📧 Email sent to %s", to_email)
            return True
        except Exception as e:
            attempt += 1
            logger.exception("Failed to send email (attempt %d/%d): %s", attempt, max_retries, e)
            time.sleep(retry_delay)
    return False
