# apps/client-cocos —— 《雀界·广东麻将》Cocos Creator 4.x 客户端源码

> 本目录交付**完整可读源码 + 接线说明**（本机无 Cocos Creator 编辑器，不做构建）。
> 所有脚本可直接放入 Cocos Creator 4.x 工程的 `assets/scripts/` 下使用，API 为
> Cocos Creator 3.x/4.x 标准 API（`import { _decorator, Component, ... } from 'cc'`）。
> 未创建 `.meta` 文件（由编辑器自动生成）、未创建 `package.json`（见下文依赖导入方案）。

---

## 1. 目录结构

```
apps/client-cocos/
└─ assets/scripts/
   ├─ GameManager.ts        全局入口：连接/场景切换/房间状态机/本地 PVE，事件集中转发
   ├─ NetClient.ts          WebSocket 封装：心跳 ping/pong、指数退避重连（reconnect+token）、消息分发
   ├─ TableScene.ts         牌桌主场景控制器：座位布局/手牌/副露/弃牌河/牌墙/风位/动作面板/结算/规则
   ├─ HandView.ts           自己手牌渲染与触摸（选中 → 再点打出；摸牌尾距加宽）
   ├─ TileView.ts           单张牌（Label 牌名兜底 + Sprite 换图接口；node.name 携带 tileId）
   ├─ ActionPanel.ts        动作按钮面板（胡/碰/明杠/补杠/暗杠/过 动态生成，动作列表驱动）
   ├─ SettlePanel.ts        结算明细（番型逐项/封顶过程 lines/包三家原因/最终番数与分数，PRD 7.4）
   ├─ RulePanel.ts          规则展示（牌张配置/番型表/封顶/红中规则）
   ├─ WallCounter.ts        牌墙进度条（wallRemaining/deadWall，Graphics 绘制免图片）
   ├─ SoundManager.ts       音频封装（微信 InnerAudioContext / H5 Audio，首次触摸解锁，前后台切换）
   ├─ SafeArea.ts           Widget 安全区适配（微信刘海屏）
   ├─ LocalPveDriver.ts     本地 PVE 驱动：1 人类 + 3 AI（aiDecide hard），回合驱动与延时
   ├─ platform/
   │  ├─ IPlatform.ts       平台适配统一接口 + getPlatform()/getPlatformAdapter()
   │  ├─ WxAdapter.ts       微信小游戏实现（音频/安全区/剪贴板/震动/前后台）
   │  └─ BrowserAdapter.ts  浏览器 H5 实现（Audio/navigator/visibilitychange）
   └─ ui/
      └─ Tips.ts            轻提示（Graphics 底 + Label，自动淡出）
```

依赖方向（与 monorepo 一致）：`@quejie/fan-config` ← `@quejie/mahjong-core` ← 本客户端。
`@quejie/protocol` 仅以 **type-only** 引入（编译期擦除，不占运行时体积）。

---

## 2. 从零到可运行：完整步骤清单

### 步骤 0：准备 monorepo 产物

```bash
# 在 monorepo 根目录
npm install
npm run build        # 产出 packages/*/dist（ESM + d.ts）
npm test             # 确认引擎测试全绿（可选）
```

得到三个可被客户端引用的包：
- `packages/fan-config/dist`（规则解析；PVE 与规则面板需要）
- `packages/mahjong-core/dist`（引擎 + AI；PVE 与牌名文案需要）
- `packages/protocol/dist`（消息类型；**仅类型**，运行时会被摇树掉）

> 注意：`@quejie/mahjong-core` 运行时依赖 `@quejie/fan-config`，
> 因此两者必须同时可用（npm 依赖方式自动处理；复制方式两个都要拷）。

### 步骤 1：新建 Cocos Creator 4.x 工程

1. 打开 Cocos Dashboard → **新建项目** → 模板选 **Empty(2D)**，引擎 4.x。
2. 项目路径任意（建议与 monorepo 平级，避免被 npm workspaces 误收录）。
3. 打开项目后：**项目 → 项目设置 → 项目数据** 设置设计分辨率 **1280×720**、
   适配方案勾选 **Fit Height（适配高度）**（横屏麻将）。
4. **项目 → 项目设置 → 功能裁剪**：保持 2D 渲染 + GUI 全量（默认即可）。

### 步骤 2：导入 @quejie/* 依赖（两种方案二选一）

#### 方案 A（推荐）：npm 依赖 + node_modules

在 Cocos 工程**根目录**的 `package.json`（新建工程自带）中加入：

