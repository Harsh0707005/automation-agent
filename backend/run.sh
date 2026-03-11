#!/usr/bin/env bash
# Run from repo root: ./backend/run.sh
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" && PYTHONPATH=. "$ROOT/backend/venv/bin/python" backend/run_server.py
