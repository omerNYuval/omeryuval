import json
import os
from datetime import datetime, timezone

import requests

SEED_KEYWORD = "garage door"
REGION_NAME = "Indianapolis, IN"
LOCATION_CODE = 1017146  # Indianapolis,Indiana,United States (City)
LANGUAGE_NAME = "English"
LIMIT = 30
API_URL = "https://api.dataforseo.com/v3/dataforseo_labs/google/keyword_ideas/live"

DATA_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "trends.json")
MAX_ENTRIES = 300


def main():
    login = os.environ.get("DATAFORSEO_LOGIN")
    password = os.environ.get("DATAFORSEO_PASSWORD")
    if not login or not password:
        raise RuntimeError("Missing DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD environment variables")

    payload = [{
        "keywords": [SEED_KEYWORD],
        "location_name": "Indianapolis,Indiana,United States",
        "language_code": "en",
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
    items = (result[0].get("items") if result else None) or []

    rows = []
    for item in items:
        keyword = item.get("keyword")
        info = item.get("keyword_info") or {}
        volume = info.get("search_volume")
        if keyword and volume is not None:
            rows.append((keyword, volume))

    rows.sort(key=lambda r: r[1], reverse=True)

    print(f"Total ideas returned: {len(items)}, with volume data: {len(rows)}\n")
    for keyword, volume in rows[:10]:
        print(f"{keyword:45s} | {volume}")

    now = datetime.now(timezone.utc)
    run_date = now.strftime("%Y-%m-%d")
    run_time = now.strftime("%H:%M")
    new_entries = []

    if rows:
        top_keyword, top_volume = rows[0]
        runners_up = ", ".join(f"{k} ({v})" for k, v in rows[1:4])
        new_entries.append({
            "date": run_date,
            "time": run_time,
            "type": "score",
            "title": f"גילוי: המונח הכי מבוקש הוא \"{top_keyword}\"",
            "detail": f"מתוך {len(rows)} ביטויים אמיתיים שנבדקו סביב \"{SEED_KEYWORD}\" באזור {REGION_NAME}, \"{top_keyword}\" מוביל עם כ-{top_volume} חיפושים בחודש. אחריו: {runners_up}.",
            "region": REGION_NAME,
            "tags": [f"{top_volume} חיפושים לחודש", "גילוי מילות מפתח"],
        })
    else:
        new_entries.append({
            "date": run_date,
            "time": run_time,
            "type": "scan",
            "title": "גילוי מילות מפתח הושלם",
            "detail": f"נבדקו ביטויים סביב \"{SEED_KEYWORD}\" באזור {REGION_NAME} — לא נמצאו נתוני נפח חיפוש.",
            "region": REGION_NAME,
            "tags": ["גילוי מילות מפתח"],
        })

    with open(DATA_PATH, "r", encoding="utf-8") as f:
        output = json.load(f)

    entries = new_entries + (output.get("entries") or [])
    seen = set()
    deduped = []
    for entry in entries:
        key = (entry["date"], entry["time"], entry["title"], entry["region"])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(entry)
    deduped.sort(key=lambda e: (e["date"], e["time"]), reverse=True)

    output["generated_at"] = now.isoformat()
    output["entries"] = deduped[:MAX_ENTRIES]

    with open(DATA_PATH, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
