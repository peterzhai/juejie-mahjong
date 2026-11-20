# 《雀界·广东麻将》测试计划

## 1. 测试分层

| 层 | 范围 | 工具 | 位置 |
|---|---|---|---|
| L1 单元 | 牌张/配置/校验/表达式/胡牌/番型/计分/封顶 | vitest | `packages/*/tests` |
| L2 状态机集成 | 碰杠抢杠/漏胡锁/包三家/流局/连庄/回放重算 | vitest | `packages/mahjong-core/tests/game.*` |
| L3 服务集成 | 房间生命周期、ws 协议、非法动作拒绝、托管、重连 | vitest + ws 真实客户端 | `apps/server/tests` |
| L4 端到端 | 浏览器真实对局（建房→AI→托管→结算明细）、双端同步 | 自动化浏览器 | P10 |
| L5 soak/性能 | 1000 局无崩溃、单操作 <100ms、formula <10ms | vitest / 脚本 | `tests-soak` |

## 2. 验收清单 → 测试用例追溯矩阵（PRD §10.1–10.4 共 22 项）

| # | 验收项 | 测试文件 | 关键用例 |
|---|---|---|---|
| 1 | 9 预设张数/牌墙/底牌计算 | `tileSet.test.ts` | `presets: 9 组张数黄金值` |
| 2 | copies=3/5 动态变化 | `tileSet.test.ts` | `copies mutation` |
| 3 | 番型依赖矩阵黄金用例 | `fanDependency.test.ts` | 6 番型 × 4 预设 24 断言 |
| 4 | gd128 大三元"缺发白"、gd100 十三幺"仅 11 种"报错 | `fanDependency.test.ts` | 错误文案断言 |
| 5 | normal 模式启用 redCenterBonus 被拒 | `validation.test.ts` | `red-center consistency` |
| 6 | 改 fans 配置值分数变化（不改代码） | `scoring.test.ts` | config override 前后对比 |
| 7 | max 与 additive 可预期 | `scoring.test.ts` | 双模式对照表 |
| 8 | 有/无红中 × 四种加成模式 | `redCenterBonus.test.ts` | 4×2 矩阵 |
| 9 | fanDouble+cap3+bypassCap:false 无实际加成并告警 | `redCenterBonus.test.ts` / `validation.test.ts` | 分数不变 + warning 存在 |
| 10 | 红中暗杠计"有红中"；弃牌区/别家副露不影响 | `redCenterBonus.test.ts` | 暗杠/河牌/他家副露三情形 |
| 11 | cap 四种 value.type 生效 | `cap.test.ts` | fixed/tiered/formula/unlimited |
| 12 | formula 越界 clamp；非法表达式报错；超时报错 | `expr.test.ts` / `cap.test.ts` | 白名单外符号逐类拒绝 |
| 13 | group/player 作用域、未分组回落全局 | `cap.test.ts` | 清一色组/字牌组/回落 |
| 14 | bypass.fanIds 跳过封顶但 hardCap 生效；conditions 四开关只豁免一次 | `cap.test.ts` | 4 条件逐项 |
| 15 | minFan 保底（鸡胡 ≥ base×2^minFan） | `cap.test.ts` | 鸡胡各封顶配置 |
| 16 | maxScore 在 unlimited/bypass 截断，无 NaN/Infinity | `cap.test.ts` | 极端配置 |
| 17 | 同手牌 fixed vs formula 分数不同；元数据正确 | `cap.test.ts` / `replay.test.ts` | resolvedCapFan/formulaSnapshot |
| 18 | 抢杠仅补杠；十三幺可抢暗杠；被抢杠者包三家 | `kong.test.ts` / `bao.test.ts` | 明杠/暗杠不可抢反例 |
| 19 | 流局杠分退回；连庄规则 | `drawGame.test.ts` | 账本归零 + 庄位不变 |
| 20 | 回放 tileSetPresetId/resolvedFanConfigHash，改预设不漂移 | `replay.test.ts` | 重放比对 + 换配置重放 |
| 21 | 主包 ≤4MB；分包按需；H5 可玩 | `report`（包体预算文档）+ P10 E2E | h5 主流程浏览器实测 |
| 22 | 服务端拒绝非法动作并记录 | `server.integration.test.ts` | 非本回合出牌/非法杠等 |

## 3. 各阶段退出标准

- 每阶段：新增测试全绿、既有测试无回归、`npm run build` 通过。
- P2 起：番型依赖矩阵、张数表为**黄金值硬断言**，禁止软断言。
- P4 起：番型正反例覆盖率达到"每个番型 ≥1 正例 ≥1 反例"。
- P4b 起：6.4/6.5.5 运算顺序用**顺序锁定测试**（同一输入构造出顺序敏感的分数差）。
- P5 起：回放重算一致性测试进入回归集。
- P7：合法性 harness（每个 AI 动作过引擎校验）+ 1000 局 soak。
- P9：真实 ws 客户端集成测试（非 mock）。
- P10：覆盖率报告（`mahjong-core` + `fan-config` 语句覆盖 >90%）+ E2E 截图 + 验收报告生成。

## 4. 非功能测试

| 项 | 方法 | 阈值 |
|---|---|---|
| 单局操作响应 | benchmark：胡牌判定+计分 5000 次取均值 | <100ms（留数量级余量） |
| formula 求值 | 10 万次求值均值 | <10ms |
| 表达式安全 | 恶意输入用例集（赋值/循环/原型链/超长/深嵌套） | 全部启动期拒绝 |
| 包体预算 | 资源清单核算（图集/音频预算表） | 主包 ≤3.5MB 预留 |
| 内存/稳定性 | soak 1000 局（混合预设/红中模式/封顶配置） | 零异常退出 |
| 回放一致性 | 100 局回放重算全等 | 100% 一致 |

## 5. 缺陷管理约定

- 门禁阶段发现缺陷：当场修复并补回归用例后重跑门禁，不带病进入下一阶段。
- 黄金值断言失败视为规格理解偏差，优先回查 PRD 口径再改测试。
