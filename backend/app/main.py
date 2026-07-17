from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# import routers from local modules
from . import races
from . import championship_standings
from . import session_results
from . import circuit_info

app = FastAPI(title="F1 API")

# CORS — allow the frontend (on a different Cloud Run URL) to call the backend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Tighten to your frontend URL in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# include routers defined in each module
app.include_router(races.router)
app.include_router(championship_standings.router)
app.include_router(session_results.router)
app.include_router(circuit_info.router)


@app.get("/health")
async def health():
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)



