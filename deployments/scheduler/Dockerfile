# Use lightweight Python image
FROM python:3.11-slim

# Install system dependencies if needed
RUN apt-get update && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

# Set working directory inside container
WORKDIR /app

# Copy requirements and install
COPY backend/app/scheduler/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy scheduler code (maintain directory structure for imports)
COPY backend/app/scheduler ./scheduler
COPY backend/app/mail_sender.py .
COPY backend/app/assets ./assets

# Disable output buffering (useful for logs in Cloud Run)
ENV PYTHONUNBUFFERED=1

# Run the scheduler script
CMD ["python", "scheduler/mail_scheduler.py"]

