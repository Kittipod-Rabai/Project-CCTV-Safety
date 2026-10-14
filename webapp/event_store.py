"""Local model-observation history. No media, credentials, or confirmed incidents."""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import re
import sqlite3
import threading
import uuid

UTC = timezone.utc
BANGKOK = timezone(timedelta(hours=7))
STATUSES = {"new", "ack", "closed"}
EVENT_TYPES = {"person", "helmet", "vest", "fall", "fire", "smoke", "no_helmet",
               "no_vest", "fight", "non_fight", "review_fall_fight_conflict"}


class StorageUnavailable(RuntimeError):
    pass


def now():
    return datetime.now(UTC).isoformat(timespec="microseconds")


def source_label(value, source_type):
    if source_type == "rtsp":
        return "RTSP stream"
    # Browser filenames are untrusted; never retain client filesystem paths.
    return re.sub(r"[\x00-\x1f\x7f]", "", re.split(r"[/\\]", value or "media")[-1])[:255] or "media"


def frame_observations(frame):
    grouped = {}
    for detection in frame.get("detections", []):
        kind = detection["class_name"]
        group = grouped.setdefault(kind, {"score": 0.0, "count": 0, "details": {}})
        group["count"] += 1
        if detection["confidence"] >= group["score"]:
            group["score"] = float(detection["confidence"])
            group["details"] = {"xyxy": detection.get("xyxy"), "frame_index": frame.get("index")}
    for person in frame.get("ppe", []):
        for kind in person.get("alerts", []):
            group = grouped.setdefault(kind, {"score": 0.0, "count": 0, "details": {}})
            group["count"] += 1
            group["score"] = max(group["score"], float(person["person_confidence"]))
            group["details"] = {"method": "ppe-centre-in-person-region", "score_basis": "person_confidence; derived PPE rule"}
    t = frame.get("time_s")
    return [{"event_type": kind, "start_s": t, "end_s": t, **group} for kind, group in grouped.items()]


def window_observation(window):
    label = window["label"]
    return {"event_type": label, "start_s": window["start_s"], "end_s": window["end_s"],
            "score": float(window["probs"][label]), "count": 1,
            "details": {"score_basis": "X3D softmax", "probs": window["probs"]}}


