# 可选 UniMate 本地动作后端

该目录是独立 Python worker，使用本扩展的中立动作库协议。显式启动后才加载本地权重；没有定时规划或外部 LLM 调用。源码和权重单独安装，版本、许可见根目录 THIRD_PARTY_NOTICES.md。

## 环境

已验证环境：Python 3.13、PyTorch 2.11.0+cu128、transformers 5.1.0、CUDA 5090D、Blender 5.2 LTS。按 UniMate 固定源码版本安装其依赖及 Motion 包，再显式下载 UniMate uniml3d-f60-v3 与 google/flan-t5-base 到本地缓存。不同 CUDA/Blender 组合需另行验证。

此仓库不在安装时自动运行 pip、下载权重或修改系统 Python。建议独立虚拟环境。

## 人物准备

```sh
python providers/unimate/unimate_rig.py /absolute/avatar.vrm /absolute/rig/control
```

VRM 使用元数据里的真实人形骨骼；普通 GLB 需提供 `--profile`，内容为语义骨骼名到模型真实节点名的映射。工具只生成小型控制代理和 mapping.json，不改渲染人物的 mesh、蒙皮、衣服权重或原文件。

在固定 UniMate 源码目录，按其官方 rig_preprocess 文档离线执行：

```sh
python -m data_process.rig_preprocess run --input /absolute/rig/control/control.glb --output_dir /absolute/rig/asset --annotate rule --face_r R_Thigh --face_l L_Thigh --review
# 核对 annotation.json 的全部标签、左右及朝向，然后用该已核对文件构建：
python -m data_process.rig_preprocess run --input /absolute/rig/control/control.glb --output_dir /absolute/rig/asset --annotate rule --annotation /absolute/rig/asset/annotation.json
```

使用绝对路径，Windows 跨盘时从 UniMate 源码目录执行。预处理需要 Blender/bpy 的兼容环境；`--annotate rule` 明确禁用自动 LLM 标注。不要把未经核对的关节标签直接用于在线动作。

## worker 配置

参考 [examples/unimate.json](../../examples/unimate.json)，把所有路径替换为自己的绝对路径，并填写人物与 checkpoint 的真实 SHA256。`assetDir` 指向生成 cond.npy 的目录，mappingFile 指向控制代理的映射。启动：

```sh
python providers/unimate/unimate_worker.py /absolute/unimate.local.json
```

然后把该人物的 `motionUrl` 设为本机 worker 地址。只绑定回环，拒绝浏览器跨源写入；启动后阻止非回环 TCP、DNS 和 UDP，使用本地 HF 缓存。下载与预处理在启动前显式完成。

短动作使用 60 帧 / 30FPS，推荐从两秒开始。当前实测配置 Euler32、FP32、批量 CFG；长动作走上游扩展，其后续窗口采样设置可能不同，不能用短动作耗时线性估算。所有动作保存原始特征、转换轨迹、人物哈希、采样配置指纹和检查结果。

## 使用与验收

`generate` 返回 jobId；`result/search` 查原任务；`preview` 查看候选；确认动作语义、方向、衣服和接缝后才 `approve`，再 `play`。取消后即使推理迟到返回也不会恢复任务。实际 renderer 的 playing 回执分别累加 previewCount/usageCount。

数值检查只检查有限值、连续性等，不能判断挥手是否明显，也不负责修复人物本身的衣服绑定。面部、手指、耳朵、尾巴等保留各自的动画层。

离线回归（需要 NumPy/SciPy，不加载实际权重）：

```sh
python -m unittest discover -s tests -p test_unimate.py -v
```
