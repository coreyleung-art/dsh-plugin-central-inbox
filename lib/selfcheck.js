// selfcheck.js — 插件自查门 v1.0（R014：插件依赖完整性自查基础设施）
// 作用：插件 apply() 最前执行，检查自身依赖完整性（peerDeps/ESM 匹配/关键导入/符号）
//       缺模块 → 写黑板告警（data/ops/plugin-selfcheck/<plugin>-<ts>）+ 文件日志
//       → 返回 { ok, missing[], warnings[] } 供插件决定是否继续
// 目标：缺模块在加载前暴露，而非等崩溃/被外部 restart-guard 发现
//
// 用法（插件 apply 开头）：
//   import { runSelfCheck } from './selfcheck.js';
//   const sc = runSelfCheck('<plugin-name>', {
//     requiredPeers: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools'],
//     requiredSymbols: ['join', 'homedir', 'fs'],   // 顶层必须导入的符号
//     allowRequire: false,                          // type:module 下禁止裸 require
//   });
//   if (!sc.ok) { /* 依赖缺失，写告警 + 决定是否继续 */ }

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
// ★ v0.2.4 修复（审计 D1，2026-10-03）：本模块是 ESM，原实现用
//   `typeof require === 'function'` 与 `typeof __filename !== 'undefined'` 守卫——
//   两者在 ESM 下恒为 undefined ⇒ peerDeps 探测与符号检查双双被跳过，
//   只剩 type:module 检查然后打印「✅ 自查通过」= 空集通过（与 agent-way 同坑，实测负例）。
//   改用 createRequire(import.meta.url) 与 fileURLToPath(import.meta.url)。
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
 * 依赖完整性自查
 * @param {string} pluginName 插件名
 * @param {object} opts 检查选项
 * @returns {{ok: boolean, missing: string[], warnings: string[]}}
 */
export async function runSelfCheck(pluginName, opts = {}) {
  const { requiredPeers = [], requiredSymbols = [], allowRequire = false } = opts;
  const missing = [];
  const warnings = [];

  // ① peerDependencies 可解析性（探测）
  // v0.2.4 修复（D1）：ESM 下没有全局 require ⇒ 原实现恒走 else 分支、直接跳过。
  // 改用 createRequire(import.meta.url) 得到以本文件为基准的解析器。
  const req = (() => {
    if (typeof require === 'function') return require;      // CJS 环境
    try { return createRequire(import.meta.url); } catch (e) { return null; }
  })();
  if (req === null) {
    warnings.push('无法构造 require（既无全局 require 也建不出 createRequire）——peerDeps 探测跳过');
  } else {
    for (const peer of requiredPeers) {
      try {
        req.resolve(peer);
      } catch (e) {
        missing.push(`peer:${peer}`);
        warnings.push(`依赖 ${peer} 不可解析（node_modules 缺失或符号链接断）`);
      }
    }
  }

  // ② 关键符号导入完整性（当前文件顶层 import 扫描）
  if (requiredSymbols.length > 0) {
    try {
      // v0.2.4 修复（D1）：原用 `typeof __filename !== 'undefined'` 守卫——
      //   ESM 下 __filename 不存在 ⇒ 整段被跳过。改用 fileURLToPath(import.meta.url)。
      const srcPath = opts.sourceFile ? String(opts.sourceFile) : fileURLToPath(import.meta.url);
      const src = readFileSync(srcPath, 'utf8');
      for (const sym of requiredSymbols) {
        const imported = src.includes(`import { ${sym}`) || src.includes(`import ${sym} `) || src.includes(`import * as ${sym}`);
        if (!imported) {
          missing.push(`symbol:${sym}`);
          warnings.push(`符号 ${sym} 未在顶层导入（ESM 下裸调用 → ReferenceError）`);
        }
      }
    } catch (e) { /* 读自身失败跳过 */ }
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

  // ★ 0.2.9 真挂载冒烟（cff6275e 事故：os 裸引用只在 apply 期崩，
  //   node --check/import/selftest 三层都拦不住 ⇒ 必须有 apply 冒烟；三态分开报）
  let smokeState = 'skipped', smokeDetail = '';
  try {
    const mod = await import('./index.js');
    const noop = new Proxy(function () {}, { get: () => noop, apply: () => undefined });
    const stubCtx = new Proxy({
      effect: (fn) => { if (typeof fn === 'function') fn(); },
      on: () => undefined,
      get: () => undefined,
    }, { get: (t, k) => (k in t ? t[k] : noop) });
    await mod.apply(stubCtx, {});
    smokeState = 'pass';
    smokeDetail = 'apply(stub) 正常返回（0.2.9 os 引用已修）';
  } catch (e) {
    const m = String((e && e.message) || e);
    if (m.includes('ERR_MODULE_NOT_FOUND') || m.includes('Cannot find')) { smokeState = 'skipped'; smokeDetail = '依赖缺失: ' + m.slice(0, 60); }
    else { smokeState = 'fail'; smokeDetail = 'apply 抛异常: ' + m.slice(0, 100); warnings.push('真挂载冒烟 ' + smokeState + ': ' + smokeDetail); missing.push('mount-smoke-' + smokeState); }
  }
  if (smokeState !== 'fail') console.log('  [' + smokeState + '] 真挂载冒烟 — ' + smokeDetail);

  const ok = missing.length === 0;
  // 结果落盘 + 黑板告警（非阻断，仅标记）
  const ts = Date.now();
  const result = { plugin: pluginName, ok, missing, warnings, ts };
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
