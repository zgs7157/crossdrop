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

    let codeEmitted = false;
    let relayHost = null;
    let relayGuest = null;
    let relayFallbackTimer = null;
    let linkMode = 'auto';

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

    function relayConfig() {
      const config = getConfig() || {};
      const relay = config.relay || {};
      return { url: relay.url || '', token: relay.token || '' };
    }

    function emitCode() {
      if (codeEmitted) return;
      codeEmitted = true;
      emit('code', { code: code, display: displayCode(code) });
    }

    function start() {
      if (destroyed) return;
      if (!code) code = randomCode(8);

      const config = getConfig() || {};
      linkMode = config.linkMode || 'auto';
      const relay = relayConfig();
      const canRelay = linkMode !== 'peer' && !!relay.url;
      const usePeer = linkMode !== 'relay';

      if (!usePeer && !canRelay) {
        status('error', '未配置自建服务地址');
        return;
      }

      if (canRelay) startRelayHost();
      if (usePeer) startPeer();
      else emitCode();
    }

    function startRelayHost() {
      if (destroyed || relayHost) return;
      const relay = relayConfig();
      if (!relay.url) return;

      const link = global.CDRelay.create({
        url: relay.url,
        token: relay.token,
        role: 'host',
        code: code
      });
      relayHost = link;

      link.on('registered', function () {
        emitCode();
        status('boot', '已注册到自建服务，等待对方连接');
        if (!peer || !peer.open) emitCode();
      });

      link.on('open', function () {
        attach(link, false, 'relay');
      });

      link.on('error', function (payload) {
        const reason = payload && payload.reason;
        if (reason === 'socket') {
          notice('warn', '自建服务连不上：' + (payload.message || '地址或端口不对'));
        } else if (reason === 'token') {
          notice('error', '自建服务口令不对，请在设置里检查');
        }
      });

      link.on('close', function () {
        if (relayHost === link) relayHost = null;
        if (destroyed) return;
        if (conn === link) {
          conn = null;
          peerInfo = null;
          abortCurrent();
          emit('disconnected', {});
          status('ready', '连接已断开');
        }
        /* 主机位掉了就重新注册 */
        scheduleRelayRehost();
      });
    }

    let rehostTimer = null;
    function scheduleRelayRehost() {
      if (rehostTimer || destroyed) return;
      rehostTimer = setTimeout(function () {
        rehostTimer = null;
        if (destroyed) return;
        if (!relayConfig().url) return;
        startRelayHost();
      }, 3000);
    }

    function startPeer() {
      if (destroyed || starting) return;
      starting = true;
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
        emitCode();
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
        attach(incoming, false, 'peer');
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
      if (conn && conn.open) {
        notice('warn', '已经有一个连接了，请先断开');
        return false;
      }

      const relay = relayConfig();
      const canRelay = linkMode !== 'peer' && !!relay.url;
      const peerReady = !!peer && peer.open;

      status('connecting', '正在连接 ' + displayCode(target));
      emit('connecting', { target: target });

      if (linkMode !== 'relay') {
        if (peerReady) {
          const dataConnection = peer.connect(PEER_PREFIX + target.toLowerCase(), {
            reliable: true,
            serialization: 'binary'
          });
          attach(dataConnection, true, 'peer');
        } else {
          pendingTarget = target;
          notice('info', '信令还在连接，连上后会立刻与对方建立通道');
        }
      }

      if (canRelay) {
        if (relayFallbackTimer) clearTimeout(relayFallbackTimer);
        const delay = peerReady ? 4000 : 0;
        relayFallbackTimer = setTimeout(function () {
          relayFallbackTimer = null;
          connectRelay(target);
        }, delay);
      }

      if (linkMode === 'relay' && !canRelay) {
        status('error', '未配置自建服务，无法连接');
        return false;
      }

      return true;
    }

    function connectRelay(target) {
      if (destroyed || (conn && conn.open)) return;
      const relay = relayConfig();
      if (!relay.url) return;

      let attempts = 0;
      const open = function () {
        relayGuest = global.CDRelay.create({
          url: relay.url,
          token: relay.token,
          role: 'guest',
          target: target
        });

        relayGuest.on('open', function () {
          attach(relayGuest, true, 'relay');
        });

        relayGuest.on('error', function (payload) {
          const reason = payload && payload.reason;
          if (reason === 'no-host') {
            attempts += 1;
            if (attempts <= 3 && !destroyed && !(conn && conn.open)) {
              setTimeout(open, 3000);
              return;
            }
            notice('warn', '自建服务上没有找到对方：确认双方填的是同一个服务地址和口令');
            status(conn && conn.open ? 'connected' : 'ready', '没有找到对方');
            return;
          }
          if (reason === 'token') {
            notice('error', '自建服务口令不对，请在设置里检查');
            return;
          }
          if (reason === 'socket') {
            notice('error', '自建服务连不上：' + (payload.message || '地址或端口不对'));
          }
        });

        relayGuest.on('close', function () {
          if (destroyed || conn !== relayGuest) return;
          conn = null;
          peerInfo = null;
          abortCurrent();
          emit('disconnected', {});
          status('ready', '连接已断开');
        });
      };

      open();
    }

    function attach(dataConnection, outgoing, kind) {
      const linkKind = kind || 'peer';

      if (conn && conn !== dataConnection) {
        if (conn.open) {
          try {
            dataConnection.close();
          } catch {
            /* 已关闭 */
          }
          notice('warn', '已有连接，拒绝了新的连入请求');
          return;
        }
        /* 旧通道还没建立：直接让位给新通道（直连失败转中继时会走到这里） */
        try {
          conn.close();
        } catch {
          /* 忽略 */
        }
      }

      if (relayFallbackTimer) {
        clearTimeout(relayFallbackTimer);
        relayFallbackTimer = null;
      }

      conn = dataConnection;
      conn.kind = linkKind;

      const timeout = linkKind === 'relay' ? 15000 : 22000;
      let handshakeTimer = setTimeout(function () {
        if (!dataConnection.open) {
          status('ready', '连接超时');
          if (linkKind === 'relay') {
            notice('warn', '自建服务通道没有建立：检查地址、口令与端口是否放通');
          } else {
            notice('warn', '直连没有建立：可在设置里填自建服务地址，自动改走中继');
          }
          try {
            dataConnection.close();
          } catch {
            /* 忽略 */
          }
        }
      }, timeout);

      dataConnection.on('open', function () {
        clearTimeout(handshakeTimer);
        status('connected', outgoing ? '已连接到对方' : '对方已接入');
        emit('connected', { mine: outgoing });
        try {
          dataConnection.send(JSON.stringify({ t: 'hello', name: selfName(), platform: navigator.userAgent.indexOf('Electron') >= 0 ? 'desktop' : 'web' }));
        } catch {
          /* 发送 hello 失败不致命 */
        }
        if (linkKind === 'relay') {
          emit('transport', { relay: true, kind: 'relay', localType: 'relay', remoteType: 'relay' });
        } else {
          setTimeout(inspectTransport, 1500);
        }
      });

      dataConnection.on('data', handleData);

      dataConnection.on('close', function () {
        clearTimeout(handshakeTimer);
        if (conn !== dataConnection) return;
        conn = null;
        peerInfo = null;
        abortCurrent();
        emit('disconnected', {});
        status((peer && peer.open) || relayHost ? 'ready' : 'boot', '连接已断开');
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
      status((peer && peer.open) || relayHost ? 'ready' : 'boot', '已断开');
      emit('disconnected', {});
    }

    function destroy() {
      destroyed = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (rehostTimer) clearTimeout(rehostTimer);
      if (relayFallbackTimer) clearTimeout(relayFallbackTimer);
      abortCurrent(true);
      try {
        if (peer) {
          peer.removeAllListeners();
          peer.destroy();
        }
      } catch {
        /* 忽略 */
      }
      try {
        if (relayHost) relayHost.close();
      } catch {
        /* 忽略 */
      }
      try {
        if (relayGuest) relayGuest.close();
      } catch {
        /* 忽略 */
      }
      relayHost = null;
      relayGuest = null;
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
