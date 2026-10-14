# DSH 步骤影响与本轮终局风险：技术论证及落地契约

适用版本：dsh-step-risk 0.3.1 / DeepSeek Harness 0.2.0-rc.2。

## 结论

DSH 能在每个 `step/start` 与 `step/end` 观察结构化执行事实，因此可以构造只依赖当时已见信息的在线预测。它没有插件可直接使用的 token logprobs、同一环境的独立重放器或任务成功判据。仅凭工具报错和单条轨迹，无法得到“这个步骤造成最终失败”的经验概率，也无法识别反事实致因。因此插件保留现有步骤影响**未校准模型估计**，另设需要同源成功与失败标签的**本轮目标终局风险**；没有合格模型时后者的数值为 `null`。

## 三个不同的量

1. **步骤影响估计** `J_i = P(A_i ∩ B_i ∩ C_i | E_i)`：`A_i` 表示本步引入或遗留与目标相关的问题，`B_i` 表示该问题到终局仍未消除，`C_i` 表示其对最终失败有实质影响。条件链
   `P(A_i|E_i) P(B_i|A_i,E_i) P(C_i|A_i,B_i,E_i)` 在数学上成立，无须假设三个事件独立。当前系数 4%/15%/45%/70%、60%、50% 是人工设计先验，状态始终为 `model_estimate`、`experimental_uncalibrated`，证据质量为 low。多个步骤可共同影响同一次失败，`J_i` 不归一化。`A_i` 包括遗留问题，因此 `J_i` 不是该步**制造根因**的因果概率。
2. **本轮目标终局风险** `q_t = P(Y_turn = failure | H_t, π, D)`：`Y_turn` 需要人工核验为当前 DSH turn 的用户目标是否最终失败，`H_t` 仅含时点 `t` 前的结构化事件，`π` 是执行策略，`D` 是数据域。`q_pre` 在当前 `step/start` 前由先前完成的步骤计算；`q_post` 在 `step/end` 后纳入本步观测。插件不从 `turn/end`、`tool/result.isError` 或文本关键词制造终局标签。
3. **风险变化** `Δq = q_post - q_pre`：只是看到本步后条件预测的变化。它可受之前积累的问题、任务难度、选择性执行和后续恢复影响，不等于本步的反事实致因效应，也不能代替 `J_i`。

若要估计 `P(origin=i | Y_turn=failure, H_t)` 或反事实“去掉本步”效应，还需独立的可审定步骤归因标签或可控介入；当前插件不输出该量。

## 可观测性与时点

| 来源 | 当前可用字段 | 使用边界 |
| --- | --- | --- |
| `step/start`, `step/end` | `turn`, `step`, 时间 | `step/start` 只看严格历史前缀；完成后才看本步结果 |
| `tool/call`, `tool/result` | `callId`, 工具名, `message.isError` | `isError=true` 表示框架报错；`false` 对非 shell 工具可形成内部成功，对 shell 还需结构化退出事实；正文与参数不保存 |
| `tools/result` | 顶层执行的 `callId`、工具名与 `result.value` 中的结构化前台完成状态 | 仅与模型直接调用的官方 `bash`、`pwsh` 配对；安全整数退出码 0/非 0 分别形成内部成功/错误，不读取或保存 stdout/stderr |
| `assistant/message`, `assistant/attempt` | 中断、尝试信号 | 重试恢复后不因历史请求错误把整步判为失败 |
| `agent/request-error`, `agent/error` | 请求错误、终止错误信号 | waterfall 原样返回 `next()`；迟到终止错误可修订同一步 |
| session header | agent preset, delegation depth | 仅供旧步骤兼容字段使用；本版 turn 风险模型不使用，也不将其当作任务结果标签 |

Shell 判据要求 `result.value.kind=foreground`、`timedOut=false`、`aborted=false`、`signal=null`、没有 `stopped` 字段、沙箱拒绝或运行器失败，且 `exitCode` 为安全整数。缺失、后台或不完整的结构化结果保留 `unknown`；`tool/result.message.isError=true` 仍优先产生内部 `error`。官方 PTC 模式下经 `run_code` 嵌套调用的 shell 不是本规则的顶层配对对象，不能拿内部退出码单独决定整个 step 成败。这里的内部成功/错误是执行观测，不是用户目标验收、问题来源或步骤致因标签。

指定 rc.2 的 `GenerateOptions` 和 `StreamChunk` 均没有 token logprobs，现有 `assistant/message`/`assistant/attempt` 事件也不携带该信息。DeepSeek 请求扩展能尝试加入请求字段，但是否被具体提供方接受尚未实测，当前响应翻译器也不会保留概率；OpenAI 兼容适配器同样没有请求和映射链路。提示词要求模型自述 logprobs 不能产生真实的逐 token 概率。若以后要实验，须先按提供方与模型实测，再修改请求、响应转换和有界事件契约。多次采样、自一致性和环境 rollout 会增加调用并可能改变被观察任务。本版不把它们伪装为被动、低延迟、已校准的故障概率。把多个相关评分直接当似然比相乘会重复计入先验，也不属于本版算法。

## 经验预测模型

数据单位是一条人工核验的 `(sessionId, turn)` 终局标签，取值只能是 `success` 或 `failure`。未结束、不可判定、用户撤回及基础设施中断不得硬塞进二元训练集；标注流程应在训练输入之外单独记录这些排除原因。每个已标注 turn 的每个前缀可形成训练例，但同一 turn 在同一个风险桶只贡献一次且评估按 turn 等权，避免长任务凭步骤数压倒短任务。

