/* 自建服务的连接端点：把 WebSocket 包装成与 PeerJS DataConnection 同形的对象 */

(function (global) {
  'use strict';

  function buildUrl(base, params) {
    let raw = String(base || '').trim();
    if (!raw) return '';
    if (!/^(wss?|https?):\/\//i.test(raw)) raw = 'ws://' + raw;

    const url = new URL(raw);
    if (url.protocol === 'https:') url.protocol = 'wss:';
    if (url.protocol === 'http:') url.protocol = 'ws:';
    if (!url.pathname || url.pathname === '/') url.pathname = '/ws';

    Object.keys(params).forEach(function (key) {
      const value = params[key];
      if (value === undefined || value === null || value === '') return;
      url.searchParams.set(key, String(value));
    });
    return url.toString();
  }

  function create(options) {
    const opts = options || {};
    const handlers = { open: [], data: [], close: [], error: [], registered: [] };

    let socket = null;
    let closedByUs = false;
    let open = false;

    function fire(type, payload) {
      const list = handlers[type] || [];
      for (let i = 0; i < list.length; i += 1) {
        try {
          list[i](payload);
        } catch (error) {
          /* 单个回调失败不影响其它 */
        }
      }
    }

    const channelShim = {
      bufferedAmountLowThreshold: 0,
      get bufferedAmount() {
        if (!socket) return 0;
        return Number(socket.bufferedAmount) || 0;
      },
      addEventListener: function () {},
      removeEventListener: function () {}
    };

    const link = {
      kind: 'relay',
      get open() { return open && !!socket && socket.readyState === 1; },
      dataChannel: channelShim,
      send: function (data) {
        if (!socket || socket.readyState !== 1) throw new Error('中继连接已断开');
        socket.send(data);
      },
      close: function () {
        closedByUs = true;
        if (socket && socket.readyState === 1) {
          try {
            socket.close();
          } catch {
            /* 忽略 */
          }
        }
      },
      on: function (type, handler) {
        if (!handlers[type]) handlers[type] = [];
        handlers[type].push(handler);
        return link;
      }
    };

    const url = buildUrl(opts.url, {
      role: opts.role,
      code: opts.code,
      target: opts.target,
      token: opts.token
    });

    if (!url) {
      setTimeout(function () { fire('error', { reason: 'no-url' }); }, 0);
      return link;
    }

    try {
      socket = new WebSocket(url);
    } catch (error) {
      setTimeout(function () { fire('error', { reason: 'socket', message: String(error) }); }, 0);
      return link;
    }

    socket.binaryType = 'arraybuffer';

    socket.onopen = function () {
      /* 等对端配对，服务端回 ready 才算通道建立 */
    };

    socket.onmessage = function (event) {
      const data = event.data;
      if (typeof data === 'string') {
        let message = null;
        try {
          message = JSON.parse(data);
        } catch {
          return;
        }
        if (message && message.t === 'registered') {
          fire('registered', message);
          return;
        }
        if (message && message.t === 'ready') {
          open = true;
          fire('open', { side: message.side });
          return;
        }
        if (message && message.t === 'peer-close') {
          open = false;
          fire('close', { reason: message.reason || 'peer' });
          return;
        }
        if (message && message.t === 'error') {
          open = false;
          fire('error', { reason: message.reason || 'error' });
          return;
        }
        fire('data', data);
        return;
      }

      if (data instanceof ArrayBuffer) {
        fire('data', data);
        return;
      }

      if (data && typeof data.arrayBuffer === 'function') {
        data.arrayBuffer().then(function (buffer) { fire('data', buffer); });
      }
    };

    socket.onclose = function () {
      const wasOpen = open;
      open = false;
      fire('close', { reason: closedByUs ? 'local' : 'socket' });
      if (!wasOpen && !closedByUs) {
        /* 还没配上就被关掉，交给上层重试 */
      }
    };

    socket.onerror = function (error) {
      fire('error', { reason: 'socket', message: (error && error.message) || '连接失败' });
    };

    return link;
  }

  global.CDRelay = { create: create, buildUrl: buildUrl };
})(window);
