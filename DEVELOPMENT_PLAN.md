# 《雀界·广东麻将》开发计划（依据 PRD v1.1）

> 本计划为执行基线。每个阶段结束时跑对应门禁，全绿才进入下一阶段。
> 环境事实：Node 22 / npm 10 / TypeScript 5.x；**本机未安装 Cocos Creator**，
> `apps/client-cocos` 以完整可读源码 + 接线说明交付（在编辑器中打开后构建），
> 端到端验证由 `apps/h5-demo`（可运行 H5 调试客户端，走同一规则引擎与服务端权威链路）承担。

## 0. 工程定位

```
quejie-mahjong/
├─ packages/fan-config      配置 schema、启动校验、9 套预设、受限表达式引擎、默认配置
├─ packages/mahjong-core    纯 TS 规则引擎（牌张/胡牌/番型/计分/状态机/回放/AI）
├─ packages/protocol        前后端共享消息与类型
├─ apps/server              Node.js + ws：房间、权威裁决、托管、重连、健康检查
├─ apps/client-cocos        Cocos Creator 4.x 工程源码（wechatgame + web-mobile）
├─ apps/h5-demo             可运行 H5 调试客户端（DOM 渲染，联机 + 本地 PVE 双模式）
└─ tools                    soak、验收清单报告等脚本
```

依赖方向：`fan-config`（无依赖）← `mahjong-core` ← `protocol` ← `server` / `h5-demo` / `client-cocos`。
全部 TypeScript ESM（`"type": "module"`，import 带 `.js` 后缀，浏览器与 Node 通用）。

## 1. 阶段计划与门禁

### P1 工程基建
- 交付：npm workspaces monorepo；`tsconfig.base.json`；四包脚手架；根脚本 `build/test/coverage`；server `/health` HTTP 健康检查。
- 门禁：`npm run build` 与 `npm test` 全绿（含占位冒烟测试）。

### P2 组合式牌张配置
- 交付：
  - `fan-config`：tileSet schema（每牌面独立开关/张数）、9 套预设 gd100–gd144、启动校验 fail-fast（4.2 数学约束、4.4 红中一致性、花牌 v0.2 拒绝）、`resolveTileSet`。
  - `mahjong-core`：TileId 动态编码（不硬编码 34 种）、牌列表构建、totalTiles/dealTiles/wallTiles/deadWallCount 动态计算、番型依赖求交（requiresTiles/requiresSuits/requiresHonors）与 `resolvedFanConfig` 生成。
- 门禁（对应验收 1–4）：
  - 9 套预设 totalTiles/wallTiles/deadWallCount 与 PRD 表逐项一致，且 `wallTiles > deadWallCount + 1`。
  - 任一牌面 copies 改 3/5，总张数/牌墙同步变化，引擎不崩溃。
  - 番型依赖矩阵黄金用例（大三元/大四喜/字一色/十三幺/清一色/九莲宝灯 × gd100/gd108/gd128/gd136）与规格表一致。
  - gd128 启用大三元报错并指出"缺发白"；gd100 启用十三幺报错并指出"幺九字牌仅 11 种"。

### P3 行牌动作与状态机
- 交付：发牌（庄家 +1）、回合流转、碰/大明杠/补杠/暗杠、抢杠（仅补杠，十三幺可抢暗杠可配）、杠分即时结算与流局退回账本、杠后墙尾补牌、漏胡锁定（可配）、红中碰/明杠限制（wild 模式）、合法动作列表驱动接口、事件日志。
- 门禁（对应验收 18 前半）：抢杠只触发补杠；暗杠不可抢（十三幺例外可配）；杠分立即入账；优先级 胡 > 碰/杠。

### P4 胡牌判定与番型
- 交付：万能牌胡牌枚举（红中 wildcard，数量受 copies 限制）、4 组+对将分解、七对（sevenPairsWithWild）、十三幺、九莲宝灯、番型识别（5.5 全表 + 附加番 6 项 + exclusive 分组 + fallback 鸡胡）、计分模式 `max`/`additive`、点炮/自摸/抢杠胡入参、按启用牌面动态生成编码。
- 门禁（对应验收 6–7 前半、P4 gate）：每种番型至少一组正例/反例；改 `fans` 配置值不改代码分数变化；`max` 与 `additive` 结果可预期。

### P4b 无红中加成 + 多维最大番数
- 交付：redCenterBonus 四模式（none/addFan/fanDouble/scoreDouble）与 bypassCap 双运算顺序（6.4 固定顺序，单测锁定）；cap 四种 value.type（fixed/tiered/formula/unlimited）；scope global/group/player；bypass fanIds 与 4 种 conditions；minFan 保底；maxScore 截断；受限表达式引擎（白名单变量/函数、禁赋值循环 IO、节点数上限、10ms 超时、越界 clamp）；6.5.6 校验规则 8–12 与冲突告警（fanDouble×封顶）。
- 门禁（对应验收 5、8–17）：四种加成模式符合预期；`fanDouble`+cap3+bypassCap:false 断言无实际加成并告警；红中暗杠计为"有红中"、弃牌区与别家副露不影响判定；四种 value.type 分别生效；非法表达式启动报错；group/player 作用域；bypass 命中跳过封顶但 hardCap 仍生效；minFan 保底（鸡胡 ≥ baseScore×2^minFan）；maxScore 无 NaN/Infinity；同一手牌 fixed=3 与 formula 分数不同且元数据正确。

