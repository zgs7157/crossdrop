/* 传输核心：PeerJS 信令 + WebRTC 数据通道 + 分片文件协议 */
(function (global) {
  'use strict';

  const CHUNK_SIZE = 64 * 1024;
  const HIGH_WATER = 2 * 1024 * 1024;
  const LOW_WATER = 1 * 1024 * 1024;
  const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const PEER_PREFIX = 'crossdrop-';

  function randomCode(length) {
    const len = length || 8;
    const bytes = new Uint8Array(len);
    global.crypto.getRandomValues(bytes);
    let out = '';
    for (let i = 0; i < len; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
    return out;
  }

  function normalizeCode(input) {
    return String(input || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  }

  function isValidCode(code) {
    const raw = normalizeCode(code);
    if (raw.length !== 8) return false;
    for (let i = 0; i < raw.length; i += 1) {
      if (ALPHABET.indexOf(raw[i]) < 0) return false;
    }
    return true;
  }

  function displayCode(code) {
    const raw = String(code || '');
    return raw.slice(0, 4) + '-' + raw.slice(4);
  }

  function create(options) {
    const opts = options || {};
    const emit = typeof opts.onEvent === 'function' ? opts.onEvent : function () {};
    const getConfig = typeof opts.getConfig === 'function' ? opts.getConfig : function () { return {}; };
    const selfName = typeof opts.name === 'function' ? opts.name : function () { return '未命名设备'; };

    let peer = null;
    let conn = null;
    let code = '';
    let destroyed = false;
    let starting = false;
    let retryTimer = null;
    let idAttempts = 0;
    let pendingTarget = null;

    let sending = false;
    let cancelRequested = false;
    let queueCursor = 0;
    let activeSendId = null;
    let activeBatch = [];

    let current = null;
    let recvChain = Promise.resolve();
    let peerInfo = null;

    function status(state, message) {
      emit('status', { state: state, message: message });
    }

    function notice(level, message) {
      emit('notice', { level: level, message: message });
    }

    function peerOptions() {
      const config = getConfig() || {};
      const result = {
        debug: 0,
        config: { iceServers: config.iceServers || [] }
      };
      const signal = config.signaling || {};
      if (signal.mode === 'custom' && signal.host) {
        result.host = signal.host;
        result.port = Number(signal.port) || 443;
        result.path = signal.path || '/';
        result.key = signal.key || 'peerjs';
        result.secure = signal.secure !== false;
      }
      return result;
    }

    function start() {
      if (destroyed || starting) return;
      starting = true;
      if (!code) code = randomCode(8);
      status('boot', '正在连接信令服务');
      let instance;
      try {
        instance = new global.Peer(PEER_PREFIX + code.toLowerCase(), peerOptions());
      } catch (error) {
        starting = false;
        status('error', '无法初始化连接：' + (error && error.message ? error.message : '未知错误'));
        return;
      }

      peer = instance;

      instance.on('open', function () {
        starting = false;
        idAttempts = 0;
        emit('code', { code: code, display: displayCode(code) });
        if (conn && conn.open) {
          status('connected', '已连接');
        } else {
          status('ready', '就绪 · 等待对方连接');
        }
        if (pendingTarget) {
          const target = pendingTarget;
          pendingTarget = null;
          setTimeout(function () { connectTo(target); }, 0);
        }
      });

      instance.on('connection', function (incoming) {
        attach(incoming, false);
      });

      instance.on('disconnected', function () {
        if (destroyed) return;
        status('boot', '信令断开，正在重连');
        try {
          instance.reconnect();
        } catch (error) {
          scheduleRebuild();
        }
      });

      instance.on('close', function () {
        if (destroyed) return;
        status('boot', '信令连接关闭，正在重建');
        scheduleRebuild();
      });

      instance.on('error', function (error) {
        const type = error && error.type;
        starting = false;
        if (type === 'unavailable-id') {
          idAttempts += 1;
          if (idAttempts <= 3) {
            code = randomCode(8);
            rebuildPeer();
            return;
          }
          status('error', '连接码被占用，请稍后重试');
          return;
        }
        if (type === 'peer-unavailable') {
          status(conn && conn.open ? 'connected' : 'ready', '没有找到对方');
          notice('warn', '对方不在线，或连接码输入有误');
          return;
        }
        if (type === 'browser-incompatible') {
          status('error', '当前浏览器不支持 WebRTC');
          return;
        }
        if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed') {
          status('error', '信令服务连不上，正在重试');
          scheduleRebuild();
          return;
        }
        notice('error', '连接异常：' + (error && error.message ? error.message : type || '未知错误'));
      });
    }

    function scheduleRebuild() {
      if (destroyed) return;
      if (retryTimer) return;
      retryTimer = setTimeout(function () {
        retryTimer = null;
        rebuildPeer();
      }, 2500);
    }

    function rebuildPeer() {
      if (destroyed) return;
      const old = peer;
      peer = null;
      if (old) {
        try {
          old.removeAllListeners();
          old.destroy();
        } catch {
          /* 已销毁 */
        }
      }
      conn = null;
      starting = false;
      retryTimer = retryTimer || null;
      start();
    }

    function connectTo(input) {
      const target = normalizeCode(input);
      if (!isValidCode(target)) {
        notice('warn', '连接码是 8 位字符（不含 0、1、I、O），请检查后再试');
        return false;
      }
      if (target === code) {
        notice('warn', '这是你自己的连接码，请填对方的');
        return false;
      }
      if (conn && conn.open) {
        notice('warn', '已经有一个连接了，请先断开');
        return false;
      }
      if (!peer || !peer.open) {
        pendingTarget = target;
        notice('info', '信令还在连接，连上后会立刻与对方建立通道');
        return true;
      }

      status('connecting', '正在连接 ' + displayCode(target));
      const dataConnection = peer.connect(PEER_PREFIX + target.toLowerCase(), {
        reliable: true,
        serialization: 'binary'
      });
      attach(dataConnection, true);
      emit('connecting', { target: target });
      return true;
    }

    function attach(dataConnection, outgoing) {
      if (conn && conn !== dataConnection && conn.open) {
        try {
          dataConnection.close();
        } catch {
          /* 已关闭 */
        }
        notice('warn', '已有连接，拒绝了新的连入请求');
        return;
      }

      conn = dataConnection;
      let handshakeTimer = setTimeout(function () {
        if (!dataConnection.open) {
          status('ready', '连接超时');
          notice('warn', '连接没有建立：对方可能处于严格内网，可在设置里配置 TURN 中继');
          try {
            dataConnection.close();
          } catch {
            /* 忽略 */
          }
        }
      }, 22000);

      dataConnection.on('open', function () {
        clearTimeout(handshakeTimer);
        status('connected', outgoing ? '已连接到对方' : '对方已接入');
        emit('connected', { mine: outgoing });
        try {
          dataConnection.send(JSON.stringify({ t: 'hello', name: selfName(), platform: navigator.userAgent.indexOf('Electron') >= 0 ? 'desktop' : 'web' }));
        } catch {
          /* 发送 hello 失败不致命 */
        }
        setTimeout(inspectTransport, 1500);
      });

      dataConnection.on('data', handleData);

      dataConnection.on('close', function () {
        clearTimeout(handshakeTimer);
        if (conn !== dataConnection) return;
        conn = null;
        peerInfo = null;
        abortCurrent();
        emit('disconnected', {});
        status(peer && peer.open ? 'ready' : 'boot', '连接已断开');
      });

      dataConnection.on('error', function (error) {
        notice('warn', '通道异常：' + (error && error.message ? error.message : '未知错误'));
      });

      dataConnection.on('iceStateChanged', function () {});
    }

    function inspectTransport() {
      const pc = conn && conn.peerConnection;
      if (!pc || typeof pc.getStats !== 'function') return Promise.resolve();
      return pc.getStats().then(function (stats) {
        let pairId = null;
        stats.forEach(function (report) {
          if (report.type === 'transport' && report.selectedCandidatePairId) pairId = report.selectedCandidatePairId;
        });
        if (!pairId) {
          stats.forEach(function (report) {
            if (report.type === 'candidate-pair' && (report.state === 'succeeded' || report.nominated)) {
              if (!pairId) pairId = report.id;
            }
          });
        }
        let remoteType = null;
        let localType = null;
        if (pairId && stats.get(pairId)) {
          const pair = stats.get(pairId);
          const remote = stats.get(pair.remoteCandidateId);
          const local = stats.get(pair.localCandidateId);
          remoteType = remote ? remote.candidateType : null;
          localType = local ? local.candidateType : null;
        }
        const relayed = remoteType === 'relay' || localType === 'relay';
        emit('transport', { relay: relayed, remoteType: remoteType, localType: localType });
      }).catch(function () {});
    }

    function handleData(data) {
      if (typeof data === 'string') {
        let message = null;
        try {
          message = JSON.parse(data);
        } catch {
          return;
        }
        handleControl(message);
        return;
      }

      let toBytes;
      if (data instanceof ArrayBuffer) {
        toBytes = Promise.resolve(new Uint8Array(data));
      } else if (data && typeof data.arrayBuffer === 'function') {
        toBytes = data.arrayBuffer().then(function (buffer) { return new Uint8Array(buffer); });
      } else if (ArrayBuffer.isView(data)) {
        toBytes = Promise.resolve(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      } else {
        return;
      }

      const target = current;
      if (!target) return;

      toBytes.then(function (bytes) {
        recvChain = recvChain.then(function () {
          if (!current || current !== target || !current.sink) return Promise.resolve();
          return Promise.resolve(current.sink.write(bytes)).then(function () {
            current.received += bytes.byteLength;
            emit('recv-progress', { id: current.id, received: current.received, size: current.size });
          });
        }).catch(function (error) {
          notice('error', '写入文件失败：' + (error && error.message ? error.message : '未知错误'));
          abortCurrent();
        });
      });
    }

    function handleControl(message) {
      if (!message || !message.t) return;

      if (message.t === 'hello') {
        peerInfo = { name: message.name || '对方设备', platform: message.platform || 'web' };
        emit('peer-info', peerInfo);
        return;
      }

      if (message.t === 'fs') {
        const meta = {
          id: message.id,
          name: message.name || 'file',
          size: Number(message.size) || 0,
          mime: message.mime || '',
          rel: message.rel || ''
        };
        const target = { id: meta.id, name: meta.name, size: meta.size, received: 0, sink: null };
        current = target;
        recvChain = recvChain.then(function () {
          if (current !== target) return Promise.resolve();
          return global.CDPlatform.createSink(meta).then(function (sink) {
            if (current !== target) {
              return sink.abort();
            }
            target.sink = sink;
            emit('recv-start', { id: meta.id, name: meta.name, size: meta.size });
          });
        }).catch(function (error) {
          notice('error', '无法创建接收文件：' + (error && error.message ? error.message : '未知错误'));
          abortCurrent();
        });
        return;
      }

      if (message.t === 'fe') {
        const id = message.id;
        const target = current;
        if (!target || target.id !== id) return;
        recvChain = recvChain.then(function () {
          if (current !== target) return Promise.resolve();
          current = null;
          if (!target.sink) return Promise.resolve();
          return Promise.resolve(target.sink.close()).then(function (result) {
            emit('recv-end', {
              id: target.id,
              name: target.name,
              size: target.received,
              path: (result && result.path) || '',
              ok: true
            });
          });
        }).catch(function (error) {
          emit('recv-end', { id: target.id, name: target.name, size: target.received, path: '', ok: false, error: error && error.message });
        });
        return;
      }

      if (message.t === 'cxl') {
        abortCurrent(true);
        notice('warn', '对方取消了发送');
        return;
      }

      if (message.t === 'done') {
        emit('recv-batch-end', {});
      }
    }

    function abortCurrent(silent) {
      const target = current;
      current = null;
      if (!target) return;
      if (target.sink) {
        Promise.resolve(target.sink.abort()).catch(function () {});
      }
      if (!silent) emit('recv-abort', { id: target.id, name: target.name });
    }

    function waitForBuffer() {
      const channel = conn && conn.dataChannel;
      if (!channel) return Promise.resolve();
      if (channel.bufferedAmount < HIGH_WATER) return Promise.resolve();

      const low = LOW_WATER;
      try {
        channel.bufferedAmountLowThreshold = low;
      } catch {
        /* 部分实现只读 */
      }

      return new Promise(function (resolve) {
        let done = false;
        const finish = function () {
          if (done) return;
          done = true;
          try {
            channel.removeEventListener('bufferedamountlow', finish);
          } catch {
            /* 忽略 */
          }
          clearInterval(poll);
          clearTimeout(timer);
          resolve();
        };
        const poll = setInterval(function () {
          if (!channel || channel.bufferedAmount <= low) finish();
        }, 60);
        const timer = setTimeout(finish, 30000);
        try {
          channel.addEventListener('bufferedamountlow', finish);
        } catch {
          /* 忽略 */
        }
      });
    }

    async function sendFiles(items) {
      if (!conn || !conn.open) {
        notice('warn', '还没连上对方，先输入对方连接码');
        return false;
      }
      if (sending) {
        notice('warn', '上一批还在发送中');
        return false;
      }

      activeBatch = (items || []).filter(function (item) { return item && item.file; });
      if (!activeBatch.length) return false;

      sending = true;
      cancelRequested = false;
      queueCursor = 0;
      emit('send-batch-start', { total: activeBatch.reduce(function (sum, item) { return sum + (item.file.size || 0); }, 0), count: activeBatch.length });

      try {
        for (queueCursor = 0; queueCursor < activeBatch.length; queueCursor += 1) {
          if (cancelRequested) throw new Error('已取消');
          if (!conn || !conn.open) throw new Error('连接已断开');

          const item = activeBatch[queueCursor];
          const file = item.file;
          const size = file.size;
          activeSendId = item.id;
          emit('send-start', { id: item.id, name: item.name, size: size });

          conn.send(JSON.stringify({
            t: 'fs',
            id: item.id,
            name: item.name,
            size: size,
            mime: file.type || '',
            rel: item.rel || ''
          }));

          let sent = 0;
          while (sent < size) {
            if (cancelRequested) throw new Error('已取消');
            const end = Math.min(sent + CHUNK_SIZE, size);
            const buffer = await file.slice(sent, end).arrayBuffer();
            await waitForBuffer();
            if (!conn || !conn.open) throw new Error('连接已断开');
            conn.send(buffer);
            sent += buffer.byteLength;
            emit('send-progress', { id: item.id, sent: sent, size: size });
          }

          conn.send(JSON.stringify({ t: 'fe', id: item.id }));
          emit('send-end', { id: item.id, ok: true });
          activeSendId = null;
        }

        if (conn && conn.open) conn.send(JSON.stringify({ t: 'done' }));
        emit('send-batch-end', { ok: true });
        return true;
      } catch (error) {
        const message = error && error.message ? error.message : '发送失败';
        if (activeSendId) emit('send-end', { id: activeSendId, ok: false, error: message });
        try {
          if (conn && conn.open) conn.send(JSON.stringify({ t: 'cxl' }));
        } catch {
          /* 忽略 */
        }
        emit('send-batch-end', { ok: false, error: message });
        return false;
      } finally {
        sending = false;
        activeSendId = null;
      }
    }

    function cancelSend() {
      if (!sending) return false;
      cancelRequested = true;
      return true;
    }

    function disconnect() {
      if (conn) {
        try {
          conn.close();
        } catch {
          /* 忽略 */
        }
        conn = null;
      }
      peerInfo = null;
      abortCurrent();
      status(peer && peer.open ? 'ready' : 'boot', '已断开');
      emit('disconnected', {});
    }

    function destroy() {
      destroyed = true;
      if (retryTimer) clearTimeout(retryTimer);
      abortCurrent(true);
      try {
        if (peer) {
          peer.removeAllListeners();
          peer.destroy();
        }
      } catch {
        /* 忽略 */
      }
      peer = null;
      conn = null;
    }

    return {
      start: start,
      connect: connectTo,
      sendFiles: sendFiles,
      cancelSend: cancelSend,
      disconnect: disconnect,
      destroy: destroy,
      getCode: function () { return code; },
      isConnected: function () { return !!(conn && conn.open); },
      isSending: function () { return sending; },
      peerInfo: function () { return peerInfo; }
    };
  }

  global.CDTransfer = {
    create: create,
    displayCode: displayCode,
    normalizeCode: normalizeCode,
    isValidCode: isValidCode
  };
})(window);
