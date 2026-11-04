"""Derive a small motion-control proxy without rewriting the render avatar."""
from __future__ import annotations
import argparse, hashlib, json, struct
from pathlib import Path
import numpy as np

HUMAN_CONTROL = {'hips':'Hip','spine':'Spine','chest':'Chest','upperChest':'UpperChest','neck':'Neck','head':'Head'}
for side,prefix in [('left','L'),('right','R')]:
    HUMAN_CONTROL.update({side+semantic:prefix+'_'+control for semantic,control in [('Shoulder','Shoulder'),('UpperArm','UpperArm'),('LowerArm','Forearm'),('Hand','Hand'),('MiddleProximal','Middle1'),('UpperLeg','Thigh'),('LowerLeg','Calf'),('Foot','Foot'),('Toes','ToeBase')]})

def read_glb(path):
    raw = Path(path).read_bytes()
    magic, version, length = struct.unpack_from('<III', raw)
    if magic != 0x46546c67 or version != 2 or length != len(raw):
        raise ValueError('Expected a complete glTF 2 GLB')
    size, kind = struct.unpack_from('<II', raw, 12)
    if kind != 0x4e4f534a:
        raise ValueError('Missing glTF JSON')
    return json.loads(raw[20:20+size]), hashlib.sha256(raw).hexdigest()

def local_matrix(node):
    if 'matrix' in node:
        return np.asarray(node['matrix'], dtype=float).reshape(4, 4).T
    x, y, z, w = node.get('rotation', [0, 0, 0, 1])
    r = np.array([[1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)],
                  [2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)],
                  [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)]])
    m = np.eye(4); m[:3, :3] = r * np.asarray(node.get('scale', [1, 1, 1]))
    m[:3, 3] = node.get('translation', [0, 0, 0])
    return m

def node_worlds(nodes):
    parents = {c: i for i, n in enumerate(nodes) for c in n.get('children', [])}
    result = {}
    def visit(i, stack=()):
        if i in stack: raise ValueError('Cyclic node hierarchy')
        if i not in result:
            m = local_matrix(nodes[i])
            result[i] = visit(parents[i], (*stack, i)) @ m if i in parents else m
        return result[i]
    for i in range(len(nodes)): visit(i)
    return result, parents