### P5 对局完整流与回放
- 交付：包三家四条件（①补杠被抢杠 ②放杠→杠上开花 ③十二张落地后点炮/单吊自摸 ④大三元/大四喜最后一组同一人打出，①②③默认开、④可配）；一炮多响（可配）；流局（含杠分退回、庄家连庄）；庄位轮转；结算明细输出（7.4）；回放记录（6.5.7 元数据 + resolvedFanConfig 快照）与重放器（重算一致）；seeded RNG。
- 门禁（对应验收 18–20）：被抢杠者包三家；流局退回杠分；连庄正确；回放含 tileSetPresetId 与 resolvedFanConfigHash，改预设后旧回放重算不漂移。

### P7 AI 三档（先于 UI，供 server 托管与 h5-demo 复用）
- 交付：向听数（含万能牌贪心替换）、有效进张、危险度；easy/normal/hard 三档（新手偏进攻、高手加防守与舍牌记忆）；只走合法动作接口；单步限时。
- 门禁（对应 P7 gate）：动作 100% 合法（harness 校验）；1000 局混合配置 soak 无崩溃；三档决策差异指标（进攻度/点炮率/平均向听）单调。

### P6 牌桌 UI
- 交付：
  - `apps/h5-demo`：DOM 牌桌（手牌/副露/弃牌河/牌墙余量/风位/座位）、合法动作按钮（动作列表驱动，非法不可点）、结算明细面板、规则面板、联机（WebSocket）+ 本地 PVE 双模式、自动化锚点（data-testid）。
  - `apps/client-cocos`：Cocos Creator 4.x 组件源码（GameManager/NetworkClient/HandView/MeldView/DiscardRiver/WallCounter/ActionPanel/SettlePanel/RulePanel/SoundManager/wx 适配层），资源结构与接线说明。
- 门禁：h5-demo 实际可玩（浏览器 E2E 走通主流程）；cocos 源码过 TS 语法检查 + 接线文档完整；主包预算与分包策略写入文档（真实构建需编辑器，见发布清单）。

### P9 联机服务端
- 交付：HTTP `/health` + WebSocket（ws）；房间创建/加入/准备/开始（AI 填充）；服务端权威裁决（客户端只发意图，非法动作拒绝并记录日志——验收 22）；动作超时 AI 托管；断线重连返回完整对局；对局事件日志与回放元数据落盘；多局连庄与累计分数。
- 门禁：双客户端同步对局全绿；非法动作被拒且留痕；断线重连状态一致。

### P8 微信 + H5 适配（源码级）
- 交付：`wx.createInnerAudioContext` 音频封装（首次触摸解锁、切后台暂停/回前台恢复）、安全区适配、平台判定；主包/分包资源清单与构建参数文档。
- 门禁：源码级检查 + 文档；真机构建列入发布清单人工步骤（无编辑器环境无法自动化）。

### P10 端到端与发布验收
- 交付：
  - E2E：浏览器（自动化）打开 h5-demo → 建房 → AI 填充 → 自动托管完整对局 → 结算明细逐项可见 → 截图；双标签页联机同步验证。
  - 全量测试：单测 + 集成 + soak + 覆盖率报告（core 目标 >90%）。
  - `tools/acceptance-report`：自动生成验收清单 1–22 → 测试用例映射与通过状态。
  - `RELEASE_CHECKLIST.md`：已自动化验证项 vs 需人工项（Cocos 编辑器构建、微信真机、审核材料）。
- 门禁：全部测试绿 + 验收报告无未决失败项 + 发布清单明确。

## 2. 关键设计决策（与 PRD 对齐的实现口径）

| 决策点 | 口径 |
|---|---|
| 牌 ID | `C1..C9`(万) `B1..B9`(条) `D1..D9`(筒) `WE/WS/WW/WN`(风) `HR/HG/HW`(中发白) `F1..F8`(花，v0.2) |
| 万能牌 | `redCenterMode="wild"` 时 HR 为万能牌；不可碰/明杠/补杠，可暗杠；数量上限 = copies |
| 杠与手牌 | 杠占 1 副露槽（3 张位），第 4 张随杠入副露不参与分解；胡牌分解牌数 = 3×(4−副露数)+2 |
| 计分最优分解 | 枚举所有合法分解，取最终得分最高者（封顶前比较番数，封顶内取高番） |
| 十三幺依赖 | 要求 13 张标准幺九字牌全部存在于 tileSet；缺失列名并报可用种数 |
| formula 变量 | `base`(当前番) `kongCount`(全场杠数) `wallTiles`(胡牌时牌墙余量) `playerCount` `minFan` `hardCap` |
| tiered 选择器 | `roomLevel`（房间等级 1..tiers.length，越界 clamp） |
| scope=player | `cap.playerOffsets.{dealer,nonDealer}` 对 capFan 做整数偏移 |
| 十二张落地 | 玩家副露达 4 组后：其点炮→自己包三家；其单吊自摸→供第 4 组者包三家 |
| 庄位轮转 | 流局庄家连庄；庄家胡连庄；闲家胡→胡牌者下家坐庄 |
| AI 向听 | 万能牌逐张贪心指派近似，仅用于 AI 决策，不参与判定/计分正确性 |
| 回放 | 事件流 + seed + resolvedFanConfig 全量快照；重放=重跑事件流比对结算 |
| 表达式引擎 | 自研递归下降解析：白名单变量/函数、四则运算与括号、禁赋值/成员访问/未知标识；节点数与 10ms 超时双保险 |

## 3. 里程碑顺序与并行

P1 → P2 → P3 → P4 → P4b → P5 →（P7 与 P9 可并行）→ P6 → P8 → P10。
`client-cocos` 源码在 P5 接口冻结后与 P9 并行产出。
