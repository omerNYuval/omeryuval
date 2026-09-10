import json
import os
from datetime import datetime, timezone

import requests

MARKET_NAME = "Boston, MA"
LOCATION_NAME = "Boston,Massachusetts,United States"
LANGUAGE_NAME = "English"
KEYWORDS = [
    "garage door repair",
    "garage door spring repair",
    "garage door opener repair",
    "garage door won't open",
    "garage door off track",
]
RISE_THRESHOLD_PCT = 15

def bdi(text):
    """Wrap embedded Latin/numeric text in a bidi-isolate so it doesn't
    scramble the surrounding Hebrew sentence's punctuation/word order.
    dir="ltr" is required (not just isolation) because purely numeric/symbol
    text (e.g. "+39%") has no strong-direction character of its own, so a
    plain isolate falls back to the ambient RTL direction and still flips."""
    return f'<bdi dir="ltr">{text}</bdi>'


def quoted(text):
    return f'"{text}"'


DATA_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "trends.json")
MAX_ENTRIES = 300
API_URL = "https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live"
BALANCE_URL = "https://api.dataforseo.com/v3/appendix/user_data"


def fetch_balance(login, password):
    try:
        response = requests.get(BALANCE_URL, auth=(login, password), timeout=30)
        response.raise_for_status()
        data = response.json()
        tasks = data.get("tasks") or []
        result = (tasks[0].get("result") if tasks else None) or []
        money = (result[0].get("money") if result else None) or {}
        return money.get("balance")
    except Exception:
        return None


def get_credentials():
    login = os.environ.get("DATAFORSEO_LOGIN")
    password = os.environ.get("DATAFORSEO_PASSWORD")
    if not login or not password:
        raise RuntimeError("Missing DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD environment variables")
    return login, password


def fetch_search_volume(login, password):
    payload = [{
        "keywords": KEYWORDS,
        "location_name": LOCATION_NAME,
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
    signals_found = 0

    for row in results:
        keyword = row.get("keyword")
        volume = row.get("search_volume")
        if keyword is None or volume is None:
            continue
        pct = trend_pct_change(row.get("monthly_searches"))
        if pct is not None and pct >= RISE_THRESHOLD_PCT:
            new_entries.append({
                "date": run_date,
                "time": run_time,
                "type": "score",
                "title": f"עלייה בביקוש: {bdi(keyword)}",
                "detail": f"נפח החיפוש למונח {bdi(quoted(keyword))} עלה ב-{bdi(f'{pct}%')} לעומת החודש הקודם באזור {bdi(MARKET_NAME)} (נפח נוכחי: כ-{bdi(volume)} חיפושים בחודש).",
                "region": MARKET_NAME,
                "tags": [f"+{pct}%", f"{volume} חיפושים לחודש"],
            })
            signals_found += 1

    new_entries.append({
        "date": run_date,
        "time": run_time,
        "type": "scan",
        "title": "סריקת ביקוש הושלמה",
        "detail": f"נבדקו {len(KEYWORDS)} מונחי מפתח מרכזיים מול נתוני חיפוש אמיתיים עבור {bdi(MARKET_NAME)}. נמצאו {signals_found} מונחים בעלייה.",
        "region": MARKET_NAME,
        "tags": ["נתונים אמיתיים"],
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

    output = {
        "generated_at": now.isoformat(),
        "market": MARKET_NAME,
        "keywords": KEYWORDS,
        "balance": fetch_balance(login, password),
        "entries": deduped,
    }

    os.makedirs(os.path.dirname(DATA_PATH), exist_ok=True)
    with open(DATA_PATH, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
