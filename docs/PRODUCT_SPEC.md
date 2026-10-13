# DSH Step Risk 0.2.0 产品约定

目标运行时为 DeepSeek Harness V0.2.0-rc.2。入口是 npm/本地 bundle，dsh.bundle.patch 安装 Host 观察器，dsh.client 加载原生客户端。客户端包括会话右侧栏标签和设置页记录浏览器，均无需安装时构建。

主指标继承 Codex Step Risk 0.4.1：在步骤完成时可见证据下，本步引入或遗留的问题持续到结束，并对当前会话目标失败产生实质影响的模型估计。采用本地条件链规则。多个步骤可能共同影响最终结果，不归一化。

## 事件契约

官方源码：dsh-v0.2.0-rc.2，提交 639ed015397290b3745d163aafe02ffee4aa3f84。

- session/event：真实 Session 对象与事件。step/end.data 包含 turn、step；一个 step 是一次模型调用及其工具执行。
- tool/call.data：callId 和 name，不保存 arguments。
- tool/result.data.message.source.callId 匹配调用；仅用布尔 isError，不从正文关键词猜结果。
- agent/request-error(payload,next)：waterfall 必须原样返回 next()；重试不等于最终报错。
- agent/error：终止性错误可修订刚完成的步骤。
- session/disposed：释放在线跟踪状态，展示历史保留。

事实合并：任一工具报错则 error；全部已请求工具明确成功且无中断/截断则 success；其余 unknown。无工具模型步骤为 unknown。失败工具的操作类型一致时采用该类型，混合或不明则 unknown。请求错误和 attempt 保留为解释信号，不覆盖成功恢复后的结果。

## 输出与数据

stepFailure 为 {modelVersion,status,value,source,factors,evidenceQuality,summary,reasons,limitations,evidenceRefs}，source 固定 rules，status 为 model_estimate。同时保存角色、委派深度、工具名、工具数和实际结果。旧 tracker 的 pCurrent 等字段仅保留在兼容事件/可选日志中。

记录按会话哈希命名并原子替换，默认最多 100 会话、每会话 500 步。重复完成不重复插入，较新 revision 替换对应步骤，重启恢复插件记录。默认仅结构化白名单，不读既有 transcript，不保存目标/参数/响应/错误正文。

客户端使用官方 Connection.fetch.register 的 GET /api/dsh-step-risk/snapshot。Web 与 Desktop 使用同一路径及受认证载体。面板可见时每 2 秒轮询，隐藏或切换会话取消旧请求；迟到响应不能覆盖新会话。

## 验收

1. 指定版本真实 Loader 加载，无版本豁免。
2. 原生 AgentLoop 成功、错误、无工具步骤各自产生概率。
3. 结果判定、读写错误区分、重复/迟到事件、waterfall 和会话隔离有测试。
4. 历史可恢复、有界、只保存白名单字段。
5. 原生客户端呈现概率/事实/因素，支持空状态和读取错误。
6. 用户 profile 安装可回滚，记录实际验证层级。

本版无外部 AI 评估，不用未来成功重写已有预测，不将 turn/end 当作任务成功标签。测试证明软件行为，不证明概率准确性。
