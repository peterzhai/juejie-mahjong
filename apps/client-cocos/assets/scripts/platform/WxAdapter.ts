/**
 * 微信小游戏平台适配器：基于 wx 全局 API 实现音频（wx.createInnerAudioContext）、
 * 安全区（wx.getWindowInfo/getSystemInfoSync）、剪贴板、震动与前后台生命周期。
 */

import type { IAudioHandle, IPlatform, SafeAreaPx } from './IPlatform';

/** 最小化的 wx 全局类型声明（只声明本项目用到的 API） */
interface WxInnerAudioContext {
  src: string;
  autoplay: boolean;
  loop: boolean;
  volume: number;
  obeyMuteSwitch: boolean;
  play(): void;
  pause(): void;
  stop(): void;
  seek(position: number): void;
  destroy(): void;
  onError?(cb: (err: { errMsg: string }) => void): void;
  onEnded?(cb: () => void): void;
}

interface WxWindowInfo {
  pixelRatio: number;
  screenWidth: number;
  screenHeight: number;
  safeArea?: {
    top: number;
    bottom: number;
    left: number;
    right: number;
    width: number;
    height: number;
  };
}

interface WxGlobal {
  createInnerAudioContext(): WxInnerAudioContext;
  vibrateShort(opts?: { type?: string; success?: () => void; fail?: () => void }): void;
  setClipboardData(opts: { data: string; success?: () => void; fail?: (e: unknown) => void }): void;
  getClipboardData(opts: { success?: (res: { data: string }) => void; fail?: (e: unknown) => void }): void;
  getWindowInfo?(): WxWindowInfo;
  getSystemInfoSync?(): WxWindowInfo;
  onHide(cb: () => void): void;
  onShow(cb: () => void): void;
}

declare const wx: WxGlobal | undefined;

/** 微信音频句柄：包装 InnerAudioContext，保证重复播放回到起点 */
class WxAudioHandle implements IAudioHandle {
  private ctx: WxInnerAudioContext;
  private valid = true;

  constructor(src: string) {
    const w = wx as WxGlobal;
    const ctx = w.createInnerAudioContext();
    ctx.src = src;
    ctx.autoplay = false;
    ctx.loop = false;
    ctx.obeyMuteSwitch = false;
    if (ctx.onError) ctx.onError(() => { /* 音源缺失/解码失败：静默忽略，见 README 占位音源说明 */ });
    this.ctx = ctx;
  }

  play(): void {
    if (!this.valid) return;
    try {
      this.ctx.stop();
      this.ctx.play();
    } catch (e) {
      // 播放失败不打断游戏流程
      void e;
    }
  }

  stop(): void {
    if (!this.valid) return;
    try {
      this.ctx.stop();
    } catch (e) {
      void e;
    }
  }

  pause(): void {
    if (!this.valid) return;
    try {
      this.ctx.pause();
    } catch (e) {
      void e;
    }
  }

  resume(): void {
    if (!this.valid) return;
    try {
      this.ctx.play();
    } catch (e) {
      void e;
    }
  }

  setVolume(v: number): void {
    if (!this.valid) return;
    this.ctx.volume = Math.max(0, Math.min(1, v));
  }

  setLoop(loop: boolean): void {
    if (!this.valid) return;
    this.ctx.loop = loop;
  }

  destroy(): void {
    if (!this.valid) return;
    this.valid = false;
    try {
      this.ctx.destroy();
    } catch (e) {
      void e;
    }
  }
}

export class WxAdapter implements IPlatform {
  readonly kind = 'wechat' as const;

  getPlatform(): 'wechat' {
    return 'wechat';
  }

  /** 微信刘海屏安全区：优先 wx.getWindowInfo（新 API），回退 getSystemInfoSync */
  getSafeAreaPx(): SafeAreaPx {
    const w = wx as WxGlobal;
    try {
      const info: WxWindowInfo = w.getWindowInfo ? w.getWindowInfo() : (w.getSystemInfoSync ? w.getSystemInfoSync() : { pixelRatio: 1, screenWidth: 0, screenHeight: 0 });
      const sw = info.screenWidth || 0;
      const sh = info.screenHeight || 0;
      const sa = info.safeArea;
      if (!sa) {
        return { top: 0, bottom: 0, left: 0, right: 0, screenWidth: sw, screenHeight: sh };
      }
      return {
        top: Math.max(0, sa.top),
        bottom: Math.max(0, sh - sa.bottom),
        left: Math.max(0, sa.left),
        right: Math.max(0, sw - sa.right),
        screenWidth: sw,
        screenHeight: sh,
      };
    } catch (e) {
      void e;
      return { top: 0, bottom: 0, left: 0, right: 0, screenWidth: 0, screenHeight: 0 };
    }
  }

  /** 微信音源：wx.createInnerAudioContext（无需手势解锁，兼容性兜底在 unlockAudio） */
  createAudio(src: string): IAudioHandle | null {
    try {
      return new WxAudioHandle(src);
    } catch (e) {
      void e;
      return null;
    }
  }

  /** 微信 InnerAudioContext 不受手势限制；此处仅做兜底占位（首次触摸调用无副作用） */
  unlockAudio(): void {
    // 微信小游戏音频无需用户手势解锁，保留接口与 H5 对齐
  }

  /** 短震动（部分机型不支持 type 参数，失败静默） */
  vibrate(): void {
    try {
      const w = wx as WxGlobal;
      w.vibrateShort({ type: 'medium' });
    } catch (e) {
      void e;
    }
  }

  /** 写剪贴板（异步回调转 Promise） */
  setClipboardText(text: string): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const w = wx as WxGlobal;
        w.setClipboardData({
          data: text,
          success: () => resolve(true),
          fail: () => resolve(false),
        });
      } catch (e) {
        void e;
        resolve(false);
      }
    });
  }

  /** 读剪贴板 */
  getClipboardText(): Promise<string> {
    return new Promise((resolve) => {
      try {
        const w = wx as WxGlobal;
        w.getClipboardData({
          success: (res) => resolve(res.data ?? ''),
          fail: () => resolve(''),
        });
      } catch (e) {
        void e;
        resolve('');
      }
    });
  }

  /** 前后台切换：wx.onHide / wx.onShow */
  registerLifecycle(onHide: () => void, onShow: () => void): void {
    try {
      const w = wx as WxGlobal;
      w.onHide(onHide);
      w.onShow(onShow);
    } catch (e) {
      void e;
    }
  }
}
