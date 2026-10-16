# 发布管理

单臂、双臂客户端和 Windows 后台的 Velopack 发布后台。页面用 Vue 3 和 Element Plus，接口用 Node.js。安装包放在本机磁盘，版本、灰度和设备记录放在 SQLite。

客户端自己请求 `releases.win.json` 和 `.nupkg`。管理页面负责上传、合并清单、查看历史、下线和按设备放行。

## 环境

- Node.js 24（使用内置的 `node:sqlite`）
- 在项目目录执行过一次 `npm install`

## 启动

开发时页面走 Vite，接口走 5088：

```powershell
cd D:\Users\27540\source\repos\RobotReleaseAdmin
npm install
npm run dev
```

浏览器打开 http://localhost:5173 。Vite 把 `/api` 和 `/updates` 转到 http://127.0.0.1:5088 。

给现场用时，先构建页面，再由 Node 一起提供页面和接口：

```powershell
npm start
```

浏览器打开 http://localhost:5088 。

## 登录

| 账号 | 初始密码 | 权限 |
| --- | --- | --- |
| admin | change-me | 上传、发布、下线、改灰度 |
| operator | change-me | 查看、导出离线包、看设备日志 |

流水线使用 `server/config.json` 里的 `token`，请求头 `Authorization: Bearer change-me`。部署前把两个密码和 `token` 都改掉。也可以用环境变量覆盖：`PORT`、`DATA_ROOT`、`ADMIN_USER`、`ADMIN_PASSWORD`、`OPERATOR_PASSWORD`、`ADMIN_TOKEN`。

从本机部署到一台 Windows 的 Docker，或更新已经在跑的 Ubuntu，按 [运维.md](运维.md) 从第 1 步做。下面是 Ubuntu 上的补充说明。

## Docker 部署到 Ubuntu

镜像基于 Node.js 24。页面在构建镜像时打进包里，容器只跑一个进程，同时提供管理页面和 `/updates`。SQLite 和安装包在挂载的 `data/` 里，重建容器不会清掉。

Ubuntu 上安装 Docker Engine 和 Compose 插件后，把这个项目目录拷过去（不要带本机的 `node_modules`）。在项目目录：

```bash
cp .env.example .env
```

编辑 `.env`，把 `ADMIN_PASSWORD`、`OPERATOR_PASSWORD`、`ADMIN_TOKEN` 改成现场自己的值。`ADMIN_TOKEN` 就是 Azure 管道里的 `ReleaseAdminToken`。然后：

```bash
docker compose up -d --build
```

浏览器打开 `http://这台电脑的IP:5088`。客户端和后台的更新目录写成 `http://这台电脑的IP:5088/updates/single-arm/stable/`，程序名按实际替换。管道的 `adminUrl` 也填这个根地址，不要带 `/updates` 或 `/api`。

当前现场机器是 `192.168.99.54`，页面为 http://192.168.99.54:5088 。这台机器拉镜像和重新构建要走代理 `http://192.168.99.5:7897`。维护命令见 [运维.md](运维.md)。

要换主机端口时，只改 `.env` 里的 `HOST_PORT`，容器内部仍是 5088。Ubuntu 开了防火墙时放行该端口。

已有 Windows 上的发布数据时，在第一次启动前把原来的 `data` 目录整个拷到 Ubuntu 项目下的 `data`。里面要有 `admin.db` 和 `feeds`。拷完再 `docker compose up -d`。

查看日志和停止：

```bash
docker compose logs -f
docker compose down
```

`docker compose down` 不删除 `data/`。

## 程序和通道

| 程序 | id |
| --- | --- |
| 单臂客户端 | `single-arm` |
| 双臂客户端 | `dual-arm` |
| 单臂后台 | `single-arm-backend` |
| 双臂后台 | `dual-arm-backend` |

每个程序有三条通道：`stable` 正式、`beta` 公测、`canary` 试点。清单文件始终是 `releases.win.json`。通道体现在目录上，不体现在文件名上。

客户端更新目录：

```text
http://localhost:5088/updates/single-arm/stable/
```

Velopack 会请求这个目录下的 `releases.win.json`。`/updates/single-arm/` 等同于正式通道。

按设备看灰度或草稿时，把目录写成：

```text
http://localhost:5088/updates/single-arm/stable/d/{设备ID}/
```

不带设备 ID 的地址只返回已全量发布的版本。草稿只有白名单里的设备或 IP 能看到。已下线的版本从清单消失，文件仍留在磁盘上。

最低兼容版本在「灰度策略」里设置，客户端另读：

```text
http://localhost:5088/updates/single-arm/stable/policy.json
```

这个字段不写进 `releases.win.json`。

## 上传规则

版本号用 `1.2.3`，可以带 `-beta.1` 这种预发布号。不能使用 `20261012.1530` 这种日期号，也不能比该通道里已有的最高版本更旧。再次上传同一个版本会替换它。

可以上传单个全量 `.nupkg`、可选差分包、可选 `releases.win.json`、可选 `Setup.exe`，也可以上传 `vpk pack` 打出来的 zip。版本号能从 `程序名-1.2.3-full.nupkg` 解析出来时可以留空。上传清单里的 SHA1、SHA256、大小会和文件比对，不一致则整次上传失败。清单里更旧的版本不会覆盖服务器上已有记录。

单个文件上限 4 GB。

流水线示例：

```powershell
curl.exe -X POST http://localhost:5088/api/apps/single-arm/versions `
  -H "Authorization: Bearer change-me" `
  -F "channel=stable" `
  -F "version=1.2.3" `
  -F "notes=修复夹线" `
  -F "status=active" `
  -F "fullPackage=@single-arm-1.2.3-full.nupkg" `
  -F "deltaPackage=@single-arm-1.2.3-delta.nupkg" `
  -F "feed=@releases.win.json"
```

`status` 省略时按已发布处理。设为 `draft` 时只有白名单能下载。

## 设备上报

客户端检查更新时可以匿名上报。超过 5 分钟没有心跳，页面上记为离线。

```json
POST /api/v1/client/heartbeat
{
  "appId": "single-arm",
  "deviceId": "pc-01",
  "machineName": "一线",
  "version": "1.2.3",
  "os": "Windows",
  "group": "A",
  "channel": "stable"
}
```

```json
POST /api/v1/client/update-log
{
  "appId": "single-arm",
  "deviceId": "pc-01",
  "event": "Failed",
  "version": "1.2.3",
  "message": "磁盘满了",
  "progress": 40
}
```

`event` 只能是 `UpdateStarted`、`DownloadProgress`、`AppliedSuccess`、`Failed`。`deviceId` 使用字母、数字、`.`、`_`、`:`、`-`，最长 80 个字符。

## 数据目录

`data/` 不进入版本库。

```text
data/
  admin.db
  feeds/
    single-arm/
      stable/
        releases.win.json
        policy.json
        single-arm-1.2.3-full.nupkg
      beta/
      canary/
```

直接拷贝 `feeds` 目录时，只有已全量发布的版本。百分比灰度和草稿白名单要经过本服务的 `/updates/...` 地址才会生效。

## 测试

```powershell
npm test
```
