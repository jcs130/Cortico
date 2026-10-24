"""Optional resident UniMate engine. Only explicit generate calls run inference."""
from __future__ import annotations
import contextlib, hashlib, math, os, sys, time
from pathlib import Path

class GenerationCancelled(Exception): pass

def batched_guidance(model, condition, scale):
    """Evaluate adaLN conditional/unconditional branches in one forward call."""
    import torch
    merged = {}
    for key, value in condition.items():
        if torch.is_tensor(value) and value.ndim and value.shape[0] == 1:
            merged[key] = torch.cat([value, torch.zeros_like(value) if key == 'caption_emb' else value])
        elif isinstance(value, list) and len(value) == 1:
            merged[key] = value*2
        else:
            merged[key] = value
    if 'caption_emb' not in merged: raise ValueError('Batched guidance requires explicit caption vectors')
    class Guided(torch.nn.Module):
        def __init__(self):
            super().__init__(); self.model = model
        def forward(self, x, timesteps, cond=None):
            conditioned, unconditioned = self.model(torch.cat([x, x]), torch.cat([timesteps, timesteps]), merged).chunk(2)
            return unconditioned + scale*(conditioned-unconditioned)
    return Guided()

class UniMateEngine:
    def __init__(self, config, cancelled=lambda: False):
        self.settings, self.cancelled, self.loaded = config, cancelled, False

    def load(self):
        if self.loaded: return
        started = time.perf_counter()
        cfg = self.settings
        os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_CACHE=cfg['hfCache'], TOKENIZERS_PARALLELISM='false')
        sys.path.insert(0, cfg['sourceDir'])
        import numpy as np
        import torch
        from unimate.inference import sample
        from unimate.inference.assets import AssetResolver
        checkpoint = Path(cfg['expDir'])/'checkpoints/checkpoint_step_150000.pt'
        with checkpoint.open('rb') as f: sha = hashlib.file_digest(f, 'sha256').hexdigest()
        if sha != cfg['checkpointSha256']: raise ValueError('UniMate checkpoint hash mismatch')
        torch.set_num_threads(cfg.get('cpuThreads', 8))
        torch.set_float32_matmul_precision('high')
        self.torch, self.np, self.sample = torch, np, sample
        self.config = sample.MainConfig.from_json(str(Path(cfg['expDir'])/'config.json'))
        self.device = torch.device(cfg.get('device', 'cuda'))
        self.config.sampling.device = str(self.device)
        args = sample.InferenceArgs(exp_dir=cfg['expDir'], asset=(cfg['assetDir'],), prompt=('An object stands.',), cfg_scale=3.0, batch_size=1, only_save_motion=True)
        resolver = AssetResolver(self.config.dataset, assets=args.asset)
        specs, self.assets = sample._resolve_cases(sample._parse_cases(args, 3.0), resolver)
        self.dataset = sample.create_skeleton_dataset(self.config.dataset, self.config.model, sample._resolve_stats_path(cfg['expDir']))
        self.encoder = sample._make_text_encoder(self.config, self.device)
        self.dataset.motion_dataset.text_encoder = self.encoder
        self.assets = sample._register_assets(self.dataset, self.assets, specs, False, self.config, ())
        self.dataset.motion_dataset.text_encoder = None
        self.asset_name = next(iter(self.assets))
        self.model = sample.create_model(self.config.dataset, self.config.model)
        sample._load_checkpoint(self.model, str(checkpoint), self.config)
        self.model.to(self.device).eval()
        self.diffusion, self.sampler = sample._build_diffusion(self.config)
        def check_cancelled(_module, _args):
            self.evaluations = getattr(self, 'evaluations', 0) + 1
            if self.cancelled(): raise GenerationCancelled('Motion generation cancelled')
        self.model.register_forward_pre_hook(check_cancelled)
        from unimate_motion import MotionConverter
        self.converter = MotionConverter(cfg['avatar'], str(Path(cfg['assetDir'])/'cond.npy'), cfg['mappingFile'])
        self.loaded = True
        self.load_seconds = time.perf_counter()-started

    def generate(self, prompt, duration, seed, output):
        if not isinstance(prompt,str) or not 5<=len(prompt.strip())<=1200:raise ValueError('Invalid motion prompt')
        if not isinstance(duration,(int,float)) or not math.isfinite(duration) or not 2<=duration<=12:raise ValueError('Invalid motion duration')
        if not isinstance(seed,int) or isinstance(seed,bool) or not 0<=seed<=2147483647:raise ValueError('Invalid motion seed')
        started = time.perf_counter()
        self.load()
        if self.cancelled(): raise GenerationCancelled('Motion generation cancelled')
        torch, sample, np = self.torch, self.sample, self.np
        output = Path(output)
        output.mkdir(parents=True, exist_ok=True)
        torch.manual_seed(seed)
        if self.device.type == 'cuda': torch.cuda.synchronize(); torch.cuda.reset_peak_memory_stats()
        enc_started = time.perf_counter()
        encoded = sample._encode_prompt(self.encoder, prompt)
        encode_seconds = time.perf_counter()-enc_started
        _, cond = sample.create_sample_condition(config=self.config, data=self.dataset,
                   test_case_captions=[(self.asset_name, prompt, encoded)])
        cond = {k: v.to(self.device) if torch.is_tensor(v) else v for k, v in cond.items()}
        guidance = self.settings.get('guidanceScale', 3.0)
        sampling_model = self.model
        batched = self.settings.get('batchedGuidance', False)
        if batched:
            if self.config.model.text_cond != 'adaln': raise ValueError('Batched guidance currently supports only adaLN checkpoints')
            sampling_model = batched_guidance(self.model, cond, guidance)
            guidance = 1.0  # The wrapper already applies classifier-free guidance.
        shape = (1, self.config.dataset.max_joints, self.config.dataset.feature_len, self.config.dataset.max_motion_length)
        frames = max(60, min(360, round(duration*30)))
        overlap = 10
        segments = 1+max(0, math.ceil((frames-60)/(60-overlap)))
        gen_started = time.perf_counter()
        self.evaluations = 0
        profile = self.settings.get('solver', {'method': 'dopri5', 'steps': 50})
        if profile['method'] not in {'dopri5', 'euler', 'midpoint', 'rk4'} or not 8 <= profile['steps'] <= 128:
            raise ValueError('Unsupported motion sampling profile')
        base_sampler = self.sampler
        class ProfileSampler:
            transport = base_sampler.transport
            def sample_ode(self):
                return base_sampler.sample_ode(sampling_method=profile['method'],
                    num_steps=profile['steps']+(profile['method']!='dopri5'))
        sampler = ProfileSampler()
        mixed = self.settings.get('precision', 'float32')
        if mixed not in {'float32', 'bfloat16'}: raise ValueError('Unsupported motion precision')
        autocast = torch.autocast('cuda', dtype=torch.bfloat16) if mixed == 'bfloat16' and self.device.type == 'cuda' else contextlib.nullcontext()
        with torch.inference_mode(), autocast:
            if segments == 1:
                features = sample.generate_samples(sampling_model, cond, shape, self.config.training.diff_model,
                           self.diffusion, sampler, self.device, cfg_scale=guidance)
            else:
                from unimate.inference.motion_expansion import expand_motion_chain
                features = expand_motion_chain([cond]*segments, shape, overlap, sampling_model,
                         self.config.training.diff_model, self.diffusion, sampler,
                         guidance, self.device)
        if self.device.type == 'cuda': torch.cuda.synchronize()
        gen_seconds = time.perf_counter()-gen_started
        n = int(cond['n_joints'][0])
        raw = features[0, :n, :, :frames].cpu().permute(2, 0, 1).numpy()
        raw = raw*cond['std'][0, :n].cpu().numpy()[None]+cond['mean'][0, :n].cpu().numpy()[None]
        if self.cancelled(): raise GenerationCancelled('Motion generation cancelled')
        np.save(output/'unimate-features.npy', raw)
        qa = self.converter.convert(raw, output/'clip.json', 'UniMate_'+str(seed), max_frames=frames)
        if self.cancelled(): raise GenerationCancelled('Motion generation cancelled')
        metrics = {'loadSec': self.load_seconds, 'textEncodeSec': encode_seconds, 'generationSec': gen_seconds,
                   'conversionSec': qa['seconds'], 'totalSec': time.perf_counter()-started,
                   'generatedFrames': len(raw), 'segments': segments, 'fps': 30,
                   'solver': profile, 'precision': mixed, 'denoiserEvaluations': self.evaluations,
                   'expansionSolver': {'method':'euler','steps':50} if segments>1 else None,
                   'guidanceBatchSize': 2 if batched else 1, 'guidanceScale': self.settings.get('guidanceScale', 3.0),
                   'cudaPeakAllocatedBytes': torch.cuda.max_memory_allocated() if self.device.type == 'cuda' else 0,
                   'cudaPeakReservedBytes': torch.cuda.max_memory_reserved() if self.device.type == 'cuda' else 0,
                   'checkpointSha256': self.settings['checkpointSha256'], 'externalModelCalls': 0, 'qa': qa}
        return metrics
