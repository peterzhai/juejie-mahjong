# 启动雀界 Cocos 2D

在仓库根目录安装共享依赖并构建规则引擎。

```sh
npm ci
npm run build
npm run typecheck --workspace=@quejie/client-cocos
```

1. 在 Cocos Creator 3.8.8 中打开 `apps/client-cocos`，双击 `assets/scenes/Main.scene` 后预览。场景已绑定 `ClientBootstrap`，大厅、房间和牌桌由它创建。
2. 点「开始练习」可直接试玩。联机时从仓库根目录运行 `npm run server`，在「玩法设置 → 操作与联机」填写 WebSocket 地址，再创建或加入房间。浏览器预览默认使用当前主机的 8080 端口。
3. 选择 Web Mobile 构建时，将 `Main` 设为启动场景。Web Mobile 会随窗口方向自动切换横竖布局。构建微信小游戏时，使用自己的 AppID，并按目标设备配置构建方向。真机联机需要已配置的 WSS 服务域名。

「玩法设置」分为开局规则、操作与联机、高级规则。可以设置人数、牌组、封顶、红中模式、是否允许点炮、AI 节奏、单击出牌和自动托管。番型可单独调整，完整规则 JSON 优先于快捷选项。牌局中的「战绩」显示每局分差和累计分，「对局日志」可回看本场操作。

牌面图片由 Cangjie6 的 [Mahjong eg HK.jpg](https://commons.wikimedia.org/wiki/File:Mahjong_eg_HK.jpg) 缩放并转换为 PNG，采用 [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)。

大厅照片由 Astra Virtually 的 [Mahjong tiles on green felt table](https://unsplash.com/photos/mahjong-tiles-on-green-felt-table-fDXUYOLulNQ) 缩放并转换为 JPEG，采用 [Unsplash License](https://unsplash.com/license)。

编辑器下载入口及微信构建参数见 [Cocos Creator 下载](https://www.cocos.com/en/creator-download) 和 [发布到微信小游戏](https://docs.cocos.com/creator/3.8/manual/zh/editor/publish/publish-wechatgame.html)。
