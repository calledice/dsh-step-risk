# 模型与技术路线

## 预测对象

对一个 DeepSeek Harness session，在第 t 个已结束步骤后输出

`P(C=t | O_{1:t}, F=1, S=1, M)`，

其中 `C` 是该 session 所属任务失败时的单个决定性责任步骤，`O` 是目前可见事件，`F=1` 表示任务最终失败，`S=1` 表示决定性步骤在该 session 内，`M` 是首版假设模型。`pCurrent` 在该 session 已见步骤和未来步骤之间归一化。不同 session 未共同建模；结果不能跨 agent 直接比较为全任务概率。

这不是已经观测到的频率，也不是因果证明。产品始终输出 `calibration: experimental_uncalibrated`。

## 在线状态

每个 session 保存：

- `futureMass`：责任步骤尚在未来的非归一化质量。
- 最多 `maxCandidates` 个历史候选及其权重。
- `otherPastMass`：被压缩历史候选的总质量。

初始全部质量在未来。对新步骤先按 `recoveryHazard` 把既有历史质量的一小部分移回未来，然后从未来质量按当前步 hazard 分出一份。恢复转移是对后续检验或纠错可能改变责任位置的**粗略近似**，并不等价于对 verifier 职责的因果验证；默认对所有后续步骤施加同一转移。该设计使无限长度链路中旧候选不会仅因出现过就永久占优。

`h_t = sigmoid(logit(baseHazard) + roleOffset[role_t] + delegationDepthOffset × depth_t)`。

当前步质量乘以证据似然比；其余质量不变，随后归一化。首版没有学习跨步联合似然，也没有静态制品校验器。`no_hard_signal` 是无已支持硬信号时的负证据，并不表明该步正确。多种证据码相乘属于简化的条件独立假设，可能高估重复信号；参数要用 DSH 原生标签再标定。

默认参数：

| 参数 | 默认值 | 用途 |
| --- | ---: | --- |
| `baseHazard` | 0.03 | 新步骤的基础先验 hazard |
| `recoveryHazard` | 0.02 | 每个后续步骤把部分旧质量转回未来 |
| `roleOffsets` | planner 0.15, executor 0.20, verifier 0, other 0 | log-odds 偏移 |
| `delegationDepthOffset` | 0.08 | 每层委派的 log-odds 偏移 |
| `likelihoodRatios.no_hard_signal` | 0.25 | 无已支持硬信号 |
| `likelihoodRatios.tool_error` | 6 | `tool/result.message.isError` |
| `likelihoodRatios.request_error` | 2.5 | `agent/request-error` |
| `likelihoodRatios.agent_error` | 8 | `agent/error` |
| `likelihoodRatios.interrupted` | 2 | `assistant/message.interrupted` |
| `likelihoodRatios.model_attempt` | 1.3 | `assistant/attempt` |
| `maxCandidates` / `topK` | 128 / 3 | 内存上限与输出数量 |

`request_error` 可能被重试后恢复；它只是弱信号。`agent/error` 可能在 `step/end` 后到达，插件对刚结束的步骤发布 `revision=1` 的修订。若错误缺少可匹配的步骤，插件不强行归因。

## 架构与事件

通过 `Session.header.agentPreset` 做显式 `roleByPreset` 映射；无映射时按 preset 名称启发式分类。`delegationDepth` 表示 subagent 层级。订阅 `session/event` 的 `step/start`、`step/end`、`tool/result`、`assistant/message`、`assistant/attempt`，另订阅 `agent/request-error`、`agent/error`、`session/disposed`。请求错误监听器调用 `next()`，不改变 Harness 的错误处理。

插件不会读取事件中的 prompt 或工具结果正文来评分。它只读布尔错误标记、结构化位置与架构元数据。没有跨步骤语义矛盾检测，因此对于无报错的隐蔽计划错误，早期预测能力有限。

## 复杂度、边界与校准

每步处理量与 `maxCandidates` 成正比，和已发生的链路总长度无关；每个活跃 session 内存受候选上限约束。`pOtherPast` 保留被压缩候选的合计概率，但不能再指出其中某个精确步骤。已结束 session 在 `session/disposed` 时释放。

首版只提供候选路由信号，不负责最终人工判责，也不区分环境故障与 agent 错误的因果关系。最终任务未失败时，条件概率对象不成立，历史输出应丢弃或另行用于校准记录。若任务最终失败但决定性步骤位于其他 session，本 session 的质量模型也不是正确的全任务分布。

校准所需数据：同一 DSH 版本的完整任务结果、每一步的预测快照和人工责任标签；按任务分组切分训练/验证/测试；先测 Top-K 排序，再测 Brier 分数和可靠性图。缺乏这些数据时，0.62 只能读作“模型内相对质量约 62%”，不能读作“历史上 62% 的此类步骤真的有责”。
