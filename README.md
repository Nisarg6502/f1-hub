# F1 Hub

F1 Hub is a full-stack web application designed to provide comprehensive Formula 1 data, including race schedules, driver standings, circuit information, and live statistics. The application fetches data from the Ergast Developer API, caches it in a MongoDB database using a scheduled synchronization service, and serves it through a highly scalable backend and a modern Next.js frontend.

## 🏗 Architecture Overview

The system is designed with a microservices-oriented architecture deployed entirely on Google Cloud Platform (GCP):

- **Frontend (`/frontend`)**: A Next.js application styled with Tailwind CSS, providing a dynamic and responsive user interface. Deployed on Google Cloud Run.
- **Backend (`/backend`)**: A highly performant FastAPI Python application that serves data from MongoDB to the frontend. Deployed on Google Cloud Run.
- **Sync Service (`f1-data-sync`)**: A lightweight Python cron job that periodically pulls fresh Formula 1 data from external sources (e.g., Ergast API) and updates the MongoDB database. Built and deployed via Cloud Build and triggered by Cloud Scheduler.
- **Database**: MongoDB (Atlas) used for persisting race, driver, and circuit data to reduce external API rate limiting and latency.
- **Asset Storage**: Driver images, team logos, and flags are stored and served from Google Cloud Storage (`f1-scratch-assets`).

## 🛠 Tech Stack

**Frontend:**
- Framework: Next.js 15+ (React 19)
- Styling: Tailwind CSS
- Language: TypeScript

**Backend:**
- Framework: FastAPI (Python 3.11+)
- Database Driver: Motor (Async MongoDB)
- Data Validation: Pydantic

**Infrastructure / CI/CD:**
- Google Cloud Run (Serverless Containers)
- Google Cloud Build (CI/CD Pipelines)
- Google Cloud Scheduler (Cron Jobs)
- Google Cloud Storage (Assets)
- Google Container Registry (GCR)
- Docker (Containerization)

## 📂 Folder Structure

```
.
├── backend/                  # FastAPI backend service
│   ├── app/                  # Application code, routers, db setup
│   └── requirements.txt      # Python dependencies
├── frontend/                 # Next.js frontend application
│   ├── src/                  # React components, pages, lib
│   ├── public/               # Static assets
│   └── package.json          # Node dependencies
├── Dockerfile.frontend       # Docker config for the Next.js app
├── Dockerfile.backend        # Docker config for the FastAPI app
├── Dockerfile.sync           # Docker config for the data sync service
├── cloudbuild-frontend.yaml  # Cloud Build pipeline for frontend
├── cloudbuild-backend.yaml   # Cloud Build pipeline for backend
└── cloudbuild-sync.yaml      # Cloud Build pipeline for sync service
```

## ⚙️ Prerequisites

Before you begin, ensure you have the following installed on your local machine:
- Node.js (v20+)
- Python (v3.11+)
- Docker
- Google Cloud SDK (`gcloud` CLI)

## 🚀 Local Development

### 1. Clone the repository
```bash
git clone https://github.com/Nisarg6502/f1-hub.git
cd f1-hub
```

### 2. Backend Setup
```bash
cd backend
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
pip install -r requirements.txt
```
Create a `.env` file in the `backend` directory:
```env
MONGODB_URI=your_mongodb_connection_string
```
Run the FastAPI server:
```bash
uvicorn app.main:app --reload --port 8000
```

### 3. Frontend Setup
```bash
cd frontend
npm install
```
Create a `.env.local` file in the `frontend` directory:
```env
NEXT_PUBLIC_API_BASE_URL=http://localhost:8000
NEXT_PUBLIC_ASSET_BASE_URL=https://storage.googleapis.com/f1-scratch-assets
```
Run the development server:
```bash
npm run dev
```
Access the application at `http://localhost:3000`.

### 4. Running the Sync Service locally
```bash
cd backend
python app/data_sync.py
```

## ☁️ Deployment

The application uses Google Cloud Build for continuous integration and deployment. Any push to the `main` branch (or manual triggers) will initiate the builds based on the configuration files.

- **Frontend Deployment**: Defined in `cloudbuild-frontend.yaml`. Builds the Next.js Docker image and deploys to Cloud Run.
- **Backend Deployment**: Defined in `cloudbuild-backend.yaml`. Builds the FastAPI Docker image and deploys to Cloud Run.
- **Sync Service**: Defined in `cloudbuild-sync.yaml`. Builds the Python sync script and pushes it to Google Container Registry. A Google Cloud Scheduler job periodically runs this container.

### Manual Deployment Commands

To deploy the frontend manually using Cloud Build:
```bash
gcloud builds submit --config cloudbuild-frontend.yaml .
```

To deploy the backend manually:
```bash
gcloud builds submit --config cloudbuild-backend.yaml .
```

To deploy the sync service:
```bash
gcloud builds submit --config cloudbuild-sync.yaml .
```

## 📝 License

This project is licensed under the MIT License.
