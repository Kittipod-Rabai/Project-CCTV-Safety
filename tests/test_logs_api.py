from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from conftest import image_bytes, write_video
from test_api import NoFaceFixture
from test_pipeline_live import Registry
from webapp.api import create_app
from webapp.event_store import EventStore, StorageUnavailable


def test_upload_history_reopens_with_review_state(tmp_path):
    path = tmp_path / "persistent.sqlite3"
    with TestClient(create_app(registry=Registry(), face_anonymizer_factory=NoFaceFixture, event_store=EventStore(path))) as client:
        assert client.get('/api/logs').json()['items'] == []
        response = client.post('/api/stage1/analyze',files={'file':('scene.jpg',image_bytes())},data={'model':'yolov8n','device':'cpu'})
        assert response.status_code == 200
        logs = client.get('/api/logs').json()
        assert logs['total'] > 0
        person = next(x for x in logs['items'] if x['event_type']=='person')
        assert person['observation_count']==2 and person['source_label']=='scene.jpg'
        assert person['start_s'] is None and person['run_state']=='completed'
        assert client.patch(f"/api/logs/{person['id']}",json={'status':'ack'}).status_code==200
        assert client.get('/api/logs',params={'status':'ack'}).json()['total']==1
        assert client.get('/api/logs',params={'q':"' OR 1=1 --"}).json()['total']==0
    with TestClient(create_app(registry=Registry(),event_store=EventStore(path))) as client:
        event = client.get(f"/api/logs/{person['id']}").json()
        assert event['status']=='ack' and len(event['status_history'])==1
        assert client.patch(f"/api/logs/{person['id']}",json={'status':'closed'}).json()['status']=='closed'
        assert client.get('/api/logs/sources').json()['items'][0]['source_label']=='scene.jpg'


def test_pipeline_saves_both_stages_once_and_failure_saves_nothing(tmp_path):
    video=write_video(tmp_path/'test.avi',n_frames=30,fps=10)
    with TestClient(create_app(registry=Registry(),face_anonymizer_factory=NoFaceFixture)) as client:
        assert client.post('/api/pipeline/analyze',files={'file':(video.name,video.read_bytes())},data={'model':'yolov8n','device':'cpu'}).status_code==200
        runs=client.get('/api/logs/sources').json()['items']
        assert len(runs)==1
        rows=client.get('/api/logs',params={'run_id':runs[0]['id'],'page_size':100}).json()['items']
        assert {'yolov8n','x3d_s'} == {x['model'] for x in rows}
        assert next(x for x in rows if x['event_type']=='person')['observation_count']==60
        assert next(x for x in rows if x['event_type']=='non_fight')['end_s']==3
        response=client.post('/api/pipeline/analyze',files={'file':('bad.avi',b'bad file')},data={'model':'yolov8n','device':'cpu'})
        assert response.status_code==422
        assert len(client.get('/api/logs/sources').json()['items'])==1


def test_replay_history_matches_session_and_survives_stop(tmp_path):
    video=write_video(tmp_path/'test.avi',n_frames=35,fps=100)
    with TestClient(create_app(registry=Registry(),face_anonymizer_factory=NoFaceFixture)) as client:
        result=client.post('/api/live/start-upload',files={'file':(video.name,video.read_bytes())},data={'device':'cpu'})
        assert result.status_code==200
        sid=result.json()['session_id']
        live=client.app.state.live_session
        assert live.wait(5)
        assert not Path(live.source).exists()
        assert client.get('/api/logs',params={'run_id':sid}).json()['total']>0
        run=client.get('/api/logs/sources').json()['items'][0]
        assert run['id']==sid and run['state']=='stopped' and run['source_label']=='test.avi'


@pytest.mark.parametrize('params',[{'page':0},{'page_size':101},{'status':'confirmed'},{'event_type':'bad'},{'period':'future'}])
def test_logs_reject_invalid_filters(params):
    with TestClient(create_app(registry=Registry())) as client:
        assert client.get('/api/logs',params=params).status_code==400


def test_invalid_review_and_missing_item():
    with TestClient(create_app(registry=Registry())) as client:
        assert client.patch('/api/logs/1',json={'status':'confirmed'}).status_code==400
        assert client.patch('/api/logs/1',json={'status':'ack'}).status_code==404
        assert client.get('/api/logs/1').status_code==404


def test_database_error_is_visible_and_does_not_leak_path(tmp_path):
    with TestClient(create_app(registry=Registry(),face_anonymizer_factory=NoFaceFixture,event_store=EventStore(tmp_path))) as client:
        result=client.get('/api/logs')
        assert result.status_code==503 and result.json()['error']['code']=='storage_unavailable'
        assert str(tmp_path) not in result.text
        result=client.post('/api/stage1/analyze',files={'file':('a.jpg',image_bytes())},data={'model':'yolov8n','device':'cpu'})
        assert result.status_code==503
        assert client.app.state.analysis_semaphore.acquire(blocking=False)
        client.app.state.analysis_semaphore.release()


def test_live_storage_failure_is_error_and_still_cleans_up(tmp_path):
    class BrokenWrites(EventStore):
        def observe(self, *args):
            raise StorageUnavailable('fixture storage failure')
    store=BrokenWrites(tmp_path/'history.sqlite3')
    video=write_video(tmp_path/'test.avi',n_frames=30,fps=100)
    with TestClient(create_app(registry=Registry(),face_anonymizer_factory=NoFaceFixture,event_store=store)) as client:
        result=client.post('/api/live/start-upload',files={'file':(video.name,video.read_bytes())},data={'device':'cpu'})
        assert result.status_code==200
        live=client.app.state.live_session
        assert live.wait(5) and live.state=='error'
        assert store.sources()[0]['state']=='error' and not Path(live.source).exists()
        assert client.app.state.analysis_semaphore.acquire(blocking=False)
        client.app.state.analysis_semaphore.release()
