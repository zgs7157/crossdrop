/* 界面逻辑：配对、队列、进度、设置 */
(function () {
  'use strict';

  const P = window.CDPlatform;
  const REPO_URL = 'https://github.com/zgs7157/crossdrop';
  const WEB_URL = 'https://zgs7157.github.io/crossdrop/';

  const el = function (id) { return document.getElementById(id); };

  const ICON_FILE =
    '<svg class="file-icon" viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M14 3.5H7.5A2 2 0 0 0 5.5 5.5v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
    '<path d="M14 3.5V8h4.5" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';

  const ICON_X =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 8l8 8M16 8l-8 8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';

  const ICON_FOLDER =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 8.2v9.3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V9.7a2 2 0 0 0-2-2h-5L11 5.6H6.5a2 2 0 0 0-2 2z" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';

  const state = {
    settings: null,
    info: null,
    engine: null,
    connected: false,
    sending: false,
    queue: [],
    recv: [],
    seq: 0,
    speed: {},
    pendingRender: new Set(),
    rafId: 0,
    recvBytes: 0,
    recvCount: 0
  };

  /* ------------------------------------------------------------ 工具函数 */

  function toast(message, level) {
    const node = el('toast');
    node.textContent = message;
    node.classList.add('show');
    node.dataset.level = level || 'info';
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { node.classList.remove('show'); }, 2600);
  }

  function setStatus(status, text) {
    const pill = el('statusPill');
    pill.dataset.state = status;
    el('statusText').textContent = text;
  }

  function scheduleRender(id) {
    state.pendingRender.add(id || '*');
    if (state.rafId) return;
    state.rafId = requestAnimationFrame(function () {
      state.rafId = 0;
      const ids = Array.from(state.pendingRender);
      state.pendingRender.clear();
      if (ids.indexOf('*') >= 0) {
        ids.forEach(function (item) {
          if (item !== '*') updateQueueRow(item);
        });
        updateTotals();
      } else {
        ids.forEach(updateQueueRow);
        updateTotals();
      }
    });
  }

  function updateTotals() {
    const pending = state.queue.filter(function (item) { return item.state !== 'done'; });
    const totalBytes = pending.reduce(function (sum, item) { return sum + item.size; }, 0);
    el('sendTotals').textContent = pending.length
      ? pending.length + ' 个文件 · ' + P.formatBytes(totalBytes)
      : '';
    el('queueEmpty').hidden = state.queue.length > 0;
    el('sendMeta').textContent = state.queue.length
      ? '共 ' + state.queue.length + ' 个文件'
      : '未选择文件';

    const sendButton = el('btnSend');
    if (state.sending) {
      sendButton.textContent = '取消发送';
      sendButton.disabled = false;
      el('btnClearQueue').disabled = true;
    } else {
      sendButton.textContent = '发送全部';
      sendButton.disabled = !state.queue.some(function (item) {
        return item.state === 'pending' || item.state === 'error';
      });
      el('btnClearQueue').disabled = !state.queue.length;
    }
  }

  /* ------------------------------------------------------------ 发送队列 */

  function addFiles(fileList, prefix) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    files.forEach(function (file) {
      const relativePath = file.webkitRelativePath || '';
      let dirPart = relativePath ? relativePath.split('/').slice(0, -1).join('/') : '';
      if (prefix) dirPart = dirPart ? prefix + '/' + dirPart : prefix;
      state.seq += 1;
      state.queue.push({
        id: 'f' + state.seq + '_' + Math.random().toString(36).slice(2, 7),
        file: file,
        name: file.name,
        label: dirPart ? dirPart + '/' + file.name : file.name,
        size: file.size,
        rel: dirPart,
        sent: 0,
        state: 'pending',
        speed: 0,
        lastTime: 0,
        lastBytes: 0
      });
    });
    renderQueue();
    updateTotals();
    toast('已加入 ' + files.length + ' 个文件');
  }

  function renderQueue() {
    const host = el('queue');
    host.textContent = '';
    state.queue.forEach(function (item) {
      const row = document.createElement('div');
      row.className = 'queue-item';
      row.dataset.id = item.id;
      row.dataset.state = item.state;
      row.innerHTML =
        ICON_FILE +
        '<div class="file-body">' +
        '<div class="file-line"><span class="file-name"></span><span class="file-size">' + P.formatBytes(item.size) + '</span></div>' +
        '<div class="bar"><div class="bar-fill"></div></div>' +
        '<div class="file-status">等待发送</div>' +
        '</div>' +
        '<button class="item-action" title="移除" aria-label="移除">' + ICON_X + '</button>';
      row.querySelector('.file-name').textContent = item.label || item.name;
      row.querySelector('.file-name').title = item.label || item.name;
      row.querySelector('.item-action').addEventListener('click', function () {
        if (state.sending) {
          toast('发送中，不能移除', 'warn');
          return;
        }
        state.queue = state.queue.filter(function (entry) { return entry.id !== item.id; });
        renderQueue();
        updateTotals();
      });
      host.appendChild(row);
      updateQueueRow(item.id);
    });
    updateTotals();
  }

  function findQueueItem(id) {
    for (let i = 0; i < state.queue.length; i += 1) {
      if (state.queue[i].id === id) return state.queue[i];
    }
    return null;
  }

  function updateQueueRow(id) {
    const item = findQueueItem(id);
    const row = document.querySelector('.queue-item[data-id="' + id + '"]');
    if (!item || !row) return;
    row.dataset.state = item.state;
    row.dataset.active = item.state === 'sending' ? 'true' : 'false';
    const percent = item.size ? Math.min(100, (item.sent / item.size) * 100) : 0;
    row.querySelector('.bar-fill').style.width = percent + '%';
    const status = row.querySelector('.file-status');
    if (item.state === 'pending') {
      status.textContent = '等待发送';
    } else if (item.state === 'sending') {
      const elapsed = item.lastTime ? item.speed : 0;
      status.textContent = P.formatBytes(item.sent) + ' / ' + P.formatBytes(item.size) +
        (elapsed ? ' · ' + P.formatSpeed(elapsed) : '');
    } else if (item.state === 'done') {
      status.textContent = '已发送 · ' + P.formatBytes(item.size);
    } else if (item.state === 'error') {
      status.textContent = item.error || '发送失败';
    }
  }

  /* ------------------------------------------------------------ 接收列表 */

  function renderRecv() {
    const host = el('recvList');
    host.textContent = '';
    state.recv.forEach(function (item) {
      const row = document.createElement('div');
      row.className = 'queue-item';
      row.dataset.id = item.id;
      row.dataset.state = item.state;
      row.dataset.active = item.state === 'receiving' ? 'true' : 'false';
      const action = item.state === 'done' && P.isDesktop
        ? '<button class="item-action open" title="打开所在文件夹" aria-label="打开所在文件夹">' + ICON_FOLDER + '</button>'
        : '';
      row.innerHTML =
        ICON_FILE +
        '<div class="file-body">' +
        '<div class="file-line"><span class="file-name"></span><span class="file-size">' + P.formatBytes(item.size) + '</span></div>' +
        '<div class="bar"><div class="bar-fill"></div></div>' +
        '<div class="file-status"></div>' +
        '</div>' + action;
      row.querySelector('.file-name').textContent = item.name;
      row.querySelector('.file-name').title = item.path || item.name;
      if (action) {
        row.querySelector('.item-action').addEventListener('click', function () { P.openInFolder(item.path); });
      }
      host.appendChild(row);
      updateRecvRow(item.id);
    });
    el('recvEmpty').hidden = state.recv.length > 0;
    el('recvMeta').textContent = state.recvCount ? '本次已收 ' + state.recvCount + ' 个文件' : '保持在线即可接文件';
    el('recvTotals').textContent = state.recvBytes ? '共接收 ' + P.formatBytes(state.recvBytes) : '';
  }

  function updateRecvRow(id) {
    const item = state.recv.filter(function (entry) { return entry.id === id; })[0];
    const row = document.querySelector('#recvList .queue-item[data-id="' + id + '"]');
    if (!item || !row) return;
    row.dataset.state = item.state;
    row.dataset.active = item.state === 'receiving' ? 'true' : 'false';
    const percent = item.size ? Math.min(100, (item.received / item.size) * 100) : 0;
    row.querySelector('.bar-fill').style.width = (item.state === 'done' ? 100 : percent) + '%';
    const status = row.querySelector('.file-status');
    if (item.state === 'receiving') {
      status.textContent = P.formatBytes(item.received) + ' / ' + P.formatBytes(item.size) +
        (item.speed ? ' · ' + P.formatSpeed(item.speed) : '');
    } else if (item.state === 'done') {
      status.textContent = '已保存 · ' + P.formatBytes(item.received);
    } else if (item.state === 'aborted') {
      status.textContent = '已中断';
    }
  }

  /* ------------------------------------------------------------ 传输引擎 */

  function buildConfig() {
    const settings = state.settings;
    const iceServers = [];
    if (settings.useStun !== false) {
      iceServers.push({ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] });
      iceServers.push({
        urls: [
          'turn:openrelay.metered.ca:80',
          'turn:openrelay.metered.ca:443',
          'turn:openrelay.metered.ca:443?transport=tcp'
        ],
        username: 'openrelayproject',
        credential: 'openrelayproject'
      });
    }
    if (settings.turnUrl) {
      iceServers.push({
        urls: settings.turnUrl,
        username: settings.turnUser || '',
        credential: settings.turnSecret || ''
      });
    }
    return {
      iceServers: iceServers,
      signaling: {
        mode: settings.signalMode || 'cloud',
        host: settings.signalHost || '',
        port: settings.signalPort || 443,
        path: settings.signalPath || '/',
        key: settings.signalKey || 'peerjs',
        secure: settings.signalSecure !== false
      }
    };
  }

  function deviceName() {
    if (state.info.desktop) return '桌面版 · ' + state.info.platform;
    return '网页版 · ' + state.info.platform;
  }

  function handleEvent(type, payload) {
    switch (type) {
      case 'status':
        setStatus(payload.state === 'connected' ? 'connected' : payload.state === 'error' ? 'error' : payload.state === 'boot' ? 'boot' : 'ready', payload.message);
        if (payload.state !== 'connected' && !state.connected) {
          el('sessionBar').hidden = true;
        }
        break;
      case 'code':
        el('myCode').textContent = payload.display;
        el('myCodeHint').textContent = '已就绪';
        break;
      case 'connecting':
        setStatus('busy', '正在连接 ' + payload.target + '…');
        break;
      case 'connected':
        state.connected = true;
        el('sessionBar').hidden = false;
        el('sessionText').textContent = '已建立加密通道 · 等待传输';
        el('transportText').textContent = '协商中';
        setStatus('connected', '已连接');
        el('btnConnect').disabled = true;
        break;
      case 'peer-info':
        el('sessionText').textContent = '已连接 · ' + payload.name;
        break;
      case 'transport':
        el('transportText').textContent = payload.relay ? '经中继转发' : '点对点直连';
        break;
      case 'disconnected':
        state.connected = false;
        el('sessionBar').hidden = true;
        el('btnConnect').disabled = false;
        el('transportText').textContent = 'P2P 直连';
        break;
      case 'notice':
        toast(payload.message, payload.level);
        break;
      case 'send-batch-start':
        state.sending = true;
        updateTotals();
        renderQueue();
        break;
      case 'send-start': {
        const item = findQueueItem(payload.id);
        if (item) {
          item.state = 'sending';
          item.lastTime = performance.now();
          item.lastBytes = 0;
          item.sent = 0;
          scheduleRender(payload.id);
        }
        break;
      }
      case 'send-progress': {
        const item = findQueueItem(payload.id);
        if (!item) break;
        const now = performance.now();
        const deltaBytes = payload.sent - item.lastBytes;
        const deltaTime = now - (item.lastTime || now);
        if (deltaTime > 60) {
          const instant = (deltaBytes / deltaTime) * 1000;
          item.speed = item.speed ? item.speed * 0.72 + instant * 0.28 : instant;
          item.lastTime = now;
          item.lastBytes = payload.sent;
        }
        item.sent = payload.sent;
        item.state = 'sending';
        scheduleRender(payload.id);
        break;
      }
      case 'send-end': {
        const item = findQueueItem(payload.id);
        if (item) {
          item.state = payload.ok ? 'done' : 'error';
          item.error = payload.error || '';
          if (payload.ok) item.sent = item.size;
          scheduleRender(payload.id);
        }
        break;
      }
      case 'send-batch-end':
        state.sending = false;
        if (payload.ok === false && payload.error) toast(payload.error, 'warn');
        else if (payload.ok) toast('发送完成');
        updateTotals();
        break;
      case 'recv-start': {
        const item = {
          id: payload.id,
          name: payload.name,
          size: payload.size,
          received: 0,
          speed: 0,
          lastTime: performance.now(),
          lastBytes: 0,
          state: 'receiving',
          path: ''
        };
        state.recv.unshift(item);
        renderRecv();
        break;
      }
      case 'recv-progress': {
        const item = state.recv.filter(function (entry) { return entry.id === payload.id; })[0];
        if (!item) break;
        const now = performance.now();
        const deltaBytes = payload.received - item.lastBytes;
        const deltaTime = now - (item.lastTime || now);
        if (deltaTime > 80) {
          const instant = (deltaBytes / deltaTime) * 1000;
          item.speed = item.speed ? item.speed * 0.72 + instant * 0.28 : instant;
          item.lastTime = now;
          item.lastBytes = payload.received;
        }
        item.received = payload.received;
        scheduleRecv(payload.id);
        break;
      }
      case 'recv-end': {
        const item = state.recv.filter(function (entry) { return entry.id === payload.id; })[0];
        if (!item) break;
        item.state = payload.ok ? 'done' : 'aborted';
        item.received = payload.size || item.received;
        item.path = payload.path || '';
        state.recvBytes += item.received;
        state.recvCount += 1;
        renderRecv();
        if (payload.ok) toast('已接收：' + item.name);
        break;
      }
      case 'recv-abort': {
        const item = state.recv.filter(function (entry) { return entry.id === payload.id; })[0];
        if (item) {
          item.state = 'aborted';
          renderRecv();
        }
        break;
      }
      default:
        break;
    }
  }

  function scheduleRecv(id) {
    const row = document.querySelector('#recvList .queue-item[data-id="' + id + '"]');
    if (!row) {
      renderRecv();
      return;
    }
    updateRecvRow(id);
  }

  function startEngine() {
    if (state.engine) state.engine.destroy();
    state.engine = window.CDTransfer.create({
      getConfig: buildConfig,
      name: deviceName,
      onEvent: handleEvent
    });
    state.engine.start();
  }

  /* ------------------------------------------------------------ 拖拽与选择 */

  function readEntry(entry, path, out) {
    return new Promise(function (resolve) {
      if (entry.isFile) {
        entry.file(function (file) {
          out.push({ file: file, rel: path ? path + '/' + file.name : '' });
          resolve();
        }, function () { resolve(); });
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        let batch = [];
        const readBatch = function () {
          reader.readEntries(function (entries) {
            if (!entries.length) {
              Promise.all(batch.map(function (child) {
                return readEntry(child, path ? path + '/' + entry.name : entry.name, out);
              })).then(resolve);
              return;
            }
            batch = batch.concat(Array.from(entries));
            readBatch();
          }, function () { resolve(); });
        };
        readBatch();
      } else {
        resolve();
      }
    });
  }

  function handleDrop(event) {
    event.preventDefault();
    el('dropzone').classList.remove('dragover');
    const items = event.dataTransfer && event.dataTransfer.items;
    if (!items || !items.length) {
      addFiles(event.dataTransfer.files, '');
      return;
    }
    const collected = [];
    const promises = Array.from(items).map(function (item) {
      const entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
      if (entry) return readEntry(entry, '', collected);
      const file = item.getAsFile && item.getAsFile();
      if (file) collected.push({ file: file, rel: '' });
      return Promise.resolve();
    });
    Promise.all(promises).then(function () {
      if (!collected.length) return;
      const files = collected.map(function (entry) {
        const file = entry.file;
        if (entry.rel) {
          try {
            Object.defineProperty(file, 'webkitRelativePath', { value: entry.rel, configurable: true });
          } catch {
            /* 只读属性，忽略 */
          }
        }
        return file;
      });
      addFiles(files, '');
    });
  }

  /* ------------------------------------------------------------ 设置面板 */

  function fillSettingsForm() {
    const settings = state.settings;
    el('inpSaveDir').value = state.info.desktop ? (settings.saveDir || '') : '浏览器默认下载目录';
    el('inpSignalMode').value = settings.signalMode || 'cloud';
    el('inpSignalHost').value = settings.signalHost || '';
    el('inpSignalPort').value = settings.signalPort || 443;
    el('inpSignalPath').value = settings.signalPath || '/';
    el('inpSignalSecure').checked = settings.signalSecure !== false;
    el('inpUseStun').checked = settings.useStun !== false;
    el('inpTurnUrl').value = settings.turnUrl || '';
    el('inpTurnUser').value = settings.turnUser || '';
    el('inpTurnSecret').value = settings.turnSecret || '';
    el('customSignal').hidden = (settings.signalMode || 'cloud') !== 'custom';
    el('saveDirField').hidden = !state.info.desktop;
  }

  async function saveSettingsFromForm() {
    const patch = {
      signalMode: el('inpSignalMode').value,
      signalHost: el('inpSignalHost').value.trim(),
      signalPort: Number(el('inpSignalPort').value) || 443,
      signalPath: el('inpSignalPath').value.trim() || '/',
      signalSecure: el('inpSignalSecure').checked,
      useStun: el('inpUseStun').checked,
      turnUrl: el('inpTurnUrl').value.trim(),
      turnUser: el('inpTurnUser').value.trim(),
      turnSecret: el('inpTurnSecret').value.trim()
    };
    state.settings = await P.saveSettings(patch);
    el('settingsDialog').close();
    toast('设置已保存，正在重新连接');
    startEngine();
  }

  /* ------------------------------------------------------------ 绑定 */

  function bind() {
    el('btnPick').addEventListener('click', function (event) {
      event.stopPropagation();
      el('fileInput').click();
    });
    el('btnPickFolder').addEventListener('click', function (event) {
      event.stopPropagation();
      el('folderInput').click();
    });
    el('dropzone').addEventListener('click', function () { el('fileInput').click(); });
    el('dropzone').addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        el('fileInput').click();
      }
    });
    el('fileInput').addEventListener('change', function (event) {
      addFiles(event.target.files, '');
      event.target.value = '';
    });
    el('folderInput').addEventListener('change', function (event) {
      addFiles(event.target.files, '');
      event.target.value = '';
    });

    const dropzone = el('dropzone');
    ['dragenter', 'dragover'].forEach(function (name) {
      dropzone.addEventListener(name, function (event) {
        event.preventDefault();
        dropzone.classList.add('dragover');
      });
    });
    ['dragleave', 'drop'].forEach(function (name) {
      dropzone.addEventListener(name, function (event) {
        event.preventDefault();
        dropzone.classList.remove('dragover');
      });
    });
    dropzone.addEventListener('drop', handleDrop);
    window.addEventListener('dragover', function (event) { event.preventDefault(); });
    window.addEventListener('drop', function (event) { event.preventDefault(); });

    el('btnCopyCode').addEventListener('click', function () {
      const text = window.CDTransfer.displayCode(state.engine ? state.engine.getCode() : el('myCode').textContent);
      navigator.clipboard.writeText(text).then(function () {
        toast('连接码已复制：' + text);
      }).catch(function () {
        toast('复制失败，请手动选择文本', 'warn');
      });
    });

    const codeInput = el('peerCode');
    codeInput.addEventListener('input', function () {
      const raw = window.CDTransfer.normalizeCode(codeInput.value);
      const grouped = raw.length > 4 ? raw.slice(0, 4) + '-' + raw.slice(4, 8) : raw;
      codeInput.value = grouped;
      if (raw.length === 8 && window.CDTransfer.isValidCode(raw)) {
        el('btnConnect').click();
      }
    });
    codeInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        el('btnConnect').click();
      }
    });

    el('btnConnect').addEventListener('click', function () {
      const raw = codeInput.value;
      if (!raw) {
        toast('先输入对方的连接码', 'warn');
        return;
      }
      const ok = state.engine.connect(raw);
      if (ok) codeInput.blur();
    });

    el('btnDisconnect').addEventListener('click', function () {
      state.engine.disconnect();
      el('btnConnect').disabled = false;
    });

    el('btnSend').addEventListener('click', function () {
      if (state.sending) {
        state.engine.cancelSend();
        toast('正在取消发送', 'warn');
        return;
      }
      const pending = state.queue.filter(function (item) { return item.state === 'pending' || item.state === 'error'; });
      if (!pending.length) {
        toast('队列里没有待发送文件', 'warn');
        return;
      }
      if (!state.engine.isConnected()) {
        toast('还没连上对方，先输入对方连接码', 'warn');
        return;
      }
      pending.forEach(function (item) { item.state = 'pending'; item.sent = 0; item.speed = 0; });
      state.sending = true;
      renderQueue();
      state.engine.sendFiles(pending.map(function (item) {
        return { id: item.id, file: item.file, name: item.name, rel: item.rel };
      }));
      updateTotals();
    });

    el('btnClearQueue').addEventListener('click', function () {
      if (state.sending) {
        toast('发送中，不能清空', 'warn');
        return;
      }
      state.queue = [];
      renderQueue();
      updateTotals();
    });

    el('btnSettings').addEventListener('click', function () {
      fillSettingsForm();
      el('settingsDialog').showModal();
    });

    el('inpSignalMode').addEventListener('change', function () {
      el('customSignal').hidden = el('inpSignalMode').value !== 'custom';
    });

    el('btnSaveSettings').addEventListener('click', saveSettingsFromForm);
    el('btnChangeSaveDir').addEventListener('click', async function () {
      const dir = await P.pickSaveDir();
      if (dir) {
        el('inpSaveDir').value = dir;
        el('savePath').textContent = dir;
        el('savePath').title = dir;
      }
    });
    el('btnSaveDir').addEventListener('click', async function () {
      const dir = await P.pickSaveDir();
      if (dir) {
        el('savePath').textContent = dir;
        el('savePath').title = dir;
        toast('接收目录已更新');
      }
    });

    el('btnOpenWebLink').addEventListener('click', async function () {
      if (!state.info.desktop) {
        window.open(REPO_URL, '_blank', 'noopener');
        return;
      }
      try {
        await navigator.clipboard.writeText(WEB_URL);
        toast('网页版地址已复制，可直接发到手机');
      } catch (err) {
        toast('网页版地址：' + WEB_URL);
      }
      window.open(WEB_URL, '_blank', 'noopener');
    });

    window.addEventListener('beforeunload', function () {
      if (state.engine) state.engine.destroy();
    });
  }

  /* ------------------------------------------------------------ 启动 */

  async function boot() {
    const init = await P.init();
    state.settings = init.settings;
    state.info = init.info;

    el('savePath').textContent = state.info.desktop ? (state.settings.saveDir || '—') : '浏览器默认下载目录';
    el('savePath').title = el('savePath').textContent;
    el('versionText').textContent = 'CrossDrop ' + state.info.version + ' · ' + state.info.platform;
    el('btnSaveDir').hidden = !state.info.desktop;
    el('btnOpenWebLink').hidden = false;
    el('btnOpenWebLink').textContent = state.info.desktop ? '手机/网页版入口' : '获取桌面版';

    if (!window.Peer) {
      setStatus('error', '传输组件缺失');
      toast('缺少 peerjs 组件，请重新安装应用', 'error');
      return;
    }

    bind();
    startEngine();
    renderQueue();
    renderRecv();
    updateTotals();
  }

  /* 调试/自动化测试用的轻量接口（不参与正常交互） */
  window.CDApp = {
    code: function () { return state.engine ? state.engine.getCode() : ''; },
    connected: function () { return !!state.connected; },
    status: function () { return el('statusText').textContent; },
    addFiles: function (files) { addFiles(files, ''); },
    send: function () { el('btnSend').click(); },
    isSending: function () { return state.sending; },
    connect: function (code) { return state.engine.connect(code); },
    queue: function () {
      return state.queue.map(function (item) {
        return { id: item.id, name: item.name, size: item.size, state: item.state, sent: item.sent };
      });
    },
    recv: function () {
      return state.recv.map(function (item) {
        return { id: item.id, name: item.name, size: item.size, state: item.state, received: item.received, path: item.path };
      });
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
