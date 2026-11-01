import json
import os
import urllib.request
from urllib.parse import urlsplit

origin = os.environ["LIMEIOT_PUBLIC_ORIGIN"]
request = urllib.request.Request("http://127.0.0.1:17880/healthz", headers={"Host": urlsplit(origin).netloc})
with urllib.request.urlopen(request, timeout=3) as response:
    health = json.load(response)
    if not health.get("broker_connected"):
        raise SystemExit(1)
