"""Behavioral parity: identical operations against SQLite and the JS demo store."""
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil
import subprocess

import pytest
import webapp.event_store as module

ROOT = Path(__file__).resolve().parents[1]

def normalize(value):
    # Provenance/display labels are intentionally extra in the demo interface.
    if isinstance(value, dict):
        return {k: normalize(v) for k, v in value.items() if k not in {"context", "source_label", "status_history"}}
    if isinstance(value, list):
        return [normalize(v) for v in value]
    if isinstance(value, str) and "T" in value and (value.endswith("Z") or value.endswith("+00:00")):
        return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)
    return value

@pytest.mark.parametrize("boundary", ["2026-10-14T15:00:00+00:00", "2026-10-14T17:00:00+00:00"])
def test_demo_store_matches_sqlite(tmp_path, monkeypatch, boundary):
    node = shutil.which("node")
    if not node:
        pytest.skip("Node.js is required for cross-runtime demo parity")
    start = int(datetime.fromisoformat(boundary).timestamp() * 1000)
    clock = [start]

    class FrozenDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime.fromtimestamp(clock[0] / 1000, timezone.utc).astimezone(tz)

    monkeypatch.setattr(module, "datetime", FrozenDateTime)
    monkeypatch.setattr(module, "now", lambda: FrozenDateTime.now(timezone.utc).isoformat(timespec="microseconds"))
    store = module.EventStore(tmp_path / "parity.sqlite3")
    def item(score, t=0, count=1):
        return {"event_type": "smoke", "score": score, "start_s": t, "end_s": t, "count": count, "details": {"score": score}}
    run = "DEMO-RUN-0001"
    actions = [
        {"op": "begin", "id": run, "time": start - 6 * 86400000 - 3600000},
        {"op": "observe", "id": run, "model": "yolov8n", "items": [item(.9)], "time": start - 6 * 86400000 - 3600000},
        {"op": "snapshot", "period": "7d", "filters": {"period": "7d"}, "time": start},
        {"op": "observe", "id": run, "model": "yolov8n", "items": [item(.3, 20, 2)], "time": start},
        {"op": "observe", "id": run, "model": "yolov8n", "items": [item(.5, 25)], "time": start + 1000},
        {"op": "review", "id": 1, "status": "ack", "time": start + 2000},
        {"op": "review", "id": 1, "status": "ack", "time": start + 3000},
        {"op": "observe", "id": run, "model": "yolov8n", "items": [item(.95, 28)], "time": start + 40000},
        {"op": "review", "id": 1, "status": "new", "time": start + 41000},
        {"op": "observe", "id": run, "model": "yolov8n", "items": [item(.7, 40)], "time": start + 42000},
        {"op": "snapshot", "period": "all", "filters": {"q": "smoke", "page": 99, "page_size": 1}, "after": 0, "limit": 2, "time": start + 42000},
        {"op": "finish", "id": run, "time": start + 45000},
        {"op": "snapshot", "period": "today", "filters": {"period": "yesterday"}, "after": 999, "time": start + 45000},
    ]
    expected = []
    for action in actions:
        clock[0] = action["time"]
        if action["op"] == "begin":
            store.begin("test", "upload", action["id"])
        elif action["op"] == "observe":
            store.observe(action["id"], action["model"], action["items"])
        elif action["op"] == "review":
            store.set_status(action["id"], action["status"])
        elif action["op"] == "finish":
            store.finish(action["id"], "completed")
        else:
            expected.append({"dashboard": store.dashboard(action["period"]), "logs": store.list(**action["filters"]),
                             "notifications": store.notifications(after_id=action.get("after"), limit=action.get("limit", 20))})
    result = subprocess.run([node, str(ROOT / "tests/demo_contract_runner.cjs")],
                            input=json.dumps({"now": start, "actions": actions}), text=True,
                            encoding="utf-8", capture_output=True, timeout=15, check=True)
    assert normalize(json.loads(result.stdout)) == normalize(expected)
