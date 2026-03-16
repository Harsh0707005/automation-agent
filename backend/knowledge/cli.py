"""Standalone CLI for the knowledge indexer.

Spawned by the Electron desktop app as a local subprocess.
Communicates via JSON over stdin/stdout — one JSON object per line.

Commands (sent as JSON on stdin):
  {"cmd": "scan", "directory": "/path/to/dir"}
  {"cmd": "search", "query": "...", "mode": "hybrid", "top_k": 10}
  {"cmd": "layered_search", "query": "...", "directories": [...], "extensions": [...], "recency_days": 30, "top_k": 10}
  {"cmd": "set_search_dirs", "directories": ["/path1", "/path2"]}
  {"cmd": "status"}
  {"cmd": "watch", "directories": ["/path1", "/path2"]}
  {"cmd": "stop_watch"}
  {"cmd": "stats"}
  {"cmd": "shutdown"}

Responses (JSON on stdout, one per line):
  {"ok": true, ...}
  {"ok": false, "error": "..."}

Progress updates are pushed as:
  {"type": "progress", ...status fields...}
"""

import json
import logging
import os
import sys
import threading
from pathlib import Path

import warnings
warnings.filterwarnings("ignore")
os.environ["TRANSFORMERS_NO_TQDM"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"
logging.getLogger("sentence_transformers").setLevel(logging.ERROR)
logging.getLogger("transformers").setLevel(logging.ERROR)
logging.getLogger("huggingface_hub").setLevel(logging.ERROR)

from backend.knowledge.service import KnowledgeIndexService

# Single lock for ALL stdout writes — prevents interleaved JSON lines
# from the main thread (command responses) and background threads (progress).
_stdout_lock = threading.Lock()


def _send(obj: dict) -> None:
    line = json.dumps(obj)
    with _stdout_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def _format_results(results) -> list[dict]:
    return [
        {
            "file_path": r.file_path,
            "file_name": r.file_name,
            "extension": r.extension,
            "size": r.size,
            "modified_at": r.modified_at,
            "directory": r.directory,
            "excerpt": r.excerpt,
            "score": r.score,
            "normalized_score": r.normalized_score,
            "source": r.source,
        }
        for r in results
    ]


def main():
    if len(sys.argv) < 2:
        _send({"ok": False, "error": "Usage: cli.py <data_dir>"})
        sys.exit(1)

    data_dir = sys.argv[1]
    svc = KnowledgeIndexService(data_dir=data_dir)

    def on_status_update(status: dict):
        _send({"type": "progress", **status})

    svc.set_status_callback(on_status_update)

    _send({"type": "ready", "ok": True, "data_dir": data_dir})

    # Use readline() instead of `for line in sys.stdin:` — the iterator
    # uses Python's internal read-ahead buffer which delays processing.
    while True:
        line = sys.stdin.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            _send({"ok": False, "error": "Invalid JSON"})
            continue

        cmd = req.get("cmd", "")
        try:
            if cmd == "scan":
                directory = req.get("directory", "")
                if not directory:
                    _send({"ok": False, "cmd": cmd, "error": "directory required"})
                    continue
                count = svc.scan_directory(directory)
                _send({"ok": True, "cmd": "scan", "indexed_files": count})

            elif cmd == "scan_async":
                directory = req.get("directory", "")
                if not directory:
                    _send({"ok": False, "cmd": cmd, "error": "directory required"})
                    continue
                svc.scan_directory_async(directory)
                _send({"ok": True, "cmd": "scan_async", "message": f"Scan started for {directory}"})

            elif cmd == "search":
                query = req.get("query", "")
                if not query:
                    _send({"ok": False, "cmd": cmd, "error": "query required"})
                    continue
                results = svc.search(
                    query,
                    mode=req.get("mode", "hybrid"),
                    extension=req.get("extension"),
                    directory=req.get("directory"),
                    top_k=req.get("top_k", 10),
                )
                _send({
                    "ok": True,
                    "cmd": "search",
                    "results": _format_results(results),
                })

            elif cmd == "layered_search":
                query = req.get("query", "")
                if not query:
                    _send({"ok": False, "cmd": cmd, "error": "query required"})
                    continue
                results = svc.layered_search(
                    query,
                    directories=req.get("directories"),
                    extensions=req.get("extensions"),
                    recency_days=req.get("recency_days"),
                    top_k=req.get("top_k", 10),
                )
                _send({
                    "ok": True,
                    "cmd": "layered_search",
                    "results": _format_results(results),
                })

            elif cmd == "set_search_dirs":
                dirs = req.get("directories", [])
                if not dirs:
                    _send({"ok": False, "cmd": cmd, "error": "directories required"})
                    continue
                svc.set_search_dirs(dirs)
                _send({"ok": True, "cmd": "set_search_dirs"})

            elif cmd == "status":
                _send({"ok": True, "cmd": "status", **svc.get_status()})

            elif cmd == "stats":
                _send({"ok": True, "cmd": "stats", **svc.get_stats()})

            elif cmd == "watch":
                directories = req.get("directories", [])
                if not directories:
                    _send({"ok": False, "cmd": cmd, "error": "directories required"})
                    continue
                svc.start_watching(directories)
                _send({"ok": True, "cmd": "watch", "watching": directories})

            elif cmd == "stop_watch":
                svc.stop_watching()
                _send({"ok": True, "cmd": "stop_watch"})

            elif cmd == "shutdown":
                svc.stop_watching()
                svc.save()
                _send({"ok": True, "cmd": "shutdown"})
                break

            else:
                _send({"ok": False, "cmd": cmd, "error": f"Unknown command: {cmd}"})

        except Exception as e:
            _send({"ok": False, "cmd": cmd, "error": str(e)})


if __name__ == "__main__":
    main()
