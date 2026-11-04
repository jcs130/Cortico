"""Map UniMate's canonical motion deltas onto the unchanged glTF bone tree."""
from __future__ import annotations
import json, math, time
from pathlib import Path
import numpy as np
from scipy.spatial.transform import Rotation
from unimate_rig import read_glb, node_worlds, local_matrix

def rotation(matrix):
    u, _, v = np.linalg.svd(np.asarray(matrix)[:3, :3])
    r = u @ v
    if np.linalg.det(r) < 0: raise ValueError('Reflected bone frame is unsupported')
    return r

def alignment(source, target):
    """Uniform proper similarity, with a measured rest-position residual."""
    a, b = np.asarray(source, dtype=float), np.asarray(target, dtype=float)
    ac, bc = a.mean(0), b.mean(0)
    u, values, vt = np.linalg.svd((a-ac).T @ (b-bc))
    fix = np.eye(3); fix[-1, -1] = np.linalg.det(vt.T @ u.T)
    r = vt.T @ fix @ u.T
    scale = np.sum(values * np.diag(fix)) / np.sum((a-ac)**2)
    shift = bc-scale*(r @ ac)
    error = np.max(np.linalg.norm(scale*(a @ r.T)+shift-b, axis=1))
    if not np.isfinite(scale) or scale <= 0 or error > 2e-4:
        raise ValueError('Canonical rest pose differs from the source rig')
    return r, scale, shift, error

class MotionConverter:
    def __init__(self, avatar, cond_file, mapping_file):
        self.g, sha = read_glb(avatar)
        mapping = json.loads(Path(mapping_file).read_text(encoding='utf8'))
        if mapping['avatarSha256'] != sha: raise ValueError('Control rig belongs to another avatar')
        data = np.load(cond_file, allow_pickle=True).item()
        if len(data) != 1: raise ValueError('Expected exactly one reviewed control asset')
        self.name, self.cond = next(iter(data.items()))
        self.names = [str(n) for n in self.cond['joint_names']]
        self.worlds, self.parents = node_worlds(self.g['nodes'])
        self.nodes = {joint['name']:joint['sourceNode'] for joint in mapping['joints']}
        self.control_at={index:name for name,index in self.nodes.items()}
        self.target_names={name:self.g['nodes'][index]['name'] for name,index in self.nodes.items()}
        if not set(self.names) <= {j['name'] for j in mapping['joints']}: raise ValueError('Unexpected control joint')
        original = np.array([self.worlds[self.nodes[n]][:3, 3] for n in self.names])
        canonical = np.asarray(self.cond['tpos_first_frame'])[:, :3]
        self.frame, self.scale, self.shift, self.residual = alignment(original, canonical)
        self.rest = {i: rotation(m) for i, m in self.worlds.items()}
        self.sha = sha

    def convert(self, features, output, name='UniMate', max_frames=None):
        from unimate.utils.motion_utils import recover_unimate_anim_from_rot
        started = time.perf_counter()
        features = np.asarray(features)
        if max_frames is not None: features = features[:max_frames]
        if features.ndim != 3 or features.shape[1:] != (len(self.names), 12) or not 30 <= len(features) <= 360 or not np.isfinite(features).all():
            raise ValueError('Invalid UniMate motion features')
        anim = recover_unimate_anim_from_rot(features, self.cond['parents'], self.cond['tpos_offsets'])
        deltas = anim.rotations.transforms()
        count = len(features)
        desired = {}
        for j, bone in enumerate(self.names):
            parent = int(self.cond['parents'][j])
            rp0 = np.eye(3) if parent < 0 else self.rest[self.nodes[self.names[parent]]]
            rj0 = self.rest[self.nodes[bone]]
            local = rp0.T @ self.frame.T @ deltas[:, j] @ self.frame @ rj0
            desired[bone] = local if parent < 0 else desired[self.names[parent]] @ local
        actual = {}
        def pose(i):
            if i not in actual:
                p = self.parents.get(i)
                pr = np.broadcast_to(np.eye(3), (count, 3, 3)) if p is None else pose(p)
                n = self.control_at.get(i)
                actual[i] = desired[n] if n in desired else pr @ rotation(local_matrix(self.g['nodes'][i]))
            return actual[i]
        times = (np.arange(count)/30).tolist()
        tracks, peak = [], 0.0
        for bone in self.names:
            if bone.endswith('_Middle1'): continue  # Preserve the authored finger pose.
            i, parent = self.nodes[bone], self.parents.get(self.nodes[bone])
            pr = np.broadcast_to(np.eye(3), (count, 3, 3)) if parent is None else pose(parent)
            q = Rotation.from_matrix(np.swapaxes(pr, -1, -2) @ pose(i)).as_quat()
            for f in range(1, count):
                if np.dot(q[f], q[f-1]) < 0: q[f] *= -1
            steps = np.degrees(2*np.arccos(np.clip(np.abs(np.sum(q[1:]*q[:-1], axis=1)), 0, 1)))
            peak = max(peak, float(steps.max(initial=0)))
            tracks.append({'name': self.target_names[bone]+'.quaternion', 'type': 'quaternion', 'times': times,
                           'values': np.round(q, 7).reshape(-1).tolist(), 'interpolation': 2301})
        root = self.nodes[self.names[0]]
        parent_world = np.eye(4) if root not in self.parents else self.worlds[self.parents[root]]
        # Keep horizontal placement fixed on the broadcast stage.
        height = (np.asarray(anim.positions)[:, 0, 1] - np.asarray(self.cond['tpos_first_frame'])[0, 1])/self.scale
        world_delta = height[:, None]*self.frame.T[:, 1]
        world_delta[:, [0, 2]] = 0
        points = local_matrix(self.g['nodes'][root])[:3, 3] + world_delta @ np.linalg.inv(parent_world)[:3, :3].T
        tracks.append({'name': self.target_names[self.names[0]]+'.position', 'type': 'vector', 'times': times,
                       'values': np.round(points, 7).reshape(-1).tolist(), 'interpolation': 2301})
        qa = {'valid': bool(peak < 35), 'frames': count, 'fps': 30, 'durationSec': (count-1)/30,
              'mappedBodyJoints': len(tracks)-1, 'maxJointStepDegrees': peak, 'restAlignmentError': float(self.residual),
              'avatarSha256': self.sha, 'targetGeometryModified': False, 'reviewRequired': True,
              'limits': ['Horizontal travel removed for a stationary stage', 'Face, fingers and secondary motion remain separate',
                         'Automatic checks do not certify cloth collision, contact or artistic quality'],
              'seconds': time.perf_counter()-started}
        result = {'clip': {'name': name, 'duration': (count-1)/30, 'tracks': tracks}, 'qa': qa}
        Path(output).write_text(json.dumps(result, separators=(',', ':')), encoding='utf8')
        return qa
