# Changelog · dsh-plugin-central-inbox

## [0.1.1] - 2026-08-28

### 修复：自注入循环 + 探针噪音
- **自注入防护**：handleEvent 加 `value.from === NODE_ID` 跳过本节点自写消息——根治 LLM 自动应答无限回声（历史上出现 `llm-reply-llm-reply-...` 嵌套 key + ~2693 次版本递增）
- **探针噪音过滤**：跳过 `verify-*` / `verify-recovery` / `sse-probe` 类消息（链路自检消息不注入业务会话，防排队刷屏）
- 关联：双向注入修复报告（黑板 SSE 广播断链 → 全链路打通）

## [0.1.0] - 2026-08-27

### 首版登记（版本管理补全）
- 定位：黑板→本节点上下文注入桥（SSE 监听→agentBus.send 注入，泛化多节点）
- 说明：本插件此前未做版本管理，本次补全 CHANGELOG + git 初始化。