class EventStore:
    def __init__(self, path):
        self.path = Path(path)
        self._ready = False
        self._schema_lock = threading.Lock()

    @contextmanager
    def connection(self):
        con = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            con = sqlite3.connect(self.path, timeout=5)
            con.row_factory = sqlite3.Row
            con.execute("PRAGMA foreign_keys=ON")
            with self._schema_lock:
                if not self._ready:
                    version = con.execute("PRAGMA user_version").fetchone()[0]
                    if version not in (0, 1):
                        raise StorageUnavailable("Unsupported observation database version")
                    con.execute("PRAGMA journal_mode=WAL")
                    con.executescript("""
                        CREATE TABLE IF NOT EXISTS analysis_runs (
                            id TEXT PRIMARY KEY, source_label TEXT NOT NULL,
                            source_type TEXT NOT NULL, created_at TEXT NOT NULL,
                            completed_at TEXT, state TEXT NOT NULL);
                        CREATE TABLE IF NOT EXISTS observations (
                            id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES analysis_runs(id),
                            event_type TEXT NOT NULL, model TEXT NOT NULL,
                            recorded_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                            start_s REAL, end_s REAL, score REAL NOT NULL,
                            observation_count INTEGER NOT NULL, details TEXT NOT NULL,
                            status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','ack','closed')),
                            UNIQUE(run_id,event_type,model));
                        CREATE INDEX IF NOT EXISTS observations_order ON observations(recorded_at DESC,id DESC);
                        CREATE INDEX IF NOT EXISTS observations_status ON observations(status);
                        CREATE TABLE IF NOT EXISTS observation_changes (
                            id INTEGER PRIMARY KEY, observation_id INTEGER NOT NULL REFERENCES observations(id),
                            previous_status TEXT NOT NULL, status TEXT NOT NULL, changed_at TEXT NOT NULL);
                        PRAGMA user_version=1;
                    """)
                    self._ready = True
            with con:
                yield con
        except (sqlite3.Error, OSError) as exc:
            raise StorageUnavailable("Observation history is unavailable; check the local database") from exc
        finally:
            if con:
                con.close()

    @staticmethod
    def _begin(con, name, source_type, run_id, state):
        con.execute("INSERT INTO analysis_runs VALUES (?,?,?,?,?,?)",
                    (run_id, source_label(name, source_type), source_type, now(), None, state))

    def begin(self, name, source_type, run_id=None):
        run_id = run_id or uuid.uuid4().hex
        with self.connection() as con:
            self._begin(con, name, source_type, run_id, "running")
        return run_id

    @staticmethod
    def _observe(con, run_id, model, observations):
        timestamp = now()
        for item in observations:
            if item["event_type"] not in EVENT_TYPES:
                raise ValueError("Unknown observation type")
            score = float(item["score"])
            if not 0 <= score <= 1:
                raise ValueError("Invalid observation score")
            con.execute("""INSERT INTO observations
                (run_id,event_type,model,recorded_at,updated_at,start_s,end_s,score,observation_count,details)
                VALUES (?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(run_id,event_type,model) DO UPDATE SET
                updated_at=excluded.updated_at,
                start_s=MIN(observations.start_s,excluded.start_s),
                end_s=MAX(observations.end_s,excluded.end_s),
                score=MAX(observations.score,excluded.score),
                observation_count=observations.observation_count+excluded.observation_count,
                details=CASE WHEN excluded.score>=observations.score THEN excluded.details ELSE observations.details END
                """, (run_id,item["event_type"],model,timestamp,timestamp,item.get("start_s"),item.get("end_s"),
                      score,item["count"],json.dumps(item.get("details",{}), ensure_ascii=False)))

    def observe(self, run_id, model, observations):
        with self.connection() as con:
            self._observe(con, run_id, model, observations)

    def finish(self, run_id, state):
        with self.connection() as con:
            con.execute("UPDATE analysis_runs SET state=?,completed_at=? WHERE id=?", (state,now(),run_id))

    def interrupt_running(self):
        with self.connection() as con:
            con.execute("UPDATE analysis_runs SET state='interrupted',completed_at=? WHERE state='running'", (now(),))

    def save_analysis(self, name, stage1=None, stage2=None, pipeline=None):
        run_id = uuid.uuid4().hex
        with self.connection() as con:
            self._begin(con, name, "upload", run_id, "completed")
            if stage1:
                for frame in stage1["frames"]:
                    self._observe(con, run_id, stage1["model"], frame_observations(frame))
            if stage2:
                for window in stage2["windows"]:
                    self._observe(con, run_id, "x3d_s", [window_observation(window)])
            if pipeline:
                for window in pipeline["windows"]:
                    if window["decision"] == "review_fall_fight_conflict":
                        self._observe(con, run_id, "x3d_s", [{"event_type": window["decision"],
                            "start_s": window["start_s"], "end_s": window["end_s"],
                            "score": window["fight_probability"], "count": 1,
                            "details": {"decision": "Fall/Fight conflict; human review required"}}])
            con.execute("UPDATE analysis_runs SET completed_at=? WHERE id=?", (now(),run_id))
        return run_id

    @staticmethod
    def _item(row):
        item = dict(row)
        item["details"] = json.loads(item["details"])
        return item

    def list(self, *, page=1, page_size=10, q="", status=None, event_type=None, run_id=None, period="all"):
        clauses, params = [], []
        for key,value in (("status",status),("event_type",event_type),("run_id",run_id)):
            if value:
                clauses.append(f"o.{key}=?")
                params.append(value)
        if q:
            clauses.append("instr(lower(r.source_label||' '||o.run_id||' '||o.event_type||' '||o.model||' '||o.id),lower(?))>0")
            params.append(q)
        if period != "all":
            local = datetime.now(BANGKOK)
            midnight = local.replace(hour=0,minute=0,second=0,microsecond=0)
            lower = midnight if period == "today" else midnight-timedelta(days=1) if period == "yesterday" else local-timedelta(days=7)
            clauses.append("o.recorded_at>=?")
            params.append(lower.astimezone(UTC).isoformat(timespec="microseconds"))
            if period == "yesterday":
                clauses.append("o.recorded_at<?")
                params.append(midnight.astimezone(UTC).isoformat(timespec="microseconds"))
        where = " WHERE "+" AND ".join(clauses) if clauses else ""
        joined = " FROM observations o JOIN analysis_runs r ON r.id=o.run_id"
        with self.connection() as con:
            con.execute("BEGIN")
            total = con.execute("SELECT COUNT(*)"+joined+where,params).fetchone()[0]
            pages = max(1,(total+page_size-1)//page_size)
            page = min(page,pages)
            rows = con.execute("SELECT o.*,r.source_label,r.source_type,r.state AS run_state"+joined+where+
                               " ORDER BY o.recorded_at DESC,o.id DESC LIMIT ? OFFSET ?",
                               [*params,page_size,(page-1)*page_size]).fetchall()
            pending = con.execute("SELECT COUNT(*) FROM observations WHERE status='new'").fetchone()[0]
        return {"items":[self._item(row) for row in rows],"total":total,"page":page,
                "page_size":page_size,"pages":pages,"pending_total":pending}

    def sources(self):
        with self.connection() as con:
            return [dict(row) for row in con.execute("SELECT * FROM analysis_runs ORDER BY created_at DESC,id DESC LIMIT 100")]

    def dashboard(self, period="7d"):
        """Count stored summary rows, not incidents, people, or frame observations.

        Calendar periods use Bangkok dates. Daily counts use first recorded_at;
        an existing Live summary updated today stays in its original day's bucket.
        """
        if period not in {"today", "7d", "all"}:
            raise ValueError("Unknown dashboard period")
        timestamp = datetime.now(UTC)
        local = timestamp.astimezone(BANGKOK)
        midnight = local.replace(hour=0, minute=0, second=0, microsecond=0)
        chart_start = midnight - timedelta(days=6)
        lower = midnight if period == "today" else chart_start if period == "7d" else None
        upper = timestamp.isoformat(timespec="microseconds")
        lower_utc = lower.astimezone(UTC).isoformat(timespec="microseconds") if lower else None
        clauses = "recorded_at<=?" + (" AND recorded_at>=?" if lower else "")
        params = [upper, lower_utc] if lower else [upper]
        run_clauses = clauses.replace("recorded_at", "created_at")
        daily = {(chart_start + timedelta(days=n)).date().isoformat(): 0 for n in range(7)}
        by_type = {kind: 0 for kind in sorted(EVENT_TYPES)}
        by_status = {status: 0 for status in sorted(STATUSES)}
        with self.connection() as con:
            con.execute("BEGIN")  # All history panels share one read snapshot.
            for row in con.execute("SELECT event_type,status,COUNT(*) AS n FROM observations WHERE " +
                                   clauses + " GROUP BY event_type,status", params):
                by_type[row["event_type"]] = by_type.get(row["event_type"], 0) + row["n"]
                by_status[row["status"]] = by_status.get(row["status"], 0) + row["n"]
            for row in con.execute("SELECT substr(datetime(recorded_at,'+7 hours'),1,10) AS day,COUNT(*) AS n "
                                   "FROM observations WHERE " + clauses + " AND recorded_at>=? GROUP BY day",
                                   [*params, chart_start.astimezone(UTC).isoformat(timespec="microseconds")]):
                if row["day"] in daily:
                    daily[row["day"]] = row["n"]
            run_states = {row["state"]: row["n"] for row in con.execute(
                "SELECT state,COUNT(*) AS n FROM analysis_runs WHERE " + run_clauses + " GROUP BY state", params)}
            pending_total = con.execute("SELECT COUNT(*) FROM observations WHERE status='new'").fetchone()[0]
            latest = con.execute("SELECT o.*,r.source_label,r.source_type,r.state AS run_state FROM observations o "
                                 "JOIN analysis_runs r ON r.id=o.run_id WHERE " +
                                 clauses.replace("recorded_at", "o.recorded_at") +
                                 " ORDER BY o.recorded_at DESC,o.id DESC LIMIT 5", params).fetchall()
        return {"period": period, "timezone": "Asia/Bangkok", "time_basis": "recorded_at",
                "generated_at": upper, "range_start": lower_utc, "range_end": upper,
                "total": sum(by_type.values()), "by_type": by_type, "by_status": by_status,
                "pending_total": pending_total,
                "run_count": sum(run_states.values()), "run_states": run_states,
                "daily": [{"date": day, "count": n} for day, n in daily.items()],
                "latest": [self._item(row) for row in latest]}

    def get(self, event_id):
        with self.connection() as con:
            con.execute("BEGIN")
            row = con.execute("SELECT o.*,r.source_label,r.source_type,r.state AS run_state FROM observations o JOIN analysis_runs r ON r.id=o.run_id WHERE o.id=?",(event_id,)).fetchone()
            if not row:
                return None
            item = self._item(row)
            item["status_history"] = [dict(x) for x in con.execute("SELECT previous_status,status,changed_at FROM observation_changes WHERE observation_id=? ORDER BY id",(event_id,))]
            return item

    def set_status(self, event_id, status):
        if status not in STATUSES:
            raise ValueError("Invalid review status")
        with self.connection() as con:
            con.execute("BEGIN IMMEDIATE")
            row = con.execute("SELECT status FROM observations WHERE id=?",(event_id,)).fetchone()
            if not row:
                return False
            if row[0] != status:
                timestamp = now()
                con.execute("UPDATE observations SET status=?,updated_at=? WHERE id=?",(status,timestamp,event_id))
                con.execute("INSERT INTO observation_changes(observation_id,previous_status,status,changed_at) VALUES (?,?,?,?)",(event_id,row[0],status,timestamp))
        return True
