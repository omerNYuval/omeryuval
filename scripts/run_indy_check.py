import json
import os
from datetime import datetime, timezone

import requests

REGION_NAME = "Meridian-Kessler, Indianapolis, IN"
LOCATION_CODE = 9209441  # Meridian-Kessler,Indiana,United States (Neighborhood)
LANGUAGE_NAME = "English"
KEYWORD = "garage door repair"
RISE_THRESHOLD_PCT = 15

DATA_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "trends.json")
MAX_ENTRIES = 300
API_URL = "https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live"


def get_credentials():
    login = os.environ.get("DATAFORSEO_LOGIN")
    password = os.environ.get("DATAFORSEO_PASSWORD")
    if not login or not password:
        raise RuntimeError("Missing DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD environment variables")
    return login, password


def fetch_search_volume(login, password):
    payload = [{
        "keywords": [KEYWORD],
        "location_code": LOCATION_CODE,
        "language_name": LANGUAGE_NAME,
    }]
    response = requests.post(API_URL, auth=(login, password), json=payload, timeout=30)
    response.raise_for_status()
    data = response.json()

    if data.get("status_code") != 20000:
        raise RuntimeError(f"DataForSEO API error: {data.get('status_message')}")

    tasks = data.get("tasks") or []
    if not tasks or tasks[0].get("status_code") != 20000:
        message = tasks[0].get("status_message") if tasks else "no tasks returned"
        raise RuntimeError(f"DataForSEO task error: {message}")

    return tasks[0].get("result") or []


def trend_pct_change(monthly_searches):
    points = sorted(
        (m for m in (monthly_searches or []) if m.get("search_volume") is not None),
        key=lambda m: (m["year"], m["month"]),
    )
    if len(points) < 2:
        return None
    prev, current = points[-2], points[-1]
    if not prev.get("search_volume"):
        return None
    return round((current["search_volume"] - prev["search_volume"]) / prev["search_volume"] * 100)


def load_existing_entries():
    if not os.path.exists(DATA_PATH):
        return []
    with open(DATA_PATH, "r", encoding="utf-8") as f:
        return json.load(f).get("entries", [])


def main():
    login, password = get_credentials()
    now = datetime.now(timezone.utc)
    run_date = now.strftime("%Y-%m-%d")
    run_time = now.strftime("%H:%M")

    results = fetch_search_volume(login, password)
    new_entries = []

    for row in results:
        keyword = row.get("keyword")
        volume = row.get("search_volume")
        if keyword is None or volume is None:
            new_entries.append({
                "date": run_date,
                "time": run_time,
                "type": "scan",
                "title": "סריקת ביקוש הושלמה",
                "detail": f"נבדק המונח \"{KEYWORD}\" באזור {REGION_NAME} — לא נמצא נפח חיפוש מדיד בשכונה זו.",
                "region": REGION_NAME,
                "tags": ["נתונים אמיתיים"],
            })
            continue

        pct = trend_pct_change(row.get("monthly_searches"))
        if pct is not None and pct >= RISE_THRESHOLD_PCT:
            new_entries.append({
                "date": run_date,
                "time": run_time,
                "type": "score",
                "title": f"עלייה בביקוש: {keyword}",
                "detail": f"נפח החיפוש למונח \"{keyword}\" עלה ב-{pct}% לעומת החודש הקודם באזור {REGION_NAME} (נפח נוכחי: כ-{volume} חיפושים בחודש).",
                "region": REGION_NAME,
                "tags": [f"+{pct}%", f"{volume} חיפושים לחודש"],
            })
        else:
            new_entries.append({
                "date": run_date,
                "time": run_time,
                "type": "scan",
                "title": "סריקת ביקוש הושלמה",
                "detail": f"נבדק המונח \"{keyword}\" באזור {REGION_NAME}. נפח חיפוש נוכחי: כ-{volume} חיפושים בחודש.",
                "region": REGION_NAME,
                "tags": [f"{volume} חיפושים לחודש", "נתונים אמיתיים"],
            })

    entries = new_entries + load_existing_entries()

    seen = set()
    deduped = []
    for entry in entries:
        key = (entry["date"], entry["time"], entry["title"], entry["region"])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(entry)

    deduped.sort(key=lambda e: (e["date"], e["time"]), reverse=True)
    deduped = deduped[:MAX_ENTRIES]

    with open(DATA_PATH, "r", encoding="utf-8") as f:
        output = json.load(f)
    output["generated_at"] = now.isoformat()
    output["entries"] = deduped

    with open(DATA_PATH, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
