<!-- Owner: ../scripts/setup-bundled.ts, */package.json -->

# 随仓库部署的模块

| 目录 | 导入来源 | 基线提交 | 许可 |
| --- | --- | --- | --- |
| `cortico-world-vtuber` | [jcs130/cortico-world-vtuber](https://github.com/jcs130/cortico-world-vtuber) | `5cc074bd0926aab8003a829c8e79fd3a60a92978` | AGPL-3.0-or-later |
| `cortico-world-qiandengji` | [jcs130/cortico-world-qiandengji](https://github.com/jcs130/cortico-world-qiandengji) | `a9a62a83baaf2ac3574fa0a5fe6c9971b0d4f1c2` | MIT |
| `mc-visual-console` | [jcs130/mc-visual-console](https://github.com/jcs130/mc-visual-console) | `f8d811e5ec26d045b067db26e179441fa28ee37b` | MIT；第三方声明见子目录 |

此后的集成改动由本仓库 Git 记录。根 `pnpm-workspace.yaml` 管理三份包的开发依赖；
World 的 `cortico/*` 指向本仓库 `src/`，运行时继续由扩展解析器装载。
现代渲染器的离线资源构建使用其 `renderer-src/package-lock.json`。

安装与迁移见 [统一部署说明](../docs/bundled-deployment.md)。各包的 LICENSE、CLA 和第三方声明保留在原目录。
