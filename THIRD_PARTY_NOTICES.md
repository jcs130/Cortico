# Third-party sources and assets

## Runtime libraries

- Three.js 0.186.1 — MIT — https://github.com/mrdoob/three.js
- @pixiv/three-vrm 3.5.5 — MIT — https://github.com/pixiv/three-vrm
- @pixiv/three-vrm-animation 3.5.5 — MIT — https://github.com/pixiv/three-vrm — the browser bundle retains its copyright notice; VRMA files are separately installed assets.
- Cortico 0.2.4 is a development type dependency for the optional thin World adapter. Its source is not extracted or patched by this build. https://github.com/Pal-AI-Lab/Cortico

Their license files remain with installed dependencies. This repository's own code is AGPL-3.0-only; see LICENSE.

## Commentary migration

The optional evidence/eligibility logic in `src/core/commentary.ts` and `commentary-runtime.ts` derives from our existing independent VTuber extension, as shipped in the local `cortico-world-boundaries-consumer-20261020` installation. It is adapted here to the Avatar Stage's structured admission and playback events. Neither the old VTuber World nor its private character configuration is imported or enabled by this package.

## Optional UniMate integration

The Python adapters derive from our independently developed Cormy stage motion adapters (local source commits ffa68b11c12ae5c9d76d07749335ba40be27c5e3 and b4eb5a9193b4c082e2e338419eef2a9cd45a9539). The generic World does not import that private stage, its avatar, or the existing VTuber World at build or runtime.

- UniMate source: https://github.com/Friedrich-M/UniMate — MIT, pinned b78c7807df7cf4231d4e67f8d0ece29c5e11025b. Installed separately; not vendored.
- Model: https://huggingface.co/Linzhan/UniMate — pinned 174fc755ec248d0c98f27759b7a95648e7f05905. Weights use CC-BY-NC-4.0, separate from code; not distributed here.
- FLAN-T5-base: https://huggingface.co/google/flan-t5-base — Apache-2.0. Explicit local download required; not distributed here.
- Motion processing dependency: https://github.com/ianxmarch/Motion — pinned ac236251f90e5ca37c444c53ad383fc85de6d833. Install under its own license, separately.

The optional worker verifies the configured checkpoint and rig mapping. Review the applicable model license before deployment.

## Official VRM sample catalog

Catalog source: https://github.com/vrm-c/vrm-specification at 94e82dd346fa6cf0337c4421728640e5252dd38e. No model binary is included in the npm package. Explicit preset installation fetches and verifies the asset; original VRM metadata remains inside the unchanged binary and is recorded in assets/presets.json.

- Seed-san — VirtualCast, Inc. — VRM Public License 1.0; credit required. The viewer retains attribution on both controls and OBS.
- VRM1_Constraint_Twist_Sample — (c) 2022 pixiv Inc. — VRM Public License 1.0; credit unnecessary, attribution retained.

See the full per-model usage flags in assets/presets.json and https://vrm.dev/en/licenses/1.0/. The repository license does not replace individual avatar terms.

Private Cormy model, voice references, model weights and music files are excluded from this repository and its release package.

## Optional presentation direction and external motions

Design references, without vendoring their code or character assets:

- Eidolon SC: https://github.com/Sallyn0225/eidolon-sc — AGPL-3.0, reviewed commit 8a31a358fc9347f88d2108bd74b7945d6c51912a. Concurrent typed emotion selection and TTS are useful examples; its benchmark numbers do not describe this package.
- SoullinkEmotion3D: https://github.com/nanlingyin/SoullinkEmotion3D — Apache-2.0, reviewed commit 6697822e70d54f21a7b107b9186bf84dd073ed12. Speaker/quoted-action distinctions and smoothly varying emotion are design references.
- JEV typed decision protocol: https://jev-ai.org/docs/. Optional host connections may use a compatible locally hosted model; this package contains no JEV cloud credential or default online connection.

Separately installed ready-made VRMA examples, not shipped in this npm package:

- Sachi VRMA 1 by sashii — CC0 1.0 — https://booth.pm/ja/items/6412084
- VRMA animation pack by へすい / rerofumi — CC0 1.0 — https://booth.pm/ja/items/5527394

Deployments retain each file's source, original license and hash. Mirror downloads require their own pinned byte verification. Attribution is retained even where CC0 does not require it. Model-specific suitability still requires visible review.

## Repository-only EdenLive experiment

- EdenLive: https://github.com/VAST-AI-Research/EdenLive — Apache-2.0 source; model assets are installed separately under their original terms.
- LightX2V: https://github.com/ModelTC/LightX2V — Apache-2.0. The bounded worker adapts the autoregressive cache/denoising/decoder sequence in `lightx2v/models/runners/wan/edenlive_runner.py`. Original contributors retain their copyright. The optional video worker and retained license have moved to `cortico-world-aigc/providers/edenlive`; this package no longer ships them.
- The installed LightX2V checkout, quantized weights, CUDA dependencies and Minecraft renderer assets are not vendored or included in the npm package. The relay consumes an explicitly configured public Minecraft SDK and renderer.

These experimental adapters are excluded from the current npm file whitelist. Their source and validation notes do not constitute a released or loaded World capability.
