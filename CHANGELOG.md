## v0.2.5 (2026-10-03)
- **告警语义修复（MBP 验收补遗）**: `index.js` 原用 `mode==='central'` 当「未命中」代理判据，
  但该 mode 含两种语义（显式中枢别名/精确命中中枢=成功，与真未命中回退混淆）⇒ 精确命中中枢时
  日志打出「未命中（exact）→回退」自相矛盾告警（MBP 实测被误导去怀疑回退逻辑仍在）。
## [0.2.11] - 2026-10-04

> 主题：**A 批次 · 通讯链路收敛**（MBP 实测缺陷驱动，三项+时效门）。

- **seen 后置（A①）**：去重键写入移到成功注入之后——注入失败（目标 null/centralAgent 未就绪）不再写 seen，重放/重连事件可重试（MBP 实测 10 条 null 跳过中 1 条即其卡，失败即记号永不重试）。
- **own-node 别名解析（A②）**：`to=mac-mini/macmini/<NODE_ID>` → 中枢（MBP 三卡 to=mac-mini 曾被 null 吞；与 comm-preflight B7 可解析性语义对齐）。
- **角色离线排队（A③）**：role-mapped-offline 不再丢卡——排完整 id 待会话上线自动投递（mode=queued-direct），告警降级为 ℹ️。
- **R43 重放时效门（A④）**：重放事件超过 24h 跳过（不注入不写 seen），防「106 条/34 天旧卡一次灌入」；env CENTRAL_INBOX_MAX_REPLAY_AGE_MS 可调。
- **验证**：selftest 18/18（新增 A②/A③ 两用例：别名→中枢、离线→完整 id）；selfcheck 全绿；冒烟深路径 pass。
  修法：告警只对未命中类 reason 触发（unresolvable/agentBus.list-empty/role-mapped-offline/
  ambiguous-fragment），排除 exact/central-alias/role-mapped/fragment。

## v0.2.4 (2026-10-03)
- **审计修复 D1（自检空转）**: `lib/selfcheck.js` 的 peerDeps 探测与符号检查在 ESM 下是死码
  （`typeof require === 'function'` / `typeof __filename !== 'undefined'` 恒为 undefined ⇒ 两段全跳过
  ⇒ 空集通过打印 ✅，与 agent-way 同坑同修复）。改用 `createRequire(import.meta.url)` +
  `fileURLToPath(import.meta.url)`（镜像 agent-way selfcheck 已修方案）。
- **审计修复 D3（去重键「去 version」名存实亡）**: `lib/route.js` 的指纹此前仍
  `JSON.stringify(value)` ⇒ `value.version` 参与指纹 ⇒ 同内容重建卡片仍被当新卡注入。
  现真正剔除 `value.version` 再算指纹；删除死变量 `ver`。selftest 补真实变版用例
  （`value.version` 1→2 而去重键相同——旧用例 version 恒同为 1 才侥幸绿，测错了对象）。

## v0.2.3 (2026-10-02)
- **去重键改版（MBP 建议）**: `<key>#<内容指纹>`（去 version）——重建卡片（内容同、version 变）
  不再重复注入；内容变 ⇒ 新键照常注入。
- **依赖**: agent-way 1.5.7。

## v0.2.2 (2026-10-02)
- **I7a 透传**: 卡片 `value.reply_required === true` ⇒ 注入 `agentBus.send(..., { replyRequired: true })`
  （配合 agent-way 1.5.7：要求回复的卡在收件方空闲时也触发唤醒，不再排队等自然回合）。
- **依赖**: agent-way 1.5.7。

## v0.2.1 (2026-10-01)
- **修复（治理缺口）**: `lib/selftest.js` 补 **CLI 入口**。此前该模块**只导出 `runSelftest`、无 CLI 入口**
  ⇒ `node lib/selftest.js` **静默退出 0、零输出**，外观与「15 条全过」完全无异。
  这是「空集通过」坑的又一实例（本次实测踩中：一句「自检通过」的报告其实什么都没跑）。
  同步修正 `package.json` 中 `r006.cli_form: true` —— 该自报值此前**与事实不符**，现已成立并附证据字段。
