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
    print("RAW RESPONSE:")
    print(json.dumps(data, indent=2))


if __name__ == "__main__":
    main()
