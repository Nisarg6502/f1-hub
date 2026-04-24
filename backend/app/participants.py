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


@router.get("/constructors")
async def get_constructors(
    year: int = Query(..., description="Year for which to fetch the constructors"),
    fields: str | None = Query(None, description="comma-separated fields: total,constructors,constructors_list"),
):
    url = f'https://api.jolpi.ca/ergast/f1/{year}/constructors/'

    data = _fetch_upstream(url)
    # If _fetch_upstream returned a JSONResponse (error), return it directly
    if isinstance(data, JSONResponse):
        return data

    constructors_full = data.get("MRData", {}).get("ConstructorTable", {}).get("Constructors", [])
    constructors_count = int(data.get("MRData", {}).get("total", 0)) if data.get("MRData") else 0
    constructors_list = [c.get("name", "") for c in constructors_full]

    requested = {p.strip() for p in (fields or "").split(",") if p.strip()} if fields else set()

    result = {}
    if "total" in requested:
        result["total_constructors"] = constructors_count
    if "constructors_list" in requested:
        result["constructors_list"] = constructors_list
    if "constructors" in requested:
        result["constructors"] = constructors_full

    return JSONResponse(content=result)


@router.get("/drivers")
async def get_drivers(
    year: int = Query(..., description="Year for which to fetch the drivers"),
    fields: str | None = Query(None, description="comma-separated fields: total,drivers,drivers_list"),
):
    url = f'https://api.jolpi.ca/ergast/f1/{year}/drivers/'

    data = _fetch_upstream(url)
    if isinstance(data, JSONResponse):
        return data

    drivers_full = data.get("MRData", {}).get("DriverTable", {}).get("Drivers", [])
    drivers_count = int(data.get("MRData", {}).get("total", 0)) if data.get("MRData") else 0
    drivers_list = [ (f"{d.get('givenName','')} {d.get('familyName','')}").strip() if (d.get('givenName') or d.get('familyName')) else d.get('driverId','') for d in drivers_full]

    requested = {p.strip() for p in (fields or "").split(",") if p.strip()} if fields else set()

    result = {}
    if "total" in requested:
        result["total_drivers"] = drivers_count
    if "drivers_list" in requested:
        result["drivers_list"] = drivers_list
    if "drivers" in requested:
        result["drivers"] = drivers_full

    return JSONResponse(content=result)
