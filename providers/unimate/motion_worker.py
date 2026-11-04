"""Loopback asynchronous motion jobs. No live bot imports or source modifications."""
from __future__ import annotations
import hashlib, json, queue, threading, time, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs

TERMINAL = {'ready', 'review', 'failed', 'cancelled'}

class MotionLibrary:
    def __init__(self, root: Path, config: dict, recover_interrupted=True):
        self.root, self.config = root.resolve(), config
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock(); self.jobs = {}; self.tasks = queue.Queue(); self.active = {}
        self.requests = json.loads((self.root/'requests.json').read_text(encoding='utf8')) if (self.root/'requests.json').exists() else {}
        for p in self.root.glob('*/job.json'):
            try:
                j = json.loads(p.read_text(encoding='utf8'))
                interrupted = recover_interrupted and j['status'] not in TERMINAL
                if interrupted:
                    j.update(status='failed', error='Worker restarted before completion; resubmit explicitly.')
                self.jobs[j['id']] = j
                if interrupted: self.save(j)
            except (ValueError, KeyError): pass
        threading.Thread(target=self.run, daemon=True).start()

    def generation_status(self):
        return {'generatorConfigured':bool(self.config.get('providerCommand')),'model':self.config.get('model')}

    def remember_request(self, request_id, key, job_id):
        if request_id is None:return
        self.requests[request_id]={'key':key,'jobId':job_id}
        tmp=self.root/'requests.tmp';tmp.write_text(json.dumps(self.requests,separators=(',',':')),encoding='utf8');tmp.replace(self.root/'requests.json')

    def save(self, job):
        with self.lock:
            dest = self.root / job['id']; dest.mkdir(exist_ok=True)
            tmp = dest / 'job.tmp'; tmp.write_text(json.dumps(job, ensure_ascii=False, indent=2), encoding='utf8'); tmp.replace(dest/'job.json')

    def list(self):
        with self.lock: return [dict(j) for j in sorted(self.jobs.values(), key=lambda j:j['createdAt'], reverse=True)]

    def refresh_imports(self):
        # A CLI import writes job.json atomically. Adopt only completed, unknown jobs.
        with self.lock:
            for path in self.root.glob('*/job.json'):
                if path.parent.name in self.jobs: continue
                try:
                    job=json.loads(path.read_text(encoding='utf8'))
                    if job['id']==path.parent.name and job['status'] in TERMINAL and job.get('avatarSha256')==self.config['avatarSha256']:
                        self.jobs[job['id']]=job
                except (OSError,ValueError,KeyError): continue

    def catalog(self, query='', offset=0, limit=50, review=''):
        if not isinstance(query,str) or len(query)>200 or not 0<=offset or not 1<=limit<=200 or review not in {'','pending','approved','rejected'}:
            raise ValueError('invalid catalog filter')
        self.refresh_imports();jobs=self.list();total=len(jobs);terms=query.casefold().split()
        jobs=[j for j in jobs if (not review or j.get('review')==review) and all(term in ' '.join(str(j.get(k,'')) for k in ['title','prompt','model']).casefold() for term in terms)]
        matched=len(jobs)
        return {'jobs':[{k:v for k,v in j.items() if k!='recentUsageEvents'} for j in jobs[offset:offset+limit]],'total':total,'matched':matched,'offset':offset,'limit':limit,'hasMore':offset+limit<matched,**self.generation_status()}

    def review(self, id, review):
        if review not in {'approved','rejected'}: raise ValueError('invalid review state')
        with self.lock:
            job = self.jobs[id]
            if job['status']!='ready' and not (job['status']=='review' and review=='rejected'): raise ValueError('motion has not passed automatic checks')
            job.update(review=review, reviewedAt=time.time()); self.save(job); return dict(job)

    def used(self, id, event_id, role):
        if not isinstance(event_id,str) or not 1<=len(event_id)<=100: raise ValueError('invalid event id')
        if role not in {'broadcast','preview'}: raise ValueError('invalid renderer role')
        with self.lock:
            job=self.jobs[id]
            if job['status']!='ready':raise ValueError('motion is not ready')
            key=role+':'+event_id
            previous=job.setdefault('recentUsageEvents',[])
            if key not in previous:
                previous.append(key);del previous[:-256]
                counter='usageCount' if role=='broadcast' else 'previewCount'
                job[counter]=job.get(counter,0)+1;job['lastUsedAt']=time.time();self.save(job)
            return dict(job)

    def submit(self, request):
        prompt = request.get('prompt', '')
        if not isinstance(prompt, str) or not 5 <= len(prompt.strip()) <= 1200: raise ValueError('prompt must contain 5–1200 characters')
        duration = float(request.get('durationSec', 6)); seed = int(request.get('seed', 42))
        if not 2 <= duration <= 12 or not 0 <= seed <= 2147483647: raise ValueError('invalid duration or seed')
        request_id=request.get('requestId')
        if request_id is not None and (not isinstance(request_id,str) or not 1<=len(request_id)<=200):raise ValueError('invalid request id')
        identity=[prompt.strip(),duration,seed,self.config.get('model'),self.config['avatarSha256']]
        if self.config.get('generationRevision'):identity.append(self.config['generationRevision'])
        key = hashlib.sha256(json.dumps(identity,ensure_ascii=False).encode()).hexdigest()[:24]
        with self.lock:
            known=self.requests.get(request_id) if request_id is not None else None
            if known:
                if known['key']!=key:raise ValueError('request id belongs to another motion')
                if known['jobId'] not in self.jobs:raise ValueError('original request is archived or unavailable; reconcile it before resubmitting')
                return dict(self.jobs[known['jobId']],reused=True)
            previous = next((j for j in self.jobs.values() if j['key']==key and j['status'] not in {'failed','cancelled'}),None)
            if previous:self.remember_request(request_id,key,previous['id']);return dict(previous,reused=True)
            if sum(j['status'] not in TERMINAL for j in self.jobs.values()) >= 8: raise ValueError('motion queue is full')
            job={'id':str(uuid.uuid4()),'key':key,'prompt':prompt.strip(),'title':prompt.strip()[:80],'durationSec':duration,'seed':seed,'status':'queued','createdAt':time.time(),'provider':self.config.get('provider','none'),'model':self.config.get('model'),'avatarSha256':self.config['avatarSha256'],'timings':{},'usageCount':0,'review':'pending'}
            if self.config.get('generationRevision'):job['generationRevision']=self.config['generationRevision']
            self.jobs[job['id']]=job;self.save(job);self.remember_request(request_id,key,job['id']);self.tasks.put(job['id']);return dict(job)

    def cancel(self, id):
        with self.lock:
            job=self.jobs[id]
            if job['status'] in TERMINAL: return dict(job)
            job['status']='cancelled';self.save(job)
            proc=self.active.get(id)
            if proc and proc.poll() is None: proc.terminate()
            return dict(job)

    def run(self):
        raise NotImplementedError("Select an explicit motion provider")


