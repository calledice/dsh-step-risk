# DSH Step Risk

DeepSeek Harness 的实验性实时步骤归因插件。每个 `step/end` 后输出一个模型估计：**如果当前任务最终失败，且决定性责任步骤属于这个 session，该步骤被认定为责任步骤的模型概率**。同时列出当前 session 内最可疑的历史步骤，并保留尚未发生步骤的概率质量。无需重放，也无需预先知道链路长度。

> **状态：0.1.0，未校准。** 数值来自明确的先验和证据似然比假设，目前没有 DeepSeek Harness 原生的成功/失败及人工责任标签来验证概率刻度。不要把 `pCurrent` 解读为任务失败率，或用于自动阻断、处罚 agent。

## 安装

针对 DeepSeek Harness 0.2.1-alpha.1 的源码事件契约开发；需要 Node.js 22.19+ 或 24+。在已有 `dsh` CLI 的机器上运行：

```sh
dsh plugin --profile demo add github:calledice/dsh-step-risk#v0.1.0
dsh --profile demo --dump-config
dsh --profile demo
```

`--dump-config` 中应出现 `dsh-step-risk` 层和 `step-risk` 行。启动后，插件在每个已结束 step 输出一条 `[dsh-step-risk] { ... }` JSON。也可以从本仓库 checkout 安装：`dsh plugin --profile demo add ./dsh-step-risk`。插件直接提供 ESM 文件，没有安装时构建脚本。

移除：`dsh plugin --profile demo remove dsh-step-risk`。

## 输出

关键字段：

| 字段 | 含义 |
| --- | --- |
| `sessionId`、`turn`、`step`、`ordinal` | DSH 会话与步骤定位；`ordinal` 是该 session 内观测到的步骤序号 |
| `role`、`delegationDepth` | 从 agent preset 和委派深度得到的架构特征 |
| `evidenceCodes` | 当前步骤的有限错误信号；无硬信号时为 `no_hard_signal` |
| `priorHazard` | 当前步骤在尚未归因于更早步骤时的先验 hazard |
| `pCurrent` | 当前步骤的归一化归因质量，含更早步骤与未知未来的竞争 |
| `pCurrentGivenNoEarlier` | 排除已发生步骤后的当前步与未知未来二选一估计 |
| `pFuture`、`pOtherPast`、`pRetained` | 未知未来、被压缩的历史、保留的历史候选之概率质量；三者和为 1 |
| `topCandidates` | 当前 session 中保留的 Top-K 候选 |
| `revision` | 迟到的 `agent/error` 可修订刚完成的步骤 |
| `calibration`、`scope` | 始终标明 `experimental_uncalibrated` 和条件事件 |

`pCurrent` 是**session 局部**的估计。DSH 的不同 agent 通常拥有不同 session；本版不把多个 agent session 的概率强行归一化为一个全链路排名。用 `sessionId`、`role` 和人工任务上下文关联 agent。子 agent 的 `delegationDepth` 已进入先验。

## 配置

在 profile 的 `cordis.patch.yml` 中覆盖插件行，例如：

```yaml
- id: step-risk
  name: dsh-step-risk
  config:
    logToConsole: true
    logFile: ./step-risk.jsonl
    baseHazard: 0.03
    recoveryHazard: 0.02
    maxCandidates: 128
    topK: 3
    roleByPreset:
      my-planner: planner
      my-worker: executor
      my-reviewer: verifier
```

`roleByPreset` 优先于名称启发式。可用角色为 `planner`、`executor`、`verifier`、`other`。完整参数、模型公式和限制见 [模型说明](docs/MODEL.md)；产品边界见 [产品与研究约定](docs/PRODUCT_SPEC.md)。

`logFile` 是可选 JSONL 路径。日志只写 session 标识、步骤序号、角色、证据码及概率，不写 prompt、工具参数、模型回复正文或错误原文。session 标识仍可能关联用户工作，应按本地日志权限管理。插件另发出 Cordis 事件 `step-risk/prediction`，供其他插件订阅。

## 验证

```sh
npm test
npm pack --dry-run --ignore-scripts
```

测试覆盖概率质量、长链路候选压缩、会话隔离、架构先验、事件提取和迟到错误修订。真实 DSH profile 加载仍需在安装了对应版本 CLI 的环境中验证；详见 [验证记录](docs/VALIDATION.md)。

## 数据与路线

内部人工标注数据属于另一套 agent 系统，事件粒度与 DSH step 不相同，也缺少成功轨迹，因此没有直接放入模型训练或公开仓库。试用后应收集 DSH 原生步骤、任务结果和人工责任标签，按任务分组评估 Top-1/Top-3 命中率，再做 Brier 分数与可靠性图；通过校准检验后才可移除未校准标识。

MIT License。
