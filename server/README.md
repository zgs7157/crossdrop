# CrossDrop 自建服务

信令 + 中继二合一，一个 Node 进程搞定。跨局域网、公司网、校园网互传时，客户端会自动把数据经这里转发。

## 运行

```bash
npm install
npm start                       # 默认 9000 端口，无口令
node index.js --port 9000 --token 你的口令
```

参数：`--port`、`--host`、`--token`，也可以走环境变量 `CROSSDROP_PORT` / `CROSSDROP_TOKEN`。
需要 `wss://` 时传 `--cert 证书.pem --key 私钥.pem`，或放在 Nginx 后面反代。

## 验证

浏览器打开 `http://服务器地址:9000/health`，应返回：

```json
{"ok":true,"service":"crossdrop-relay","hosts":0,"pairs":0,"uptime":12,"version":"1.0.1"}
```

## 客户端怎么填

CrossDrop 右上角「设置」：

- 自建服务地址：`ws://服务器地址:9000/ws`（HTTPS 反代下填 `wss://域名/ws`）
- 访问口令：与 `--token` 一致
- 连接方式：「先直连，连不上自动走中继」

双方必须填同一个地址与口令。

## 说明

- 数据只在两端和这台服务器之间流动，不经任何第三方云。
- 一对连接占用一条 WebSocket 双向转发；带宽就是转发上限。
- 只依赖 `ws` 一个包（MIT）。
