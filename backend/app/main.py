from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# import routers from local modules
from . import races
from . import championship_standings
from . import session_results
from . import circuit_info
from . import driver_bio
from . import race_stints
from . import pit_stops
from . import race_laps
from . import circuit_history
from . import session_recap
from . import race_replay
from . import strategy_commentary
from . import driver_comparison_recap
from . import historical_index

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
app.include_router(driver_bio.router)
app.include_router(race_stints.router)
app.include_router(pit_stops.router)
app.include_router(race_laps.router)
app.include_router(circuit_history.router)
app.include_router(session_recap.router)
app.include_router(race_replay.router)
app.include_router(strategy_commentary.router)
app.include_router(driver_comparison_recap.router)
app.include_router(historical_index.router)


@app.get("/health")
async def health():
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)



