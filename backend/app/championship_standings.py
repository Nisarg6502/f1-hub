from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse
from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError
import json
import time
import traceback
import sys

router = APIRouter(prefix="/api")


def _fetch_upstream(url: str, max_retries: int = 3, base_backoff: int = 1):
    data = None
    for attempt in range(1, max_retries + 1):
        try:
            req = Request(url, headers={"User-Agent": "f1-scratch-client/1.0"})
            response = urlopen(req, timeout=10)
            status_code = response.getcode() if hasattr(response, "getcode") else None
            body = response.read().decode("utf-8")

            if status_code is not None and status_code != 200:
                raise HTTPError(url, status_code, f"Unexpected status code: {status_code}", hdrs=None, fp=None)

            data = json.loads(body)
            break

        except HTTPError as e:
            traceback.print_exc(file=sys.stderr)
            if attempt == max_retries:
                status = e.code if hasattr(e, "code") and isinstance(e.code, int) else 502
                return JSONResponse(content={"error": "Upstream HTTP error", "message": str(e)}, status_code=status)

        except URLError as e:
            traceback.print_exc(file=sys.stderr)
            if attempt == max_retries:
                return JSONResponse(content={"error": "Network error", "message": str(e.reason)}, status_code=503)

        except Exception as e:
            traceback.print_exc(file=sys.stderr)
            if attempt == max_retries:
                return JSONResponse(content={"error": "Unexpected error", "message": str(e)}, status_code=500)

        time.sleep(base_backoff * attempt)

    if data is None:
        return JSONResponse(content={"error": "Failed to fetch upstream data"}, status_code=502)

    return data
@router.get("/driverstandings")
async def get_driver_standings(
    year: int = Query(..., description="Year for which to fetch the driver standings"),
    fields: str | None = Query(None, description="comma-separated fields: standings,standings_list"),
):
    url = f'https://api.jolpi.ca/ergast/f1/{year}/driverstandings/'

    data = _fetch_upstream(url)
    if isinstance(data, JSONResponse):
        return data

    standings_lists = data.get("MRData", {}).get("StandingsTable", {}).get("StandingsLists", [])
    driver_standings = []
    if standings_lists:
        driver_standings = standings_lists[0].get("DriverStandings", [])

    drivers_list = [
        (f"{d.get('Driver',{}).get('givenName','')} {d.get('Driver',{}).get('familyName','')}").strip()
        if d.get('Driver') else d.get('driverId','')
        for d in driver_standings
    ]

    requested = {p.strip() for p in (fields or "").split(",") if p.strip()} if fields else set()

    result = {}
    if "standings_list" in requested:
        result["standings_list"] = drivers_list
    if "standings" in requested:
        result["driver_standings"] = driver_standings

    return JSONResponse(content=result)


@router.get("/constructorstandings")
async def get_constructor_standings(
    year: int = Query(..., description="Year for which to fetch the constructor standings"),
    fields: str | None = Query(None, description="comma-separated fields: standings,constructors_list"),
):
    url = f'https://api.jolpi.ca/ergast/f1/{year}/constructorstandings/'

    data = _fetch_upstream(url)
    if isinstance(data, JSONResponse):
        return data

    standings_lists = data.get("MRData", {}).get("StandingsTable", {}).get("StandingsLists", [])
    constructor_standings = []
    if standings_lists:
        constructor_standings = standings_lists[0].get("ConstructorStandings", [])

    constructors_list = [c.get('Constructor', {}).get('name', '') for c in constructor_standings]

    requested = {p.strip() for p in (fields or "").split(",") if p.strip()} if fields else set()

    result = {}
    if "constructors_list" in requested:
        result["constructors_list"] = constructors_list
    if "standings" in requested:
        result["constructor_standings"] = constructor_standings

    return JSONResponse(content=result)


