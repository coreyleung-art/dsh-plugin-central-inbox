#!/usr/bin/env node
// cli.js — central-inbox 治理入口（R006 ⑨ 补课）：--tool-version / --selfcheck；未知旗标 exit 2。
import { readFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const args = process.argv.slice(2);
if (args.length === 0 || args.includes('--help')) {
  console.log('central-inbox CLI\n  --tool-version  版本号（package.json 单一来源）\n  --selfcheck     行为断言套件');
  process.exit(args.includes('--help') ? 0 : 2);
}
if (args.includes('--tool-version')) { console.log(pkg.version); process.exit(0); }
if (args.includes('--selfcheck')) {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('/opt/homebrew/bin/node', [new URL('./lib/selftest.js', import.meta.url).pathname], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
console.error('用法错误: 未知旗标 ' + args.join(' '));
process.exit(2);