def serve(library,port):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def response(self,status,data):
            body=json.dumps(data,ensure_ascii=False).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
        def do_GET(self):
            try:
                url=urlsplit(self.path);params=parse_qs(url.query)
                if self.path=='/health':return self.response(200,{'ok':True,**library.generation_status()})
                if url.path=='/jobs':return self.response(200,library.catalog(params.get('query',[''])[0],int(params.get('offset',['0'])[0]),int(params.get('limit',['200'])[0]),params.get('review',[''])[0]))
                if self.path.startswith('/jobs/'):return self.response(200,library.jobs[self.path.split('/')[-1]])
                if self.path.startswith('/clips/'):
                    id=self.path.split('/')[-1];job=library.jobs[id]
                    if job['status'] not in {'ready','review'}:raise ValueError('not ready')
                    return self.response(200,json.loads((library.root/id/'clip.json').read_text(encoding='utf8')))
                self.response(404,{'error':'not found'})
            except (KeyError,ValueError):self.response(404,{'error':'unknown motion'})
        def do_POST(self):
            if self.headers.get('Origin'):return self.response(403,{'error':'use stage API'})
            try:
                size=int(self.headers.get('Content-Length','0'))
                if not 0<size<=10000:raise ValueError('request size')
                data=json.loads(self.rfile.read(size))
                if not isinstance(data,dict):raise ValueError('expected object')
                if self.path=='/jobs':return self.response(202,library.submit(data))
                parts=self.path.strip('/').split('/')
                if len(parts)==3 and parts[0]=='jobs':
                    if parts[2]=='review':return self.response(200,library.review(parts[1],data.get('review')))
                    if parts[2]=='used':return self.response(200,library.used(parts[1],data.get('eventId'),data.get('role')))
                self.response(404,{'error':'not found'})
            except (ValueError,TypeError) as e:self.response(400,{'error':str(e)})
            except KeyError:self.response(404,{'error':'unknown job'})
        def do_DELETE(self):
            if self.headers.get('Origin'):return self.response(403,{'error':'use stage API'})
            try:self.response(200,library.cancel(self.path.split('/')[-1]))
            except KeyError:self.response(404,{'error':'unknown job'})
    print(json.dumps({'motionWorker':port,'jobs':len(library.jobs)}),flush=True)
    ThreadingHTTPServer(('127.0.0.1',port),Handler).serve_forever()

