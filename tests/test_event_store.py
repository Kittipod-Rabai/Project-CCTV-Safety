import concurrent.futures
import sqlite3

import pytest

from webapp.event_store import EventStore, StorageUnavailable, frame_observations


def item(kind="fire", score=.8, t=1):
    return {"event_type":kind,"score":score,"start_s":t,"end_s":t,"count":1,"details":{}}


def test_persistence_aggregation_and_status_audit(tmp_path):
    path = tmp_path / "history.sqlite3"
    store = EventStore(path)
    run = store.begin(r"C:\private\demo.mp4", "replay")
    store.observe(run,"yolov8n",[item()])
    event = store.list()["items"][0]
    assert event["source_label"] == "demo.mp4"
    assert store.set_status(event["id"],"ack")
    store.observe(run,"yolov8n",[item(score=.9,t=3)])
    store.finish(run,"stopped")
    reopened = EventStore(path)
    event = reopened.get(event["id"])
    assert event["status"] == "ack" and event["observation_count"] == 2
    assert event["start_s"] == 1 and event["end_s"] == 3 and event["score"] == .9
    assert event["run_state"] == "stopped" and len(event["status_history"]) == 1
    reopened.set_status(event["id"],"closed")
    reopened.set_status(event["id"],"closed")
    assert len(reopened.get(event["id"])["status_history"]) == 2


def test_concurrent_writes_and_filter_pagination(tmp_path):
    store = EventStore(tmp_path / "history.sqlite3")
    run = store.begin("a.mp4","upload")
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(lambda _: store.observe(run,"yolov8n",[item()]),range(20)))
    assert store.list()["items"][0]["observation_count"] == 20
    for n in range(12):
        rid = store.begin(f"source{n}.mp4","upload")
        store.observe(rid,"yolov8n",[item("smoke")])
    assert len(store.list(page_size=10)["items"]) == 10
    assert store.list(page=2)["total"] == 13
    assert len(store.list(page=2)["items"]) == 3
    assert store.list(event_type="fire",run_id=run)["total"] == 1
    assert store.list(q="source1")["total"] == 3
    assert store.list(q="' OR 1=1 --")["total"] == 0
    assert store.list(q="%_")["total"] == 0
    assert store.list(period="today")["total"] == 13
    assert store.list(period="yesterday")["total"] == 0


def test_atomic_upload_and_no_credentials_or_media(tmp_path):
    store = EventStore(tmp_path / "history.sqlite3")
    run = store.begin("rtsp://user:secret@camera/private", "rtsp")
    assert store.sources()[0]["source_label"] == "RTSP stream"
    stage1 = {"model":"yolov8n","frames":[{"time_s":None,"detections":[
        {"class_name":"fire","confidence":.9,"xyxy":[0,0,20,20]}]}]}
    store.save_analysis("demo.jpg",stage1=stage1)
    assert store.list()["items"][0]["start_s"] is None
    stage1["frames"].append({"detections":[{"class_name":"invalid","confidence":.9}]})
    before = len(store.sources())
    with pytest.raises(ValueError):
        store.save_analysis("bad.jpg",stage1=stage1)
    assert len(store.sources()) == before
    store.interrupt_running()
    assert next(r for r in store.sources() if r["id"] == run)["state"] == "interrupted"
    with sqlite3.connect(store.path) as con:
        assert "secret" not in str(con.execute("SELECT * FROM analysis_runs").fetchall())


def test_derived_ppe_score_is_identified():
    events = frame_observations({"time_s":2,"ppe":[{"alerts":["no_helmet"],"person_confidence":.9}]})
    assert events[0]["details"]["score_basis"].startswith("person_confidence")


def test_storage_unavailable_does_not_silently_succeed(tmp_path):
    with pytest.raises(StorageUnavailable):
        EventStore(tmp_path).list()  # a directory cannot be opened as a SQLite database
