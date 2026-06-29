#!/usr/bin/env python3
import json
import base64
import subprocess
import sys
import os

# Numbering app runs on a separate server (not the signature server)
SERVER_ID = os.environ.get("NUMBERS_SERVER_ID", "")
API_KEY = os.environ.get("VIBE_API_KEY", "vibe_api_Rmvh4dYft65rpq6IG7mIuGy4qSIRKs9R_74123f")
ARCHIVE = "/tmp/edo-numbering.tar.gz"
NUMBERS_DIR = os.path.join(os.path.dirname(__file__), "..")

if not SERVER_ID:
    print("ERROR: Set NUMBERS_SERVER_ID env var to the numbering server ID.")
    print("Create a server first: python3 scripts/create-numbers-server.py")
    sys.exit(1)

os.chdir(NUMBERS_DIR)
subprocess.run(
    ["tar", "-czf", ARCHIVE, "--exclude=node_modules", "--exclude=.git", "--exclude=scripts", "."],
    check=True,
)

with open(ARCHIVE, "rb") as f:
    content = base64.b64encode(f.read()).decode()

payload = {
    "source": {"content": content},
    "runtime": "node20",
    "install": "cd /opt/app && npm install --production",
    "preStart": "mkdir -p /data",
    "start": "cd /opt/app && node server.js",
    "port": 3000,
    "cleanDeploy": True,
    "env": {
        "NODE_ENV": "production",
        "VIBE_API_KEY": API_KEY,
        "DATA_DIR": "/data",
    },
}

with open("/tmp/deploy-payload.json", "w") as f:
    json.dump(payload, f)

result = subprocess.run(
    [
        "curl", "-s", "-X", "POST",
        f"https://vibecode.bitrix24.tech/v1/infra/servers/{SERVER_ID}/deploy",
        "-H", f"X-Api-Key: {API_KEY}",
        "-H", "Content-Type: application/json",
        "--data-binary", "@/tmp/deploy-payload.json",
        "--max-time", "900",
    ],
    capture_output=True,
    text=True,
)

print(result.stdout or result.stderr)
sys.exit(result.returncode)