```json
{
  "dependencies": {
    "@quejie/fan-config": "file:/绝对路径/quejie-mahjong/packages/fan-config",
    "@quejie/mahjong-core": "file:/绝对路径/quejie-mahjong/packages/mahjong-core"
  }
}
```

然后 `npm install`（或在 dashboard 打开时自动安装）。
Cocos Creator 3.6+/4.x 会把 `node_modules` 中被脚本引用的纯 JS ESM 包一起打包，
`import { MahjongGame } from '@quejie/mahjong-core'` 直接可用。

- 优点：版本随 monorepo 演进（改用 `file:` 协议或发布私有 npm registry 皆可）。
- 注意：`file:` 协议安装的是符号链接；若 Creator 打包异常，改用 `npm pack` 出 tgz 再 `"@quejie/mahjong-core": "file:../deps/quejie-mahjong-core-0.1.0.tgz"`。

#### 方案 B：dist 产物复制 + tsconfig paths 映射

1. 复制产物到工程 `assets/libs/`：
   ```
   assets/libs/quejie/fan-config/    ← packages/fan-config/dist/* 全部内容
   assets/libs/quejie/mahjong-core/  ← packages/mahjong-core/dist/* 全部内容
   ```
2. 在工程根 `tsconfig.json` 的 `compilerOptions.paths` 增加映射
   （Cocos Creator 的 tsconfig 会被脚本编译管线继承）：
   ```json
   {
     "compilerOptions": {
       "baseUrl": ".",
       "paths": {
         "@quejie/fan-config": ["assets/libs/quejie/fan-config/index.d.ts"],
         "@quejie/mahjong-core": ["assets/libs/quejie/mahjong-core/index.d.ts"]
       }
     }
   }
   ```
3. 让**运行时** import 落到真实 JS：Cocos 的模块解析按 d.ts 同目录 js 走相对导入时，
   需要把 d.ts 内的相对引用保持一致（dist 内部 `./xxx.js` 互相引用已是 ESM，可被 Creator 解析）。
   若个别版本编辑器对 `.js` 后缀解析异常，退化为**改导入语句**：全局把
   `from '@quejie/mahjong-core'` 替换为相对路径 `from '../../../libs/quejie/mahjong-core/index'`
   （本交付脚本集中在 `assets/scripts/`，仅 5 个文件有值导入，替换成本低：见 §10 依赖清单）。

**两种方案取舍**：方案 A 零改动、升级方便，优先；方案 B 完全可控、便于离线交付与审计。

### 步骤 3：拷贝脚本

把本目录 `assets/scripts/` 整体拷入 Cocos 工程 `assets/scripts/`。
编辑器会自动为每个文件生成 `.meta`（**不要手工创建/复制 .meta**）。

### 步骤 4：创建场景与节点树

场景两个：**Lobby**（大厅，微信构建的首屏场景）与 **Table**（牌桌）。
`GameManager` / `SoundManager` 跨场景持久（脚本自动 `addPersistRootNode`）。

#### Lobby 场景节点树

```
Lobby (Scene)
├─ Canvas (Canvas + UITransform, 1280×720)
│  ├─ Camera
│  ├─ GameManager          ← 挂 GameManager 组件（空节点即可）
│  ├─ SafeAreaTop          ← 挂 SafeArea 组件（alignTop=true）
│  ├─ Title (Label)        文案「雀界·广东麻将」
│  ├─ EditRoomCode (EditBox)          房间码输入
│  ├─ BtnCreate (Button)   文案「创建房间」
│  ├─ BtnJoin (Button)     文案「加入房间」
│  ├─ BtnLocal (Button)    文案「本地单机」
│  └─ LabelServer (Label)  可选：显示服务器地址
```

**按钮绑定**（Button 组件 → ClickEvents → 目标节点 `GameManager` → 依次选方法）：
- BtnCreate → `GameManager.uiCreateRoom`
- BtnJoin → `GameManager.uiJoinRoom`（读取 EditRoomCode 的 string）
- BtnLocal → `GameManager.uiLocalPve`
- （房间内可再加）准备按钮 → `GameManager.uiReady`；开局按钮 → `GameManager.uiStartWithAi`；
  复制房间码 → `GameManager.uiCopyRoomCode`

把 `EditRoomCode`（EditBox）拖到 GameManager 组件的 **roomCodeInput** 属性上。

#### Table 场景节点树

