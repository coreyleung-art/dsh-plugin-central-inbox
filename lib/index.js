// dsh-central-inbox — 黑板→本节点上下文插入桥（泛化版，支持多节点）
// 目标：任何节点（mac-mini/mbp/i9）被跨设备消息注入本地会话上下文（等价 agent_send）
// 原理：监听黑板事件桥 8803 SSE → 过滤 notes/<本节点>/* → agentBus.send 注入本节点会话
// 配置（环境变量，多节点复用同一插件）：
//   DSH_NODE_ID: 本节点名（mbp/i9/mac-mini）→ 决定监听 notes/<node>/*
//   CENTRAL_AGENT: 本节点中枢会话id（默认自动找）
// 依据：Claude Code Channels（MCP notification 注入会话）+ Cordis 事件系统

// =====================================================================
// v0.2.0 · 定向注入（v9.7 星台会话切换 P2，2026-09-04，沙箱副本改造，未部署）
// ---------------------------------------------------------------------
// 改造点（相对部署基线 = ~/dsh-plugin-central-inbox/lib/index.js 工作树，
//         即 v0.1.10 提交 + 未提交的 45s 假活检测/重连抖动）：
//  1. handleEvent 读取 d.value.to（目标会话 id / 符号名 'coordinator'）：
//     - to 为空 / 'coordinator' / 'central'        → 注入中枢（现逻辑，回归不破）
//     - to 精确命中 agentBus.list() 中某会话 id      → 定向注入该会话
//     - to 唯一稳定片段命中（如 'fa1f9150'/'aa528267'）→ 定向注入（会话重启后 id 会变，用稳定段）
//     - to 歧义 / 未命中本机在线会话                  → 告警日志 + 回退注入中枢（不改语义）
//  2. 防回声（value.from===NODE_ID / coordinator×mac-mini）、去重（lastInjected）、
//     文本格式（'看黑板 <key>'）、threadId=undefined（每卡新线程）全部保持。
//  3. 方向判断每次事件实时查 agentBus.list()（会话在线性动态，不缓存）。
// 契约依据（源码实读 ~/dsh-plugin-agent-bus/lib/index.js v1.5.3，1627 行）：
//  - agentBus.list() = agentsSvc.list() 映射 {id,status,locks,waiting} —— 仅【在线】会话
//  - agentBus.send(from,to,text,threadId) = sendMessage：目标在线→followup 注入→{status:'delivered'}
//    目标离线/不存在→静默入库 {status:'queued',targetLive:false}（不抛错）→ 所以必须先查存在性，
//    避免给未知/离线 id 制造永久 queued 积压（历史教训：mbp-bus 别名不在→仍 queued）。
// =====================================================================

// v0.1.6 修复：补全 ESM 导入（此前 CJS 靠隐式全局 join/homedir/require，type:module 下必 ReferenceError → 插件加载即崩）
import { homedir, hostname as osHostname } from 'node:os';
import { join } from 'node:path';
import fs from 'node:fs';
import { runSelfCheck } from './selfcheck.js';

