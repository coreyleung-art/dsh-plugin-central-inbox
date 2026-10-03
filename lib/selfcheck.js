// selfcheck.js — 插件自查门（R014：插件依赖完整性自查基础设施）
// 作用：插件 apply() 最前执行，检查自身依赖完整性（peerDeps/ESM 匹配/关键导入/符号）
//       缺模块 → 写黑板告警（data/ops/plugin-selfcheck/<plugin>-<ts>）+ 文件日志
//       → 返回 { ok, missing[], warnings[] } 供插件决定是否继续
//
// ★ 0.2.10 结构修复（冒烟递归链事故）：
//   - runSelfCheck 回归【同步】纯检查（生产 apply 每次调用、零副作用、零网络）
//   - 真挂载 apply 冒烟拆为独立 export async runApplySmoke()，仅 CLI/CI 调用，带防重入守卫
//   事故根因（0.2.9）：冒烟放在 runSelfCheck 内，而 runSelfCheck 又被 apply 调用，
//   冒烟再调 apply(stubCtx) ⇒ apply 内再触发 runSelfCheck ⇒ 无限微任务递归链。
//   正控证据（0.2.10 修复前实测）：apply(stubCtx) 后 20s 内刷出上万次冒烟日志、
//   setTimeout 被微任务链饿死、进程被 SIGTERM 强杀。生产环境无 process.exit ⇒ livelock。
//   教训升级：真挂载冒烟必须【独立入口 + 防重入守卫 + 绝不在 apply 调用链内】。
//
// 用法（插件 apply 开头）：
//   import { runSelfCheck } from './selfcheck.js';
//   const sc = runSelfCheck('<plugin-name>', {
//     requiredPeers: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools'],
//     requiredSymbols: ['join', 'homedir', 'fs'],   // 顶层必须导入的符号
//     sourceFile: new URL('./index.js', import.meta.url).pathname,  // 扫描调用方而非本文件
//   });
//   if (!sc.ok) { /* 依赖缺失，写告警 + 决定是否继续 */ }

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
// ★ 2026-10-01 修复（ESM 死码）：本模块是 ESM，而原实现用 `typeof require === 'function'`
//   与 `typeof __filename !== 'undefined'` 做守卫 —— **两者在 ESM 下恒为 undefined**
//   ⇒ ① peerDeps 探测 与 ② 关键符号检查 **双双被跳过**，只剩 ③ type:module，
//   然后打印 `✅ 自查通过`。实测负例控制：传入绝不可能存在的符号，missing 仍为 []。
//   ⇒ 生产中的 R014 自查门是一个**空转绿灯**（正是 R006 坑表「空集通过」）。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HOME = homedir();
const SELFCHECK_DIR = join(HOME, '.dsh', 'plugin-selfcheck');
const BB_URL = process.env.DSH_BB_URL || 'http://127.0.0.1:8792';
const LOG_FILE = join(SELFCHECK_DIR, 'selfcheck.log');

function log(msg) {
  try {
    mkdirSync(SELFCHECK_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`, { flag: 'a' });
  } catch (e) { /* 日志失败不阻塞 */ }
}

function putBlackboard(key, value) {
  try {
    if (typeof fetch !== 'function') return;
    fetch(`${BB_URL}/${key}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    }).catch(() => {});
  } catch (e) { /* 黑板不可用不阻塞 */ }
}

/**
 * 提取源码全部顶层 import 符号（named / default / namespace 三形态）。
 * ★ 0.2.10 修复：原扫描只匹配 `import { SYM` 开头形式，
 *   多符号 import（如 `import { readFile, writeFile } from ...`）的非首位符号
 *   以及 default/namespace import 全部漏检 ⇒ 改正则整体提取后集合判断。
 */
export function extractImportedSymbols(src) {
  const out = new Set();
  const re = /import\s*(?:\{([^}]*)\}|\*\s*as\s+([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*))\s*from/gs;
  let m;
  while ((m = re.exec(src))) {
    if (m[1] !== undefined) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0].trim();
        if (name) out.add(name);
      }
    }
    if (m[2]) out.add(m[2]);
    if (m[3]) out.add(m[3]);
  }
  return out;
}

/**
 * 依赖完整性自查（同步、零副作用 —— 生产 apply 每次调用）
 * @param {string} pluginName 插件名
 * @param {object} opts 检查选项
 * @returns {{ok: boolean, missing: string[], warnings: string[]}}
 */
