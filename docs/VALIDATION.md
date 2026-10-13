# DSH Step Risk 0.3.0 验证记录

日期：2026-10-13。目标宿主：DeepSeek Harness **0.2.0-rc.2**。参考源码标签为 `dsh-v0.2.0-rc.2`，提交 `639ed015397290b3745d163aafe02ffee4aa3f84`。

## 软件检查

- 在 Node.js 24.21.0 执行 `node --test`：**83 项通过，0 项失败、跳过或取消**。覆盖步骤事实、条件链、旧 0.2.0 存储读取、执行前前缀、同 turn 与跨 session 隔离、迟到修订、保留截断后的弃权、历史回算标记、模型门槛、私有标签匹配、CLI 输出路径保护、客户端状态及路由。
- CLI 测试使用 120 个**合成**的人工标签形态数据，能训练并重新加载合格模型；缺标签、重复或冲突标签、单类别、无效日期、不安全输出路径和重新训练失败均有回归检查。合成样例不构成真实任务预测性能证据。
- `git diff --check` 和 Host、烟测脚本、新模块、训练 CLI 的 `node --check` 均通过。独立代码审查结论为 `READY`，覆盖最终模型、Host、收集器、CLI 和新增烟测逻辑。

## 指定宿主的运行时烟测

在已安装桌面版的 Electron Node 中，最终代码运行两次隔离 profile 烟测：

- `node scripts/verify-dsh-runtime.cjs --report docs/validation-dsh-rc2.json`：缺模型弃权路径于 `2026-10-13T09:32:02.313Z` 通过，报告见 [validation-dsh-rc2.json](validation-dsh-rc2.json)。
- `node scripts/verify-dsh-runtime.cjs --synthetic-model --report docs/validation-dsh-rc2-evaluated.json`：合成合格模型数值路径于 `2026-10-13T09:31:16.487Z` 通过，报告见 [validation-dsh-rc2-evaluated.json](validation-dsh-rc2-evaluated.json)。

- 运行环境为 DSH `0.2.0-rc.2`、Electron `44.0.0`、Node `24.18.1`。脚本使用隔离 profile 和真实 Cordis Loader、AgentLoop、Session、工具运行时、Connection；LLM 是确定性测试适配器，没有请求模型提供方或使用用户凭据。
- 三次模型步骤产生三条 `step/end` 估计和三条 `step/start` 执行前预测；两次工具调用实际执行。结构化结果依次为内部 `success`（工具未标错）、`error`、`unknown`，步骤规则值依次为 1.2%、13.5%、4.5%。
- 缺模型场景中，三条执行前预测和快照中的 turn 风险均为 `missing_model`、数值 `null`。合成模型场景从 120 条合成标签生成通过门槛的模型（训练 84、时间留出 36），三条执行前预测与完成后的数值均经真实 AgentLoop 事件和认证 GET 接口返回；成功观测降低风险，错误观测提高风险。这只证明数值路径能在指定宿主中运行，不是人工标签的准确率证据。
- 默认 profile 目录写入哈希 JSON 并可重新加载。Connection 对未认证请求返回 401、不可信 Origin 返回 403、认证 GET 返回 200、非法查询返回 400、POST 返回 404。预测、持久化文件和响应均未包含烟测私密标记；脚本未修改用户 profile。

## 客户端渲染

运行 `node scripts/verify-client-browser.cjs`：**11 组检查通过，浏览器 JavaScript 错误 0**。报告见 [validation-client-browser.json](validation-client-browser.json)，时间为 `2026-10-13T09:22:55.364Z`。已目视检查 [预览图](step-risk-preview.png)。

测试使用原样 `client.js`、Chromium 133.0.6943.16、React/ReactDOM 18.3.1 和最小 DSH 槽位夹具。420 px 侧栏无横向溢出；可显示规则步骤值、无模型空值、合成合格模型的执行前/后值、历史回算提示与百分点变化；排序、条件因素、会话切换、迟到响应、空状态、503 错误、隐藏后停止轮询及只读 GET 均通过。槽位和 API 数据为夹具，**不等于原生 Desktop 前端的新版挂载验证**。

## 本机安装与发行范围

桌面版自带 CLI `--version` 返回 `0.2.0-rc.2`。本机 Desktop 当前选中的 profile 为 `web`；通过官方 `plugin --profile web add <本仓库路径>` 成功安装后，`web/package.json` 的依赖和 bundle 均包含 `dsh-step-risk`，`web/node_modules/dsh-step-risk` junction 指向本工作树并读取到 0.3.0。先前 `desktop` profile 的同一链接和配置也仍在。插件 bundle patch 在 profile 中插入 `step-risk` Cordis 配置。以上证明当前 profile 的安装配置指向新版源码，**不证明正在运行的 Desktop 进程已重新加载**。

[原生 Desktop 截图](step-risk-desktop-rc2.png) 和对应结构化记录来自此前 **0.2.0** 的用户实测：原生标签成功挂载、无工具步骤显示 4.5%。0.3.0 的原生侧栏尚无新的用户会话截图；新版宿主链路由上述隔离运行时烟测验证，客户端由上述真实浏览器检查验证。

`npm pack --dry-run --json --ignore-scripts --cache <临时可写目录>` 成功，预览包为 `dsh-step-risk@0.3.0`、28 个文件，包含 Host、客户端、训练 CLI、方案与两份宿主验证报告；不包含测试、私有标签、用户 profile、日志或凭据。第一次尝试使用系统默认 npm 缓存时因沙箱 `EPERM` 未执行打包，改用临时可写缓存后通过。这里只验证打包清单，没有发布 npm 包。

## 统计与因果边界

当前没有同源、人工核验的真实 turn 成败标签，也没有面向本项目的合格经验模型。模型文件的结构与自报评估门槛可由加载器检查，但人工标注质量、数据域匹配和指标来源需操作者审查。一次时间留出集用于启用门槛，不是独立最终测试；不能将门槛通过直接称为已校准的部署准确率。

`stepFailure.value` 的 4%/15%/45%/70%、60%、50% 均为人工设计先验，始终是 `experimental_uncalibrated`。执行前后的 `turnRisk.delta` 只是条件预测变化，不是步骤致因效应。软件测试、隔离宿主烟测和浏览器检查均不证明经验概率准确性或因果归因。
