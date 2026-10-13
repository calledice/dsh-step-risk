# DSH Step Risk

DeepSeek Harness **V0.2.0-rc.2** 的步骤风险插件，版本 **0.3.0**。在每个原生 `step/end` 后展示该步骤引入或遗留的问题最终影响目标的**未校准模型估计**；另可在有人工核验的成败标签与通过留出检验的模型时，展示当前 turn 目标的终局失败风险。界面位于 Harness 右侧栏。步骤模型移植自 codex-step-risk 0.4.1 的 step-failure-chain-v1。

每步影响事件分别定义且可能重叠，无需相加到 100%。其参数是公开设计先验，标记 `experimental_uncalibrated`；它们不是经验校准或反事实致因概率。本轮终局风险是另一预测目标，缺少可用模型时明确显示“暂无可用概率”，不会用工具错误代替任务失败标签。DSH 的一个 step 包含一次模型调用及其请求的工具执行。

## 安装到 Windows 桌面版

使用 Harness 自带的 CLI，不需要另装全局 dsh。在本仓库根目录的 PowerShell 中执行：

```powershell
$dshCli = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
$selection = Join-Path $env:APPDATA 'DSH Desktop\profile-selection\state.json'
$dshProfile = if (Test-Path $selection) { (Get-Content $selection -Raw | ConvertFrom-Json).active } else { 'desktop' }
& $dshCli --version
& $dshCli plugin --profile $dshProfile add (Get-Location).Path
```

也可以把最后的路径替换成发行的本地 .tgz。目标版本为 0.2.0-rc.2，插件声明了精确的可选 DSH peer 要求，不需要兼容性豁免，也不会另装一份 Harness。当前 Desktop 选中的 profile 可能叫 `web`；独立 Web CLI 用户将 `$dshProfile` 设为自己的 profile 名称。

安装后打开一个会话，在右侧栏的新标签引导页选择 **Step Risk**；设置页也有 **Step Risk** 历史记录浏览器。若客户端尚未刷新，重新加载页面或退出并重开 Harness。运行一个新任务，已结束步骤会每 2 秒刷新到面板。安装前的历史对话不会补读；重启后可查看插件此前保存的记录。

### 快速检查

1. 新建一个会话，点击右上角“打开右侧边栏”；若已有侧栏标签，先点击“＋”。
2. 在新标签引导页选择 **Step Risk**。
3. 发送 `只回复 STEP_RISK_OK，不要调用任何工具。`
4. 回复结束后等待约 2 秒。若该步骤没有工具调用，应出现“实际结果：未知”和 **4.5%** 的当前规则估计，以及“本轮目标终局失败风险：暂无可用概率”（未训练模型时）。“未知”表示没有工具结果可供判定。

卸载：

```powershell
& $dshCli plugin --profile $dshProfile remove dsh-step-risk
```

卸载包不删除记录。默认目录是当前 profile 的 step-risk 子目录，例如 %USERPROFILE%\.dsh\profiles\desktop\step-risk。

## 功能

- 每个 Turn / Step 的未校准步骤影响估计、观测结果、工具名、agent 角色。
- `step/start` 使用严格历史前缀发出当时的执行前 turn 风险；已完成步骤的面板值由当前模型**历史回算**执行前、执行后和百分点变化，可能包含模型训练期的 turn，不能当作当时的预报或独立评估。变化是条件预测的关联变化，不是本步因果贡献。没有通过留出检验的模型时所有 turn 风险数值为 `null`。
- 展开查看问题发生、问题持续、最终影响三个条件因素及其假设。
- 按步骤顺序或估计概率排序；原生标签绑定当前会话，设置页可切换已记录会话。
- 无工具调用的模型步骤也有估计，结果为未知。请求重试只是历史信号，成功恢复后的步骤不会仅因重试判为失败。
- 界面中的“工具未标错”表示 DSH 返回的 `isError` 为 `false`，不能证明用户意图中的操作或目标成功。
- 迟到的终止性 agent/error 修订同一个步骤，不重复添加行。
- 同一 turn 的较早步骤若因保留上限被删除，后续风险会标为 `incomplete_prefix` 并返回空值；新 turn 从完整空前缀开始。

本地规则与可选的经验频率模型均无需 API key、额外模型调用或网络。Codex 专用 Luna 提供方读取和 AI 评估界面不属于此版本。

## 配置

默认保留最近 100 个会话、每会话最近 500 个步骤。在 profile 的 cordis.patch.yml 中覆盖：

```yaml
- id: step-risk
  name: dsh-step-risk
  config:
    logToConsole: false
    dataDir: !!js ctx.get('profileContext').dir + '/step-risk'
    maxSessions: 100
    maxStepsPerSession: 500
    roleByPreset:
      my-planner: planner
      my-reviewer: verifier
```

