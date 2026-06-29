#!/usr/bin/env python3
"""Create a new VibeCode server for the numbering app."""
import json
import subprocess
import sys
import os
import time

API_KEY = os.environ.get("VIBE_API_KEY", "vibe_api_Rmvh4dYft65rpq6IG7mIuGy4qSIRKs9R_74123f")
OUT_FILE = os.path.join(os.path.dirname(__file__), "..", ".numbers-server-id")

def api(method, path, body=None):
    cmd = [
        "curl", "-s", "-X", method,
        f"https://vibecode.bitrix24.tech/v1{path}",
        "-H", f"X-Api-Key: {API_KEY}",
    ]
    if body is not None:
        cmd += ["-H", "Content-Type: application/json", "-d", json.dumps(body)]
    result = subprocess.run(cmd, capture_output=True, text=True)
    return json.loads(result.stdout or "{}")

def wait_ready(server_id, timeout=300):
    start = time.time()
    while time.time() - start < timeout:
        data = api("GET", f"/infra/servers/{server_id}").get("data", {})
        status = data.get("status")
        bh = data.get("blackholeStatus")
        print(f"  status={status}, blackhole={bh}")
        if status == "running" and bh == "CONNECTED":
            return data
        time.sleep(10)
    raise TimeoutError("Server not ready")

if __name__ == "__main__":
    print("Creating numbering server...")
    resp = api("POST", "/infra/servers", {
        "provider": "bitrix-cloud",
        "name": "edo-numbering",
        "displayName": "Нумерация ЭДО",
        "plan": "bc-small",
        "region": "ru-central1-a",
        "image": "fd8qoc0krj5f20622ght",
    })

    if not resp.get("success"):
        print(json.dumps(resp, indent=2, ensure_ascii=False))
        sys.exit(1)

    server = resp["data"]
    server_id = server["id"]
    print(f"Server created: {server_id}")
    print(f"URL: {server.get('appUrl', 'pending...')}")

    print("Waiting for server to be ready...")
    info = wait_ready(server_id)
    print(f"Ready: {info.get('appUrl')}")

    with open(OUT_FILE, "w") as f:
        f.write(server_id)
    print(f"Server ID saved to {OUT_FILE}")
    print(f"\nDeploy numbering with:\n  NUMBERS_SERVER_ID={server_id} python3 scripts/deploy.py")
