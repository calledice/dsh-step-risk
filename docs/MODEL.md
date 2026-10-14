# 模型说明：DSH Step Risk 0.3.1

插件展示两个目标不同的量。`stepFailure.value` 是某个已完成步骤关联问题最终影响目标的规则估计 `J_i`，状态固定为 `model_estimate`、`experimental_uncalibrated`。`turnRisk` 是当前 turn 用户目标最终失败的条件预测 `q_t`，只有通过指定留出检验的经验模型可用时才给出数值。两者的分母、训练依据和用途不同，不合并、不归一化。

主模型移植自 Codex Step Risk 0.4.1 的 step-failure-chain-v1。令 A 为本步留下相关问题，B 为该问题直到结束仍未消除，C 为它对目标失败产生实质影响：

P(A ∩ B ∩ C | evidence) = P(A | evidence) × P(B | A,evidence) × P(C | A,B,evidence)

这是条件概率链，不要求三个因素独立。每步对应独立定义的事件，数值在步骤之间不归一化。状态 model_estimate；校准状态 experimental_uncalibrated。

| DSH 步骤事实 | 问题先验 | 条件持续先验 | 条件影响先验 | 估计 |
| --- | ---: | ---: | ---: | ---: |
| 结果未知或无工具步骤 | 15% | 60% | 50% | 4.5% |
| 工具结果全部满足结构化成功判据 | 4% | 60% | 50% | 1.2% |
| 明确修改操作报错 | 70% | 60% | 50% | 21% |
| 操作不明且报错 | 45% | 60% | 50% | 13.5% |
| 读取/验证报错 | 15% | 60% | 50% | 4.5% |

参数是公开设计先验，证据质量 low。读取/验证发现错误不自动表示它制造了问题。`bash`、`pwsh` 等通用执行工具仅凭名字不能分类；结构化非零退出通常落在“操作不明且报错”一行。正文中的 error/success 或渲染的退出码文字不能转换为执行判据。

一个 DSH step 可能含多个工具。`tool/result.message.isError=true` 优先形成内部 `error`。对其他工具，`isError=false` 是成功判据；对模型直接调用的官方顶层 `bash`、`pwsh`，插件还按同一步 `callId` 与工具名配对 `tools/result`，要求其 `result.value` 为 `kind=foreground`，`timedOut=false`、`aborted=false`、`signal=null`，无 `stopped` 字段、沙箱拒绝或运行器失败，并含安全整数 `exitCode`：0 为内部 `success`，非 0 为内部 `error`。Shell 的后台作业、缺失或不完整的结构化结果为 `unknown`。PTC 模式下由 `run_code` 嵌套执行的 shell 不适用这条顶层规则，其内部退出码不单独决定整步结果。stdout/stderr、工具参数和结果正文既不参与判定也不保存。

没有明确错误时，若有缺失结果、未知判据、中断或超出有界采集容量，整步为 `unknown`；全部工具有结果且各自满足成功判据，整步才为内部 `success`。这仅是工具执行观测，不证明预期副作用、用户目标或推理正确。操作类型由报错工具确定，无报错则由全部工具确定，混合类型保持 unknown。无工具步骤的正常结束不证明推理正确。

主指标只用本步结构化事实，不依赖旧 pCurrent、责任份额或角色 hazard，不随无关后续步骤变化。迟到的终止性 agent/error 增加同一步 revision，改用 error/unknown 操作估计。其它未来成功不自动降低历史值。

旧 src/tracker.js 的 architecture-aware 贝叶斯排名仍用于兼容事件字段：角色与委派深度影响旧 priorHazard，保留/压缩/未来质量之和为 1。旧模型与主指标语义不同，原生面板只显示条件链结果。旧 0.1.0 JSONL 不自动作为新模型事实读取。0.3.1 新步骤持久化 `observationVersion: structured-shell-exit-v1`；0.2.0/0.3.0 记录可继续展示。旧 shell 行的 `success` 可能仅代表 `isError=false`，其旧步骤影响值属于历史观测口径；缺少标记的行不被静默按新判据重算。

