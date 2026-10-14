"""Notification policy, durable cooldown, migration, and analysis-to-history links."""
import concurrent.futures
from datetime import datetime, timedelta, timezone
import sqlite3

import pytest
from fastapi.testclient import TestClient

from cctv_safety.ppe import Detection
from conftest import image_bytes, write_video
from test_api import NoFaceFixture
from test_pipeline_live import Registry
from webapp.api import create_app
from webapp.event_store import EventStore, StorageUnavailable
import webapp.event_store as history


def observation(kind="fire", score=.8):
    return {"event_type":kind,"score":score,"count":1,"start_s":1,"end_s":2}


def test_continuous_event_cooldown_current_score_review_and_restart(tmp_path, monkeypatch):
    clock = datetime(2026,10,14,tzinfo=timezone.utc)
    monkeypatch.setattr(history,'now',lambda:clock.isoformat(timespec='microseconds'))
    path = tmp_path/'notifications.sqlite3'
    store = EventStore(path)
    run = store.begin('replay.mp4','replay')
    for _ in range(100):
        store.observe(run,'yolov8n',[observation()])
    assert store.notifications()['total']==1  # 100 frames, one notice.
    event = store.list()['items'][0]
    assert event['observation_count']==100
    clock += timedelta(seconds=29.999)
    store.observe(run,'yolov8n',[observation()])
    assert store.notifications()['total']==1
    clock += timedelta(milliseconds=1)
    store.observe(run,'yolov8n',[observation()])
    assert store.notifications()['total']==2
    clock += timedelta(seconds=31)
    store.observe(run,'yolov8n',[observation(score=.2)])
    assert store.notifications()['total']==2  # Stored historical max must not trigger.
    store.set_status(event['id'],'ack')
    clock += timedelta(seconds=60)
    store.observe(run,'yolov8n',[observation()])
    store.set_status(event['id'],'closed')
    store.observe(run,'yolov8n',[observation()])
    assert store.notifications()['total']==2
    store.set_status(event['id'],'new')
    store.observe(run,'yolov8n',[observation()])
    assert store.notifications()['total']==3
    reopened = EventStore(path)
    reopened.observe(run,'yolov8n',[observation()])
    assert reopened.notifications()['total']==3  # Restart cannot reset cooldown.
    assert {n['observation_id'] for n in reopened.notifications()['items']}=={event['id']}


def test_only_suspected_safety_results_notify(tmp_path):
    store = EventStore(tmp_path/'notifications.sqlite3')
    run = store.begin('scene.jpg','upload')
    for kind in ['person','helmet','vest','non_fight','fall','fire','smoke','no_helmet','no_vest','fight','review_fall_fight_conflict']:
        store.observe(run,'fixture',[observation(kind,.9)])
    types = {n['event_type'] for n in store.notifications()['items']}
    assert types=={'fall','fire','smoke','no_helmet','no_vest','fight','review_fall_fight_conflict'}
    run = store.begin('below-threshold.mp4','upload')
    store.observe(run,'x3d_s',[observation('fight',.6999)])
    assert store.notifications()['total']==7
    store.observe(run,'x3d_s',[observation('fight',.7)])
    assert store.notifications()['total']==8


def test_concurrent_workers_share_one_notification_gate(tmp_path):
    store = EventStore(tmp_path/'notifications.sqlite3')
    run = store.begin('live.mp4','replay')
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(lambda _:store.observe(run,'yolov8n',[observation()]),range(25)))
    assert store.notifications()['total']==1
    assert store.list()['items'][0]['observation_count']==25


def test_v1_migration_preserves_history_without_backfilling_notifications(tmp_path):
    path = tmp_path/'legacy.sqlite3'
    store = EventStore(path)
    run = store.begin('legacy.mp4','replay')
    store.observe(run,'yolov8n',[observation()])
    old = store.list()['items'][0]
    store.set_status(old['id'],'ack')
    with sqlite3.connect(path) as con:
        con.execute('DROP TABLE notifications')
        con.execute('PRAGMA user_version=1')
    migrated = EventStore(path)
    assert migrated.notifications()['items']==[]
    assert migrated.get(old['id'])['status']=='ack'
    assert len(migrated.get(old['id'])['status_history'])==1
    with sqlite3.connect(path) as con:
        assert con.execute('PRAGMA user_version').fetchone()[0]==3
    new_run = migrated.begin('new.mp4','upload')
    migrated.observe(new_run,'yolov8n',[observation()])
    assert migrated.notifications()['total']==1


