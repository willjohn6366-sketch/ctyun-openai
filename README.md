# CT API

自用测试

## 启动方式

### 传统方式

要求：

- Node.js 18 或更高版本

启动命令：

```bash
npm install
npm run build
npm start
```

启动后默认访问：

```text
http://127.0.0.1:3000
```

### Docker 方式

如果本机已安装 Docker，可以直接使用官方 Node 镜像运行。下面的命令会显式映射 `data` 目录，用于持久化账号配置和本地用量统计：

```bash
docker run -d \
  --name ct-api \
  --restart unless-stopped \
  -p 3000:3000 \
  -v "$PWD":/app \
  -v "$PWD/data":/app/data \
  -w /app \
  node:20 \
  sh -c "npm install && npm run build && npm start"
```

也可以直接使用 `docker compose`：

```bash
docker compose up -d
```

启动后默认访问：

```text
http://127.0.0.1:3000
```
初始账号：admin

初始密码：admin
