# DSH Step Risk 0.2.0 验证记录

日期：2026-10-13。目标运行时：DeepSeek Harness **V0.2.0-rc.2**。本记录取代此前针对 0.2.1-alpha.1 的验证记录。

官方参考源码为 `dsh-v0.2.0-rc.2`，提交 `639ed015397290b3745d163aafe02ffee4aa3f84`。

## 自动测试与独立审查

- 当前工作树在 Node.js `24.21.0` 下运行 `node --test`：**59 项通过，0 项失败、跳过或取消**。
- 覆盖条件链概率、原生事件提取、工具调用与结果配对、读写错误区分、无工具步骤、重试恢复、重复事件、迟到终止性错误、会话隔离与释放。
- 存储测试覆盖原子写入、重启读取、修订替换、保留上限、损坏与超大文件、路径形态的会话 ID，以及白名单字段和正文排除。
- 路由测试覆盖只读访问、查询校验、错误响应与注册释放；客户端测试覆盖注册、会话切换、排序、空状态、读取失败、隐藏时停止轮询及迟到响应处理。客户端测试使用模拟 React hook host，不构成真实桌面渲染证据。
- 独立只读代码审查未发现可执行的 P0–P2 问题。审查对照指定版本源码确认事件字段与时序、waterfall 透传、Connection 注册、右侧栏与设置槽位、桌面请求转发及精确版本兼容性检查。该结论限于已审查范围。

## 指定版本真实运行时烟测

命令：

```powershell
node scripts/verify-dsh-runtime.cjs --report docs/validation-dsh-rc2.json
```

脚本使用已安装桌面版的 Electron Node 启动独立临时 profile，加载打包清单中的插件文件。机器可读结果见 [validation-dsh-rc2.json](validation-dsh-rc2.json)，记录时间为 `2026-10-13T06:41:45.173Z`（北京时间 14:41:45）。运行环境为 DSH `0.2.0-rc.2`、Electron `44.0.0`、Node.js `24.18.1`。

已通过的真实运行时检查：

- 使用生产 Cordis Loader、AgentLoop、Session、工具运行时和 Connection 加载插件，无兼容性豁免。
- 确定性 LLM 适配器驱动 3 次模型步骤、2 次真实工具执行；每个 `step/end` 产生一条预测。
- 三步结果依次为 `success`、`error`、`unknown`，对应 `stepFailure.value` 为 `0.012`、`0.135`、`0.045`。
- bundle 默认目录实际写入哈希 JSON；新建 store 实例能恢复全部 3 步及相同概率。
- 原生 Connection 拒绝未认证请求（401）和不可信 Origin（403）；认证后 GET 返回 200 及结构化 JSON；非法查询返回 400；POST 不存在（404）。
- 预测、持久化文件及接口响应均未包含测试 prompt/工具参数/响应正文中的私密标记。
- 烟测只使用隔离 profile，完成后关闭并清理；该脚本没有修改用户 profile。

烟测的 LLM 是确定性测试适配器，未请求真实模型提供方，也未使用用户凭据。它证明真实 Host、Agent 与工具链路可运行，不证明真实模型任务的结果或概率准确性。

## 实际客户端的浏览器渲染

运行 `node scripts/verify-client-browser.cjs`：**10 组检查通过，浏览器 JavaScript 错误为 0**。机器可读结果及最新执行时间见 [validation-client-browser.json](validation-client-browser.json)，预览见 [step-risk-preview.png](step-risk-preview.png)。

- 使用原样 `client.js`、Chromium `133.0.6943.16`、React/ReactDOM `18.3.1`；React 版本与官方 rc.2 源码锁文件一致，使用 npm 上游 UMD 包，并非从原生应用提取的运行时单例。
- 420 px 面板宽度下显示三种事实结果与 1.2%、13.5%、4.5%；展开后正确展示三个条件因素，按概率排序有效，未出现横向溢出。预览已经人工目视检查。
- 会话切换不串数据，迟到的旧请求不覆盖新会话；空记录、503 错误提示和保留上次成功数据均符合预期。
- 隐藏面板后停止轮询，重新显示后恢复；设置面板可选择会话；所有数据请求为 GET。
- 测试使用最小 DSH 槽位宿主、确定性 API 数据和实际生产估计函数。没有调用模型提供方，没有连接用户会话，不覆盖原生 Harness 导航和完整前端生命周期。