def test_notification_failure_rolls_back_analysis_and_unsupported_schema_is_rejected(tmp_path):
    path = tmp_path/'history.sqlite3'
    store = EventStore(path)
    assert store.notifications()['total']==0
    with sqlite3.connect(path) as con:
        con.execute("CREATE TRIGGER broken_notice BEFORE INSERT ON notifications BEGIN SELECT RAISE(FAIL,'fixture failure'); END")
    stage1 = {'model':'yolov8n','frames':[{'detections':[{'class_name':'fire','confidence':.9}]}]}
    with pytest.raises(StorageUnavailable):
        store.save_analysis('failed.jpg',stage1=stage1)
    assert store.list()['total']==0 and store.sources()==[] and store.notifications()['total']==0
    with sqlite3.connect(path) as con:
        con.execute('PRAGMA user_version=99')
    with pytest.raises(StorageUnavailable):
        EventStore(path).notifications()


def test_notification_cursor_pages_without_loss_or_repeat(tmp_path):
    store = EventStore(tmp_path/'history.sqlite3')
    for n in range(55):
        run = store.begin(f'{n}.jpg','upload')
        store.observe(run,'yolov8n',[observation()])
    snapshot = store.notifications()
    assert snapshot['total']==55 and len(snapshot['items'])==20 and snapshot['cursor']==55
    first = store.notifications(after_id=0,limit=50)
    second = store.notifications(after_id=first['cursor'],limit=50)
    assert first['has_more'] and not second['has_more']
    assert [n['id'] for n in first['items']+second['items']]==list(range(1,56))
    assert store.notifications(after_id=55)['items']==[]
    reset = store.notifications(after_id=999)
    assert reset['reset'] and reset['cursor']==55


class RiskRegistry(Registry):
    def stage1(self, name, frames, thresholds=None, options=None, device=None):
        return [[Detection('fire',.95,(0,0,20,20))] for _ in frames]

    def stage2(self, clips, device=None):
        return [(.1,.9) for _ in clips]


def test_upload_pipeline_live_notifications_open_real_history_and_persist(tmp_path):
    path = tmp_path/'api.sqlite3'
    video = write_video(tmp_path/'clip.avi',n_frames=35,fps=10)
    with TestClient(create_app(registry=RiskRegistry(),face_anonymizer_factory=NoFaceFixture,event_store=EventStore(path))) as client:
        assert client.get('/api/notifications').json()['total']==0
        assert client.post('/api/stage1/analyze',files={'file':('image.jpg',image_bytes())},data={'model':'yolov8n','device':'cpu'}).status_code==200
        assert client.post('/api/pipeline/analyze',files={'file':('clip.avi',video.read_bytes())},data={'model':'yolov8n','device':'cpu'}).status_code==200
        assert client.post('/api/live/start-upload',files={'file':('clip.avi',video.read_bytes())},data={'device':'cpu'}).status_code==200
        assert client.app.state.live_session.wait(5)
        data = client.get('/api/notifications').json()
        assert data['total']==5  # image Fire; pipeline Fire/Fight; Live Fire/Fight
        for notice in data['items']:
            event = client.get(f"/api/logs/{notice['observation_id']}").json()
            assert event['run_id']==notice['run_id'] and event['event_type']==notice['event_type']
        cursor = data['cursor']
        assert client.get('/api/notifications',params={'after_id':cursor}).json()['items']==[]
    with TestClient(create_app(registry=Registry(),event_store=EventStore(path))) as client:
        assert client.get('/api/notifications').json()['items']==data['items']
        assert client.get('/api/notifications',params={'after_id':cursor}).json()['items']==[]


@pytest.mark.parametrize('params',[{'after_id':-1},{'after_id':2**63},{'limit':0},{'limit':51}])
def test_notification_api_validates_cursor_and_limit(params):
    with TestClient(create_app(registry=Registry())) as client:
        assert client.get('/api/notifications',params=params).status_code==400


def test_notification_api_storage_failure_is_explicit(tmp_path):
    with TestClient(create_app(registry=Registry(),event_store=EventStore(tmp_path))) as client:
        response=client.get('/api/notifications')
        assert response.status_code==503 and response.json()['error']['code']=='storage_unavailable'
        assert str(tmp_path) not in response.text
