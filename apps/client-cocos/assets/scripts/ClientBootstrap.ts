import { defaultFanConfig, resolveFanConfig, type FanConfig } from '@quejie/fan-config';
import { _decorator, Component, Node, UITransform, Label, Graphics, Color, Button, EditBox, sys } from 'cc';
import { GameManager } from './GameManager';
import { TableScene } from './TableScene';
const { ccclass } = _decorator;

/** Attach to the Canvas in the entry scene; builds all screens without Inspector wiring. */
@ccclass('ClientBootstrap')
export class ClientBootstrap extends Component {
  private page: Node | null = null;
  private preset = 'gd128';
  private playerCount = 4;
  private config: FanConfig | null = null;
  private difficulty: 'easy' | 'normal' | 'hard' = 'normal';
  protected start(): void {
    try {
      const saved = JSON.parse(sys.localStorage.getItem('quejie-settings') || '{}');
      if ([2, 3, 4].includes(saved.playerCount)) this.playerCount = saved.playerCount;
      if (saved.config && resolveFanConfig(saved.config).ok) this.config = saved.config;
      if (['gd128', 'gd136', 'gd100', 'gd108'].includes(saved.preset)) this.preset = saved.preset;
      if (['easy', 'normal', 'hard'].includes(saved.difficulty)) this.difficulty = saved.difficulty;
    } catch { /* Defaults remain usable when storage is unavailable. */ }
    const gm = GameManager.ensureInstance();
    gm.playerCount = this.playerCount; gm.customConfig = this.config;
    gm.navigate = (screen) => screen === 'Table' ? this.table() : this.lobby();
    this.lobby();
  }
  private screen(name: string): Node {
    if (this.page) { this.page.removeFromParent(); this.page.destroy(); }
    const page = new Node(name);
    this.node.addChild(page);
    page.addComponent(UITransform).setContentSize(1280, 720);
    const g = page.addComponent(Graphics);
    g.fillColor = new Color(17, 48, 37); g.rect(-640, -360, 1280, 720); g.fill();
    this.page = page;
    return page;
  }
  private label(parent: Node, text: string, x: number, y: number, size = 26): Node {
    const n = new Node(text); parent.addChild(n); n.setPosition(x, y);
    n.addComponent(UITransform).setContentSize(1100, size + 18);
    const label = n.addComponent(Label); label.string = text; label.fontSize = size;
    label.color = new Color(237, 218, 173); return n;
  }
  private button(parent: Node, text: string, x: number, y: number, action: () => void): void {
    const n = new Node(text); parent.addChild(n); n.setPosition(x, y);
    n.addComponent(UITransform).setContentSize(260, 56);
    const g = n.addComponent(Graphics); g.fillColor = new Color(50, 89, 66);
    g.roundRect(-130, -28, 260, 56, 12); g.fill();
    this.label(n, text, 0, 0, 22).getComponent(UITransform)!.setContentSize(250, 48);
    n.addComponent(Button); n.on(Button.EventType.CLICK, action);
  }
  private lobby(): void {
    const p = this.screen('Lobby');
    this.label(p, '雀界 · 广东麻将', 0, 190, 48);
    this.label(p, '四方入座，闲叙一局', 0, 120, 22);
    this.button(p, '单机对局', 0, 20, () => GameManager.ensureInstance().enterLocalPve(this.preset, this.difficulty));
    this.button(p, '创建联机房间', -300, -60, () => GameManager.ensureInstance().uiCreateRoom());
    this.button(p, '准备并填充 AI', 300, -60, () => { const gm = GameManager.ensureInstance(); gm.ready(); gm.startWithAi(); });
    this.button(p, '玩法设置', 0, -60, () => this.settings());
    this.label(p, '本地练习 · 一人对战三位 AI', 0, -230, 18);
  }
  private settings(): void {
    const p = this.screen('Settings');
    this.persistSettings();
    this.button(p, '完整规则配置', 0, -110, () => this.fullSettings());
    this.label(p, '玩法设置', 0, 230, 38);
    const presets = ['gd128', 'gd136', 'gd100', 'gd108'];
    this.button(p, `人数：${this.playerCount}`, 0, 170, () => { this.playerCount = this.playerCount === 4 ? 2 : this.playerCount + 1; this.settings(); });
    this.button(p, `牌张方案：${this.preset}`, 0, 100, () => {
      this.preset = presets[(presets.indexOf(this.preset) + 1) % presets.length]!; this.settings();
    });
    this.button(p, `AI 难度：${this.difficulty}`, 0, 10, () => {
      const levels = ['easy', 'normal', 'hard'] as const;
      this.difficulty = levels[(levels.indexOf(this.difficulty) + 1) % 3]!; this.settings();
    });
    this.label(p, '完整配置保存后优先于快捷牌张方案', 0, -155, 16);
    this.button(p, '保存并返回', 0, -190, () => {
      this.persistSettings();
      this.lobby();
    });
  }
  private fullSettings(): void {
    const p = this.screen('FullRules');
    this.label(p, '完整规则配置（JSON）', 0, 300, 30);
    const n = new Node('ConfigInput'); p.addChild(n);
    n.addComponent(UITransform).setContentSize(1080, 460);
    const text = this.label(n, '', 0, 0, 16).getComponent(Label)!;
    text.getComponent(UITransform)!.setContentSize(1060, 440);
    const edit = n.addComponent(EditBox); edit.textLabel = text;
    edit.inputMode = EditBox.InputMode.ANY;
    edit.string = JSON.stringify(this.config ?? defaultFanConfig(), null, 2);
    this.button(p, '校验并保存', 170, -290, () => {
      try {
        const config = JSON.parse(edit.string) as FanConfig;
        const result = resolveFanConfig(config);
        if (!result.ok) { this.label(p, result.errors.map(e => e.message).join('; ').slice(0, 90), 0, -220, 14); return; }
        this.config = config; this.persistSettings(); this.settings();
      } catch { this.label(p, '配置格式错误，请检查 JSON', 0, -220, 18); }
    });
    this.button(p, '返回', -170, -290, () => this.settings());
  }
  private persistSettings(): void {
    const gm = GameManager.ensureInstance(); gm.playerCount = this.playerCount; gm.customConfig = this.config; gm.pvePreset = this.preset;
    try { sys.localStorage.setItem('quejie-settings', JSON.stringify({ preset:this.preset, difficulty:this.difficulty, playerCount:this.playerCount, config:this.config })); } catch { /* Session settings remain active. */ }
  }
  private table(): void {
    const p = this.screen('Table');
    // Build before attaching TableScene so its onLoad can render queued snapshots.
    const table = new Node('TableRoot'); p.addChild(table);
    table.active = false;
    const controller = table.addComponent(TableScene);
    for (const [i, x, y] of [[0, -220, -140], [1, 190, 120], [2, -220, 240], [3, -590, 120]]) {
      const seat = new Node(`Seat${i}`); table.addChild(seat); seat.setPosition(x!, y!);
      for (const [name, offset] of [['Name', 45], ['Wind', 75], ['Extra', 15], ['HandCount', -20]] as const) {
        this.label(seat, '', 0, offset, 16).name = name;
      }
      for (const name of ['Melds', 'Discards', 'Hand']) { const n = new Node(name); seat.addChild(n); }
      controller.seatNodes.push(seat);
    }
    table.active = true;
    this.button(p, '返回大厅', -480, -320, () => GameManager.ensureInstance().leaveRoom());
    this.button(p, '继续下一局', 450, -320, () => {
      const gm = GameManager.ensureInstance(); if (gm.phase === 'settle') gm.pveContinueNextHand();
    });
  }
}
