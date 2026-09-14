# Moon 日报连接器

Moon 连接器使用 Nintendo Switch Parental Controls（家长控制）客户端的独立 OAuth 流程，读取已关联主机的每日游玩摘要。它不依赖 Fancy、Nintendo Switch Online 登录或第三方签名服务。

> Nintendo 没有把这些 Moon 接口作为稳定的公共开发者 API 发布。客户端版本、请求头、返回结构或授权要求都可能变化；升级连接器后应重新运行测试，并准备让管理员重新授权。

## 能力边界

- 获取 Nintendo 提供的主机列表与按官方日期汇总的日报。
- 保存每款游戏的当日秒数、日报状态、官方时区偏移和日报修订时间。
- 把 Moon 游戏接入统一 `play_games` 数据链，供最近游玩、历史游玩和收藏关联使用。
- 不生成虚假的开始／结束时间，也不把日报当作 Nintendo Store 的累计游玩时长。
- 不导入玩家昵称、玩家 ID 或原始 Nintendo 账号 ID。

账号必须先在 Nintendo 官方家长控制 App 中关联至少一台主机。NSO 或 Nintendo Store 的既有会话不能直接替代 Moon 授权。

## 协议参数与凭据

源码中的 Moon client ID、重定向 scheme、移动端版本、固定端点和请求头是官方客户端使用的公开协议兼容参数，**不是某个安装或账号的凭据**。

官方移动端的 OAuth scope 名称中包含管理或更新能力。连接器不会因此调用写接口：网络边界只允许 OAuth token 交换、账号读取、主机列表和日报列表，并且 Moon 数据接口只允许 `GET`。任意其他主机、路径、查询参数、重定向或写请求都会被拒绝。

真正敏感的数据包括 session token、access token、PKCE verifier、sidecar API key、加密主密钥、安装伪名密钥和加密运行状态。这些值只应保存在本机私有运行目录中，不应写入环境文件、日志、数据库快照、Issue 或 Git。

## 本地配置

需要支持 `node:sqlite` 的 Node.js 版本。推荐为 sidecar 使用独立目录：

```sh
export MOON_RUNTIME_DIR="$PWD/.gamenote-private/moon"
node services/moon-sidecar/cli.mjs init
node services/moon-sidecar/cli.mjs serve
```

`init` 只输出创建后的路径，不输出密钥内容。应用进程使用绝对路径连接 sidecar：

```dotenv
MOON_SIDECAR_SOCKET_PATH=/absolute/path/to/.gamenote-private/moon/run/sidecar.sock
MOON_SIDECAR_API_KEY_FILE=/absolute/path/to/.gamenote-private/moon/secrets/api-key
MOON_SCHEDULER_STATE_FILE=/absolute/path/to/.gamenote-private/moon/state/app-scheduler.sqlite
MOON_AUTO_SYNC_ENABLED=1
MOON_LOCALE=en-US
MOON_TIME_ZONE=UTC
```

上面的单目录模式适合本地开发：应用需要读取其中的 API key 文件，但不应读取整个目录。生产部署应把 sidecar 私有目录与 IPC 目录分开。Compose 已按此方式配置：`moon-runtime` 只挂载到 sidecar，保存主密钥、安装伪名密钥和加密状态；`moon-ipc` 才同时挂载给应用和 sidecar，只包含 API key 与 Unix socket。对应的手工配置为：

```sh
export MOON_RUNTIME_DIR="$PWD/.gamenote-private/moon"
export MOON_IPC_DIRECTORY="$PWD/.gamenote-private/moon-ipc"
node services/moon-sidecar/cli.mjs init \
  --directory "$MOON_RUNTIME_DIR" \
  --ipc-directory "$MOON_IPC_DIRECTORY"
node services/moon-sidecar/cli.mjs serve \
  --directory "$MOON_RUNTIME_DIR" \
  --ipc-directory "$MOON_IPC_DIRECTORY"
```

分目录模式下，应用只配置 IPC 路径；调度租约应放在应用自己的可持久化目录：

```dotenv
MOON_SIDECAR_SOCKET_PATH=/absolute/path/to/.gamenote-private/moon-ipc/run/sidecar.sock
MOON_SIDECAR_API_KEY_FILE=/absolute/path/to/.gamenote-private/moon-ipc/secrets/api-key
MOON_SCHEDULER_STATE_FILE=/absolute/path/to/app-data/private/moon-app/scheduler.sqlite
```

`MOON_IPC_DIRECTORY` 未配置时，CLI 会回退到 `MOON_RUNTIME_DIR`，保持单目录模式兼容。不要把 sidecar 私有目录挂载到 GameNote 应用容器。

`MOON_LOCALE` 必须是有效的 BCP 47 locale，`MOON_TIME_ZONE` 必须是运行时支持的 IANA 时区。默认值分别为 `en-US` 和 `UTC`；配置无效时连接器会失败关闭，而不是静默使用某台机器的本地设置。

应用数据库仍由现有 `APP_DATABASE_FILE`（或兼容的 `SWITCH_LEDGER_DATABASE_FILE`）选择。通用 `play_*` 表与 Moon 专用审计表分别由各自 schema 以幂等方式创建。

## 管理员 API

| 方法   | 路径                             | 用途                                 |
| ------ | -------------------------------- | ------------------------------------ |
| `GET`  | `/api/moon-connector/status`     | sidecar、调度器和数据库导入状态      |
| `POST` | `/api/moon-connector/authorize`  | 创建或复用待完成的 OAuth 授权        |
| `POST` | `/api/moon-connector/callback`   | 提交 Nintendo 自定义 scheme 回调 URL |
| `POST` | `/api/moon-connector/sync`       | 抓取规范化快照并原子导入             |
| `POST` | `/api/moon-connector/disconnect` | 删除授权凭据和 sidecar 快照          |

所有端点要求现有管理员会话。写操作还要求同源请求，并限制请求体大小；回调只接受唯一的 `callbackUrl` JSON 字段，不回显其内容。

## 仓库卫生

不要提交以下内容：

- `.gamenote-private/`、真实 `.env` 或部署专用配置；
- `secrets/`、`state/`、session token、授权回调 URL 或浏览器复制内容；
- SQLite 数据库及其 `-wal`、`-shm` 文件；
- Unix socket、日志、数据库备份或真实账号导出的快照。

可运行的定向测试：

```sh
npx vitest run tests/moon-runtime.test.ts tests/moon-sidecar-client.test.ts \
  tests/moon-scheduler.test.ts tests/moon-route-security.test.ts tests/moon-import.test.ts
```