// 插件化标准第7项：统一文件日志（CLD stdout 不可见 → appendFileSync 落盘）
const LOG_FILE = process.env.CENTRAL_INBOX_LOG || join(homedir(), '.dsh', 'central-inbox.log');
function logLine(msg) {
  try {
    const ts = new Date().toISOString();
    fs.appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`);
  } catch (e) { /* 日志失败不阻塞 */ }
}

const SSE_URL = process.env.CENTRAL_INBOX_SSE || 'http://127.0.0.1:8803/events';
const BB_LIST_URL = process.env.DSH_BB_URL || 'http://127.0.0.1:8792/';
// ★ 0.2.11-A④（R43 时效门，MBP 2026-10-04 请求）：重放事件限龄——超过阈值的旧卡不注入不写 seen。
//   依据：10-03 曾有 106 条 / 34 天旧卡可被 Last-Event-ID 重放一次灌入；重放本为短断连补漏（分钟级），
//   24h 足够；环境变量 CENTRAL_INBOX_MAX_REPLAY_AGE_MS 可调。
const MAX_REPLAY_AGE_MS = Number(process.env.CENTRAL_INBOX_MAX_REPLAY_AGE_MS || 24 * 3600 * 1000);
// ★ 0.2.11.2（MBP A④ 反例实测：单看事件外层 ts 挡不住真实风暴——重建卡板时间被刷新，106 条拦截率 0%）
//   时间来源三级优先级：①卡内 sent_at_epoch_ms/ts（秒毫秒都认）②键内嵌 epoch ③事件外层 ts（兜底）。
//   算不出时间 → 不丢（R035：没观测到≠不存在）。
function cardAgeMs(d, key) {
  let t = null;
  const card = d && d.value !== undefined && typeof d.value === 'object' ? d.value : (d && typeof d === 'object' ? d : {});
  for (const f of ['sent_at_epoch_ms', 'ts']) {
    const n = card[f] !== undefined && card[f] !== null ? Number(card[f]) : NaN;
    if (Number.isFinite(n) && n > 0) { t = n < 1e12 ? n * 1000 : n; break; }
  }
  if (t === null && key) {
    let m = String(key).match(/(?:-|_)(\d{13})(?:\D|$)/);
    if (m) t = Number(m[1]);
    else { m = String(key).match(/(?:-|_)(\d{10})(?:\D|$)/); if (m) t = Number(m[1]) * 1000; }
  }
  if (t === null && d && d.ts !== undefined) {
    const n = Number(d.ts) || Date.parse(String(d.ts));
    if (Number.isFinite(n) && n > 0) t = n < 1e12 ? n * 1000 : n;
  }
  if (t === null) return null;
  return Date.now() - t;
}
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

import { normalizeTo, resolveTargetId as _resolve, shouldInject as _should, remember as _remember } from './route.js';

export const name = 'central-inbox';
export const inject = ['agentBus'];

export function apply(ctx) {
  // R014 自查门：依赖完整性检查（缺模块在加载前暴露，不等到崩溃）
  // 0.2.10：runSelfCheck 回归同步纯检查（无冒烟——冒烟独立为 runApplySmoke，CLI/CI 专用）。
  // sourceFile 指向本文件，符号扫描覆盖调用方真实依赖（join/homedir/fs/hostname/route）。
  const selfCheck = runSelfCheck('central-inbox', {
    requiredPeers: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools'],
    requiredSymbols: ['join', 'homedir', 'fs', 'hostname', 'normalizeTo', 'runSelfCheck'],
    sourceFile: new URL('./index.js', import.meta.url).pathname,
  });
  if (!selfCheck.ok) {
    console.log('[central-inbox] ⚠️ 自查失败（缺模块见黑板 data/ops/plugin-selfcheck/），继续尝试');
  }
  const agentBus = ctx.get('agentBus');
  if (!agentBus) { console.log('[central-inbox] agentBus 不可用，跳过'); return; }

  // 找本节点中枢会话（CENTRAL_AGENT 显式优先，其次 fa1f9150 或第一个会话）
  function findCentralAgent() {
    const explicit = process.env.CENTRAL_AGENT;
    if (explicit) return explicit;
    // mac-mini 中枢：注入目标即中枢会话 fa1f9150（无需 agentBus.list，boot 早期也可用）
    if (NODE_ID === 'mac-mini') return 'session-fa1f9150-c949-401f-ba8c-d265f6221676';
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

  // ---- v0.2.0 定向注入：把黑板卡的 value.to 解析为本机【在线】会话 id ----
  // 返回 { target: 会话id, mode: 'central'|'direct', reason?: string }
  //   central：to 缺失/符号中枢名/解析失败/命中即中枢 → 注入中枢（与现逻辑一致）
  //   direct ：to 唯一命中某非中枢在线会话 → 注入该会话
  // 匹配优先级（v0.2.1 增补角色名映射，修 not-found 空转）：
  //   角色名映射(~/.dsh/agent-role-map.json) > 精确 id > 唯一稳定片段 > 歧义/未命中 → 回退中枢
  let _roleMapCache = null;
  function roleMap() {
    if (_roleMapCache) return _roleMapCache;
    try {
      const p = join(homedir(), '.dsh', 'agent-role-map.json');
      if (fs.existsSync(p)) {
        const d = JSON.parse(fs.readFileSync(p, 'utf8'));
        _roleMapCache = d.main || {};
        return _roleMapCache;
      }
    } catch (e) { /* 映射文件缺失 → 空表 */ }
    _roleMapCache = {};
    return _roleMapCache;
  }
  // ★ 2026-10-01：解析逻辑已抽到 lib/route.js（纯函数、可单测）。
  //   本包装仅负责取 agentBus.list() 与角色表，行为变更见 route.js 注释：
  //     · 不可解析的 to 不再静默回退注入中枢（原 L162 not-found）
  //     · to 双侧对称归一化（剥括号/via/多收件人/短 id）
  // ★ 0.2.11-A②：own-node 别名（本节点自身别名，MBP 实测 to=mac-mini 曾被 null 吞）
  const OWN_NODE_ALIASES = ['mac-mini', 'macmini', NODE_ID].filter(Boolean);
  function resolveTargetId(to, central) {
    let ids = [];
    try {
      const agents = agentBus.list ? agentBus.list() : [];
      if (Array.isArray(agents)) ids = agents.map((a) => a && a.id).filter(Boolean);
    } catch (e) { /* agentBus.list 不可用 → ids 空 */ }
    return _resolve(to, { ids, central, roleMap: roleMap(), nodeAliases: OWN_NODE_ALIASES });
  }
  const _seen = new Set();   // ★ 修缺陷1：单槽 lastInjected → <key>@<version> 成员集合（有界）
  // ★ v0.2.8 幂等键持久化（业界「去重存储持久化」补项）：重启后 seen 不丢，防重投/重放重复注入
  const SEEN_FILE = homedir() + '/.dsh/central-inbox-seen.json'; // ★ 0.2.9：os 未导入（os.homedir 裸引用=apply 崩溃，MBP 实测）
  try {
    const _saved = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
    if (Array.isArray(_saved)) for (const k of _saved.slice(-2000)) if (typeof k === 'string') _seen.add(k);
  } catch (_) { /* 首次运行 */ }
  let _seenDirty = false;
  function _flushSeen() {
    if (!_seenDirty) return;
    _seenDirty = false;
    try { fs.writeFileSync(SEEN_FILE, JSON.stringify([..._seen].slice(-2000))); } catch (_) { /* 落盘失败不阻断 */ }
  }
  ctx.effect(() => () => _flushSeen());
  let reconnectMs = 3000;
  // ★ v0.2.6 变更3：跟踪 SSE 事件 id，重连时带 Last-Event-ID 请求服务器重放漏事件
  let lastEventId = '';
  // ★ v0.2.8：seen 防抖落盘（30s）
  setInterval(_flushSeen, 30000).unref?.();

  async function connect() {
    try {
      // P1-1c: 黑板 token（BLACKBOARD_TOKEN 环境变量，空=不带头）
      const token = process.env.BLACKBOARD_TOKEN || '';
      const headers = {};
      if (token) headers['X-Blackboard-Token'] = token;
      // ★ v0.2.6：重连带 Last-Event-ID（服务器 sse.rs v0.6.9 起支持有界重放）
      if (lastEventId) headers['Last-Event-ID'] = lastEventId;
      const res = await fetch(SSE_URL, Object.keys(headers).length ? { headers } : undefined); // 无 signal：SSE 无限流不需要超时
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
      logLine('[central-inbox] SSE 已连接 ' + SSE_URL);
      reconnectMs = 3000;

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      // 假活检测：45s 无数据视为连接失效（黑板桥无周期 keepalive）
      const HEARTBEAT_TIMEOUT = 45000;
      let lastDataAt = Date.now();
      const hbTimer = setInterval(() => {
        if (Date.now() - lastDataAt > HEARTBEAT_TIMEOUT) {
          logLine('[central-inbox] 45s 无数据，判定假活，强制重连');
          reader.cancel().catch(() => {});
        }
      }, 15000);
      while (true) {
        const { done, value } = await reader.read();
        if (done) { clearInterval(hbTimer); break; }
        lastDataAt = Date.now();
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of chunk.split('\n')) {
            if (line.startsWith('id: ')) { lastEventId = line.slice(4).trim(); continue; }
            if (!line.startsWith('data: ')) continue;
            try { handleEvent(JSON.parse(line.slice(6))); } catch { /* 忽略坏事件 */ }
          }
        }
      }
      clearInterval(hbTimer);
      logLine('[central-inbox] SSE 断开（服务端关流），重连');
      console.log('[central-inbox] SSE 断开，重连');
    } catch (e) {
      logLine('[central-inbox] SSE 错误: ' + (e.message || e).slice(0, 80) + '，' + reconnectMs + 'ms 后重连');
    }
    const jitter = Math.round(reconnectMs * (0.8 + Math.random() * 0.4));
    logLine('[central-inbox] 重连计划 ' + jitter + 'ms（当前退避 ' + reconnectMs + 'ms）');
    setTimeout(connect, jitter);
    reconnectMs = Math.min(reconnectMs * 2, 30000);
  }

  // ★ 0.2.11.1（用户反馈「两端都要提醒才看消息」）：boot 窗口被 null 跳过的卡必须【主动补投】——
  //   「不写 seen」只保证重放可重试，但 SSE 重放仅断连时发生 ⇒ 被动等待=永久延迟。
  //   预热扫描：centralAgent 就绪后把本机板 WATCH_PREFIXES 里未处理的新键补注入。
  let _warmDone = false;
  function warmScan() {
    if (!centralAgent || _warmDone) return;
    _warmDone = true;
    try {
      for (const pfx of WATCH_PREFIXES) {
        fetch(BB_LIST_URL + pfx, { headers: { 'X-Blackboard-Token': process.env.BLACKBOARD_TOKEN || '' } })
          .then((r) => r.json()).then((j) => {
            const list = j && j.list ? j.list : {};
            for (const [k, entry] of Object.entries(list)) {
              try {
                const t = entry && entry.ts ? (Date.parse(entry.ts) || Number(entry.ts) || 0) : 0;
                if (t && (Date.now() - t) > 24 * 3600 * 1000) continue;   // R43 时效门同参
                const dk = k + '#' + (entry && entry.fp ? entry.fp : '');
                if (_seen.has(dk)) continue;   // 已处理（seen 为内容指纹键）
                handleEvent({ key: k, value: entry.value !== undefined ? entry.value : entry, ts: t });
              } catch { /* 单键失败不阻塞 */ }
            }
          }).catch(() => { /* 枚举失败不阻塞 */ });
      }
    } catch { /* 非阻塞 */ }
  }

  // ★ 0.2.11.2（MBP G30 实测）：boot 窗口失败事件入有界缓冲，bus 就绪后主动重放——
  //   seen 后置只把「不可能重试」变「可能重试」，但没有东西触发重试（事件已被消费）。
  const _pending = [];
  const PENDING_CAP = 50;
  const PENDING_TTL_MS = 30 * 60 * 1000;
  function bufferPending(d, why) {
    if (_pending.length >= PENDING_CAP) { _pending.shift(); }
    _pending.push({ d, at: Date.now(), why });
    logLine('[central-inbox] 📥 G30 缓冲待重放（' + why + '）: ' + (d && d.key) + ' · 缓冲 ' + _pending.length + '/' + PENDING_CAP);
  }
  function flushPending() {
    if (!centralAgent || _pending.length === 0) return;
    // ★ 0.2.13：目标会话离线先尝试自动续活（异步不阻塞本次 flush）
    void ensureCentralLive();
    let live = false;
    try {
      const list = agentBus.list ? agentBus.list() : [];
      live = Array.isArray(list) && list.some((a) => a && a.id === centralAgent);
    } catch { live = false; }
    if (!live) return;
    const now = Date.now();
    const batch = _pending.splice(0, _pending.length);
    for (const { d, at } of batch) {
      if (now - at > PENDING_TTL_MS) { logLine('[central-inbox] ⏳ G30 缓冲过期丢弃: ' + (d && d.key)); continue; }
      try { handleEvent(d); } catch { /* 单条失败不阻塞 */ }
    }
  }
  setInterval(flushPending, 5000).unref?.();

  // ★ 0.2.13（2026-10-04 用户问「reload 后会话不自动续活」· DSH 会话机制调研结论）：
  //   DSH 官方有完整 resume 机制（dsh-agent agents.resume / dsh-session-query.listSessions），
  //   但**没有任何 boot 编排自动调用它** ⇒ reload/重启后注入目标会话离线，
  //   消息只能等用户手动点开会话——G30 缓冲只兜底「消息不丢」，不解决「会话激活」。
  //   本函数=窄版自动续活：只 resume 本插件自己的注入目标（单一会话，非批量，
  //   避开 autoWake 反风暴教训）。配方与 agent-way deliverWake 同源（CLD-013 两关键修复：
  //   agentOptions 非空取 agentDefaultModel/settings + setup 挂 agentPresets.mount）。
  let _ensureTries = 0;
  async function ensureCentralLive() {
    if (!centralAgent) return;
    try {
      const list = agentBus.list ? agentBus.list() : [];
      if (Array.isArray(list) && list.some((a) => a && a.id === centralAgent)) { _ensureTries = 0; return; } // 已在线（重置计数，下次离线可再续活）
    } catch { /* 列表不可用 → 继续尝试 */ }
    if (_ensureTries >= 10) return;   // 有界重试（每 5s 一次 ⇒ 至多 ~50s，防风暴）
    _ensureTries++;
    const ag = ctx.get('agents', false);
    if (!ag || typeof ag.resume !== 'function') return;
    // 只 resume 有持久化的会话（无持久化则 resume 必失败，跳过）
    try {
      const sp = ctx.get('sessionPersistence', false);
      if (sp && typeof sp.list === 'function') {
        const headers = await sp.list();
        const persisted = Array.isArray(headers) && headers.some((h) => h && h.id === centralAgent);
        if (!persisted) return;
      }
    } catch { /* 持久化列表不可用不阻断 */ }
    const agentOptions = {};
    try {
      const adm = ctx.get('agentDefaultModel', false);
      if (adm && typeof adm.currentSelection === 'function') {
        const sel = adm.currentSelection();
        if (sel && sel.provider) agentOptions.provider = sel.provider;
        if (sel && sel.model) agentOptions.model = sel.model;
      }
    } catch { /* fallback */ }
    if (!agentOptions.provider || !agentOptions.model) {
      try {
        const settings = ctx.get('settings', false);
        const cur = settings ? settings.get('agent-default-model') : undefined;
        if (cur && typeof cur.provider === 'string' && cur.provider) agentOptions.provider = cur.provider;
        if (cur && typeof cur.model === 'string' && cur.model) agentOptions.model = cur.model;
      } catch { /* fallback */ }
    }
    try {
      await ag.resume({
        resumeSessionId: centralAgent,
        agentOptions,
        // CLD-013 关键修复 2：resume 必须挂 preset（工具注册），与 GUI 恢复会话同路径
        setup: async (agentCtx) => {
          const ap = ctx.get('agentPresets', false);
          if (ap && typeof ap.mount === 'function') {
            try { await ap.mount(agentCtx); } catch { /* 挂载失败不阻断 resume */ }
          }
          return undefined;
        },
      });
      logLine('[central-inbox] ♻️ 自动续活注入目标会话: ' + centralAgent);
    } catch (e) {
      logLine('[central-inbox] ⚠️ 自动续活失败（第 ' + _ensureTries + ' 次）: ' + String((e && e.message) || e).slice(0, 120));
    }
  }
  // boot 后 8s 首次尝试（等 agents/persistence 服务就绪），之后随 flushPending 周期内联重试
  setTimeout(() => { void ensureCentralLive(); }, 8000).unref?.();

  function handleEvent(d) {
    if (!d || !d.key) return;
    // boot 时序修复：若注入目标尚未就绪，事件到达时动态补查
    const wasNull = !centralAgent;
    if (!centralAgent) centralAgent = findCentralAgent();
    if (!centralAgent) { bufferPending(d, 'centralAgent 未就绪'); return; }
    // ★ 0.2.11.1：boot 窗口补投触发（目标刚就绪时做一次预热扫描）
    if (wasNull && centralAgent) setTimeout(warmScan, 3000);
    const key = d.key;
    // ★ R43 时效门（0.2.11.2 三级时间源）：超龄 → 跳过并打日志（不静默）；算不出 → 不丢
    try {
      const age = cardAgeMs(d, key);
      if (age !== null && age > MAX_REPLAY_AGE_MS) {
        logLine('[central-inbox] ⏳ R43 时效门跳过（age ' + Math.round(age / 3600000) + 'h > ' + Math.round(MAX_REPLAY_AGE_MS / 3600000) + 'h）: ' + key);
        return;
      }
    } catch { /* 不拦截 */ }
    // ★ 2026-10-01：前缀 / 自回声 / 去重三段统一由 route.js 判定（可单测）
    const _verdict = _should(d, { prefixes: WATCH_PREFIXES, nodeId: NODE_ID,
      ownSession: centralAgent, seen: _seen });
    if (!_verdict.inject) return;
    // ★ 0.2.11-A 首项（MBP 实测 2026-10-04）：seen 标记【移到成功注入之后】——
    //   注入失败（目标 null/centralAgent 未就绪）若已写 seen ⇒ 重放/重连事件被去重 ⇒ 永久吞卡
    //   （实测我侧日志 10 条 null 跳过中 1 条即他的卡，失败即记号、永不重试）。
    const value = _verdict.value;
    void key;

    const from = value.from || 'node';
    // ★ v0.2.5b（MBP 六节 2026-10-03）：from 缺失的卡照样被注入且绕过自回声（不可归属）。
    //   显式处置=标注告警留痕（不静默丢弃——历史卡片可能存在缺 from 约定）：
    //   任何能写黑板的人省略 from 就能投不可归属消息，故至少必须留痕可审计。
    if (!value.from) {
      logLine('[central-inbox] ⚠️ 缺 from 卡注入（不可归属）: ' + key + ' → ' + target);
    }
    let text = '看黑板 ' + key;
    // ★ A⑤-3（2026-10-04）：手机消息（sb-mobile/mobile-inbox）注入时带回复键指引——协调者按此键回复，App 轮询可见
    if (value.from === 'sb-mobile' || key.includes('mobile-inbox')) {
      text += ' — 回复请写黑板卡 notes/mac-mini/mobile-reply/latest-main（星台 App 轮询此键）';
    }

    // ---- v0.2.0：定向注入解析（to 命中本机在线非中枢会话 → 注入该会话；否则中枢）----
    const { target, mode, reason } = resolveTargetId(value.to, centralAgent);
    // ★ v0.2.5 修复（MBP 验收补遗 2026-10-03）：原判据 mode==='central' 当「未命中」代理——
    //   但 mode==='central' 两种语义：①显式中枢别名/精确命中中枢（成功）②真未命中回退。
    //   route.js:39 精确命中中枢时 reason='exact'（成功），却被打上「未命中→回退」告警，
    //   日志自相矛盾（「未命中（exact）」），MBP 实测被其误导去怀疑回退逻辑仍在。
    //   修法：告警只对「未命中类」reason 触发（unresolvable / agentBus.list-empty /
    //   role-mapped-offline / ambiguous-fragment），排除 exact/central-alias/role-mapped/fragment。
    const _missReason = String(reason || '');
    // ★ 0.2.11-A③：role-mapped-offline 改为排队投递（不丢卡）——告警降级为信息
    if (reason === 'role-mapped-offline') {
      logLine('[central-inbox] ℹ️ to=' + String(value.to) + ' 角色离线 → 排队完整 id 待唤醒投递: ' + target);
    }
    const _isMiss = _missReason === 'agentBus.list-empty'
      || _missReason.startsWith('unresolvable') || _missReason.startsWith('ambiguous-fragment');
    if (_isMiss) {
      // 显式 to 但未命中本机在线会话 → 记录告警（仍回退中枢，语义不变）
      logLine('[central-inbox] ⚠️ to=' + String(value.to) + ' 未命中本机在线会话（' + (reason || 'unknown') + '）→ 回退注入中枢 ' + centralAgent);
    }
    // ★ v0.2.7（MBP 积压实测 2026-10-03）：注入目标 null（boot 时 centralAgent 未就绪等）
    //   ⇒ 原实现静默 queued 无报警（与「假 delivered」同族：失败无归属）。
    //   改为显式告警留痕 + 跳过注入（fail-visible；centralAgent 就绪后新卡正常）。
    if (!target) {
      // ★ G30（0.2.11.2）：不再丢弃——入有界缓冲，bus 就绪后重放（事件已被消费不会再来，必须主动重试）
      bufferPending({ key, value, ts: d.ts }, '目标 null (' + (reason || 'unknown') + ')');
      return;
    }
    try {
      // ★ I7a（2026-10-02）：卡片 value.reply_required=true → 注入时要求唤醒（跨设备回执约定）
      // ★ 方案 A（2026-10-03）：唤醒语义反转配套——卡片显式 notify_only=true 才不唤醒；
      //   否则默认唤醒（reply_required 保留为「更强提示」语义）
      const r = agentBus.send(from, target, text, undefined, {
        replyRequired: value.reply_required === true,
        notifyOnly: value.notify_only === true,
      });
      const via = (mode === 'direct') ? 'direct' : 'central';
      // 成功发出（无论 delivered/queued/duplicate）才写 seen；失败路径不写 → 重放可重试
      _remember(_seen, _verdict.dedupKey);
      _seenDirty = true;
      logLine('[central-inbox] 📩 注入 ' + NODE_ID + ': ' + key + ' → ' + target + ' [' + via + '] ' + (r && r.status));
    } catch (e) {
      logLine('[central-inbox] 注入失败: ' + (e.message || e).slice(0, 80));
    }
  }

  connect();
}