## 本机 desktop profile 安装

当前 `%USERPROFILE%\.dsh\profiles\desktop\package.json` 已包含 `dsh-step-risk` bundle，依赖以 `link:` 指向本仓库工作树：

```text
link:<local-checkout>/dsh-step-risk
```

安装前备份保存在 `%USERPROFILE%\.dsh\profiles\desktop\.step-risk-backup-20261013-144602`。默认记录目录为 `%USERPROFILE%\.dsh\profiles\desktop\step-risk`。本地依赖链接与独立烟测分别验证安装配置和隔离运行时；两者不等同于用户桌面界面已加载并显示。

- 自带 CLI `--version` 实测返回 `0.2.0-rc.2`。
- 已安装包版本为 `0.2.0`，`node_modules/dsh-step-risk` 的 junction 目标就是本仓库。
- 对比安装前后 `package.json`：仅新增 `dsh-step-risk` 依赖与 bundle，原有依赖版本未变，未移除任何 bundle。
- 应用重启后生成的 `desktop/cordis.yml` 包含 `id: step-risk`、`name: dsh-step-risk` 和预期的 profile 专属存储配置。
- 原 `cordis.patch.yml` 与安装前备份的 SHA256 相同：`BB38F6E6407708D8E58DC5B58DB3B3C404718BE32652C8E7499C27E06F7D9AC2`。

## 桌面界面验证范围

安装后已启动现有 DeepSeek Harness，Windows 辅助功能树确认主窗口和已完成会话可用，并存在“打开右侧边栏”入口。未向用户会话发送消息。

自动化点击入口时，Windows Computer Use 返回 `coordinate input geometry is unavailable`；重新选择窗口并激活后，截图返回 `window capture timed out: timed out waiting on channel`。该自动化尝试未取得界面证据，随后由用户按照 README“快速检查”自行操作。

### 用户实测通过：原生标签与无工具步骤

用户提供的 [原生 Desktop 截图](step-risk-desktop-rc2.png) 显示：

- 原生右侧栏已打开 **Step Risk** 标签，客户端成功挂载。
- 记录数量为 1，显示 `Turn 1 / Step 1`、**4.5%**、“实际结果：未知 · 未知 · other”和“无工具调用”。
- 最近记录时间为北京时间 `2026/10/13 15:00:42`。

随后只读核对 `desktop/step-risk` 中实际生成的结构化 JSON：`turn=1`、`step=1`、`outcome=unknown`、`operation=unknown`、`toolCount=0`、`stepFailure.value=0.045`、`modelVersion=step-failure-chain-v1`、`observedAt=2026-10-13T07:00:42.324Z`。记录与截图一致；未将用户会话 ID 或完整记录复制进本仓库。

由此确认本机指定版本的原生插件挂载、无工具步骤采集、概率计算、落盘和界面读取展示已贯通。单张截图不证明原生界面的连续自动刷新、排序交互或重启恢复；这些行为的自动化证据仍分别来自前述浏览器检查和运行时烟测。烟测脚本的 `clientRendering: "not-tested-by-this-script"` 保持原样，用户实测作为独立证据记录。

## 本地发行包

`pnpm pack --pack-destination .` 生成 `dsh-step-risk-0.2.0.tgz`，包含 23 个文件：Host/client 源码、Cordis patch、验证脚本、文档、验证截图和 MIT License。未包含 node_modules、测试目录、用户配置、JSONL 日志或凭据文件。

包内源码及其它文件逐字节匹配本仓库；pnpm 对 `package.json` 进行了格式化及键顺序调整，解析后的 JSON 与源码相同。浏览器报告中的客户端 SHA256 也与当前文件一致。最终归档的 SHA256 写入同目录的 `dsh-step-risk-0.2.0.tgz.sha256`。

## 模型证据边界

本版使用本地规则模型，不包含 Luna 评估。概率因素是公开设计先验；缺少 DSH 原生任务结果与人工责任标签的校准验证，始终保留 `experimental_uncalibrated`。测试和运行时烟测证明软件行为，不证明这些百分比是经验频率或因果判定。
