import json
import os

import requests

API_URL = "https://api.dataforseo.com/v3/appendix/user_data"


def main():
    login = os.environ.get("DATAFORSEO_LOGIN")
    password = os.environ.get("DATAFORSEO_PASSWORD")
    if not login or not password:
        raise RuntimeError("Missing DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD environment variables")

    response = requests.get(API_URL, auth=(login, password), timeout=30)
    response.raise_for_status()
    data = response.json()

    tasks = data.get("tasks") or []
    result = (tasks[0].get("result") if tasks else None) or []
    top = result[0] if result else {}

    print("Top-level keys:", list(top.keys()))
    for key in ("login", "money", "balance", "credit", "rate_limit_per_minute"):
        if key in top:
            print(f"{key}: {json.dumps(top[key])}")


if __name__ == "__main__":
    main()