Harness patch 替换整段 config，覆盖时请保留 dataDir。dataDir: null 只保存在内存。目录应专用于插件；超出保留数量的哈希 JSON 文件会被清理。每个 profile 使用自己的目录，不要让多个进程并发写同一目录。

可选 `logFile` 写 JSONL，`logToConsole: true` 输出结构化日志。`step-risk/prediction` 保留旧归因字段并附加 `turnRisk` 展示投影；`step-risk/turn-forecast` 在 `step/start` 发出。步骤影响只使用 `stepFailure.value`，旧 `baseHazard` 等参数不会改变它。本地 0.2.0 的已存记录可在 0.3.0 中读取，并在下一次写入该会话时升级外层版本。

### 本轮目标终局风险模型

插件默认尝试从当前 profile 的 `step-risk/turn-risk-model.json` 加载经验模型。可在 Cordis config 中用绝对路径 `turnRiskModelFile` 覆盖；无文件或文件无效时插件照常运行，但 turn 风险保持空值。新模型在插件启动时加载，训练后需重启 Harness。模型文件不会被现有的步骤记录保留清理规则误删。

训练标签须由人核验**当前 turn 的用户目标**是否最终达成，不能取自 `turn/end`、工具退出状态或步骤影响值。标签为私有 JSONL，每行例如：

```json
{"sessionId":"<本机实际会话 ID>","turn":1,"outcome":"failure","completedAt":"2026-10-13T08:00:00.000Z"}
```

`outcome` 只能是 `success` 或 `failure`。未完成、撤回、无法判定的 turn 不写为二元标签。把标签保存在仓库之外；模型训练报告和模型产物只含汇总计数与指标，不含会话 ID 或原始标签。

```powershell
$selection = Join-Path $env:APPDATA 'DSH Desktop\profile-selection\state.json'
$dshProfile = if (Test-Path $selection) { (Get-Content $selection -Raw | ConvertFrom-Json).active } else { 'desktop' }
$recordDir = Join-Path $env:USERPROFILE ('.dsh\profiles\' + $dshProfile + '\step-risk')
$labelFile = Join-Path $env:USERPROFILE 'dsh-turn-outcomes.private.jsonl'
node scripts/train-turn-risk.mjs --records $recordDir --labels $labelFile --model (Join-Path $recordDir 'turn-risk-model.json') --report (Join-Path $recordDir 'turn-risk-evaluation.json')
```

训练需要至少 100 个已核验 turn 和 30 个时间留出 turn，并按完整 session 隔离。未通过 Brier、对数损失与 ECE 门槛时不会生成新的合格模型；这些门槛是启用规则，并非概率已校准或跨域准确的保证。请先检查报告的样本量、失败基率及适用数据域，再在真实任务中解释百分比。详细论证见 [故障概率技术设计](docs/FAILURE_PROBABILITY_DESIGN.md)。

重新训练失败时 CLI 保留已有模型，并在报告中用 `existingModelRetained` 明示其可能继续生效；`modelWritten` 表示本次是否写入新模型。若要停用旧模型，请将 `turn-risk-model.json` 移出该目录并重启 Harness。

步骤记录不包含 prompt、工具参数、响应正文、错误原文、凭据或完整对话。会话 ID 和工具名仍属于本地工作元数据。面板接口通过 Harness Connection 通道访问，复用其 Web/桌面身份检查。

## 验证与开发

```powershell
node --test
node scripts/verify-dsh-runtime.cjs --report docs/validation-dsh-rc2.json
node scripts/verify-dsh-runtime.cjs --synthetic-model --report docs/validation-dsh-rc2-evaluated.json
node scripts/verify-client-browser.cjs
```

两条宿主命令在 Windows 安装的 Harness 中运行隔离 profile，用真实 Cordis Loader、AgentLoop、Session、工具运行时和 Connection 验证加载、成功/失败/无工具步骤、存储和认证。前一条验证缺模型时弃权；后一条用合成标签训练的模型验证数值预测链路，不代表真实预测准确率。LLM 是确定性测试适配器，不会使用用户凭据。安装位置不同时传 --electron <exe>。

`node scripts/verify-client-browser.cjs` 另行验证实际 `client.js` 的浏览器渲染、排序和因素、会话隔离、空状态和错误状态、隐藏后停止轮询。该开发检查需要 Playwright/Chromium 和 React/ReactDOM 18.3.1；路径参数和测试依赖安装方式见脚本头注释，插件正常使用无需这些测试依赖。它使用最小槽位测试宿主，不等同于真实 Desktop 界面挂载检查。

前版 0.2.0 在本机 V0.2.0-rc.2 的实际使用画面见 [原生 Desktop 截图](docs/step-risk-desktop-rc2.png)。新版 0.3.0 的 [浏览器测试预览](docs/step-risk-preview.png) 使用确定性测试样例。

详细边界见 [产品约定](docs/PRODUCT_SPEC.md)、[模型说明](docs/MODEL.md) 和 [验证记录](docs/VALIDATION.md)。MIT License。
