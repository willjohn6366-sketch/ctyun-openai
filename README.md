# CT API

CT API 是一个反代平台，将云电脑中的 AI 应用无缝转换为兼容接口形态，实现跨平台、跨软件的通用化调用。它突破了 AI 应用仅限于云电脑内部使用的局限，使 AI 能力可以更方便地接入各类第三方软件与开发环境，做到一次部署、处处可用。

项目包含一个本地管理面板和兼容接口服务，默认启动后可通过浏览器进行账号配置、令牌管理、服务开关和模型查看。

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
