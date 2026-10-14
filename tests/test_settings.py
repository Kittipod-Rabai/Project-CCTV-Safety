"""Saved defaults reach inference, survive restart, and cannot silently overwrite edits."""
import concurrent.futures
import copy
import json
import sqlite3
import threading

import pytest
from fastapi.testclient import TestClient

from conftest import image_bytes, write_video
from test_api import NoFaceFixture
from test_pipeline_live import Capture, Registry
from webapp.api import create_app
from webapp.event_store import EventStore


def changed(client):
    data = client.get('/api/settings').json()
    settings = copy.deepcopy(data['analysis_settings'])
    settings['yolo'].update(iou=.52,imgsz=480,max_det=37)
    settings['yolo']['thresholds']['person']=.61
    settings['x3d']['fight_threshold']=.8
    settings['tracking'].update(proximity_diagonals=.2,motion_diagonals_per_s=.3,max_track_gap_s=1.1)
    return {'analysis_settings':settings,'revision':data['revision']}


def test_saved_defaults_reach_all_upload_endpoints_and_survive_restart(tmp_path):
    store = EventStore(tmp_path/'settings.sqlite3')
    registry = Registry()
    video = write_video(tmp_path/'clip.avi',n_frames=30,fps=10)
    with TestClient(create_app(registry=registry,face_anonymizer_factory=NoFaceFixture,event_store=store)) as client:
        initial = client.get('/api/settings').json()
        assert initial['revision']==0 and initial['updated_at'] is None
        assert initial['analysis_settings']==initial['defaults']
        payload = changed(client)
        saved = client.put('/api/settings',json=payload)
        assert saved.status_code==200 and saved.json()['revision']==1
        for endpoint,source in [('/api/stage1/analyze',('image.jpg',image_bytes())),('/api/stage2/analyze',('clip.avi',video.read_bytes())),('/api/pipeline/analyze',('clip.avi',video.read_bytes()))]:
            response=client.post(endpoint,files={'file':source},data={'model':'yolov8n','device':'cpu'})
            assert response.status_code==200,response.text
            body=response.json()
            parts=[body['stage1'],body['stage2']] if endpoint.endswith('pipeline/analyze') else [body]
            for part in parts:
                assert part['analysis_settings']==payload['analysis_settings'] and part['settings_revision']==1
        assert registry.last_thresholds['person']==pytest.approx(.61)
        assert registry.last_options=={'iou':.52,'imgsz':480,'max_det':37}
        # Partial per-request overrides inherit saved values and do not persist.
        response=client.post('/api/stage1/analyze',files={'file':('override.jpg',image_bytes())},data={
            'model':'yolov8n','device':'cpu','analysis_settings':json.dumps({'yolo':{'thresholds':{'person':.4}}})})
        assert response.status_code==200
        assert response.json()['thresholds']['person']==.4
        assert response.json()['analysis_settings']['yolo']['imgsz']==480
        assert client.get('/api/settings').json()==saved.json()
    with TestClient(create_app(registry=Registry(),event_store=EventStore(store.path))) as client:
        assert client.get('/api/settings').json()==saved.json()
        # Reset is a normal versioned save of project defaults.
        reset=client.put('/api/settings',json={'analysis_settings':initial['defaults'],'revision':1})
        assert reset.status_code==200 and reset.json()['revision']==2
        assert reset.json()['analysis_settings']==initial['defaults']


def test_settings_save_conflict_preserves_winning_document(tmp_path):
    with TestClient(create_app(registry=Registry(),event_store=EventStore(tmp_path/'settings.sqlite3'))) as client:
        a=changed(client);b=copy.deepcopy(a);b['analysis_settings']['x3d']['fight_threshold']=.6
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda payload:client.put('/api/settings',json=payload),[a,b]))
        assert sorted(r.status_code for r in results)==[200,409]
        winner=next(r.json() for r in results if r.status_code==200)
        assert client.get('/api/settings').json()==winner
        assert next(r.json() for r in results if r.status_code==409)['error']['code']=='settings_conflict'


@pytest.mark.parametrize('path,value',[
    ('yolo.thresholds.person',0),('yolo.thresholds.person',.999),('yolo.thresholds.person',True),
    ('yolo.thresholds.person','0.5'),('yolo.imgsz',640.5),('yolo.imgsz',500),
    ('yolo.max_det',1.5),('yolo.max_det',1001),('x3d.fight_threshold',.99),
    ('tracking.max_track_gap_s',0),('tracking.proximity_diagonals',True),
])
def test_invalid_saved_value_is_rejected_without_changing_revision(path,value):
    with TestClient(create_app(registry=Registry())) as client:
        before=client.get('/api/settings').json();payload=changed(client)
        target=payload['analysis_settings'];keys=path.split('.')
        for key in keys[:-1]:target=target[key]
        target[keys[-1]]=value
        assert client.put('/api/settings',json=payload).status_code==400
        assert client.get('/api/settings').json()==before


