#!/usr/bin/env node
// cli.js — central-inbox 治理入口（R006 ⑨ 补课）：--tool-version / --selfcheck；未知旗标 exit 2。
import { readFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const args = process.argv.slice(2);
if (args.length === 0 || args.includes('--help')) {
  console.log('central-inbox CLI\n  --tool-version  版本号（package.json 单一来源）\n  --selfcheck     行为断言套件 + 自检门 + 真挂载冒烟');
  process.exit(args.includes('--help') ? 0 : 2);
}
if (args.includes('--tool-version')) { console.log(pkg.version); process.exit(0); }
if (args.includes('--selfcheck')) {
  // 0.2.10：①行为断言套件 → ②同步自检门（扫 index.js 调用方符号）→ ③独立真挂载冒烟
  //   （冒烟已从 runSelfCheck 剥离：0.2.9 冒烟递归链事故——冒烟在 apply 调用链内自触发）
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('/opt/homebrew/bin/node', [new URL('./lib/selftest.js', import.meta.url).pathname], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
  const { runSelfCheck, runApplySmoke } = await import('./lib/selfcheck.js');
  const g = runSelfCheck('central-inbox', {
    requiredPeers: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools'],
    requiredSymbols: ['join', 'homedir', 'fs', 'hostname', 'normalizeTo', 'runSelfCheck'],
    sourceFile: new URL('./lib/index.js', import.meta.url).pathname,
  });
  if (!g.ok) {
    console.error('  selfcheck FAIL: ' + g.missing.join(', '));
  } else {
    console.log('  selfcheck: central-inbox → PASS');
  }
  const s = await runApplySmoke();
  console.log('  [' + s.state + '] 真挂载冒烟 — ' + s.detail);
  process.exit(g.ok && s.state !== 'fail' ? 0 : 1);
}
console.error('用法错误: 未知旗标 ' + args.join(' '));
process.exit(2);
