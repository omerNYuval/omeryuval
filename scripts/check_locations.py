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
    neighborhoods = [
        r for r in results
        if r.get("location_type") == "Neighborhood" and r.get("location_code_parent") == 21152
    ]

    print(f"Total US locations returned: {len(results)}")
    print(f"Neighborhoods under parent 21152: {len(neighborhoods)}")
    print(json.dumps(sorted(neighborhoods, key=lambda r: r["location_name"]), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
