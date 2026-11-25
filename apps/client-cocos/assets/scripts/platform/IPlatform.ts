/**
 * 平台适配统一接口：微信小游戏 / 浏览器 H5 的平台能力（平台判定、安全区、音频、剪贴板、震动）
 * 在此抽象，UI 与业务层永远只面向 IPlatform，不直接触碰 wx / window 全局对象。
 */

import { sys } from 'cc';
import { WxAdapter } from './WxAdapter';
import { BrowserAdapter } from './BrowserAdapter';

/** 平台类型：微信小游戏 or 浏览器（含 web-mobile 构建） */
export type PlatformKind = 'wechat' | 'browser';

/** 物理像素安全区描述（相对屏幕的上下左右留白 px） */
export interface SafeAreaPx {
  top: number;
  bottom: number;
  left: number;
  right: number;
  /** 物理屏幕宽高（px），用于设计分辨率换算 */
  screenWidth: number;
  screenHeight: number;
}

/** 跨平台音频句柄：一段可复用的音源 */
export interface IAudioHandle {
  /** 从头播放（若正在播放则先回到起点） */
  play(): void;
  stop(): void;
  pause(): void;
  resume(): void;
  setVolume(v: number): void;
  setLoop(loop: boolean): void;
  destroy(): void;
}

/** 平台适配器接口（每个平台一个实现，见 WxAdapter / BrowserAdapter） */
export interface IPlatform {
  /** 平台类型 */
  readonly kind: PlatformKind;

  /** 平台判定：等价于 kind，供静态上下文使用 */
  getPlatform(): PlatformKind;

  /** 物理像素安全区（微信刘海屏 / 浏览器窗口） */
  getSafeAreaPx(): SafeAreaPx;

  /** 微信胶囊相对游戏窗口的位置，数值为窗口宽高的比例。 */
  getMenuButtonRect?(): { left: number; top: number; bottom: number } | null;

  /** 某些设备旋转 180° 时窗口尺寸相同，仍需重算遮挡区域。 */
  watchScreenObstructions?(callback: () => void): () => void;

  /** 创建音源（src 为相对包根的音频路径，如 'audio/hu.mp3'） */
  createAudio(src: string): IAudioHandle | null;

  /** 首次触摸解锁音频（H5 自动播放限制；微信为兼容性兜底） */
  unlockAudio(): void;

  /** 短震动（碰/杠/胡时反馈；不支持的平台静默忽略） */
  vibrate(): void;

  /** 写剪贴板（分享房间码用） */
  setClipboardText(text: string): Promise<boolean>;

  /** 读剪贴板 */
  getClipboardText(): Promise<string>;

  /** 注册前后台切换回调（切后台暂停音效、回前台恢复） */
  registerLifecycle(onHide: () => void, onShow: () => void): void;
}

/**
 * 平台判定入口：
 * 1) 优先使用 Cocos sys.platform（编辑器/web-mobile/wechatgame 构建均准确）；
 * 2) 兜底探测 wx 全局对象（原生环境直跑）。
 */
export function getPlatform(): PlatformKind {
  if (sys.platform === sys.Platform.WECHAT_GAME) {
    return 'wechat';
  }
  // 兜底：存在 wx 且具备小游戏特征 API
  const w = globalThis as Record<string, unknown>;
  const wxLike = w['wx'] as Record<string, unknown> | undefined;
  if (wxLike && typeof wxLike['createInnerAudioContext'] === 'function') {
    return 'wechat';
  }
  return 'browser';
}

/** 适配器缓存单例（首次取用时按平台构造） */
let cachedAdapter: IPlatform | null = null;

/**
 * 获取当前平台适配器。
 * 说明：WxAdapter/BrowserAdapter 对本文件只做 type-only 引用（编译期擦除），
 * 因此这里直接 import 两个实现不会形成运行时循环依赖。
 */
export function getPlatformAdapter(): IPlatform {
  if (cachedAdapter !== null) return cachedAdapter;
  cachedAdapter = getPlatform() === 'wechat' ? new WxAdapter() : new BrowserAdapter();
  return cachedAdapter;
}
