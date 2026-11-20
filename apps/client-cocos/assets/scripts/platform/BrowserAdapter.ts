/**
 * 浏览器（H5 / web-mobile）平台适配器：Audio 元素音频、屏幕窗口安全区、
 * navigator 剪贴板与震动、visibilitychange 前后台生命周期。
 */

import type { IAudioHandle, IPlatform, SafeAreaPx } from './IPlatform';

/** 浏览器音频句柄：包装 HTMLAudioElement，解决自动播放解锁与复用 */
class BrowserAudioHandle implements IAudioHandle {
  private el: HTMLAudioElement | null;
  private valid = true;

  constructor(src: string, unlocked: () => boolean) {
    try {
      const el = new Audio(src);
      el.preload = 'auto';
      el.loop = false;
      el.addEventListener('error', () => { /* 音源缺失：静默忽略（占位音源见 README） */ });
      this.el = el;
      this.unlockedCheck = unlocked;
    } catch (e) {
      void e;
      this.el = null;
      this.unlockedCheck = unlocked;
    }
  }

  private unlockedCheck: () => boolean;

  play(): void {
    if (!this.valid || !this.el) return;
    if (!this.unlockedCheck()) return; // 未解锁前不播放，避免抛 NotAllowedError
    try {
      this.el.currentTime = 0;
      void this.el.play().catch(() => { /* 用户未交互或音源缺失：静默 */ });
    } catch (e) {
      void e;
    }
  }

  stop(): void {
    if (!this.valid || !this.el) return;
    try {
      this.el.pause();
      this.el.currentTime = 0;
    } catch (e) {
      void e;
    }
  }

  pause(): void {
    if (!this.valid || !this.el) return;
    try {
      this.el.pause();
    } catch (e) {
      void e;
    }
  }

  resume(): void {
    this.play();
  }

  setVolume(v: number): void {
    if (!this.valid || !this.el) return;
    this.el.volume = Math.max(0, Math.min(1, v));
  }

  setLoop(loop: boolean): void {
    if (!this.valid || !this.el) return;
    this.el.loop = loop;
  }

  destroy(): void {
    if (!this.valid) return;
    this.valid = false;
    if (this.el) {
      try {
        this.el.pause();
        this.el.src = '';
      } catch (e) {
        void e;
      }
    }
    this.el = null;
  }
}

/** 1 秒静音 WAV（base64）：首次触摸时播放一次以解锁后续 Audio 播放 */
const SILENT_WAV =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';

export class BrowserAdapter implements IPlatform {
  readonly kind = 'browser' as const;

  /** 音频是否已通过用户手势解锁 */
  private audioUnlocked = false;

  getPlatform(): 'browser' {
    return 'browser';
  }

  /**
   * 浏览器安全区：桌面与大多数 H5 场景无刘海，返回 0 边距；
   * 若宿主提供 visualViewport 则读取实际可视区域估算。
   */
  getSafeAreaPx(): SafeAreaPx {
    const w = typeof window !== 'undefined' ? window.innerWidth : 0;
    const h = typeof window !== 'undefined' ? window.innerHeight : 0;
    return { top: 0, bottom: 0, left: 0, right: 0, screenWidth: w, screenHeight: h };
  }

  /** H5 音源：new Audio(src)，src 为相对页面根路径 */
  createAudio(src: string): IAudioHandle | null {
    try {
      return new BrowserAudioHandle(src, () => this.audioUnlocked);
    } catch (e) {
      void e;
      return null;
    }
  }

  /** 首次触摸解锁：播放一段静音音频，之后允许正常出声 */
  unlockAudio(): void {
    if (this.audioUnlocked) return;
    try {
      const el = new Audio(SILENT_WAV);
      el.volume = 0;
      void el
        .play()
        .then(() => {
          this.audioUnlocked = true;
        })
        .catch(() => {
          this.audioUnlocked = true; // 部分浏览器不抛错但直接放行
        });
    } catch (e) {
      void e;
      this.audioUnlocked = true;
    }
  }

  /** 短震动：navigator.vibrate（Safari 不支持，静默忽略） */
  vibrate(): void {
    try {
      const nav = navigator as Navigator & { vibrate?: (p: number | number[]) => boolean };
      if (typeof nav.vibrate === 'function') nav.vibrate(30);
    } catch (e) {
      void e;
    }
  }

  /** 写剪贴板：优先 async clipboard API，失败回退 execCommand */
  setClipboardText(text: string): Promise<boolean> {
    const nav = navigator as Navigator & { clipboard?: { writeText(t: string): Promise<void> } };
    if (nav.clipboard && typeof nav.clipboard.writeText === 'function') {
      return nav.clipboard.writeText(text).then(() => true).catch(() => false);
    }
    return new Promise((resolve) => {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        resolve(ok);
      } catch (e) {
        void e;
        resolve(false);
      }
    });
  }

  /** 读剪贴板：async clipboard（需权限；失败返回空串） */
  getClipboardText(): Promise<string> {
    const nav = navigator as Navigator & { clipboard?: { readText(): Promise<string> } };
    if (nav.clipboard && typeof nav.clipboard.readText === 'function') {
      return nav.clipboard.readText().catch(() => '');
    }
    return Promise.resolve('');
  }

  /** 前后台切换：document.visibilitychange */
  registerLifecycle(onHide: () => void, onShow: () => void): void {
    if (typeof document === 'undefined') return;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') onHide();
      else onShow();
    });
  }
}
