/**
 * lib/selftest.js — central-inbox 断言套件（2026-10-01 新增；此前断言数 0）
 * 每条断言对应一个实测缺陷，全部为【行为断言】（不查源码文字）。
 *
 * ⚠️ 2026-10-01 补 CLI 入口：此前本模块**只导出 runSelftest、无 CLI 入口** ⇒
 *    `node lib/selftest.js` 静默退出 0、零输出，外观与「全部通过」完全无异
 *    （实测踩中：「自检通过」的报告其实什么都没跑）。必须能直接运行才算 ② 达标。
 *    用法：node lib/selftest.js
 */
import { normalizeTo, resolveTargetId, shouldInject, remember } from './route.js';
import { pathToFileURL } from 'node:url';

const CENTRAL = 'session-fa1f9150-c949-401f-ba8c-d265f6221676';
const IDS = [CENTRAL, 'session-aa528267-0434-4bf5-87c5-d5a61f8215b2', 'session-a190c54c-ca73-4845-9a65-9dc002d45044'];

export function runSelftest() {
  let ok = 0; let fail = 0;
  const check = (name, cond, detail = '') => {
    if (cond) { ok++; console.log('  PASS  ' + name); }
    else { fail++; console.log('  FAIL  ' + name + '  ' + String(detail)); }
  };

  // ── 缺陷 1：单槽去重 → 真去重 ──
  const seen = new Set();
  const ev = (key, version, from = 'i9-hr') => ({ key, value: { from, to: 'coordinator', version } });
  const p1 = shouldInject(ev('notes/collab/a', 1), { prefixes: ['notes/collab/'], nodeId: 'mac-mini', ownSession: CENTRAL, seen });
  remember(seen, p1.dedupKey);
  const p2 = shouldInject(ev('notes/collab/b', 1), { prefixes: ['notes/collab/'], nodeId: 'mac-mini', ownSession: CENTRAL, seen });
  remember(seen, p2.dedupKey);
  const p3 = shouldInject(ev('notes/collab/a', 1), { prefixes: ['notes/collab/'], nodeId: 'mac-mini', ownSession: CENTRAL, seen });
  check('I1 ★ 交错重复键被去重（A,B,A ⇒ 第二个 A 不注入；单槽实现会漏）', p3.inject === false, JSON.stringify(p3));
  const p4 = shouldInject(ev('notes/collab/a', 2), { prefixes: ['notes/collab/'], nodeId: 'mac-mini', ownSession: CENTRAL, seen });
  check('I1 同键新版本 version=2（内容同）不再重复注入', p4.inject === false, JSON.stringify(p4));
  // ★ 2026-10-03 键形态改版：<key>#<内容指纹>（去 version——重建卡片内容同应同键）
  check('I1 去重键形态为 <key>#<指纹>', p1.dedupKey.startsWith('notes/collab/a#'), p1.dedupKey);
  // ★ v0.2.4 修复用例（审计 D3）：value.version 变（1→2）而内容同 ⇒ 去重键必须相同。
  //   旧实现 fp 含 value.version ⇒ 键不同 ⇒ 重建卡片被当新卡重复注入；
  //   旧用例 value.version 恒同为 1 才侥幸绿（测错了对象）。
  check('I1 同内容重建（value.version 变）去重键相同', (() => {
    const d2 = { key: 'notes/collab/a', version: 2, value: { from: 'i9-hr', to: 'coordinator', version: 2 } };
    const r2 = shouldInject(d2, { prefixes: ['notes/collab/'], nodeId: 'mac-mini', ownSession: CENTRAL });
    return r2.dedupKey === p1.dedupKey;
  })(), '同内容应同键');

  // ── 缺陷 2：自回声按规范身份判 ──
  for (const from of ['mac-mini', '星桥 fa1f9150', 'mac-mini (self)', CENTRAL]) {
    const r = shouldInject({ key: 'notes/collab/x', value: { from, version: 1 } },
      { prefixes: ['notes/collab/'], nodeId: 'mac-mini', ownSession: CENTRAL, seen: new Set() });
    check('I2 ★ 自回声守卫对 from=' + JSON.stringify(from) + ' 生效', r.inject === false, JSON.stringify(r));
  }
  const other = shouldInject({ key: 'notes/collab/x', value: { from: '老登 session-aa528267 (mac-mini)', version: 1 } },
    { prefixes: ['notes/collab/'], nodeId: 'mac-mini', ownSession: CENTRAL, seen: new Set() });
  check('I2 他节点（含显示名后缀）不被误判为自回声', other.inject === true, JSON.stringify(other));

  // ── 缺陷 3：不可解析→不回退注入中枢 ──
  const r1 = resolveTargetId('mac-hr (via 星桥/coordinator)', { ids: IDS, central: CENTRAL });
  check('I3 ★ 不可解析的 to 不再回退注入中枢（mode=skip）', r1.mode === 'skip' && r1.target === null, JSON.stringify(r1));
  const r2 = resolveTargetId('coordinator', { ids: IDS, central: CENTRAL });
  check('I3 显式中枢别名仍解析为中枢', r2.target === CENTRAL && r2.mode === 'central', JSON.stringify(r2));
  const r3 = resolveTargetId('session-aa528267-0434-4bf5-87c5-d5a61f8215b2', { ids: IDS, central: CENTRAL });
  check('I3 完整 session id 精确命中且为 direct', r3.mode === 'direct' && r3.target.startsWith('session-aa528267'), JSON.stringify(r3));

  // ── 缺陷 4：角色名归一化后再查 ──
  const roleMap = { '星桥': CENTRAL };
  const r4 = resolveTargetId('星桥 (mac-mini)', { ids: IDS, central: CENTRAL, roleMap });
  check('I4 ★ 带后缀的角色名仍能命中映射', r4.target === CENTRAL, JSON.stringify(r4));

  // ── 缺陷 5：多收件人列表 ──
  const r5 = resolveTargetId('明鉴 session-a190c54c, 老登 session-aa528267', { ids: IDS, central: CENTRAL });
  check('I5 逗号分隔的多收件人可解析', r5.mode === 'direct' && r5.target.startsWith('session-a190c54c'), JSON.stringify(r5));
  check('normalizeTo 剥离中英文括号与 via 链', JSON.stringify(normalizeTo('mac-hr（via 星桥）')) === JSON.stringify(['mac-hr']), JSON.stringify(normalizeTo('mac-hr（via 星桥）')));

  // ── 0.2.11-A 新判据：own-node 别名 → 中枢；角色离线 → 排完整 id ──
  const r6 = resolveTargetId('mac-mini', { ids: IDS, central: CENTRAL, nodeAliases: ['mac-mini'] });
  check('A② own-node 别名 to=mac-mini → 中枢（MBP 三卡 null 吞事故回放）', r6.target === CENTRAL && r6.reason.startsWith('own-node-alias'), JSON.stringify(r6));
  const r7 = resolveTargetId('司库', { ids: [], central: CENTRAL, roleMap: { '司库': 'session-2a15e6b1-32a9-48b3-a167-8fe0a28e8d82' } });
  check('A③ 角色离线 → 排完整 id 待唤醒（不丢卡）', r7.target === 'session-2a15e6b1-32a9-48b3-a167-8fe0a28e8d82' && r7.mode === 'queued-direct', JSON.stringify(r7));

  // ── 有界去重表 ──
  const s2 = new Set();
  for (let i = 0; i < 2100; i++) remember(s2, 'k' + i, 2000);
  check('I1 去重表有界（cap=2000，FIFO 淘汰）', s2.size === 2000, s2.size);

  console.log('\n  selftest: ' + ok + ' PASS / ' + fail + ' FAIL');
  return fail === 0 ? 0 : 1;
}

// ─── CLI 入口（R006 ⑨ / ⑫）—— 无此入口则 `node lib/selftest.js` 静默退出 0
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runSelftest());
}
