import json
import os

import requests

API_URL = "https://api.dataforseo.com/v3/appendix/user_data"
DATA_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "trends.json")


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
    balance = (top.get("money") or {}).get("balance")

    print(f"Current balance: {balance}")

    with open(DATA_PATH, "r", encoding="utf-8") as f:
        output = json.load(f)
    output["balance"] = balance
    with open(DATA_PATH, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
