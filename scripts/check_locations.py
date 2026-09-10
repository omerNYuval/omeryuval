import json
import os

import requests

API_URL = "https://api.dataforseo.com/v3/keywords_data/google_ads/locations"


def main():
    login = os.environ.get("DATAFORSEO_LOGIN")
    password = os.environ.get("DATAFORSEO_PASSWORD")
    if not login or not password:
        raise RuntimeError("Missing DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD environment variables")

    response = requests.get(API_URL, auth=(login, password), timeout=60)
    response.raise_for_status()
    data = response.json()

    if data.get("status_code") != 20000:
        raise RuntimeError(f"DataForSEO API error: {data.get('status_message')}")

    tasks = data.get("tasks") or []
    if not tasks or tasks[0].get("status_code") != 20000:
        message = tasks[0].get("status_message") if tasks else "no tasks returned"
        raise RuntimeError(f"DataForSEO task error: {message}")

    results = tasks[0].get("result") or []

    candidates = [
        "Allston", "Back Bay", "Beacon Hill", "Brighton", "Charlestown",
        "Dorchester", "Downtown Boston", "East Boston", "Fenway", "Hyde Park",
        "Jamaica Plain", "Mattapan", "Mission Hill", "North End", "Roslindale",
        "Roxbury", "South Boston", "South End", "West Roxbury", "West End",
        "Wharf District", "Bay Village", "Chinatown", "Longwood",
    ]

    by_first_segment = {}
    for r in results:
        name = r.get("location_name") or ""
        first = name.split(",")[0].strip().lower()
        by_first_segment.setdefault(first, []).append(r)

    print("Checking known Boston neighborhood names against DataForSEO's location database:\n")
    for candidate in candidates:
        matches = by_first_segment.get(candidate.lower(), [])
        ma_matches = [m for m in matches if "Massachusetts" in (m.get("location_name") or "")]
        if ma_matches:
            for m in ma_matches:
                print(f"FOUND  | {candidate:20s} -> {m['location_name']} | type={m['location_type']} | code={m['location_code']}")
        else:
            print(f"MISSING| {candidate:20s} -> not found in Massachusetts")


if __name__ == "__main__":
    main()