def test_missing_unknown_nonfinite_and_invalid_revision_fields():
    with TestClient(create_app(registry=Registry())) as client:
        for mutation in [lambda p:p['analysis_settings']['yolo'].update(unknown=1),
                         lambda p:p['analysis_settings']['yolo']['thresholds'].pop('smoke'),
                         lambda p:p.update(revision=True),lambda p:p.update(revision=-1),
                         lambda p:p.update(revision=2**63),lambda p:p.update(extra=1)]:
            payload=changed(client);mutation(payload)
            assert client.put('/api/settings',json=payload).status_code==400
        for value in [float('nan'),float('inf'),10**400]:
            payload=changed(client);payload['analysis_settings']['yolo']['thresholds']['person']=value
            assert client.put('/api/settings',content=json.dumps(payload),headers={'Content-Type':'application/json'}).status_code==400
        assert client.get('/api/settings').json()['revision']==0


def test_save_during_inference_only_changes_next_request(tmp_path):
    entered,release=threading.Event(),threading.Event()
    class HeldRegistry(Registry):
        def stage1(self,*args,**kwargs):
            entered.set();assert release.wait(5)
            return super().stage1(*args,**kwargs)
    registry=HeldRegistry()
    with TestClient(create_app(registry=registry,face_anonymizer_factory=NoFaceFixture)) as client:
        first=changed(client);assert client.put('/api/settings',json=first).status_code==200
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            future=pool.submit(client.post,'/api/stage1/analyze',files={'file':('image.jpg',image_bytes())},data={'model':'yolov8n','device':'cpu'})
            try:
                assert entered.wait(5)
                second=changed(client);second['analysis_settings']['yolo']['thresholds']['person']=.8
                assert client.put('/api/settings',json=second).status_code==200
            finally:release.set()
            response=future.result(5)
        assert response.json()['settings_revision']==1 and response.json()['thresholds']['person']==.61
        next_result=client.post('/api/stage1/analyze',files={'file':('next.jpg',image_bytes())},data={'model':'yolov8n','device':'cpu'})
        assert next_result.json()['settings_revision']==2 and next_result.json()['thresholds']['person']==.8


def test_live_upload_and_rtsp_fixture_use_saved_snapshot(tmp_path):
    gate,entered=threading.Event(),threading.Event()
    cap=Capture(2,release_gate=gate,release_entered=entered)
    captures=iter([cap,Capture(2)])
    with TestClient(create_app(registry=Registry(),face_anonymizer_factory=NoFaceFixture,capture_factory=lambda _:next(captures))) as client:
        payload=changed(client);client.put('/api/settings',json=payload)
        result=client.post('/api/live/start-upload',files={'file':('clip.avi',b'fixture capture')},data={'device':'cpu'})
        try:
            assert result.status_code==200 and entered.wait(5)
            assert result.json()['settings_revision']==1
            next_settings=changed(client);next_settings['analysis_settings']['x3d']['fight_threshold']=.6
            assert client.put('/api/settings',json=next_settings).status_code==200
            current=client.get('/api/live/status').json()
            assert current['settings_revision']==1 and current['analysis_settings']==payload['analysis_settings']
        finally:gate.set()
        assert client.app.state.live_session.wait(5)
        assert client.app.state.live_session.state=='stopped'
        result=client.post('/api/live/start',json={'source_type':'rtsp','source':'rtsp://127.0.0.1/fixture','device':'cpu'})
        assert result.status_code==200 and result.json()['settings_revision']==2
        assert result.json()['analysis_settings']['x3d']['fight_threshold']==.6
        assert client.app.state.live_session.wait(5)


def test_v2_migration_and_corrupt_or_unavailable_settings_fail_closed(tmp_path):
    path=tmp_path/'legacy.sqlite3';store=EventStore(path)
    run=store.begin('legacy.mp4','replay')
    store.observe(run,'yolov8n',[{'event_type':'fire','score':.9,'count':1}])
    store.finish(run,'stopped');event=store.list()['items'][0];store.set_status(event['id'],'ack')
    with sqlite3.connect(path) as con:
        con.execute('DROP TABLE app_settings');con.execute('PRAGMA user_version=2')
    with TestClient(create_app(registry=Registry(),event_store=EventStore(path))) as client:
        assert client.get('/api/settings').json()['revision']==0
        assert client.get('/api/notifications').json()['total']==1
        assert client.get(f"/api/logs/{event['id']}").json()['status']=='ack'
        saved=client.put('/api/settings',json=changed(client));assert saved.status_code==200
        with sqlite3.connect(path) as con:con.execute("UPDATE app_settings SET payload='not json'")
        assert client.get('/api/settings').status_code==503
        assert client.post('/api/stage1/analyze',files={'file':('image.jpg',image_bytes())},data={'model':'yolov8n'}).status_code==503
    with TestClient(create_app(registry=Registry(),event_store=EventStore(tmp_path))) as client:
        assert client.get('/api/settings').status_code==503
        assert client.put('/api/settings',json={'analysis_settings':{},'revision':0}).status_code==400
        response=client.put('/api/settings',json={'analysis_settings':saved.json()['analysis_settings'],'revision':0})
        assert response.status_code==503 and response.json()['error']['code']=='storage_unavailable'