## 本轮目标终局风险 `q_t`

预测目标是人工核验的单个 `(sessionId, turn)` 用户目标最终是否失败，标签只能为 `success` 或 `failure`。`turn/end`、`tool/result.isError`、步骤影响值和文本关键词都不是目标标签。未完成、撤回、不可判定的 turn 不进入二元训练。训练文件保留在本机私有位置，CLI 只输出聚合模型和汇总评估报告。

`turn-failure-empirical-v2` 使用 `turn-prefix-structured-v2` 特征：同一 turn 中**已经完成**的步骤数桶（0、1、2–3、4+）、观测到的最高错误类别（none、读取/验证、未知类型、执行动作）、以及是否曾出现请求错误。桶形状沿用 v1，但 shell 执行结果的观测口径已变，旧 v1 模型制品会被判为 `invalid_model`，不能直接复用。`step/start` 的执行前预测只看此前完成的步骤；`step/end` 后纳入本步事实。每个已标注 turn 在一个训练桶里最多贡献一次，经验失败频率用训练基率强度 4 平滑；精确桶支持少于 10 时回退到较宽错误桶，后者支持少于 20 时回退到训练基率。`support` 是实际使用桶的训练 turn 数。旧 `J_i` 值不作为特征。

同一 session 的所有已标注 turn 必须在同一个分区。按 session 最晚标签完成时间排序，用较早 session 训练、较晚 session 留出；至少 100 个已标注 turn、30 个留出 turn，训练集各类至少 10 个、留出集各类至少 5 个。留出评估对每个 turn 等权，报告 Brier、对数损失、五箱 ECE，并以训练失败基率作为 Brier 和对数损失基线。只有两项损失不差于基线且 ECE≤0.10，模型文件才标记可加载。这些数值是预设的启用规则，不是由数据证明的误差上界；留出集也不是独立的最终外部测试集。

模型文件保留版本、平滑规则、聚合桶和汇总指标，不含会话 ID、正文、参数、错误原文、标签行或训练样例。加载器验证结构、范围和自报门槛，无法独立证实人工标签质量、样本代表性或评估指标的来源；使用者须审核标签协议和数据域。启动时文件缺失或无效，`q_t` 为 `null`，状态为 `missing_model` 或 `invalid_model`。当前仓库没有真实人工标签或经实测的准确率，所以发布默认不显示经验百分比。

每步显示的 `pre`、`post` 与 `delta = post - pre` 是条件预测。`delta` 不是该步致因效应，也不等于 `J_i`。读取接口用当前模型和最新步骤修订**历史回算**；旧 turn 甚至可能被当前模型用作训练样本，故不能把回算值当作当时的执行前预报或留出集外准确率。快照行以 `projection: retrospective_current_model` 标明，实时 `step-risk/prediction` 事件的本步结果以 `projection: at_step_end` 标明。若先前步骤在后续步骤开始之后才被修订，历史展示的 `pre` 可能不同于当时 `step/start` 事件发出的值。要精确重放事件时点，需要额外的版本化事件日志。

指定 rc.2 AgentLoop 每个 turn 从 step 1 连续编号；若插件只保留到 turn 的尾部，或缺少中间步骤，模型不得把剩余记录误当完整前缀。此时 `status: incomplete_prefix`、值为 `null`。合格 v2 模型遇到含旧观测的完整前缀时，从该旧步骤起以 `legacy_observation`、`null` 弃权；训练器拒绝含旧步骤的已标注 turn。旧记录仍可展示，但须用新版观测重新收集并人工核验后训练。缺失或无效模型的状态优先于前缀弃权状态。可在保留容量内开始新 turn 重新获得完整前缀。

规则步骤值未经真实任务终局验证；经验 turn 风险也尚无本项目人工标注模型。单测、浏览器和宿主烟测验证软件行为，不提供概率校准或因果识别证据。