```
Table (Scene)
├─ Canvas (Canvas + UITransform, 1280×720)
│  ├─ Camera
│  ├─ TableScene           ← 挂 TableScene 组件
│  ├─ Background           纯色/图片背景
│  ├─ SafeAreaTop          ← 挂 SafeArea
│  ├─ Status (Label)       状态条（房间号/轮次/倒计时）
│  ├─ WallCounter          ← 挂 WallCounter 组件
│  ├─ Seats
│  │  ├─ SeatBottom        相对座位 0（自己）
│  │  │  ├─ Name (Label) / Wind (Label) / Extra (Label) / HandCount (Label)
│  │  │  ├─ Hand (Node)        他人手牌背面容器（自己留空）
│  │  │  ├─ Melds (Node)       副露容器
│  │  │  └─ Discards (Node)    弃牌河容器
│  │  ├─ SeatRight         相对座位 1（下家）—— 子节点同上
│  │  ├─ SeatTop           相对座位 2（对家）—— 子节点同上
│  │  └─ SeatLeft          相对座位 3（上家）—— 子节点同上
│  ├─ HandArea             ← 挂 HandView 组件（自己手牌，屏幕底部居中）
│  ├─ ActionPanel          ← 挂 ActionPanel 组件（合法动作按钮）
│  ├─ BtnDiscard (Button)  「出牌」按钮
│  ├─ BtnRule (Button)     「规则」按钮
│  ├─ SettlePanel          ← 挂 SettlePanel 组件（结算面板，默认隐藏）
│  └─ RulePanel            ← 挂 RulePanel 组件（规则面板，默认隐藏）
```

> 兜底说明：TableScene `onLoad` 时若 HandView / ActionPanel / SettlePanel / RulePanel /
> WallCounter / Status / BtnDiscard / BtnRule 属性未绑定，会**程序化创建并挂好**，
> 因此最小接线（只挂 TableScene 组件 + 建好 Seats 四个座位节点）即可运行；
> 精细布局请在编辑器中绑定并摆位。

**TableScene 属性绑定清单**：

| 属性 | 绑定到 | 说明 |
|---|---|---|
| handView | HandArea 节点 | 必绑（否则自动创建在 (0,-280)） |
| actionPanel | ActionPanel 节点 | 必绑 |
| settlePanel / rulePanel | 对应面板节点 | 必绑 |
| wallCounter | WallCounter 节点 | 必绑 |
| seatNodes | SeatBottom/Right/Top/Left（按此顺序） | 相对座位 0/1/2/3 |
| tileFaces | 牌面图集 SpriteFrame 数组 | 可空 → Label 牌名兜底 |
| btnDiscard / btnRule | 对应按钮 | 未绑定时程序化创建兜底按钮 |
| statusLabel | Status | 必绑 |

### 步骤 5：设置首屏场景

**项目 → 项目设置 → 通用 → 场景启动项 / 构建发布**：预览场景选 Lobby；
构建面板的「首屏场景」选 **Lobby**（见 §6 微信构建参数）。

### 步骤 6：运行验证

- 预览（浏览器）直接点「本地单机」→ 应进入 Table 场景，4 家发牌、AI 自动行动、
  自己回合可点牌两下打出，胡牌后弹结算明细。
- 联机：先启动服务端 `npm run server`（monorepo 根，默认 `ws://127.0.0.1:8080`），
  再在 Lobby「创建房间」→「AI 填充开局」。

---

## 3. 图集与分包配置（主包 ≤3.5MB 预算）

### 主包预算（微信小游戏硬性要求：主包 ≤4MB，本项目内控 3.5MB）

主包只允许包含：脚本、Lobby 场景、Table 场景、通用 UI 图集（按钮底框/背景）、
`@quejie/*` 代码。**以下内容必须进 Asset Bundle 分包**：

| Bundle 名 | 内容 | 说明 |
|---|---|---|
| `tilefaces` | 牌面图集（34+ 张 SpriteFrame，name=C1..C9/B1..B9/D1..D9/WE/WS/WW/WN/HR/HG/HW） | 体积大头，进分包 |
| `rules` | 规则面板用字体/图片（规则长文本大字号字库） | 字体不进主包 |
| `audio` | 音效 mp3（见 §7 占位音源名） | 进分包 |

### Asset Bundle 设置步骤

1. 在 `assets/` 下建目录 `bundles/tilefaces`、`bundles/rules`、`bundles/audio`
   （目录名即 Bundle 名，可自定义，但要与代码一致——见 §7 音频）。
2. 选中目录 → 属性检查器 → 勾选 **Is Bundle**，Bundle 名称保持与目录同名。
3. 微信构建时，Creator 会把这些 Bundle 输出为**微信独立分包**（subpackage root = bundle 名），
   自动写入 `game.json` 的 `subpackages`，无需手改。
