// dsh-central-inbox — 黑板→本节点上下文插入桥（泛化版，支持多节点）
// 目标：任何节点（mac-mini/mbp/i9）被跨设备消息注入本地会话上下文（等价 agent_send）
// 原理：监听黑板事件桥 8803 SSE → 过滤 notes/<本节点>/* → agentBus.send 注入本节点中枢会话
// 配置（环境变量，多节点复用同一插件）：
//   DSH_NODE_ID: 本节点名（mbp/i9/mac-mini）→ 决定监听 notes/<node>/*
//   CENTRAL_AGENT: 本节点中枢会话id（默认自动找）
// 依据：Claude Code Channels（MCP notification 注入会话）+ Cordis 事件系统
// 注意：cordis 4.x 已移除 definePlugin（MBP 部署实战发现）——本插件用约定式（export name/inject/apply），
//       不 import definePlugin（此前 import 了但未使用，靠 tree-shaking 摇掉才没崩；必须删以免打包配置变化时崩）

const SSE_URL = process.env.CENTRAL_INBOX_SSE || 'http://127.0.0.1:8803/events';
const NODE_ID = process.env.DSH_NODE_ID || 'mac-mini';
// 本节点监听自己的消息通道（notes/<node>/*）+ collab（全局协作）
const WATCH_PREFIXES = ['notes/' + NODE_ID + '/', 'notes/collab/'];

export const name = 'central-inbox';
export const inject = ['agentBus'];

export function apply(ctx) {
  const agentBus = ctx.get('agentBus');
  if (!agentBus) { console.log('[central-inbox] agentBus 不可用，跳过'); return; }

  // 找本节点中枢会话（fa1f9150 或第一个会话）
  function findCentralAgent() {
    try {
      const agents = agentBus.list ? agentBus.list() : [];
      if (Array.isArray(agents) && agents.length > 0) {
        // 优先 fa1f9150（mac-mini 中枢），否则第一个
        const central = agents.find(a => a.id && a.id.includes('fa1f9150'))
          || agents[0];
        return central ? central.id : null;
      }
    } catch (e) { /* agentBus.list 可能不可用 */ }
    return process.env.CENTRAL_AGENT || null;
  }

  const centralAgent = findCentralAgent();
  console.log('[central-inbox] 启动 node=' + NODE_ID + ' 监听 ' + WATCH_PREFIXES.join(',') + ' → 注入 ' + (centralAgent || '?') + '（若为空，用 CENTRAL_AGENT 环境变量指定）');

  let lastInjected = '';
  let reconnectMs = 3000;

  async function connect() {
    try {
      // 修复（MBP 定位）：AbortSignal.timeout(0) 是 0ms 立即 abort（非「无超时」）→ SSE 永远连不上
      // 正确：不传 signal（SSE 无限流）。断线由 reader.read() 抛错触发下方重连逻辑。
      const res = await fetch(SSE_URL);
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
      console.log('[central-inbox] SSE 已连接 ' + SSE_URL);
      reconnectMs = 3000;

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            try { handleEvent(JSON.parse(line.slice(6))); } catch { /* 忽略坏事件 */ }
          }
        }
      }
      console.log('[central-inbox] SSE 断开，重连');
    } catch (e) {
      console.log('[central-inbox] SSE 错误: ' + (e.message || e).slice(0, 80) + '，' + reconnectMs + 'ms 后重连');
    }
    setTimeout(connect, reconnectMs);
    reconnectMs = Math.min(reconnectMs * 2, 30000);
  }

  function handleEvent(d) {
    if (!d || !d.key || !centralAgent) return;
    const key = d.key;
    if (!WATCH_PREFIXES.some((p) => key.startsWith(p))) return;
    const value = d.value || {};
    if (value.from === 'coordinator' && NODE_ID === 'mac-mini') return; // 中枢不自注入
    if (key === lastInjected) return;
    lastInjected = key;

    const from = value.from || 'node';
    const text = '看黑板 ' + key;
    try {
      const r = agentBus.send(from, centralAgent, text, undefined);
      console.log('[central-inbox] 📩 注入 ' + NODE_ID + ': ' + key + ' → ' + (r && r.status));
    } catch (e) {
      console.log('[central-inbox] 注入失败: ' + (e.message || e).slice(0, 80));
    }
  }

  connect();
}
