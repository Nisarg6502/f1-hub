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
@router.get("/race_results")
async def get_results(
	year: int = Query(..., description="Year for which to fetch results"),
	round: int | None = Query(None, description="round number to fetch a single race results"),
	fields: str | None = Query(None, description="comma-separated fields: results,results_list"),
):
	# build upstream URL. If `round` provided, fetch that race's results only
	url = f'https://api.jolpi.ca/ergast/f1/{year}/{round}/results/'

	data = _fetch_upstream(url)
	if isinstance(data, JSONResponse):
		return data

	races_full_data = data.get("MRData", {}).get("RaceTable", {}).get("Races", [])

	selected_race = None
	results_for_race = []
	drivers_list = []
	if round is not None and races_full_data:
		# upstream for a specific round normally returns a single race in the list
		selected_race = races_full_data[0]
		results_for_race = selected_race.get("Results", [])
		drivers_list = [ (f"{res.get('Driver',{}).get('givenName','')} {res.get('Driver',{}).get('familyName','')}").strip() if res.get('Driver') else res.get('driverId','') for res in results_for_race]

	requested = {p.strip() for p in (fields or "").split(",") if p.strip()} if fields else set()

	result = {}
	# when a round is specified, allow returning the race object and its results
	if "results" in requested and round is not None:
		result["results"] = results_for_race
	if "results_list" in requested and round is not None:
		result["results_list"] = drivers_list
	if "race" in requested and round is not None:
		result["race"] = selected_race

	# if nothing requested, provide a minimal default
	if not requested:
		result = {"race": selected_race or {}, "results": results_for_race}

	return JSONResponse(content=result)

