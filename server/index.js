'use strict';

/*
 * CrossDrop 自建服务：信令 + 中继二合一。
 *
 *   node server/index.js --port 9000 --token 你的口令
 *
 * 客户端连不上对方时，可以把文件数据整段经这个服务转发，
 * 因此双方都在严格 NAT / 公司网 / 校园网里也能传。
 * 只依赖 ws，不依赖任何第三方云服务。
 */

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');

/* ------------------------------------------------------------ 启动参数 */

const argv = process.argv.slice(2);

function arg(name, fallback) {
  const index = argv.indexOf('--' + name);
  if (index >= 0 && argv[index + 1]) return argv[index + 1];
  const inline = argv.find((item) => item.startsWith('--' + name + '='));
  if (inline) return inline.split('=').slice(1).join('=');
  return fallback;
}

const PORT = Number(arg('port', process.env.CROSSDROP_PORT || 9000));
const HOST = arg('host', '0.0.0.0');
const TOKEN = arg('token', process.env.CROSSDROP_TOKEN || '');
const CERT = arg('cert', '');
const KEY = arg('key', '');
const MAX_PAYLOAD = 1024 * 1024 * 4;

if (TOKEN) {
  console.log('[crossdrop] 口令校验已开启');
} else {
  console.log('[crossdrop] 未设置口令：服务公开可用，建议用 --token 或环境变量 CROSSDROP_TOKEN 设一个');
}

/* ------------------------------------------------------------ HTTP 状态页 */

function handleHttp(req, res) {
  const url = req.url || '/';
  if (url.startsWith('/health')) {
    const payload = {
      ok: true,
      service: 'crossdrop-relay',
      hosts: hosts.size,
      pairs: sessions,
      uptime: Math.round(process.uptime()),
      version: require('../package.json').version
    };
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
    return;
  }

  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(
    [
      'CrossDrop 自建服务正在运行。',
      '',
      'WebSocket 地址：ws://<本机地址>:' + PORT + '/ws',
      TOKEN ? '访问口令：已开启（客户端设置里填写同一个口令）' : '访问口令：未设置',
      '健康检查：/health',
      '',
      '客户端设置里把「连接方式」选为「自建服务」，填入上面的地址即可。'
    ].join('\n')
  );
}

/* ------------------------------------------------------------ 配对与转发 */

const hosts = new Map();
let sessions = 0;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function sendJson(ws, payload) {
  if (ws && ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      /* 对端已断 */
    }
  }
}

function linkPartner(ws) {
  const partner = ws.partner;
  ws.partner = null;
  if (!partner || partner.readyState !== 1) return;
  partner.partner = null;
  sendJson(partner, { t: 'peer-close', reason: ws.closeReason || 'closed' });
}

/* ------------------------------------------------------------ 服务实例 */

const serverFactory = CERT && KEY ? https : http;
const options = CERT && KEY ? { cert: fs.readFileSync(path.resolve(CERT)), key: fs.readFileSync(path.resolve(KEY)) } : {};
const server = serverFactory.createServer(options, handleHttp);

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_PAYLOAD });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url || '/ws', 'http://localhost');
  const params = url.searchParams;

  if (TOKEN && params.get('token') !== TOKEN) {
    sendJson(ws, { t: 'error', reason: 'token' });
    ws.close(4001, 'token');
    return;
  }

  const role = params.get('role') === 'guest' ? 'guest' : 'host';
  const code = String(params.get('code') || '').toLowerCase();
  const target = String(params.get('target') || '').toLowerCase();

  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });

  if (role === 'host') {
    if (!code) {
      sendJson(ws, { t: 'error', reason: 'code' });
      ws.close(4002, 'code');
      return;
    }

    const previous = hosts.get(code);
    if (previous && previous !== ws) {
      previous.closeReason = 'superseded';
      try {
        previous.close(4003, 'superseded');
      } catch {
        /* 已关闭 */
      }
    }

    hosts.set(code, ws);
    ws.code = code;
    log('host 上线', code);
    sendJson(ws, { t: 'registered', code });

    ws.on('close', () => {
      if (hosts.get(code) === ws) hosts.delete(code);
      log('host 下线', code);
      linkPartner(ws);
    });
  } else {
    const host = hosts.get(target);
    if (!host) {
      sendJson(ws, { t: 'error', reason: 'no-host' });
      ws.close(4004, 'no-host');
      return;
    }

    sessions += 1;
    host.partner = ws;
    ws.partner = host;
    log('配对成功', target, '会话', sessions);
    sendJson(host, { t: 'ready', side: 'host' });
    sendJson(ws, { t: 'ready', side: 'guest' });

    ws.on('close', () => {
      log('guest 下线', target);
      linkPartner(ws);
    });
  }

  ws.on('message', (data, isBinary) => {
    const partner = ws.partner;
    if (!partner || partner.readyState !== 1) return;
    partner.send(data, { binary: isBinary });
  });

  ws.on('error', () => {
    /* 客户端异常断开，close 里统一收尾 */
  });
});

/* 心跳：清掉掉线的连接，避免主机位被占死 */
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.alive === false) {
      ws.terminate();
      return;
    }
    ws.alive = false;
    try {
      ws.ping();
    } catch {
      /* 忽略 */
    }
  });
}, 30000);

server.on('close', () => clearInterval(heartbeat));

server.listen(PORT, HOST, () => {
  log('CrossDrop 服务已启动');
  log('监听 http://' + HOST + ':' + PORT + '/ （WebSocket: /ws）');
});
