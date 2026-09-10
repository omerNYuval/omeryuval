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

    by_first_segment = {}
    for r in results:
        name = r.get("location_name") or ""
        first = name.split(",")[0].strip().lower()
        by_first_segment.setdefault(first, []).append(r)

    print("City check:")
    for m in by_first_segment.get("indianapolis", []):
        if "Indiana" in (m.get("location_name") or ""):
            print(f"FOUND  | Indianapolis -> {m['location_name']} | type={m['location_type']} | code={m['location_code']}")

    candidates = [
        "Broad Ripple", "Fountain Square", "Irvington", "Meridian-Kessler",
        "Butler-Tarkington", "Mapleton-Fall Creek", "Martindale-Brightwood",
        "Haughville", "Riverside", "Near Eastside", "Near Westside",
        "Downtown Indianapolis", "Castleton", "Nora", "Eagle Creek",
        "Garfield Park", "University Heights", "Ben Davis", "Speedway",
    ]

    print("\nChecking known Indianapolis neighborhood names against DataForSEO's location database:\n")
    for candidate in candidates:
        matches = by_first_segment.get(candidate.lower(), [])
        in_matches = [m for m in matches if "Indiana" in (m.get("location_name") or "")]
        if in_matches:
            for m in in_matches:
                print(f"FOUND  | {candidate:22s} -> {m['location_name']} | type={m['location_type']} | code={m['location_code']}")
        else:
            print(f"MISSING| {candidate:22s} -> not found in Indiana")


if __name__ == "__main__":
    main()
