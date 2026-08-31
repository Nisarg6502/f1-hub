import os

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
from . import race_timing
from . import race_radio
from . import strategy_commentary
from . import driver_comparison_recap
from . import historical_index
from . import constructor_titles
from . import track_geometry
from . import watch_session
from . import session_sectors

app = FastAPI(title="F1 API")

# Mirrors `agent/config.py`'s `ALLOWED_ORIGINS`, deliberately including the
# default: the localhost port the Next dev server runs on, so local development
# works with no environment set, and nothing wider unless a deploy says so.
_DEFAULT_ORIGINS = "http://localhost:3113,http://127.0.0.1:3113"

ALLOWED_ORIGINS = [
    origin.strip()
    for origin in (os.getenv("API_ALLOWED_ORIGINS") or _DEFAULT_ORIGINS).split(",")
    if origin.strip()
]

# CORS — allow the frontend (on a different Cloud Run URL) to call the backend.
#
# The default is localhost, NOT "*", and the difference is not cosmetic.
# Starlette does not emit a literal `*` when credentials are allowed: it echoes
# the caller's Origin back and sets `Access-Control-Allow-Credentials: true`.
# Pairing `allow_origins=["*"]` with `allow_credentials=True` therefore made
# every route on this service readable cross-origin, with cookies, by any site
# that wanted it — including the six POST endpoints, which are unauthenticated
# and mutate state.
#
# `allow_credentials` is now off because nothing here needs it. The data API
# sets no cookie and reads no `Authorization` header; only the agent service
# does, which is why the agent keeps credentials on and this does not. Methods
# and headers are narrowed to what the routers actually declare (27 GET, 6
# POST, JSON bodies) rather than `*`.
#
# `backend/agent/config.py` reaches the same conclusion for the same reason and
# is worth reading alongside this: a safe default must not depend on a deploy
# substitution being present, because the one time it is missing is the one
# time it matters.
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
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
app.include_router(race_timing.router)
app.include_router(race_radio.router)
app.include_router(strategy_commentary.router)
app.include_router(driver_comparison_recap.router)
app.include_router(historical_index.router)
app.include_router(constructor_titles.router)
app.include_router(track_geometry.router)
app.include_router(watch_session.router)
app.include_router(session_sectors.router)


@app.get("/health")
async def health():
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)



