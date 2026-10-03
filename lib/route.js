import { normalizeTo, contentFingerprint } from '../../dsh-comm-shared/identity.js';

export { normalizeTo };

/**
 * lib/route.js — central-inbox 的可测纯逻辑（从 index.js 抽出的闭包内逻辑）
 *
 * 抽取理由：原实现把「收件人解析」与「是否注入」两段判断埋在 apply(ctx) 的闭包内，
 * 无法单测 ⇒ 该插件断言数为 0。抽成纯函数后，五条缺陷可逐条被断言钉住。
 *
 * 2026-10-01 星桥：对照实测缺陷（见本文件各 ★ 注释）
 */

/** 显示名污染的形态：`老登 session-aa528267 (mac-mini)` / `mac-hr (via 星桥/coordinator)` /
 *  `明鉴 session-a190c54c（mac-mini）`（中文括号）/ 逗号或顿号分隔的收件人列表。 */
export const CENTRAL_ALIASES = Object.freeze(['coordinator', 'central', '中枢', '']);

/** 纯解析：给定 to 与可用会话表 → 目标 */
export function resolveTargetId(to, { ids = [], central, roleMap = {} } = {}) {
  const parts = normalizeTo(to);
  if (parts.length === 0) return { target: central, mode: 'central', reason: 'empty-to' };
  const one = parts[0];                       // 多收件人取首个可解析者
  if (CENTRAL_ALIASES.includes(String(one).toLowerCase())) {
    return { target: central, mode: 'central', reason: 'central-alias' };
  }
  // 角色名映射（★ 修缺陷4：归一化后再查，且允许前缀命中）
  // ★ 2026-10-01 变异测试发现：原写法带 `|| one.startsWith(k)` 前缀回退分支，
  //   但【没有任何用例需要它】——归一化后 'to="星桥 (mac-mini)"' 得到精确键 '星桥'，直接命中；
  //   而 'to="老登 session-aa528267"' 走的是下方片段匹配，不经过角色表。
  //   ⇒ 无断言覆盖 + 无用例需要的分支 = 死代码，删（而不是给它发明一个测试）。
  const mapped = roleMap[one];
  if (mapped) {
    const live = ids.find((id) => id === mapped || id.includes(String(mapped).split('-').slice(0, 2).join('-')));
    if (live) return { target: live, mode: live === central ? 'central' : 'direct', reason: 'role-mapped' };
    return { target: null, mode: 'skip', reason: 'role-mapped-offline' };
  }
  if (ids.length === 0) return { target: null, mode: 'skip', reason: 'agentBus.list-empty' };
  const exact = ids.find((id) => id === one);
  if (exact) return { target: exact, mode: exact === central ? 'central' : 'direct', reason: 'exact' };
  const frags = ids.filter((id) => id.includes(one));
  if (frags.length === 1) return { target: frags[0], mode: frags[0] === central ? 'central' : 'direct', reason: 'fragment' };
  if (frags.length > 1) return { target: null, mode: 'skip', reason: 'ambiguous-fragment(' + frags.length + ')' };
  // ★ 修缺陷3：未命中【不再静默回退注入中枢】。回退只对显式中枢别名保留（见上）。
  return { target: null, mode: 'skip', reason: 'unresolvable(' + one + ')' };
}

/** 是否应处理该事件（含自回声与去重） */
export function shouldInject(d, { prefixes, nodeId, ownSession, centralAgent, seen, seenCap = 2000 }) {
  if (!d || !d.key) return { inject: false, reason: 'no-key' };
  const key = d.key;
  if (!prefixes.some((p) => key.startsWith(p))) return { inject: false, reason: 'prefix' };
  const value = d.value || {};
  const fromRaw = String(value.from === undefined || value.from === null ? '' : value.from);
  // ★ 修缺陷2：自回声按【规范身份】判，不再拿节点名与显示名比
  const fromIds = normalizeTo(fromRaw);
  const selfNames = new Set([String(nodeId || ''), String(ownSession || ''), 'coordinator'].filter(Boolean));
  // ★ 对称：ownSession 的 8 位短形式也必须是自身标识
  const om = String(ownSession || '').match(/session-([0-9a-f]{8})/i);
  if (om) selfNames.add('session-' + om[1].toLowerCase());
  if (fromIds.some((f) => selfNames.has(f) || (ownSession && f === ownSession))) {
    return { inject: false, reason: 'self-echo(' + fromIds.join('|') + ')' };
  }
  // ★ 修缺陷1：真去重 —— 成员资格，而非单槽
  // ★★ 2026-10-03 MBP(session-20b800d4) 建议合并：去重键改用**内容指纹、不含 version**。
  //   理由（实测）：`key@version` 对「重建卡片（内容同、version 变）」无效——
  //   星桥「批量补 to→误覆盖→按历史重建」即此形态，每次重建都被当新卡重复注入。
  //   ⇒ 去 version、只留内容指纹：内容同⇒同键⇒不注入；内容变⇒新键⇒照常注入。
  //   ★ v0.2.4 修复（全架构审查 D3，2026-10-03）：此前 fp = JSON.stringify(value) 仍含
  //     value.version，「去 version」名存实亡；且 ver 变量从未被使用（死变量）。
  //     selftest 的「version 变」用例 value.version 恒同为 1 才侥幸绿。现真正剔除 value.version。
  const valueNoVersion = { ...value };
  delete valueNoVersion.version;
  const fp = contentFingerprint(JSON.stringify(valueNoVersion));
  const dk = key + '#' + fp;
  if (seen && seen.has(dk)) return { inject: false, reason: 'dup(' + dk + ')' };
  return { inject: true, reason: 'ok', dedupKey: dk, key, value, targetHint: value.to };
}

/** 去重表的写入（有界，FIFO 淘汰） */
export function remember(seen, dedupKey, cap = 2000) {
  if (!seen || !dedupKey) return seen;
  seen.add(dedupKey);
  while (seen.size > cap) { const first = seen.values().next().value; seen.delete(first); }
  return seen;
}