def derive(avatar, output, profile=None):
    output = Path(output)
    if output.exists(): raise ValueError('Use a new control-rig output directory')
    g, sha = read_glb(avatar)
    worlds, parents = node_worlds(g['nodes'])
    skin = {i for s in g.get('skins', []) for i in s['joints']}
    names = {}
    for i in skin:
        name = g['nodes'][i].get('name')
        if name in names: raise ValueError('Duplicate skin bone name')
        names[name] = i
    human = g.get('extensions',{}).get('VRMC_vrm',{}).get('humanoid',{}).get('humanBones')
    if human is None:
        human = {j['bone']:{'node':j['node']} for j in g.get('extensions',{}).get('VRM',{}).get('humanoid',{}).get('humanBones',[])}
    if profile:
        human={semantic:{'node':names[source]} for semantic,source in profile.items()}
    canonical={int(human[semantic]['node']):control for semantic,control in HUMAN_CONTROL.items() if semantic in human}
    if any(i not in skin for i in canonical):raise ValueError('Humanoid control references a non-skin joint')
    def depth(i):
        return 0 if i not in parents else 1+depth(parents[i])
    selected=sorted(canonical,key=lambda i:(depth(i),i))
    if not 18 <= len(selected) <= 70: raise ValueError('Incomplete or oversized body control rig')
    if not {'Hip','Head','L_Thigh','R_Thigh','L_Hand','R_Hand','L_Foot','R_Foot'} <= set(canonical.values()):
        raise ValueError('Incomplete anatomical control rig')
    indices = {original: index for index, original in enumerate(selected)}
    nodes, mapping = [], []
    for original in selected:
        parent = parents.get(original)
        while parent is not None and parent not in indices: parent = parents.get(parent)
        local = np.linalg.inv(worlds[parent]) @ worlds[original] if parent is not None else worlds[original]
        nodes.append({'name': canonical[original], 'matrix': local.T.reshape(-1).tolist()})
        mapping.append({'name': canonical[original], 'sourceNode': original,'sourceName':g['nodes'][original]['name'],
                        'controlParent': indices[parent] if parent is not None else -1,
                        'restWorld': worlds[original].tolist()})
    for i, item in enumerate(mapping):
        if item['controlParent'] >= 0: nodes[item['controlParent']].setdefault('children', []).append(i)
    roots = [i for i, item in enumerate(mapping) if item['controlParent'] < 0]
    if len(roots) != 1: raise ValueError('Expected one body root')
    chunks, views, accessors = [], [], []
    def add(array, component, kind, bounds=False):
        a = np.ascontiguousarray(array)
        offset = sum(len(c) for c in chunks)
        data = a.tobytes(); data += b'\0' * (-len(data) % 4)
        chunks.append(data); views.append({'buffer': 0, 'byteOffset': offset, 'byteLength': a.nbytes})
        accessor = {'bufferView': len(views)-1, 'componentType': component, 'count': len(a), 'type': kind}
        if bounds: accessor.update(min=a.min(axis=0).tolist(), max=a.max(axis=0).tolist())
        accessors.append(accessor); return len(accessors)-1
    verts, joints = [], []
    for i, original in enumerate(selected):
        point = worlds[original][:3, 3]
        for d in [[0, 0, 0], [0.0008, 0, 0], [0, 0.0008, 0]]:
            verts.append(point + d); joints.append([i, 0, 0, 0])
    pos = add(np.array(verts, dtype='<f4'), 5126, 'VEC3', True)
    ji = add(np.array(joints, dtype='<u2'), 5123, 'VEC4')
    we = add(np.tile(np.array([[1, 0, 0, 0]], dtype='<f4'), (len(verts), 1)), 5126, 'VEC4')
    ibm = add(np.array([np.linalg.inv(worlds[i]).T.reshape(16) for i in selected], dtype='<f4'), 5126, 'MAT4')
    nodes.append({'name': 'ControlMarkers', 'mesh': 0, 'skin': 0})
    proxy = {'asset': {'version': '2.0', 'generator': 'stage-unimate-control-rig/v1'},
             'scene': 0, 'scenes': [{'nodes': roots + [len(nodes)-1]}], 'nodes': nodes,
             'skins': [{'joints': list(range(len(selected))), 'skeleton': roots[0], 'inverseBindMatrices': ibm}],
             'meshes': [{'primitives': [{'attributes': {'POSITION': pos, 'JOINTS_0': ji, 'WEIGHTS_0': we}, 'mode': 4}]}],
             'bufferViews': views, 'accessors': accessors, 'buffers': [{'byteLength': sum(len(c) for c in chunks)}]}
    text = json.dumps(proxy, separators=(',', ':')).encode(); text += b' ' * (-len(text) % 4)
    binary = b''.join(chunks)
    data = struct.pack('<III', 0x46546c67, 2, 12+8+len(text)+8+len(binary))
    data += struct.pack('<II', len(text), 0x4e4f534a)+text+struct.pack('<II', len(binary), 0x004e4942)+binary
    output.mkdir(parents=True)
    (output/'control.glb').write_bytes(data)
    report = {'schema': 'stage-unimate-rig/v1', 'avatarSha256': sha,
              'sourceJoints': len(skin), 'controlJoints': len(selected), 'joints': mapping,
              'facePair': {'right': 'R_Thigh', 'left': 'L_Thigh'},
              'sourceGeometryChanged': False, 'controlSha256': hashlib.sha256(data).hexdigest(),
              'separateLayers': ['face', 'fingers', 'ears', 'tail', 'hair', 'garment secondary motion']}
    (output/'mapping.json').write_text(json.dumps(report, indent=2)+'\n', encoding='utf8')
    return report

if __name__ == '__main__':
    p = argparse.ArgumentParser(); p.add_argument('avatar'); p.add_argument('output'); p.add_argument('--profile'); a = p.parse_args()
    result = derive(a.avatar, a.output,json.loads(Path(a.profile).read_text()) if a.profile else None)
    print(json.dumps({k: v for k, v in result.items() if k != 'joints'}))
