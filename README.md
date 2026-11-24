# 《雀界·广东麻将》

广东麻将（推倒胡）游戏实现：组合式牌张配置 + 全配置化番数与封顶 + 红中变。纯 TypeScript 规则引擎，前后端共用；Cocos Creator 2D 客户端+ H5 调试客户端 + Node.js 权威服务端。

## 快速开始

```bash
npm install          # 安装依赖
npm run build        # 构建（tsc project references）
npm test             # 全量测试（含 1000 局 AI soak，约 10 分钟）
npm run server       # 启动联机服务端（默认 :8080）
# 浏览器打开 http://localhost:8080/  → H5 调试客户端（本地单机 / 联机）
```

快速测试（跳过慢速 soak/对比）：

```bash
npx vitest run --testNamePattern '^(?!.*(1000 局|三档决策|点炮更少|胜率显著|建房 → AI))'
```

## 工程结构

```
packages/fan-config      配置 schema、9 套预设、启动校验（fail-fast）、受限表达式引擎
packages/mahjong-core    规则引擎：胡牌/番型/计分/封顶/状态机/回放/AI（无 UI 依赖）
packages/protocol        前后端共享消息协议
apps/server              Node.js + ws：房间、权威裁决、AI 托管、断线重连、/health
apps/h5-demo             H5 调试客户端（本地 PVE + 联机双模式，E2E 用）
apps/client-cocos        Cocos Creator 3.8.8 2D 工程（见其 BOOTSTRAP.md）
tools                    验收报告生成器等脚本
```

## 关键命令

| 命令 | 说明 |
|---|---|
| `npm run build` | 构建全部包（含 h5-demo 的 esbuild 产物 dist/main.js） |
| `npm test` | 全量测试（vitest） |
| `npm run coverage` | 覆盖率报告（mahjong-core/fan-config 目标 >90%） |
| `npm run server` | 构建并启动服务端 |
| `node tools/acceptance-report.mjs` | 生成验收清单追溯报告 → docs/ACCEPTANCE_REPORT.md |

## 环境变量（服务端）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 8080 | HTTP/WS 端口 |
| `TURN_TIMEOUT_MS` | 15000 | 出牌超时（超时 AI 托管） |
| `CLAIM_TIMEOUT_MS` | 8000 | 碰/杠/胡宣告超时 |
| `AI_DELAY_MS` | 120 | AI 出手间隔（体验节奏） |

## 规则基线（PRD v1.1）

- 广东推倒胡：不可吃；胡 > 碰/杠；漏胡锁定；抢杠仅补杠（十三幺可抢暗杠可配）
- 红中三模式：`wild` 万能牌（不可碰/明杠/补杠，可暗杠）/ `normal` / `off`
- 无红中加成：none/addFan/fanDouble/scoreDouble，bypassCap 双运算顺序（单测锁定）
- 封顶体系：fixed/tiered/formula/unlimited × global/group/player × bypass × minFan × maxScore
- 包三家：①补杠被抢 ②放杠致杠上开花 ③十二张落地（可配开关在 `rules.bao*`）
- 回放：seeded 牌墙 + 输入决策流 + resolvedFanConfig 快照，重算不漂移

## 文档

- [DEVELOPMENT_PLAN.md](./DEVELOPMENT_PLAN.md) — 开发计划（P1–P10 交付与门禁）
- [TEST_PLAN.md](./TEST_PLAN.md) — 测试计划与验收追溯矩阵
- [RELEASE_CHECKLIST.md](./RELEASE_CHECKLIST.md) — 上线清单（已验证项 vs 人工步骤）
- [docs/ACCEPTANCE_REPORT.md](./docs/ACCEPTANCE_REPORT.md) — 验收清单 1–22 追溯报告
