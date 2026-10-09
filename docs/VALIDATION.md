# 验证记录

日期：2026-10-09。目标：DeepSeek Harness 0.2.1-alpha.1，参考源码修订 5badb15009ae1756c3afe0ae0cef1faafc290ccc。

## 已完成

- Node.js 24.14.1 下运行 `node --test`：15 项全部通过。
- `node --check` 检查入口与两个源码模块：通过。
- `npm pack --dry-run --ignore-scripts`：打包清单包含入口、源码、Cordis patch、README、模型与产品文档；没有安装时构建步骤。
- 对照官方源码确认 `dsh.bundle.patch`、Cordis patch 列表、`session/event` 的步骤和工具结果字段，以及 `agent/request-error` 的 waterfall 透传契约。
- 对公开目录扫描私有 IP、凭据变量、认证头形式和密钥前缀：无命中；测试文件仅使用字符串 `PRIVATE_SECRET` 检查原文不会进入输出。

## 待真实环境验证

本机没有可调用的 `dsh` CLI，因此尚未在真实 DeepSeek Harness profile 中执行 `dsh plugin add` / `--dump-config` / 任务跑通烟测。用户安装后应先按 README 的命令确认 patch 行激活，再运行一个含工具错误和一个正常步骤的任务，检查是否出现 `step-risk/prediction` 和控制台 JSON。

概率参数是专家设定；既有人工标签属于另一套系统，没有 DSH 原生成功轨迹，故不能校准本插件的概率。插件保留 `experimental_uncalibrated` 标识。
