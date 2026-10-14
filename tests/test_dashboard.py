"""Dashboard semantics: summary rows, Bangkok dates, and actual session state."""
from datetime import datetime as RealDateTime, timezone

from fastapi.testclient import TestClient

from conftest import image_bytes, write_video
from test_api import NoFaceFixture
from test_pipeline_live import Registry
from webapp.api import create_app
from webapp.event_store import EventStore
import webapp.event_store as history


def test_dashboard_calendar_boundaries_counts_and_review(tmp_path, monkeypatch):
    # 00:30 Bangkok, just after the UTC date boundary used by this product.
    fixed = RealDateTime(2026, 10, 13, 17, 30, tzinfo=timezone.utc)

    class Clock(RealDateTime):
        @classmethod
        def now(cls, tz=None):
            return fixed.astimezone(tz) if tz else fixed.replace(tzinfo=None)

    monkeypatch.setattr(history, "datetime", Clock)
    store = EventStore(tmp_path / 'history.sqlite3')
    times = ['2026-10-07T16:59:59.000000+00:00',  # outside 7 calendar days
             '2026-10-07T17:00:00.000000+00:00',  # Oct 8 Bangkok
             '2026-10-13T16:59:59.000000+00:00',  # yesterday
             '2026-10-13T17:00:00.000000+00:00']  # today
    for timestamp in times:
        monkeypatch.setattr(history, 'now', lambda t=timestamp: t)
        run = store.begin('example.mp4', 'replay')
        observation = {'event_type':'fire','score':.8,'count':5,'start_s':1,'end_s':2}
        store.observe(run, 'yolov8n', [observation, observation])
        store.finish(run, 'stopped')
    monkeypatch.setattr(history, 'now', lambda: fixed.isoformat(timespec='microseconds'))
    store.begin('no-results.jpg', 'upload')
    data = store.dashboard('7d')
    assert data['total'] == data['by_type']['fire'] == data['by_status']['new'] == 3
    assert data['run_count'] == 4 and data['run_states'] == {'stopped':3,'running':1}
    assert data['pending_total'] == 4
    assert [x['date'] for x in data['daily']] == [f'2026-10-{d:02d}' for d in range(8,15)]
    assert [x['count'] for x in data['daily']] == [1,0,0,0,0,1,1]
    assert data['latest'][0]['observation_count'] == 10  # KPI counts 1 row, not 10 boxes.
    today = store.dashboard('today')
    assert today['total'] == 1 and today['run_count'] == 2
    event = today['latest'][0]
    store.set_status(event['id'], 'closed')
    assert store.dashboard('today')['by_status'] == {'ack':0,'closed':1,'new':0}
    store.observe(event['run_id'], 'yolov8n', [observation])
    assert store.dashboard('today')['total'] == 1
    assert store.dashboard('all')['total'] == 4
    assert sum(x['count'] for x in store.dashboard('all')['daily']) == 3


def test_empty_dashboard_and_storage_error(tmp_path):
    with TestClient(create_app(registry=Registry())) as client:
        data = client.get('/api/dashboard').json()
        assert data['total'] == data['run_count'] == data['pending_total'] == 0
        assert data['latest'] == [] and all(x['count']==0 for x in data['daily'])
        assert client.get('/api/live/status').json()['status']=='idle'
        assert client.get('/api/dashboard?period=invalid').status_code==400
    with TestClient(create_app(registry=Registry(),event_store=EventStore(tmp_path))) as client:
        result = client.get('/api/dashboard')
        assert result.status_code == 503 and result.json()['error']['code']=='storage_unavailable'
        assert str(tmp_path) not in result.text


def test_dashboard_upload_review_replay_and_restart(tmp_path):
    store = EventStore(tmp_path/'dashboard.sqlite3')
    video = write_video(tmp_path/'clip.avi',n_frames=30,fps=100)
    with TestClient(create_app(registry=Registry(),face_anonymizer_factory=NoFaceFixture,event_store=store)) as client:
        assert client.post('/api/stage1/analyze',files={'file':('image.jpg',image_bytes())},data={'model':'yolov8n','device':'cpu'}).status_code==200
        data = client.get('/api/dashboard?period=all').json()
        logs = client.get('/api/logs?page_size=100').json()
        assert data['total'] == logs['total'] and data['run_count']==1
        assert data['by_type']['person']==1
        assert sum(data['by_type'].values()) == sum(data['by_status'].values()) == data['total']
        assert len(data['latest']) <= 5
        event = data['latest'][0]
        assert client.patch(f"/api/logs/{event['id']}",json={'status':'ack'}).status_code==200
        assert client.get('/api/dashboard').json()['by_status']['ack']==1
        result = client.post('/api/live/start-upload',files={'file':('clip.avi',video.read_bytes())},data={'device':'cpu'})
        assert result.status_code==200 and client.app.state.live_session.wait(5)
        data = client.get('/api/dashboard?period=all').json()
        live = client.get('/api/live/status').json()
        assert live['session_id']==result.json()['session_id'] and live['status']=='stopped'
        assert data['run_count']==2 and data['run_states']=={'completed':1,'stopped':1}
        assert data['total']==client.get('/api/logs').json()['total']
    with TestClient(create_app(registry=Registry(),event_store=EventStore(store.path))) as client:
        reopened = client.get('/api/dashboard?period=all').json()
        for key in ['total','run_count','run_states','by_type','by_status','daily','latest']:
            assert reopened[key]==data[key]
        assert client.get('/api/live/status').json()['status']=='idle'  # history != active process
