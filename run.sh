#!/usr/bin/env bash
# Create the venv if needed, install deps, and run the app.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d venv ]; then
  echo "Creating virtualenv..."
  python3 -m venv venv
fi

./venv/bin/pip install -q --upgrade pip
./venv/bin/pip install -q -r requirements.txt

exec ./venv/bin/python app.py
