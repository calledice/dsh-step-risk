# DSH Step Risk 0.3.1 产品约定

目标运行时为 DeepSeek Harness V0.2.0-rc.2。入口是 npm/本地 bundle，dsh.bundle.patch 安装 Host 观察器，dsh.client 加载原生客户端。客户端包括会话右侧栏标签和设置页记录浏览器，均无需安装时构建。

步骤影响估计继承 Codex Step Risk 0.4.1：在步骤完成时可见证据下，本步引入或遗留的问题持续到结束，并对目标失败产生实质影响的规则估计。多个步骤可能共同影响最终结果，不归一化。新增的本轮目标终局风险只在有人工核验的 turn 成败标签、且经验模型通过时间留出检验后给出；默认无模型时数值为 `null`。

## 事件契约

官方源码：dsh-v0.2.0-rc.2，提交 639ed015397290b3745d163aafe02ffee4aa3f84。

- session/event：真实 Session 对象与事件。step/end.data 包含 turn、step；一个 step 是一次模型调用及其工具执行。
- tool/call.data：callId 和 name，不保存 arguments。
- session/event 的 tool/result.data.message.source.callId 匹配调用；`message.isError=true` 是框架报错事实，其 `false` 不能单独判定 shell 命令成功。
- tools/result(exec,result) 提供官方 `bash`、`pwsh` 的原始结构化执行结果。仅匹配模型直接调用的同一步顶层 `callId` 与工具名，读取有界的前台完成状态和退出码；PTC `run_code` 内嵌 shell 不适用此规则，stdout/stderr 不参与判定或持久化。
- agent/request-error(payload,next)：waterfall 必须原样返回 next()；重试不等于最终报错。
- agent/error：终止性错误可修订刚完成的步骤。
- session/disposed：释放在线跟踪状态，展示历史保留。

事实合并：任一工具 `isError=true` 则内部状态为 error。其他工具 `isError=false` 判为内部成功；官方 `bash`、`pwsh` 还须 `result.value.kind=foreground`，`timedOut=false`、`aborted=false`、`signal=null`，无 `stopped` 字段、沙箱拒绝或运行器失败，且退出码为安全整数。结构化退出码 0 为内部 success，非 0 为内部 error；不完整、后台或无法匹配的 shell 结果为 unknown。全部已请求工具有结果、各自满足成功判据且无中断/截断时整步为 success；明确错误优先，其余为 unknown。内部 success/error 是执行观测，不证明用户目标成败。无工具模型步骤为 unknown。报错工具的操作类型一致时采用该类型，混合或不明则 unknown。请求错误和 attempt 保留为解释信号，不覆盖恢复后的成功观测。

## 输出与数据

`stepFailure` 为 `{modelVersion,status,value,source,factors,evidenceQuality,summary,reasons,limitations,evidenceRefs}`，source 固定 rules，status 为 model_estimate，校准标记为 experimental_uncalibrated。同时保存角色、委派深度、工具名、工具数和结构化工具观测；0.3.1 新步骤带 `observationVersion: structured-shell-exit-v1`。只持久化三态结论，不持久化退出码或原始执行结果。旧 tracker 的 pCurrent 等字段仅保留在兼容事件/可选日志中。

`step/start` 发出当时的 `step-risk/turn-forecast`，含 `phase: pre`、`horizon: turn_final_failure`、`status`、`value`、`modelVersion`、`support`。`step/end` 的 `step-risk/prediction` 附带该步 `turnRisk`，包含 `pre`、`post`、`delta` 和 `projection: at_step_end`；`delta` 仅为条件预测变化，不作因果解释。GET 快照保留 `schemaVersion: 1`，附加 `turnRiskModel`、`activeTurnForecast` 和每行 `turnRisk`。持久化步骤不增加预测字段，旧 0.2.0/0.3.0 记录可读且不会被改判；其 shell `success` 可能只依据 `isError=false`，旧步骤影响值保留历史口径。读取时由当前模型回算并标为 `projection: retrospective_current_model`。历史 turn 可能参与当前模型训练，因此快照行不能作为当时预报或独立准确率证据。

记录按会话哈希命名并原子替换，默认最多 100 会话、每会话 500 步。重复完成不重复插入，较新 revision 替换对应步骤，重启恢复插件记录。默认仅结构化白名单，不读既有 transcript，不保存目标/参数/响应/错误正文。

客户端使用官方 Connection.fetch.register 的 GET /api/dsh-step-risk/snapshot。Web 与 Desktop 使用同一路径及受认证载体。面板可见时每 2 秒轮询，隐藏或切换会话取消旧请求；迟到响应不能覆盖新会话。

可选 `turn-failure-empirical-v2` 模型从当前 profile 的 `step-risk/turn-risk-model-v2.json` 加载一次，要求 `turn-prefix-structured-v2` 特征版本。新默认文件名隔离旧模型；显式指定的 v1 模型仍为无效，须从新版步骤观测和人工标签重新训练。缺失或无效时，Host 与界面继续提供规则步骤估计，所有 turn 风险数值保持空值。模型生成使用私有人工标签 JSONL、按 session 分组的时间留出和固定启用门槛；训练工具拒绝含旧观测的已标注 turn，也不把 prompt、输出或标签行写入模型。界面显示“工具执行未见错误”而不把它呈现为任务成功；未通过留出门槛不会触发自动暂停、中止或跳过。

预测只接受指定 rc.2 AgentLoop 从 step 1 连续编号的同 turn 前缀。保留上限删掉较早步骤或中间缺步时，实时与历史风险均以 `incomplete_prefix`、`null` 弃权；含无 `structured-shell-exit-v1` 标记的旧步骤时，合格 v2 模型从该步起以 `legacy_observation`、`null` 弃权。离线训练拒绝这两类标签记录；无模型与无效模型状态优先。

## 验收

1. 指定版本真实 Loader 加载，无版本豁免。
2. 原生 AgentLoop 的普通工具成功/失败、官方前台 shell 非零退出且 `isError=false`、无工具步骤各自产生规则估计；每个 `step/start` 发出可用或明确空值的执行前 turn 风险。
3. 结果判定、读写错误区分、重复/迟到事件、waterfall、旧观测/模型隔离和会话隔离有测试；shell 正文不得进入步骤记录、存储或响应。
4. 历史可恢复、有界、只保存白名单字段。
5. 原生客户端分别呈现步骤影响与本轮风险，支持无模型、活动步骤、空记录和读取错误。
6. 用户 profile 安装可回滚，记录实际验证层级。

本版无外部 AI 评估，不用未来成功重写既有规则步骤估计，不将 turn/end 当作任务成功标签。读取时基于最新修订重建的历史 turn 风险不一定等于当时发出的执行前事件；精确时点重放需要版本化事件日志。测试证明软件行为，不证明概率准确性、跨域泛化或因果归因。
