# DSH Step Risk

DeepSeek Harness **V0.2.0-rc.2** 的步骤风险插件，版本 **0.2.0**。在每个原生 step/end 后计算该步骤引入或遗留的问题最终影响任务失败的模型概率，并在 Harness 右侧栏显示。模型移植自 codex-step-risk 0.4.1 的 step-failure-chain-v1。

每步有独立估计，各步百分比无需相加到 100%。数值使用公开设计先验，标记 experimental_uncalibrated。执行成功、错误、未知等观测事实与估计分别展示。DSH 的一个 step 包含一次模型调用及其请求的工具执行。

## 安装到 Windows 桌面版

使用 Harness 自带的 CLI，不需要另装全局 dsh。在本仓库根目录的 PowerShell 中执行：

```powershell
$dshCli = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $dshCli --version
& $dshCli plugin --profile desktop add (Get-Location).Path
```

也可以把最后的路径替换成发行的本地 .tgz。目标版本为 0.2.0-rc.2，插件声明了精确的可选 DSH peer 要求，不需要兼容性豁免，也不会另装一份 Harness。Web CLI 用户把 desktop 换成自己的 profile 名称。

安装后打开一个会话，在右侧栏的新标签引导页选择 **Step Risk**；设置页也有 **Step Risk** 历史记录浏览器。若客户端尚未刷新，重新加载页面或退出并重开 Harness。运行一个新任务，已结束步骤会每 2 秒刷新到面板。安装前的历史对话不会补读；重启后可查看插件此前保存的记录。

### 快速检查

1. 新建一个会话，点击右上角“打开右侧边栏”；若已有侧栏标签，先点击“＋”。
2. 在新标签引导页选择 **Step Risk**。
3. 发送 `只回复 STEP_RISK_OK，不要调用任何工具。`
4. 回复结束后等待约 2 秒。若该步骤没有工具调用，应出现“实际结果：未知”和 **4.5%** 的当前规则估计；“未知”表示没有工具结果可供判定。

卸载：

```powershell
& $dshCli plugin --profile desktop remove dsh-step-risk
```

卸载包不删除记录。默认目录是当前 profile 的 step-risk 子目录，例如 %USERPROFILE%\.dsh\profiles\desktop\step-risk。

## 功能

- 每个 Turn / Step 的概率、观测结果、工具名、agent 角色。
- 展开查看问题发生、问题持续、最终影响三个条件因素及其假设。
- 按步骤顺序或估计概率排序；原生标签绑定当前会话，设置页可切换已记录会话。
- 无工具调用的模型步骤也有估计，结果为未知。请求重试只是历史信号，成功恢复后的步骤不会仅因重试判为失败。
- 迟到的终止性 agent/error 修订同一个步骤，不重复添加行。

此移植版使用本地规则模型，收集和计算无需 API key、模型调用或网络。Codex 专用 Luna 提供方读取和 AI 评估界面不属于此版本。

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

可选 logFile 写 JSONL，logToConsole: true 输出结构化日志。step-risk/prediction 事件保留旧归因字段供兼容集成；主指标只使用 stepFailure.value。旧 baseHazard 等参数不会改变新模型百分比。

记录不包含 prompt、工具参数、响应正文、错误原文、凭据或完整对话。会话 ID 和工具名仍属于本地工作元数据。面板接口通过 Harness Connection 通道访问，复用其 Web/桌面身份检查。

## 验证与开发

```powershell
node --test
node scripts/verify-dsh-runtime.cjs --report docs/validation-dsh-rc2.json
```

第二条在 Windows 安装的 Harness 中运行隔离 profile，用真实 Cordis Loader、AgentLoop、Session、工具运行时和 Connection 验证加载、成功/失败/无工具步骤、存储和认证。LLM 是确定性测试适配器，不会使用用户凭据。安装位置不同时传 --electron <exe>。

`node scripts/verify-client-browser.cjs` 另行验证实际 `client.js` 的浏览器渲染、排序和因素、会话隔离、空状态和错误状态、隐藏后停止轮询。该开发检查需要 Playwright/Chromium 和 React/ReactDOM 18.3.1；路径参数和测试依赖安装方式见脚本头注释，插件正常使用无需这些测试依赖。它使用最小槽位测试宿主，不等同于真实 Desktop 界面挂载检查。

本机 V0.2.0-rc.2 的实际使用画面见 [原生 Desktop 截图](docs/step-risk-desktop-rc2.png)。另有 [浏览器测试预览](docs/step-risk-preview.png)，后者数据来自确定性测试样例。

详细边界见 [产品约定](docs/PRODUCT_SPEC.md)、[模型说明](docs/MODEL.md) 和 [验证记录](docs/VALIDATION.md)。MIT License。
