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

    candidates = [
        "Broad Ripple", "Fountain Square", "Irvington", "Meridian-Kessler",
        "Butler-Tarkington", "Mapleton-Fall Creek", "Martindale-Brightwood",
        "Haughville", "Riverside", "Near Eastside", "Near Westside",
        "Downtown Indianapolis", "Castleton", "Nora", "Eagle Creek",
        "Garfield Park", "University Heights", "Ben Davis", "Speedway",
        "Chatham Arch", "Fletcher Place", "Cottage Home", "Herron-Morton Place",
        "Old Northside", "Lockerbie Square", "Ransom Place", "Fall Creek Place",
        "Crown Hill", "Christian Park", "Bates-Hendricks", "Twin Aire",
        "Brightwood", "Emerson Heights", "Windsor Park", "Ivy Hill",
        "Rocky Ripple", "Crows Nest", "Williams Creek", "Glendale", "Devon",
        "Keystone at the Crossing", "Allisonville", "Wanamaker", "Homecroft",
    ]

    found = []
    missing = []
    for candidate in candidates:
        matches = by_first_segment.get(candidate.lower(), [])
        in_matches = [m for m in matches if "Indiana" in (m.get("location_name") or "")]
        if in_matches:
            for m in in_matches:
                found.append((candidate, m["location_name"], m["location_type"], m["location_code"]))
        else:
            missing.append(candidate)

    print(f"Checked {len(candidates)} candidate neighborhood names.")
    print(f"Found: {len(found)}")
    print(f"Missing: {len(missing)}\n")

    print("FOUND:")
    for c, name, ltype, code in found:
        print(f"  {c:24s} -> {name} | type={ltype} | code={code}")

    print("\nMISSING:")
    for c in missing:
        print(f"  {c}")


if __name__ == "__main__":
    main()