`turn-failure-empirical-v2` 的 `turn-prefix-structured-v2` 仅使用已完成步骤数的分桶、截至当前已观察的最高错误类别和是否出现过请求错误。桶形状沿用 v1，但 shell 结果观测口径已变，旧 v1 模型制品不兼容。错误类别来自结构化工具/agent 信号；读取或验证错误与执行动作错误分开，顶层 `bash`/`pwsh` 的非零退出因操作性质不明落入 unknown 错误类。模型使用训练集中的经验频率、平滑与稀疏桶回退，先回退到较宽的错误类别，再回退到训练集基率。模型不把旧步骤影响百分比作为特征或标签。

评估按**完整 session** 分组，并按其标注完成时间划分较早训练集和较晚留出集；同一 session 不可同时进入两边。至少 100 个已标注 turn、至少 30 个留出 turn，且训练和留出均需足够的成功及失败样本。留出集报告 Brier、对数损失、五箱 ECE 和训练基率基线。只有 Brier 与对数损失不差于基线、ECE 不高于 0.10 的候选才会成为可加载模型。这个门槛是**启用约束**，不构成跨项目或未来分布不变的准确性保证；应继续按项目、工具与时间监测漂移并复评。

模型文件只包含版本、聚合桶、训练基率、样本规模和留出汇总指标；不含会话 ID、标签行、prompt、工具参数、正文或错误原文。训练所需的私有标签文件留在用户本机，不纳入仓库或 npm 包。插件启动时从当前 profile 的 `step-risk/turn-risk-model-v2.json` 加载有界文件；新默认文件名与旧模型隔离。文件不存在返回 `missing_model`，格式错误、显式指定的旧 v1 制品或门槛未通过返回 `invalid_model`，均为 `value: null`。训练后重启宿主以加载新模型。加载器能检查文件结构和自报指标的一致性，不能凭模型文件独立证明标签由人核验、数据与当前任务同域或指标未经伪造；这些是操作者的数据治理责任。当前仓库没有真实人工标签，也没有实测预测准确率。

## 宿主与界面流程

```text
step/start
  └─ H_pre -> q_pre 或 null -> step-risk/turn-forecast + 当前面板提示
step/end
  ├─ 当前结构化事实（顶层 shell 可含结构化退出判据）-> 既有 J_i（未校准）
  └─ H_post -> q_post 或 null -> step-risk/prediction + 持久化步骤事实
GET /api/dsh-step-risk/snapshot
  └─ 从白名单步骤事实重建每行 q_pre、q_post、Δq；原有持久化 schemaVersion=1 可读
```

原生 Connection 载体负责 GET 身份与 Origin 检查；不增加裸 Web 路由或写入 API。模型预测仅用于可解释展示，本版不设置固定 0.4/0.7/0.9 阈值，不自动暂停、跳过或中止任务。启用干预需要误报/漏报代价、操作权限与前瞻性效用验证。

读取接口从当前模型和最新步骤修订**历史回算** `q_pre/q_post`，标为 `retrospective_current_model`。历史 turn 可能进入模型训练，因此回算值不是当时的执行前预报，也不能用来主张独立预测准确率；实时执行前事件、首次完成的 `at_step_end` 事件及迟到修订的 `at_revision` 事件对应当时加载的模型。当上一步在下一步开始后才收到修订时，重建的下一步 `q_pre` 也可能与当时 `step/start` 发出的值不同。精确的历史时点回放需要另存版本化事件日志，本版不宣称具备这一能力。

0.3.1 新步骤写入 `observationVersion: structured-shell-exit-v1`，只保存有界三态事实，不保存 shell 输出或退出码。0.2.0/0.3.0 旧行仍可读取展示，但旧 shell `success` 可能只代表 `isError=false`，旧步骤影响值属于历史口径，不能回填不存在的退出码或重算为新规则结果；标注 turn 中只要有旧行，v2 训练器即拒绝。合格 v2 模型的实时预测若前缀包含旧行，返回 `legacy_observation` 与 `null`；历史回算从该旧行的完成后起弃权。缺模型或无效模型状态优先。指定 rc.2 AgentLoop 每轮从 step 1 连续编号。若存储上限删除同一 turn 的早期步骤，或事件缺少中间步骤，模型不从残余尾部推断完整前缀，返回 `incomplete_prefix` 与 `null`；训练器也拒绝不完整 turn。

## 验收边界

- 软件验证：Node 单测证明前缀隔离、标签门槛、回退、旧记录读取与旧模型拒绝、顶层 shell 与嵌套调用隔离、敏感字段排除；指定 rc.2 的 Loader/AgentLoop/Session/Connection 烟测验证 `isError=false` 而 Bash 结构化非零退出的真实链路；浏览器测试证明客户端状态。分别报告，不把测试夹具当真实任务结果。
- 统计验证：只有同源、人工核验的成败 turn 标签与留出评估可支持 `q_t` 的经验解释；失败案例集或步骤错误信号不足以估计总体失败基率。
- 因果验证：`J_i` 仍是未校准设计先验，`Δq` 是关联量。要主张本步致因概率需步骤级来源/恢复/贡献标注或介入设计与单独评估。

原 `Failure_Probability` 通用方案里的 Python SDK、LangChain/AutoGen 适配、K8s/S3、蒙特卡洛重放和自动中止均不属于当前 DSH 插件的已验证能力。