4. TableScene 的 `tileFaces` 数组绑定：若图集在分包中，先加载 Bundle 再赋值：
   ```ts
   import { assetManager, SpriteFrame } from 'cc';
   assetManager.loadBundle('tilefaces', (err, bundle) => {
     bundle?.preloadDir('tilefaces', () => {
       // bundle.get('tile_id', SpriteFrame) 后调用 setTileFaceResolver 注入（见 TileView.ts）
     });
   });
   ```
   未加载图集时全部牌面自动回退为文字牌名，不阻塞游戏。

### 主包体积自检

微信构建完成后检查 `build/wechatgame/`：

```bash
du -sh build/wechatgame --exclude=subpackages --exclude=remote 2>/dev/null || \
du -sh build/wechatgame/{game.js,game.json,project.config.json,src,assets}
```

超过 3.5MB 时的处置顺序：① 牌面/字体/音效确认已挪分包；② 压缩纹理
（构建面板纹理压缩 png → astc/etc2）；③ 脚本混淆压缩（默认 release 已压缩）。

---

## 4. 微信构建参数（构建发布 → wechatgame）

| 参数 | 取值 | 说明 |
|---|---|---|
| 游戏名称 | 雀界·广东麻将 | |
| AppID | （在微信公众平台注册的小游戏 appid） | 体验版可先用测试号 `wx1111111111111111` 占位再替换 |
| 首屏场景 | **Lobby** | 主包入口 |
| 设备方向 | **Landscape Home Right**（横屏） | |
| 渲染后端 | WebGL | |
| 远程服务器地址 | （CDN 域名，须在微信后台配 downloadFile 合法域名） | 不用远程资源时留空，全部走分包 |
| 分包 | tilefaces / rules / audio（来自 Asset Bundle，自动生成） | 构建后核对 `game.json.subpackages` |
| 主包预算 | ≤3.5MB（内控） | 见 §3 自检命令 |
| 校验 & 预览 | 勾选「MD5 Cache」 | 真机缓存友好 |

真机步骤（列入发布清单人工项）：微信开发者工具打开 `build/wechatgame/project.config.json`
→ 预览 → 真机调试。重点回归：**刘海屏安全区**（SafeArea 组件）、**音频解锁**
（首次点击后才有声）、**切后台暂停/回前台恢复**、**断线重连**（杀进程重进自动 reconnect）。

---

## 5. 消息流程与事件转发（架构约定）

```
wx/WebSocket ──▶ NetClient（心跳/重连/JSON 解析）
                    │  on(type, handler)
                    ▼
               GameManager（唯一总控；跨场景持久）
                    │ routeGameState / routeGameEvent / showGameOver
                    ├──▶ TableScene.applyGameState()   全量快照渲染
                    ├──▶ TableScene.applyGameEvent()   音效与提示
                    └──▶ TableScene.showGameOver()     结算面板

TableScene 触摸/按钮 ──▶ GameManager.sendAction()
                    ├── 联机：net.send({type:'action', action})（服务端权威裁决，非法动作被拒）
                    └── PVE：LocalPveDriver.submitHuman()（本地引擎同口径校验）
```

- **动作列表驱动**：界面只渲染服务端/引擎下发的 `legalOptions`，
  非法动作（不可碰/漏胡锁/非本回合）绝不出现按钮或可点牌面。
- **PVE 与联机同构**：LocalPveDriver 把 `MahjongGame` 状态转成与
  `GameStateMsg`/`GameEventMsg`/`GameOverMsg` 相同结构的快照，TableScene 无感差异。
- **断线重连**：welcome 的 token + roomState 的 roomCode 存入 NetClient；
  掉线自动指数退避重连，open 后发送 `{type:'reconnect', roomCode, token}`，
  服务端返回完整对局快照恢复现场。

---

## 6. TypeScript 约束与依赖清单

- 全部文件 **strict 模式可编译**（含 `noUnusedLocals/noUnusedParameters`，
  本机已用 `tsc --noEmit` + cc 类型桩 + 真实 `@quejie/*` dist 类型走查通过）。
- **不 import 任何 Node 专有模块**（无 fs/net/process；定时器用 setTimeout/setInterval，
  web 与微信小游戏环境均可用）。
- 值导入清单（仅 5 个文件有运行时依赖，改相对路径时照此替换）：
  | 文件 | 语句 |
  |---|---|
  | TileView.ts | `import { tileLabel } from '@quejie/mahjong-core'` |
  | HandView.ts | `import { TILE_ORDER } from '@quejie/mahjong-core'` |
  | TableScene.ts | `import { SEAT_WIND_NAMES, tileLabel } from '@quejie/mahjong-core'` |
  | ActionPanel.ts | `import { tileLabel } from '@quejie/mahjong-core'` |
  | LocalPveDriver.ts | `@quejie/mahjong-core`（MahjongGame/aiDecide/类型）+ `@quejie/fan-config`（resolve 全套） |
  | RulePanel.ts / GameManager.ts | 仅 `import type`（零运行时依赖） |
