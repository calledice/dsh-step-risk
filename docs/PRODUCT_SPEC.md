# DSH Step Risk — 产品与研究约定

版本：0.1.0 首版实现（2026-10-09）

## 目标

作为可安装的 DeepSeek Harness Cordis bundle，在每个已结束的 agent step 上即时给出“该 step 最终会被认定为决定性责任步骤”的模型概率，并列出当前最可疑的历史步骤。运行时不重放、不修改 agent 的提示词、工具结果或控制流，也不需要预先知道任务长度。

## 概率的精确定义

插件首版估计 P(C=(session, turn, step) | 当前可见事件, 该任务最终失败, 责任步骤属于该 session)，其中 C 是一个任务失败时被选出的决定性责任步骤。输出保留“该 session 的责任尚在未来步骤”的概率质量。不同 agent session 的概率不构成全任务归一化分布。它不是 P(任务最终失败)，也不是步骤错误已被因果证明的概率。

当前数据只有失败或部分失败轨迹，没有成功轨迹；不同系统的原子事件与 DeepSeek Harness 的 step（一次模型调用及其工具执行）也不等价。首版数值属于未校准的模型估计，输出必须标明 experimental_uncalibrated。待收集本插件的成功/失败运行和人工责任标签后，再做适用性与校准检验。

## 用户场景与输出

1. 用户把 GitHub 仓库安装成 DSH bundle 后，不改现有 agent 任务链即可观察每步估计。
2. 一个 step 结束时，终端输出当前步骤概率、历史 Top-3 候选、未来质量、架构分组及证据码。
3. 可选 JSONL 文件供离线检查和标注；不写入原始提示词、工具参数、回复正文或密钥。
4. 插件加载失败时明确报错；普通单条事件异常不应中断 Harness agent。

## 技术路线

### 接口

- 与 DeepSeek Harness 0.2.1-alpha.1（源码修订 5badb15009ae1756c3afe0ae0cef1faafc290ccc）的 Cordis bundle 契约兼容。
- 观察持久 session/event：step/start、tool/result、assistant/message、assistant/attempt、step/end。观察 agent/request-error 与 agent/error 获取失败信号。
- 读取 Session.header.agentPreset、origin、delegationDepth，并从配置映射 preset 到角色。只读取，不改变事件或模型调用。
- 直接分发预构建 ESM JavaScript 和 cordis.patch.yml；GitHub 安装不运行 prepare。

### 模型

每个会话保留候选步骤的非归一化质量和 futureMass。新步骤的架构条件 hazard 为 h_t = sigmoid(logit(baseHazard) + roleOffset + depthOffset)；从 futureMass 分出 futureMass × h_t 给当前步骤，余量留给未知未来。每个后续步骤先按 recoveryHazard 将少量历史质量移回未来；当前步骤的证据按配置的似然比调整候选质量，例如工具报错、模型请求失败和中断。无已支持硬信号时使用 no_hard_signal 负证据。再对已见候选与未来质量归一化，输出 pCurrent、pCurrentGivenNoEarlier、pFuture、Top-3。迟到的 agent/error 可修订刚结束的步骤。有限候选上限只压缩低质量历史候选到 otherPastMass，不能静默丢弃概率质量。

这是透明、可测试的贝叶斯假设模型。似然比是首版专家默认值，不因公式形式而自动得到经验校准。插件始终输出模型版本和校准状态。

### 架构感知

- 每个 agent 会话按 preset 映射为 planner、executor、verifier 或 other，记录是否由 subagent 产生及委派深度。
- 角色参数只作为弱先验；工具/模型硬错误形成证据。不能把别的系统中“失败责任占比”直接当成每步出错率。
- 环境与评分器故障不能强行指派给 agent。首版只在 DSH agent step 候选之间排序；输出保留 unattributed 提示，后续由人工确认故障域。

## 数据使用与评估

内网 GFA Review 站点共 322 条轨迹：145 条状态为 completed，其中 80 条是已完成的多 agent 任务失败；67 条归因于 agent 系统，去除同轨迹复核副本后约 66 条。它们可用于验证角色先验和离线候选排序，但不能直接校准 DSH 实时概率。原始轨迹和标注不进入公开 GitHub 仓库。

首版用合成事件测试事件契约、单调步骤、证据更新、未知长度、会话隔离和数据最小化。15 项 Node 测试已通过；本机没有可调用的 DSH CLI，真实 profile 启动烟测待用户安装后执行。详细记录见 docs/VALIDATION.md。试用期收集人工确认标签后，按原始任务/轨迹分组划分数据，报告 Top-1/Top-3 命中率、Brier 分数和可靠性图；未通过校准检验前保留未校准标识。

## 非目标与边界

- 不预测任务最终成功率。
- 不执行反事实重放，不自动阻断或修复 agent。
- 不声称离线 GFA 标签与 DSH step 有无损映射。
- 没有可观察证据时允许概率分散；不保证早期隐蔽错误能在发生当下被检出。
