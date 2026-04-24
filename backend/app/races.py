# ...existing code...
from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse
from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError
import json
import time
import traceback
import sys

router = APIRouter(prefix="/api")

@router.get("/races")
async def get_races(
    year: int = Query(..., description="Year for which to fetch the races"),
    fields: str | None = Query(None, description="comma-separated fields: total,races,races_list"),
):  
    print(f"Fetching races for year: {year}")
    url = f'https://api.jolpi.ca/ergast/f1/{year}/races/'

    max_retries = 3
    base_backoff = 1  # seconds
    data = None

    for attempt in range(1, max_retries + 1):
        try:
            req = Request(url, headers={"User-Agent": "f1-scratch-client/1.0"})
            response = urlopen(req, timeout=10)
            status_code = response.getcode() if hasattr(response, "getcode") else None
            body = response.read().decode("utf-8")
            print(f"Response: {body}")

            if status_code is not None and status_code != 200:
                raise HTTPError(url, status_code, f"Unexpected status code: {status_code}", hdrs=None, fp=None)

            data = json.loads(body)
            print(f"Data: {data}")
            break

        except HTTPError as e:
            traceback.print_exc(file=sys.stderr)
            # If we've exhausted retries, return an error response with the upstream status if available
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

        # simple exponential backoff before next retry
        time.sleep(base_backoff * attempt)

    # If data is still None after retries, return generic error (should be handled above)
    if data is None:
        return JSONResponse(content={"error": "Failed to fetch upstream data"}, status_code=502)

    races_full_data = data.get("MRData", {}).get("RaceTable", {}).get("Races", [])
    races_count = int(data.get("MRData", {}).get("total", 0)) if data.get("MRData") else 0
    races_list = [r.get("raceName", "") for r in races_full_data]

    # ... after fetching data ...
    requested = {p.strip() for p in (fields or "").split(",") if p.strip()} if fields else set()

    result = {}

    # If no fields are requested, act as if all were requested
    if not requested:
        requested = {"total", "races_list", "races"}

    if "total" in requested:
        result["total_races"] = races_count
    if "races_list" in requested:
        result["races_list"] = races_list
    if "races" in requested:
        result["races"] = races_full_data

        return JSONResponse(content=result) # FastAPI automatically converts dicts to JSONResponse
    # ...existing code...