- `@quejie/protocol` 全程 type-only，主包体积零负担。
- LocalPveDriver 顶部为微信小游戏注入 `performance` 兜底
  （`aiDecide` 内部使用 `performance.now()`）。

---

## 7. 音频资源（占位音源名）

SoundManager 通过平台适配器按**相对包根路径**播放（`wx.createInnerAudioContext` / `new Audio`）：

| 音效名 | 路径（assets/bundles/audio/ 下放置同名 mp3） |
|---|---|
| deal | `audio/sfx_deal.mp3` |
| discard | `audio/sfx_discard.mp3` |
| peng | `audio/sfx_peng.mp3` |
| gang | `audio/sfx_gang.mp3` |
| hu | `audio/sfx_hu.mp3` |
| settle | `audio/sfx_settle.mp3` |
| click | `audio/sfx_click.mp3` |

文件缺失时静默忽略（不报错、不阻塞）。首局开始前由首次触摸调用 `unlockAudio()`（H5 解锁自动播放）。
微信 `wx.onShow/onHide` + `document.visibilitychange` 双通道：切后台全部暂停，回前台恢复。
碰/杠/胡同时触发平台震动（`wx.vibrateShort` / `navigator.vibrate`）。

---

## 8. 牌面图接入（可选）

`TileView` 无图时以 Label 牌名渲染（万条筒/风箭中文文案来自 `tileLabel`，红中红字、绿发绿字）。
接入图集：SpriteFrame 的 **name 必须等于 tileId**（`C1..C9` `B1..B9` `D1..D9`
`WE/WS/WW/WN` `HR/HG/HW`），拖入 TableScene 的 `tileFaces` 数组即可；
或运行时调用 `setTileFaceResolver((tileId) => frameOrNull)`（分包异步加载场景）。

---

## 9. 验收自检清单（接线完成后逐项勾选）

- [ ] `npm run build`（monorepo）成功，`packages/*/dist` 存在
- [ ] Cocos 工程打开无红字（控制台无脚本编译错误；@quejie 解析成功）
- [ ] Lobby 场景为首屏；GameManager/SoundManager 节点存在；按钮已绑 ClickEvents
- [ ] 点「本地单机」→ 进入 Table：四家手牌（自己明牌 + 三家背面）、风位标记、庄家标记
- [ ] 牌墙进度条随摸牌递减；死墙到达自动流局结算（杠分退回文案可见）
- [ ] 自己回合：点牌选中（放大）→ 再点打出；「出牌」按钮同效；非自己回合点牌被拒（Tips）
- [ ] 碰/杠/胡按钮只在合法时出现（动作列表驱动）；点「过」关闭窗口
- [ ] 碰/杠后有 AI 延时响应；漏胡时出现「漏胡锁定」提示
- [ ] 胡牌 → 结算面板：番型逐项、附加番、封顶 lines、包三家原因、最终番数、四家分差齐全（PRD 7.4）
- [ ] 规则按钮 → 牌张配置/番型表/封顶/红中规则可见（PVE 来自本地 resolved 配置）
- [ ] 联机：`npm run server` 后创建房间 → AI 填充 → 双端动作同步；非法动作被服务端拒绝并有提示
- [ ] 断线重连：对局中杀掉浏览器标签 → 重开 → 自动重连恢复完整对局
- [ ] H5 首次触摸后音效出声；切后台音效暂停、回前台恢复
- [ ] 微信真机：刘海屏安全区（SafeArea）不遮挡状态条与按钮
- [ ] 微信构建后主包 ≤3.5MB；`game.json.subpackages` 含 tilefaces/rules/audio

## 10. 已知限制与占位说明

- 牌面图、音效、字体均为**占位**：文字牌名 + 静默音源可跑通全流程，美术资源就位后按 §7/§8 替换。
- 「继续（连庄下一局）」按钮仅本地 PVE 模式显示；联机多局由服务端连庄流转。
- PVE 宣告窗口 10s 自动过（`humanClaimAutoPassMs` 可调），联机超时由服务端托管。
- 一炮多响、抢杠暗杠十三幺等规则开关由房间预设决定，客户端只渲染 `legalOptions`，无本地硬编码。
- AI 出牌节奏（600ms）与宣告响应（400ms）在 LocalPveDriver 属性上可调。
