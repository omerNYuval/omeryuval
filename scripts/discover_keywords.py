import json
import os

import requests

SEED_KEYWORD = "garage door"
LOCATION_NAME = "Indianapolis,Indiana,United States"
LANGUAGE_NAME = "English"
LIMIT = 30
API_URL = "https://api.dataforseo.com/v3/dataforseo_labs/google/keyword_ideas/live"


def main():
    login = os.environ.get("DATAFORSEO_LOGIN")
    password = os.environ.get("DATAFORSEO_PASSWORD")
    if not login or not password:
        raise RuntimeError("Missing DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD environment variables")

    payload = [{
        "keywords": [SEED_KEYWORD],
        "location_name": LOCATION_NAME,
        "language_name": LANGUAGE_NAME,
        "limit": LIMIT,
    }]
    response = requests.post(API_URL, auth=(login, password), json=payload, timeout=60)
    response.raise_for_status()
    data = response.json()

    if data.get("status_code") != 20000:
        raise RuntimeError(f"DataForSEO API error: {data.get('status_message')}")

    tasks = data.get("tasks") or []
    if not tasks or tasks[0].get("status_code") != 20000:
        message = tasks[0].get("status_message") if tasks else "no tasks returned"
        raise RuntimeError(f"DataForSEO task error: {message}")

    result = tasks[0].get("result") or []
    if not result:
        print("No results returned.")
        return

    items = result[0].get("items") or []
    print(f"Total ideas returned: {len(items)}\n")

    rows = []
    for item in items:
        keyword = item.get("keyword")
        info = item.get("keyword_info") or {}
        volume = info.get("search_volume")
        competition = info.get("competition")
        cpc = info.get("cpc")
        rows.append((keyword, volume, competition, cpc))

    rows.sort(key=lambda r: (r[1] if r[1] is not None else -1), reverse=True)

    print(f"{'keyword':45s} | {'volume':>8s} | {'competition':>12s} | {'cpc':>6s}")
    for keyword, volume, competition, cpc in rows:
        print(f"{str(keyword):45s} | {str(volume):>8s} | {str(competition):>12s} | {str(cpc):>6s}")


if __name__ == "__main__":
    main()
