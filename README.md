# central-inbox · 黑板卡片跨会话注入器

> 版本见 `package.json`（单一来源）· 归属 `~/dsh-plugin-central-inbox`
> 本文档满足 R006 ⑤ 与 R039（工具中文描述文档）。

## ① 为什么需要（事故/证据）

跨设备/跨会话协作里，黑板上新写的卡片需要**注入到对应智能体的收件箱**才能被对方感知——
否则就是「卡写了、人不知道」（历史上多次发生：MBP 写卡 mac-mini 不知、星桥写卡 i9 不收）。

2026-10 审计实测过五条缺陷（每条都有断言钉住）：
- 单槽去重 → 真去重（成员集合 + 内容指纹，去 version）
- 自回声按**规范身份**判，不再拿节点名/显示名比
- 不可解析的 to 不再静默回退注入中枢
- 归一化后角色名映射、括号内 id 抢救
- 去重表有界（FIFO 2000）

## ② 用法（含退出码）

插件随 CLD 挂载运行（无需手动操作）；自检 CLI：

```bash
node lib/selftest.js      # 行为断言套件（16 PASS / 0 FAIL，exit 0）
node lib/selfcheck.js     # 依赖完整性自查
```

- 监听：黑板 `notes/mac-mini/*`、`notes/collab/*`（本机域）等前缀的**新键**（增量游标，不吃存量）。
- 注入：卡片 `value.to` 解析到活跃会话 → 注入其收件箱（`reply_required=true` 时强制唤醒）。
- 退出码：selftest `0` 全过 · `1` 有断言失败。

## ③ R006 达标矩阵

| 项 | 判定 | 说明 |
|---|---|---|
| ① dsh 插件形态 | ✓ | package.json + cordis.patch.yml + lib/index.js（apply） |
| ② TCC 检测 | ✓ | lib/selfcheck.js（v0.2.4 修复 ESM 死码后真实生效） |
| ③④ CLD/版本自适应 | ✓ | 零宿主私有 API；peer 经正式声明 |
| ⑤ 文档化 | ✓ | 本文件 |
| ⑥ 版本管理 | ✓ | package.json 单一来源 + CHANGELOG |
| ⑦ 统一日志 | ✓ | `~/.dsh/plugin-selfcheck/central-inbox.json` + 黑板告警 |
| ⑧ 自动落链 | ✓ | 黑板 `data/registry/` 登记卡 |
| ⑨ CLI 治理 | ✓ | selftest CLI 严格退出码 |
| ⑩ 约束前置 | ✓ | 路由纯函数可测；去重/自回声守卫 fail-closed |

## ④ 坑（实测）

1. **自检空转**（已修 v0.2.4）：ESM 下 `typeof require === 'function'` / `typeof __filename !== 'undefined'` 恒为 undefined，两段检查全跳过仍打印「自查通过」——与 agent-way 同坑，已改用 createRequire + fileURLToPath。
2. **去重键「去 version」名存实亡**（已修 v0.2.4）：指纹曾含 `value.version`，同内容重建卡片仍被当新卡重复注入；且旧测试用例 version 恒同才侥幸绿（测错对象）。
3. **卡片必须有 `value.to`**：无 to 的卡片按路由规则解析（空 to → 中枢别名），跨设备卡片缺 to 会被标注为不可投递。
4. **增量游标**：`--backfill` 只处理本次之后的新键，存量历史不会注入（防风暴）。

## ⑤ 复现命令

```bash
cd ~/dsh-plugin-central-inbox && node lib/selftest.js     # 期望 16 PASS / 0 FAIL
node lib/selfcheck.js                                     # 期望 missing=[]
```

> 关联：`~/dsh-comm-shared/identity.js`（身份归一化单一真相源；route.js 已再导出其 normalizeTo，迁移至 normalizeIdentity 决策表为后续动作，见架构审计报告 2026-10-03）。
