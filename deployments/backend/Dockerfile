# Use lightweight Python image
FROM python:3.11-slim

# Install system dependencies if needed
RUN apt-get update && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

# Set working directory inside container
WORKDIR /app

# Copy requirements and install
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend app code
COPY backend/app ./app

# Disable output buffering (useful for logs in Cloud Run)
ENV PYTHONUNBUFFERED=1

# Expose port (default for FastAPI/uvicorn)
EXPOSE 8000

# Run the FastAPI app using uvicorn
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