- **验证**: `node lib/selftest.js` → **15 PASS / 0 FAIL**，exit 0（可直接运行，不再需 import 调用）。
- **兼容性**: 本插件 `lib/route.js` 的 `normalizeTo` 为**共享模块 `~/dsh-comm-shared/identity.js` 的再导出**
  （实测 `route.normalizeTo === shared.normalizeTo` 为 `true`）。共享模块 2026-10-01 的 A4a 修复
  （括号内 id 抢救）经**真实语料差分**验证：221 个真实 `to` 值中 218 个输出不变，3 个变化全为修复目标；
  本插件 15 条断言在该改动后**全绿**（消费者无破坏）。
## v0.1.7 (2026-08-29)
- **修复**: NODE_ID 自动探测（hostname 含 mac-mini/mbp/i9），修复 mac-mini 漏配 DSH_NODE_ID 默认成 mbp 监听错通道（R004 教训：central-inbox 必须识别本节点）
- **验证**: apply OK + restart-guard 0 FAIL
## v0.1.6 (2026-08-29)
- **修复（重启崩溃根因）**: package.json 缺 "type": "module"（index.js 用 ESM export 但按 CJS 解析 → 加载即 SyntaxError）+ 缺 peerDependencies（agentBus 依赖无法声明）+ lib/index.js 缺 import（join/homedir/fs 依赖 CJS 隐式全局 → ESM 下 ReferenceError）
- **修复**: 补 node_modules 符号链接（cordis/dsh-tools → profile 解析链，同 agent-way）
- **验证**: 沙箱 node v25 语法 OK + ESM 模块加载 OK（exports: name/inject/apply）+ cordis.patch.yml 完整
# Changelog

## [0.2.12] - 2026-10-04

- **R43 三级时间源（A④ 反例修复）**：时效门从「只看事件外层 ts」改为 ①卡内 sent_at_epoch_ms/ts（秒毫秒都认）②键内嵌 epoch ③外层 ts 兜底；算不出时间不丢（MBP 真实回放：单层判据对 106 条风暴拦截率 0%——重建卡板时间被刷新）。
- **G30 缓冲重放**：boot 窗口 centralAgent 未就绪/目标 null 的事件入有界缓冲（≤50/30min TTL），5s 周期在 bus 就绪后主动重放——seen 后置只把「不可能重试」变「可能重试」，本版补上「触发重试的东西」。
- 同内容重投判 dup 的约束：补投/重投必须改内容（去重键=内容指纹，剔除 version）。

## [0.2.11] - 2026-10-04 · dsh-plugin-central-inbox

## [0.1.5] - 2026-08-29

### 修复
- dsh 版本自适应层（插件化标准第4项，复用 adapt.js 模板）

## [0.1.4] - 2026-08-29

### 修复
- 统一文件日志（插件化标准第7项：CLD stdout 不可见 → appendFileSync 落盘）

## [0.1.3] - 2026-08-29

### 修复
- SSE 订阅带 BLACKBOARD_TOKEN（P1-1c token 逐步启用前提）

## [0.1.2] - 2026-08-28

### 修复
- CENTRAL_AGENT 显式优先（修复注入目标解析）+ NODE_ID 默认 mbp

## [0.1.1] - 2026-08-28

### 修复：自注入循环 + 探针噪音
- **自注入防护**：handleEvent 加 `value.from === NODE_ID` 跳过本节点自写消息——根治 LLM 自动应答无限回声（历史上出现 `llm-reply-llm-reply-...` 嵌套 key + ~2693 次版本递增）
- **探针噪音过滤**：跳过 `verify-*` / `verify-recovery` / `sse-probe` 类消息（链路自检消息不注入业务会话，防排队刷屏）
- 关联：双向注入修复报告（黑板 SSE 广播断链 → 全链路打通）

## [0.1.0] - 2026-08-27

### 首版登记（版本管理补全）
- 定位：黑板→本节点上下文注入桥（SSE 监听→agentBus.send 注入，泛化多节点）
- 说明：本插件此前未做版本管理，本次补全 CHANGELOG + git 初始化。
