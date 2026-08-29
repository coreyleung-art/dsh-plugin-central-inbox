## v0.1.7 (2026-08-29)
- **修复**: NODE_ID 自动探测（hostname 含 mac-mini/mbp/i9），修复 mac-mini 漏配 DSH_NODE_ID 默认成 mbp 监听错通道（R004 教训：central-inbox 必须识别本节点）
- **验证**: apply OK + restart-guard 0 FAIL
## v0.1.6 (2026-08-29)
- **修复（重启崩溃根因）**: package.json 缺 "type": "module"（index.js 用 ESM export 但按 CJS 解析 → 加载即 SyntaxError）+ 缺 peerDependencies（agentBus 依赖无法声明）+ lib/index.js 缺 import（join/homedir/fs 依赖 CJS 隐式全局 → ESM 下 ReferenceError）
- **修复**: 补 node_modules 符号链接（cordis/dsh-tools → profile 解析链，同 agent-way）
- **验证**: 沙箱 node v25 语法 OK + ESM 模块加载 OK（exports: name/inject/apply）+ cordis.patch.yml 完整
# Changelog · dsh-plugin-central-inbox

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
