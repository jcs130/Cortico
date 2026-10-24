"""Optional local UniMate backend using the existing motion-library protocol."""
from __future__ import annotations
import argparse, hashlib, json, threading, time, os
from pathlib import Path
from motion_worker import MotionLibrary, TERMINAL, serve
from unimate_engine import UniMateEngine, GenerationCancelled

class UniMateMotionLibrary(MotionLibrary):
    def __init__(self, root, config, engine_factory=UniMateEngine):
        self.stopping=threading.Event();self.current_job=None
        self.engine=engine_factory(config['unimate'],lambda:self.stopping.is_set() or bool(self.current_job and self.current_job['status']=='cancelled'))
        super().__init__(root,config)

    def generation_status(self):
        return {'generatorConfigured':True,'model':self.config['model'],'provider':'unimate-local',
                'resident':True,'loaded':self.engine.loaded,'nativeFrames':60,'fps':30}

    def submit(self, request):
        with self.lock:
            if self.stopping.is_set():raise ValueError('motion worker has stopped')
            return super().submit(request)

    def close(self):
        with self.lock:
            if self.stopping.is_set():return
            self.stopping.set()
            for job in self.jobs.values():
                if job['status'] not in TERMINAL:job.update(status='cancelled',error='motion worker stopped');self.save(job)
            self.tasks.put(None)

    def run(self):
        while True:
            id=self.tasks.get()
            if id is None:self.tasks.task_done();return
            job=self.jobs[id];directory=self.root/id;started=time.perf_counter()
            try:
                with self.lock:
                    if job['status']=='cancelled' or self.stopping.is_set():continue
                    self.current_job=job;job['status']='generating';job['timings']['queueSec']=time.time()-job['createdAt'];self.save(job)
                metrics=self.engine.generate(job['prompt'],job['durationSec'],job['seed'],directory)
                qa=metrics['qa']
                if qa.get('avatarSha256')!=self.config['avatarSha256'] or not (directory/'clip.json').is_file():raise RuntimeError('Generated clip target does not match the configured avatar')
                with self.lock:
                    if job['status']=='cancelled' or self.stopping.is_set():continue
                    source=directory/'unimate-features.npy'
                    if not source.is_file():raise RuntimeError('UniMate did not retain its original motion features')
                    job.update(status='ready' if qa['valid'] else 'review',clipId=id,qa=qa,review='pending',
                        sourceSha256=hashlib.sha256(source.read_bytes()).hexdigest(),metrics=metrics,
                        timings={**job['timings'],'generationSec':metrics['generationSec'],'retargetSec':metrics['conversionSec'],'textEncodeSec':metrics['textEncodeSec']})
            except GenerationCancelled:
                with self.lock:job.update(status='cancelled')
            except Exception as e:
                with self.lock:
                    if job['status']!='cancelled':job.update(status='failed',error=str(e))
            finally:
                with self.lock:
                    job['timings']['totalSec']=time.perf_counter()-started+job['timings'].get('queueSec',0)
                    self.save(job);self.current_job=None
                self.tasks.task_done()

def fingerprint(config):
    profile={k:config.get(k) for k in ['sourceRevision','checkpointSha256','solver','precision','batchedGuidance','guidanceScale']}
    profile['controlMappingSha256']=hashlib.sha256(Path(config['mappingFile']).read_bytes()).hexdigest()
    return hashlib.sha256(json.dumps(profile,sort_keys=True,separators=(',',':')).encode()).hexdigest()

def reject_external_network(event, audit_args):
    if event=='socket.connect' and isinstance(audit_args[1],tuple) and str(audit_args[1][0]) not in {'127.0.0.1','::1','localhost'}:
        raise RuntimeError('External network is disabled in the local motion worker')
    if event=='socket.getaddrinfo' and str(audit_args[0]) not in {'127.0.0.1','::1','localhost','None'}:
        raise RuntimeError('External DNS is disabled in the local motion worker')
    if event=='socket.sendto' and isinstance(audit_args[-1],tuple) and str(audit_args[-1][0]) not in {'127.0.0.1','::1','localhost'}:
        raise RuntimeError('External datagrams are disabled in the local motion worker')

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('config');args=parser.parse_args()
    config=json.loads(Path(args.config).read_text(encoding='utf8'))
    config['generationRevision']=fingerprint(config['unimate'])
    if config.get('provider')!='unimate-local':raise ValueError('UniMate backend must be explicitly selected')
    # Upstream formats asset paths relative to cwd using os.path.relpath, which
    # fails across Windows drives. This is the isolated worker's cwd only.
    os.chdir(config['unimate']['sourceDir'])
    import sys
    sys.addaudithook(reject_external_network)
    library=UniMateMotionLibrary(Path(config['dataDir']),config)
    try:serve(library,config.get('port',18422))
    finally:library.close()
