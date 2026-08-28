# Changelog · dsh-plugin-central-inbox

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
