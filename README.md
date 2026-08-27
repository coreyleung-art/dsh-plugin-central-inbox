# dsh-plugin-central-inbox

**黑板→本节点上下文注入桥**

监听黑板事件桥 8803 SSE → 过滤 notes/<本节点>/* → agentBus.send 注入本机中枢会话。配置：DSH_NODE_ID / CENTRAL_AGENT / CENTRAL_INBOX_SSE。

> 版本管理登记 2026-08-27（详见 CHANGELOG.md）
