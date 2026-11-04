import hashlib, json, struct, sys, tempfile, threading, time, unittest, subprocess
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parents[1]/'providers'/'unimate'))
import numpy as np
from motion_worker import MotionLibrary
from unimate_worker import UniMateMotionLibrary
from unimate_rig import HUMAN_CONTROL, derive, read_glb, node_worlds
BODY = list(HUMAN_CONTROL.values())
from unimate_motion import alignment

class LateEngine:
    def __init__(self, config, cancelled):
        self.cancelled=cancelled;self.loaded=False;self.gate=threading.Event();self.entered=threading.Event()
    def generate(self,prompt,duration,seed,folder):
        self.loaded=True;self.entered.set();self.gate.wait(2)
        qa={'valid':True,'avatarSha256':'a'*64}
        (folder/'clip.json').write_text(json.dumps({'clip':{},'qa':qa}))
        (folder/'unimate-features.npy').write_bytes(b'actual-test-output')
        return {'qa':qa,'generationSec':.01,'conversionSec':.001,'textEncodeSec':.001}

class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        self.config={'avatarSha256':'a'*64,'provider':'unimate-local','model':'fixture-model','generationRevision':'profile-1','unimate':{}}
        self.library=UniMateMotionLibrary(self.root,self.config,LateEngine)
    def tearDown(self):
        self.library.close();self.library.engine.gate.set();self.library.tasks.join();self.tmp.cleanup()
    def test_returns_before_generation_and_preserves_review_boundary(self):
        started=time.monotonic();j=self.library.submit({'prompt':'An object waves.','requestId':'one','durationSec':2})
        self.assertLess(time.monotonic()-started,.5);self.assertEqual(j['status'],'queued')
        self.library.engine.gate.set();self.library.tasks.join();done=self.library.jobs[j['id']]
        self.assertEqual(done['status'],'ready');self.assertEqual(done['review'],'pending');self.assertEqual(done['usageCount'],0)
        self.assertEqual(self.library.generation_status()['loaded'],True)
    def test_late_success_does_not_resurrect_cancelled_job(self):
        j=self.library.submit({'prompt':'An object waves.','requestId':'cancelled'})
        self.assertTrue(self.library.engine.entered.wait(1));self.library.cancel(j['id'])
        self.library.engine.gate.set();self.library.tasks.join()
        self.assertEqual(self.library.jobs[j['id']]['status'],'cancelled')
        self.assertNotIn('clipId',self.library.jobs[j['id']])
        self.assertEqual(self.library.submit({'prompt':'An object waves.','requestId':'cancelled'})['id'],j['id'])
    def test_request_alias_survives_restart_and_rejects_changed_arguments(self):
        a={'prompt':'An object waves.','durationSec':2,'requestId':'original'}
        j=self.library.submit(a)
        self.assertEqual(self.library.submit({**a,'requestId':'alias'})['id'],j['id'])
        self.library.engine.gate.set();self.library.tasks.join()
        restarted=UniMateMotionLibrary(self.root,self.config,LateEngine)
        try:
            self.assertEqual(restarted.submit({**a,'requestId':'alias'})['id'],j['id'])
            with self.assertRaisesRegex(ValueError,'belongs to another'):restarted.submit({**a,'requestId':'alias','durationSec':3})
        finally:restarted.close();restarted.tasks.join()
    def test_shutdown_cancels_active_work_and_rejects_new_requests(self):
        j=self.library.submit({'prompt':'An object waves.'})
        self.assertTrue(self.library.engine.entered.wait(1));self.library.close();self.library.engine.gate.set();self.library.tasks.join()
        self.assertEqual(self.library.jobs[j['id']]['status'],'cancelled')
        with self.assertRaisesRegex(ValueError,'stopped'):self.library.submit({'prompt':'An object sits.'})
        # close() is idempotent and may be called by the test teardown.
    def test_loading_legacy_clip_preserves_its_record_and_approval(self):
        self.library.close();self.library.tasks.join()
        legacy=self.root/'legacy';legacy.mkdir();record={'id':'legacy','key':'old','status':'ready','model':'previous-backend','avatarSha256':'b'*64,'review':'approved','usageCount':7,'createdAt':1}
        raw=json.dumps(record);(legacy/'job.json').write_text(raw)
        self.library=UniMateMotionLibrary(self.root,self.config,LateEngine)
        self.assertEqual((legacy/'job.json').read_text(),raw)
        self.assertEqual(self.library.catalog()['jobs'][0]['usageCount'],7)

class RigTests(unittest.TestCase):
    def test_control_rig_keeps_observed_world_transforms_and_source_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);nodes=[{'name':'scene','rotation':[0,0,.2,float(np.sqrt(.96))],'scale':[2,2,2],'children':[1]}]
            for i,name in enumerate(BODY):
                nodes.append({'name':name,'translation':[i*.02,1+i*.01,(i%3)*.03]})
            nodes[1]['children']=list(range(2,len(nodes)))
            g={'asset':{'version':'2.0'},'scene':0,'scenes':[{'nodes':[0]}],'nodes':nodes,'skins':[{'joints':list(range(1,len(nodes)))}]}
            g['extensions']={'VRMC_vrm':{'humanoid':{'humanBones':{semantic:{'node':BODY.index(name)+1} for semantic,name in HUMAN_CONTROL.items()}}}}
            text=json.dumps(g).encode();text+=b' '*(-len(text)%4)
            raw=struct.pack('<III',0x46546c67,2,20+len(text))+struct.pack('<II',len(text),0x4e4f534a)+text
            avatar=root/'source.glb';avatar.write_bytes(raw)
            report=derive(avatar,root/'proxy');self.assertEqual(avatar.read_bytes(),raw)
            out,_=read_glb(root/'proxy/control.glb');worlds,_=node_worlds(out['nodes']);source_worlds,_=node_worlds(nodes)
            for i,joint in enumerate(report['joints']):np.testing.assert_allclose(worlds[i],source_worlds[joint['sourceNode']],atol=1e-10)
            self.assertFalse(report['sourceGeometryChanged'])
            with self.assertRaisesRegex(ValueError,'new control'):derive(avatar,root/'proxy')
    def test_similarity_recovery_rejects_nonrigid_changes(self):
        a=np.array([[0,0,0],[1,0,0],[0,1,0],[0,0,1]],float)
        r=np.array([[0,-1,0],[1,0,0],[0,0,1]],float);b=2*(a@r.T)+[1,3,5]
        fit,scale,shift,error=alignment(a,b)
        np.testing.assert_allclose(fit,r,atol=1e-10);self.assertAlmostEqual(scale,2);self.assertLess(error,1e-10)
        b[0,0]+=.1
        with self.assertRaisesRegex(ValueError,'differs'):alignment(a,b)

class OfflineTests(unittest.TestCase):
    def test_external_tcp_dns_and_udp_are_blocked_before_connection(self):
        code='''import sys,socket
from unimate_worker import reject_external_network
sys.addaudithook(reject_external_network)
blocked=0
for run in [lambda:socket.socket().connect(('203.0.113.1',9)),lambda:socket.getaddrinfo('example.invalid',80),lambda:socket.socket(type=socket.SOCK_DGRAM).sendto(b'x',('203.0.113.1',9))]:
    try:run()
    except RuntimeError:blocked+=1
assert blocked==3,blocked
'''
        result=subprocess.run([sys.executable,'-c',code],cwd=Path(__file__).parents[1]/'providers'/'unimate',capture_output=True,text=True,timeout=15)
        self.assertEqual(result.returncode,0,result.stderr)

if __name__=='__main__':unittest.main()
