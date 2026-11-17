/* 平台适配：桌面端（Electron 预加载 API）/ 浏览器端（纯前端降级） */
(function (global) {
  'use strict';

  const bridge = global.crossdrop;
  const IS_DESKTOP = !!(bridge && bridge.isDesktop);
  const LS_KEY = 'crossdrop.settings.v1';

  let settings = {};
  let info = {};
  let desktopInfo = null;

  function webDefaults() {
    return {
      saveDir: '',
      signalMode: 'cloud',
      signalHost: '',
      signalPort: 443,
      signalPath: '/',
      signalKey: 'peerjs',
      signalSecure: true,
      useStun: true,
      turnUrl: '',
      turnUser: '',
      turnSecret: ''
    };
  }

  function detectPlatform() {
    const ua = navigator.userAgent;
    if (/Android/i.test(ua)) return 'Android 浏览器';
    if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS 浏览器';
    if (/Macintosh/i.test(ua)) return 'macOS 浏览器';
    return '浏览器';
  }

  async function init() {
    if (IS_DESKTOP) {
      desktopInfo = await bridge.getSystemInfo();
      settings = await bridge.getSettings();
      info = {
        desktop: true,
        platform: desktopInfo.platform === 'win32' ? 'Windows 桌面版' : desktopInfo.platform,
        version: desktopInfo.version,
        saveDir: desktopInfo.saveDir
      };
    } else {
      info = { desktop: false, platform: detectPlatform(), version: '1.0.0', saveDir: '浏览器默认下载目录' };
      try {
        settings = Object.assign(webDefaults(), JSON.parse(localStorage.getItem(LS_KEY) || '{}'));
      } catch {
        settings = webDefaults();
      }
    }
    return { settings, info };
  }

  function getSettings() {
    return settings;
  }

  async function saveSettings(patch) {
    settings = Object.assign({}, settings, patch);
    if (IS_DESKTOP) {
      settings = await bridge.setSettings(patch);
    } else {
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(settings));
      } catch {
        /* 隐私模式下写入失败，本次会话仍生效 */
      }
    }
    return settings;
  }

  async function pickSaveDir() {
    if (!IS_DESKTOP) return null;
    const dir = await bridge.pickSaveDir();
    if (dir) {
      settings.saveDir = dir;
      info.saveDir = dir;
    }
    return dir;
  }

  async function createSink(meta) {
    if (IS_DESKTOP) {
      const session = await bridge.recvBegin({ name: meta.name, size: meta.size, rel: meta.rel || '' });
      return {
        async write(bytes) {
          await bridge.recvChunk(session.id, bytes);
        },
        async close() {
          await bridge.recvEnd(session.id);
          return { path: session.path };
        },
        async abort() {
          try {
            await bridge.recvAbort(session.id);
          } catch {
            /* 已清理 */
          }
        }
      };
    }

    const parts = [];
    const name = meta.name || 'file';
    return {
      async write(bytes) {
        parts.push(bytes);
      },
      async close() {
        const blob = new Blob(parts, { type: 'application/octet-stream' });
        parts.length = 0;
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = name;
        link.rel = 'noopener';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 180000);
        return { path: '浏览器下载：' + name };
      },
      async abort() {
        parts.length = 0;
      }
    };
  }

  function openInFolder(target) {
    if (IS_DESKTOP && target) bridge.showItemInFolder(target);
  }

  function openPath(target) {
    if (IS_DESKTOP && target) bridge.openPath(target);
  }

  function formatBytes(value) {
    const n = Number(value) || 0;
    if (n < 1024) return n + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let size = n / 1024;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024;
      unit += 1;
    }
    return (size >= 100 ? size.toFixed(0) : size.toFixed(size >= 10 ? 1 : 2)) + ' ' + units[unit];
  }

  function formatSpeed(bytesPerSecond) {
    const n = Number(bytesPerSecond) || 0;
    if (!n) return '—';
    return formatBytes(n) + '/s';
  }

  global.CDPlatform = {
    isDesktop: IS_DESKTOP,
    init,
    getSettings,
    saveSettings,
    pickSaveDir,
    createSink,
    openInFolder,
    openPath,
    formatBytes,
    formatSpeed,
    info: () => info
  };
})(window);
