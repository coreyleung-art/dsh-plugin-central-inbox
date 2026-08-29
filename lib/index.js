// dsh-central-inbox — 黑板→本节点上下文插入桥（泛化版，支持多节点）
// 目标：任何节点（mac-mini/mbp/i9）被跨设备消息注入本地会话上下文（等价 agent_send）
// 原理：监听黑板事件桥 8803 SSE → 过滤 notes/<本节点>/* → agentBus.send 注入本节点中枢会话
// 配置（环境变量，多节点复用同一插件）：
//   DSH_NODE_ID: 本节点名（mbp/i9/mac-mini）→ 决定监听 notes/<node>/*
//   CENTRAL_AGENT: 本节点中枢会话id（默认自动找）
// 依据：Claude Code Channels（MCP notification 注入会话）+ Cordis 事件系统

// v0.1.6 修复：补全 ESM 导入（此前 CJS 靠隐式全局 join/homedir/require，type:module 下必 ReferenceError → 插件加载即崩）
import { homedir, hostname as osHostname } from 'node:os';
import { join } from 'node:path';
import fs from 'node:fs';

// 插件化标准第7项：统一文件日志（CLD stdout 不可见 → appendFileSync 落盘）
const LOG_FILE = process.env.CENTRAL_INBOX_LOG || join(homedir(), '.dsh', 'central-inbox.log');
function logLine(msg) {
  try {
    const ts = new Date().toISOString();
    fs.appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`);
  } catch (e) { /* 日志失败不阻塞 */ }
}

const SSE_URL = process.env.CENTRAL_INBOX_SSE || 'http://127.0.0.1:8803/events';
// v0.1.8 修复：NODE_ID 自动探测改用 os.hostname()（v0.1.7 用 process.env.HOSTNAME 在 CLD GUI 环境为 undefined → 回退 mbp）
function detectNodeId() {
  const env = process.env.DSH_NODE_ID;
  if (env) return env;
  const hostname = (process.env.HOSTNAME || process.env.COMPUTERNAME || osHostname() || '').toLowerCase();
  if (hostname.includes('mac-mini')) return 'mac-mini';
  if (hostname.includes('mbp') || hostname.includes('macbook')) return 'mbp';
  if (hostname.includes('i9') || hostname.includes('desktop')) return 'i9';
  return 'mbp'; // 兜底（原默认）
}
const NODE_ID = detectNodeId();
// 本节点监听自己的消息通道（notes/<node>/*）+ collab（全局协作）
const WATCH_PREFIXES = ['notes/' + NODE_ID + '/', 'notes/collab/'];

export const name = 'central-inbox';
export const inject = ['agentBus'];

export function apply(ctx) {
  const agentBus = ctx.get('agentBus');
  if (!agentBus) { console.log('[central-inbox] agentBus 不可用，跳过'); return; }

  // 找本节点中枢会话（CENTRAL_AGENT 显式优先，其次 fa1f9150 或第一个会话）
  function findCentralAgent() {
    const explicit = process.env.CENTRAL_AGENT;
    if (explicit) return explicit;
    try {
      const agents = agentBus.list ? agentBus.list() : [];
      if (Array.isArray(agents) && agents.length > 0) {
        // 优先 fa1f9150（mac-mini 中枢），否则第一个
        const central = agents.find(a => a.id && a.id.includes('fa1f9150'))
          || agents[0];
        return central ? central.id : null;
      }
    } catch (e) { /* agentBus.list 可能不可用 */ }
    return null;
  }

  let centralAgent = findCentralAgent();
  logLine('[central-inbox] 启动 node=' + NODE_ID + ' 监听 ' + WATCH_PREFIXES.join(',') + ' → 注入 ' + (centralAgent || '?') + '（若为空，用 CENTRAL_AGENT 环境变量指定）');

  // boot 时序修复：agentBus 会话可能晚于插件 apply() 就绪，定时重试直到找到注入目标
  if (!centralAgent) {
    const retryMs = 5000;
    const retryTimer = setInterval(() => {
      centralAgent = findCentralAgent();
      if (centralAgent) {
        clearInterval(retryTimer);
        console.log('[central-inbox] 注入目标已就绪: ' + centralAgent);
      }
    }, retryMs);
    // 不阻止进程退出
    if (retryTimer.unref) retryTimer.unref();
  }

  let lastInjected = '';
  let reconnectMs = 3000;

  async function connect() {
    try {
      // P1-1c: 黑板 token（BLACKBOARD_TOKEN 环境变量，空=不带头）
      const token = process.env.BLACKBOARD_TOKEN || '';
      const res = await fetch(SSE_URL, token ? { headers: { 'X-Blackboard-Token': token } } : undefined); // 无 signal：SSE 无限流不需要超时
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
      logLine('[central-inbox] SSE 已连接 ' + SSE_URL);
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
      logLine('[central-inbox] SSE 错误: ' + (e.message || e).slice(0, 80) + '，' + reconnectMs + 'ms 后重连');
    }
    setTimeout(connect, reconnectMs);
    reconnectMs = Math.min(reconnectMs * 2, 30000);
  }

  function handleEvent(d) {
    if (!d || !d.key) return;
    // boot 时序修复：若注入目标尚未就绪，事件到达时动态补查
    if (!centralAgent) centralAgent = findCentralAgent();
    if (!centralAgent) return;
    const key = d.key;
    if (!WATCH_PREFIXES.some((p) => key.startsWith(p))) return;
    const value = d.value || {};
    if (value.from === NODE_ID) return; // 本节点自写的消息不注入回本会话（防自回声，2026-08-28）
    if (value.from === 'coordinator' && NODE_ID === 'mac-mini') return; // 中枢不自注入
    if (key === lastInjected) return;
    lastInjected = key;

    const from = value.from || 'node';
    const text = '看黑板 ' + key;
    try {
      const r = agentBus.send(from, centralAgent, text, undefined);
      logLine('[central-inbox] 📩 注入 ' + NODE_ID + ': ' + key + ' → ' + (r && r.status));
    } catch (e) {
      logLine('[central-inbox] 注入失败: ' + (e.message || e).slice(0, 80));
    }
  }

  connect();
}
