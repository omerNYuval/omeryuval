import json
import os
import time
from datetime import datetime, timezone

from pytrends.request import TrendReq

MARKET_NAME = "Boston, MA"
GEO = "US-MA-506"  # Boston-Manchester Nielsen DMA
KEYWORDS = [
    "garage door repair",
    "garage door spring repair",
    "garage door opener repair",
    "garage door won't open",
    "garage door off track",
]

DATA_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "trends.json")
MAX_ENTRIES = 300


def fetch_rising_queries(pytrends, keyword, retries=3, backoff=20):
    last_error = None
    for attempt in range(retries):
        try:
            pytrends.build_payload([keyword], timeframe="today 1-m", geo=GEO)
            related = pytrends.related_queries()
            return related.get(keyword, {}).get("rising")
        except Exception as exc:  # pytrends raises on rate limiting / network errors
            last_error = exc
            time.sleep(backoff * (attempt + 1))
    raise RuntimeError(f"Failed to fetch '{keyword}' after {retries} attempts: {last_error}")


def load_existing_entries():
    if not os.path.exists(DATA_PATH):
        return []
    with open(DATA_PATH, "r", encoding="utf-8") as f:
        return json.load(f).get("entries", [])


def main():
    pytrends = TrendReq(hl="en-US", tz=300)
    now = datetime.now(timezone.utc)
    run_date = now.strftime("%Y-%m-%d")
    run_time = now.strftime("%H:%M")

    new_entries = []
    signals_found = 0

    for keyword in KEYWORDS:
        rising = fetch_rising_queries(pytrends, keyword)
        if rising is None or rising.empty:
            continue
        for row in rising.head(3).itertuples(index=False):
            value_label = (
                "עלייה חדה מאוד"
                if isinstance(row.value, str) and row.value.lower() == "breakout"
                else f"+{row.value}%"
            )
            new_entries.append({
                "date": run_date,
                "time": run_time,
                "type": "score",
                "title": f"מונח מבוקש בעלייה: {row.query}",
                "detail": f"החיפוש \"{row.query}\", הקשור למונח הבסיס \"{keyword}\", נמצא בעלייה באזור {MARKET_NAME} בחודש האחרון.",
                "region": MARKET_NAME,
                "tags": [value_label, "גוגל טרנדס"],
            })
            signals_found += 1

    new_entries.append({
        "date": run_date,
        "time": run_time,
        "type": "scan",
        "title": "סריקת ביקוש הושלמה",
        "detail": f"נבדקו {len(KEYWORDS)} מונחי מפתח מרכזיים מול Google Trends עבור {MARKET_NAME}. נמצאו {signals_found} מונחים בעלייה.",
        "region": MARKET_NAME,
        "tags": ["גוגל טרנדס"],
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
        "entries": deduped,
    }

    os.makedirs(os.path.dirname(DATA_PATH), exist_ok=True)
    with open(DATA_PATH, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