export function runSelfCheck(pluginName, opts = {}) {
  const { requiredPeers = [], requiredSymbols = [], allowRequire = false } = opts;
  const missing = [];
  const warnings = [];
  const resolved = [];   // ★ 修复后新增：peer 的实际解析路径（用于暴露「遮蔽 runtime」= M1 根因）

  // ① peerDependencies 可解析性（探测）
  const req = (() => {
    if (typeof require === 'function') return require;      // CJS 环境
    try { return createRequire(import.meta.url); } catch (e) { return null; }
  })();
  if (req === null) {
    warnings.push('无法构造 require（既无全局 require 也建不出 createRequire）——peerDeps 探测跳过');
  } else {
    for (const peer of requiredPeers) {
      try {
        const resolvedPath = req.resolve(peer);
        resolved.push(`${peer} → ${resolvedPath}`);
      } catch (e) {
        missing.push(`peer:${peer}`);
        warnings.push(`依赖 ${peer} 不可解析（node_modules 缺失或符号链接断）`);
      }
    }
  }

  // ② 关键符号导入完整性（默认扫描本文件；传 opts.sourceFile 扫调用方）
  if (requiredSymbols.length > 0) {
    try {
      const srcPath = opts.sourceFile ? String(opts.sourceFile) : fileURLToPath(import.meta.url);
      const src = readFileSync(srcPath, 'utf8');
      const imported = extractImportedSymbols(src);
      for (const sym of requiredSymbols) {
        if (!imported.has(sym)) {
          missing.push(`symbol:${sym}`);
          warnings.push(`符号 ${sym} 未在 ${srcPath} 顶层导入（ESM 下裸调用 → ReferenceError）`);
        }
      }
    } catch (e) { /* 读失败跳过 */ }
  }

  // ③ type:module 匹配（本文件所在包）
  try {
    const pkgPath = new URL('../package.json', import.meta.url).pathname;
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const isEsm = pkg.type === 'module';
      const hasExport = requiredSymbols.length > 0; // 有 requiredSymbols 说明用 ESM
      if (hasExport && !isEsm) {
        warnings.push(`package.json 缺 type:module（ESM 语法按 CJS 解析 → SyntaxError）`);
      }
    }
  } catch (e) { /* 包解析失败跳过 */ }

  const ok = missing.length === 0;
  // 结果落盘 + 黑板告警（非阻断，仅标记）
  const ts = Date.now();
  const result = { plugin: pluginName, ok, missing, warnings, resolved, ts };
  try {
    mkdirSync(SELFCHECK_DIR, { recursive: true });
    writeFileSync(join(SELFCHECK_DIR, `${pluginName}.json`), JSON.stringify(result, null, 2));
  } catch (e) { /* 落盘失败不阻塞 */ }
  if (!ok) {
    log(`❌ ${pluginName} 自查失败: ${missing.join(', ')}`);
    putBlackboard(`data/ops/plugin-selfcheck/${pluginName}-${ts}`, result);
  } else {
    log(`✅ ${pluginName} 自查通过`);
  }
  return result;
}

// ─── 真挂载 apply 冒烟（CLI/CI 专用）────────────────────────────────
// ★ 0.2.10 独立化 + 防重入：只允许 CLI/CI 显式调用；绝不在 apply 调用链内执行。
//   事故教训：apply 期 ReferenceError（如 os 裸引用）只有真 apply 冒烟拦得住，
//   但冒烟本身绝不能挂在 apply 调用链上（否则自查=自触发递归，见 0.2.9 事故）。
let _smokeInFlight = false;

/**
 * 真挂载冒烟：import('./index.js') + apply(stubCtx) 三态判定
 * @returns {Promise<{state: 'pass'|'fail'|'skipped', detail: string}>}
 */
export async function runApplySmoke(opts = {}) {
  if (_smokeInFlight) {
    return { state: 'skipped', detail: '防重入守卫：已有冒烟在跑，跳过本次' };
  }
  _smokeInFlight = true;
  try {
    const mod = await import('./index.js');
    const noop = new Proxy(function () {}, { get: () => noop, apply: () => undefined });
    // ★ 0.2.10 修盲区：stub 目标里若有 get/on/effect 同名键会遮蔽 Proxy 回退，
    //   导致 ctx.get('agentBus') 返回 undefined → apply 提前 return（0.2.9 冒烟假绿：
    //   SEEN_FILE 行根本走不到）。此处显式按服务名供给：agentBus 给真 stub 服务。
    const stubAgentBus = {
      list: () => [],
      send: async () => ({ delivered: true, messageId: 'smoke-' + Date.now() }),
      broadcast: async () => ({}),
    };
    const stubCtx = new Proxy({
      effect: (fn) => { if (typeof fn === 'function') fn(); },
      on: () => undefined,
      provide: () => undefined,
    }, {
      get: (t, k) => {
        if (k === 'get') return (name) => (name === 'agentBus' ? stubAgentBus : noop);
        return (k in t ? t[k] : noop);
      },
    });
    await mod.apply(stubCtx, {});
    return { state: 'pass', detail: 'apply(stub) 深路径正常返回（0.2.10 冒烟独立化+去盲区）' };
  } catch (e) {
    const m = String((e && e.message) || e);
    if (m.includes('ERR_MODULE_NOT_FOUND') || m.includes('Cannot find')) {
      return { state: 'skipped', detail: '依赖缺失: ' + m.slice(0, 60) };
    }
    return { state: 'fail', detail: 'apply 抛异常: ' + m.slice(0, 100) };
  } finally {
    _smokeInFlight = false;
  }
}
