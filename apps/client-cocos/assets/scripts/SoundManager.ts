/**
 * 音频管理器：平台适配播放（微信 wx.createInnerAudioContext / H5 Audio）、
 * 首次触摸解锁、切后台暂停/回前台恢复、出牌碰杠胡等音效接口。
 * 音源为占位文件名（见 README「音频资源」），文件缺失时静默不报错。
 */

import { _decorator, Component, director, game, Game, input, Input } from 'cc';
import { getPlatformAdapter, type IAudioHandle } from './platform/IPlatform';

const { ccclass, property } = _decorator;

/** 占位音源名 → 相对包根路径（无扩展名，适配器按平台补全或直接使用） */
const SOUND_SOURCES: Record<SoundName, string> = {
  deal: 'audio/sfx_deal.mp3',
  discard: 'audio/sfx_discard.mp3',
  peng: 'audio/sfx_peng.mp3',
  gang: 'audio/sfx_gang.mp3',
  hu: 'audio/sfx_hu.mp3',
  settle: 'audio/sfx_settle.mp3',
  click: 'audio/sfx_click.mp3',
};

export type SoundName = 'deal' | 'discard' | 'peng' | 'gang' | 'hu' | 'settle' | 'click';

@ccclass('SoundManager')
export class SoundManager extends Component {
  /** 全局单例（由 GameManager 在启动时确保存在） */
  public static instance: SoundManager | null = null;

  /** 总音量（0..1） */
  @property({ range: [0, 1], slide: true })
  public volume = 0.9;

  /** 已创建音源缓存（懒加载，首次播放时创建） */
  private handles = new Map<SoundName, IAudioHandle | null>();
  private muted = false;

  protected override onLoad(): void {
    // 单例：重复节点自毁
    if (SoundManager.instance && SoundManager.instance !== this) {
      this.node.destroy();
      return;
    }
    SoundManager.instance = this;
    // 仅当直接挂在场景根时自行持久化；作为 GameManager 子节点创建时随父节点持久化
    const parent = this.node.parent;
    if (parent && parent === director.getScene()) {
      director.addPersistRootNode(this.node);
    }

    // 首次触摸解锁（H5 自动播放限制）
    input.on(Input.EventType.TOUCH_START, this.onFirstTouch, this);

    // 切后台暂停 / 回前台恢复
    game.on(Game.EVENT_HIDE, this.onBackground, this);
    game.on(Game.EVENT_SHOW, this.onForeground, this);

    // 平台级生命周期（微信 onShow/onHide 与 visibilitychange 双保险）
    getPlatformAdapter().registerLifecycle(
      () => this.onBackground(),
      () => this.onForeground(),
    );
  }

  protected override onDestroy(): void {
    input.off(Input.EventType.TOUCH_START, this.onFirstTouch, this);
    game.off(Game.EVENT_HIDE, this.onBackground, this);
    game.off(Game.EVENT_SHOW, this.onForeground, this);
    if (SoundManager.instance === this) SoundManager.instance = null;
  }

  // —— 播放接口 ——

  /** 发牌/洗牌 */
  public playDeal(): void {
    this.play('deal');
  }

  /** 出牌 */
  public playDiscard(): void {
    this.play('discard');
  }

  /** 碰 */
  public playPeng(): void {
    this.play('peng');
    this.vibrate();
  }

  /** 杠（明杠/暗杠/补杠共用） */
  public playGang(): void {
    this.play('gang');
    this.vibrate();
  }

  /** 胡（含自摸/点炮/抢杠） */
  public playHu(): void {
    this.play('hu');
    this.vibrate();
  }

  /** 结算 */
  public playSettle(): void {
    this.play('settle');
  }

  /** 按钮 */
  public playClick(): void {
    this.play('click');
  }

  /** 静音开关 */
  public setMuted(muted: boolean): void {
    this.muted = muted;
  }

  public get isMuted(): boolean {
    return this.muted;
  }

  // —— 内部 ——

  /** 通用播放：懒创建音源 → 复用播放 */
  private play(name: SoundName): void {
    if (this.muted) return;
    const handle = this.ensureHandle(name);
    if (!handle) return;
    handle.setVolume(this.volume);
    handle.setLoop(false);
    handle.play();
  }

  /** 按名取缓存音源，未创建则经平台适配器创建 */
  private ensureHandle(name: SoundName): IAudioHandle | null {
    if (this.handles.has(name)) return this.handles.get(name) ?? null;
    const adapter = getPlatformAdapter();
    const handle = adapter.createAudio(SOUND_SOURCES[name]);
    this.handles.set(name, handle);
    return handle;
  }

  /** 碰/杠/胡附带短震动 */
  private vibrate(): void {
    if (this.muted) return;
    getPlatformAdapter().vibrate();
  }

  /** 首次触摸解锁音频 */
  private onFirstTouch(): void {
    getPlatformAdapter().unlockAudio();
  }

  /** 切后台：全部音源暂停 */
  private onBackground(): void {
    for (const handle of this.handles.values()) {
      handle?.pause();
    }
  }

  /** 回前台：恢复（音效句柄多为一次性播放，恢复循环类音源） */
  private onForeground(): void {
    for (const handle of this.handles.values()) {
      handle?.resume();
    }
  }
}
