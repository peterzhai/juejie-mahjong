# 上线发布清单（RELEASE CHECKLIST）

> 状态标记：✅ 已自动化验证｜🔶 需人工/编辑器步骤｜📄 文档

## 1. 已自动化验证（本仓库内）

- ✅ 规则引擎：胡牌判定（含万能牌/七对/十三幺/九莲宝灯）随机胡牌形检测率 100%（3353 局生成样本）
- ✅ 牌张配置：9 套预设黄金值、copies 动态变化、墙约束 fail-fast
- ✅ 番型依赖矩阵：PRD 5.4 黄金用例逐项一致；缺失报错文案（缺发白 / 仅 11 种）
- ✅ 计分：max/additive、附加番 6 项、exclusive 分组、fallback 鸡胡
- ✅ 无红中加成四模式 + bypassCap 双运算顺序（顺序锁定测试）
- ✅ 多维封顶：4 种 value.type、3 种作用域、bypass、minFan、maxScore、表达式白名单/超时
- ✅ 对局流：碰/三种杠/抢杠/漏胡锁/流局退杠分/连庄/一炮多响（代码路径）+ 包三家四条件
- ✅ 回放：多配置 60 局重放全等；改配置不漂移；元数据完整（6.5.7 全字段）
- ✅ AI：合法性 harness（每动作过引擎校验）、1000 局 soak 无崩溃、三档决策差异显著、hard 点炮率更低
- ✅ 服务端：建房/加入/准备/AI 填充/托管/断线重连/非法动作拒绝并留痕/双端同步
- ✅ H5 端到端：浏览器实测本地 PVE 与联机全流程（含结算逐项明细）
- ✅ 构建链：`npm run build`（tsc project references）+ `npm test` 全绿

## 2. 需人工/编辑器步骤（无法在本环境自动化）

| 步骤 | 说明 |
|---|---|
| 🔶 Cocos Creator 工程构建 | 在 Cocos Creator 4.x 中按 `apps/client-cocos/README.md` 接线后构建 wechatgame + web-mobile 双端 |
| 🔶 真机预览 | 微信开发者工具真机预览（iOS/Android 各一台）+ 主流 H5 浏览器回归 |
| 🔶 包体核算 | Cocos 构建产物主包 ≤4MB 核对（图集压缩：ETC2/ASTC + 音频降码率；预算表见 README） |
| 🔶 分包加载验证 | Asset Bundle（规则面板/音效/字体）按需加载真机验证 |
| 🔶 音频验收 | 微信真机 `wx.createInnerAudioContext` 首触解锁、切后台暂停/回前台恢复、无叠音 |
| 🔶 微信审核材料 | 类目/版号合规材料、隐私协议、防沉迷指引（游戏类目要求） |
| 🔶 服务端部署 | `apps/server` 部署（Node 20+，`PORT`/`TURN_TIMEOUT_MS` 环境变量），域名 + TLS（微信要求 wss） |

## 3. 已知边界（诚实披露）

- `apps/client-cocos` 为完整可读源码 + 接线文档，**未经编辑器构建验证**（本机无 Cocos Creator）；首次接线可能需要按 README 排查场景节点绑定。
- AI 向听数为万能牌贪心近似，仅供决策，不影响判定/计分正确性。
- 一炮多响默认关闭（`rules.multiWinEnabled`），开启后庄家连庄逻辑已实现并测试。
- gd112/gd116/gd124 预设按 PRD 表格总张数黄金值实现（PRD 组成描述与张数列存在内部不一致，已在 presets.ts 注释记录）。

## 4. 发布顺序建议

1. 合并主干 → `npm run build && npm test` 全绿
2. Cocos 构建双端包 → 包体核算 → 真机回归（第 2 节清单）
3. 服务端部署 + 冒烟（/health、建房、托管完整局）
4. 微信提审材料准备 → 提审
