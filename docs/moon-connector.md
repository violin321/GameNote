# Moon 日报连接

Moon 使用 Nintendo Switch Parental Controls 的独立授权，直接读取 Nintendo 的主机与日报接口，不依赖 Fancy、NSO 登录或 NSO 的 f/encrypt/decrypt 服务。账号需要先在官方家长控制 App 中关联主机。现有 NSO 会话不能复用，其他部署保存的凭据不应在实例之间复制。

## 数据与界面

采集器返回 `gamenote.moon.daily.v1` 快照，包含安装范围内的匿名账号、主机标识，以及官方日期、时区、当日状态和每款游戏秒数。当前链路按主机与游戏统计，不提供玩家明细或月报。日报可能延迟、修订，今天的数据尤其可能变化；不保证获取全部历史。

导入在单个数据库事务中更新日报修订，同一主机同一天替换已有值，重放不会叠加时长。Moon 的 `play_games` 来源行通过 `source_bindings` 进入稳定的 `game_entities` 游戏档案，因此最近游玩、历史游玩和关联收藏共享同一身份，但日报证据仍与 Store 累计、Coral 快照和手动会话分开保存。已确认或拒绝的收藏关联不会被再次同步覆盖。日报是按天汇总，不生成精确开始／结束时间，也不与可能重叠的累计值或手动时长相加。完整口径见 `docs/moon-data-model.md`。

设置页区分采集状态与导入状态：`lastSuccessAt` 是采集器抓取成功时间，`importState.lastImportedAt` 是应用写库时间。抓取成功而导入失败时，不能把抓取时间当作数据已经更新。

## 本地启用

需要 Node.js 22.13+。先备份所选 NS2 数据库，再运行既有 `npm run migrate:play`，安装当前数据结构（包括 Moon 日报与统一游戏实体）。路由不会擅自迁移数据库。

示例使用独立的用户运行目录；初始化输出只有路径，不包含密钥：

```sh
node services/moon-sidecar/cli.mjs init --directory '/absolute/private/gamenote-moon'
node services/moon-sidecar/cli.mjs serve --directory '/absolute/private/gamenote-moon'
```

应用进程配置：

```dotenv
MOON_SIDECAR_SOCKET_PATH=/absolute/private/gamenote-moon/run/sidecar.sock
MOON_SIDECAR_API_KEY_FILE=/absolute/private/gamenote-moon/secrets/api-key
MOON_AUTO_SYNC_ENABLED=1
MOON_SCHEDULER_STATE_FILE=/absolute/private/gamenote-moon/state/app-scheduler.sqlite
```

路径必须按实际安装目录填写；密钥文件内容不放进浏览器环境变量、日志或 Git。重启应用后，在设置页完成单独的家长控制授权。密钥、授权会话及原始运行状态独立保存在采集器目录；应用只通过 Unix socket 的带密钥端点访问它。

## 自动同步

应用是唯一的自动任务执行者。`MOON_AUTO_SYNC_ENABLED=1` 明确启用后，Node 服务启动钩子启动后台定时器，每 30 秒检查持久化到期时间。成功抓取并导入后间隔 6 小时；失败通常 5 分钟后重试，并尊重上游限流提示（最长 6 小时）。采集成功后仍必须读取规范化快照并成功导入，才记录任务成功。

生产环境默认关闭。启用时必须显式配置绝对路径 `MOON_SCHEDULER_STATE_FILE`，使用持久化本地磁盘并让所有应用进程共享同一文件；该文件不能是 `ns2.sqlite` 或 `records.sqlite`。不要在不同主机、不共享磁盘的副本分别启动调度。此方案面向常驻 Node 服务，不适用于随请求冻结的 serverless 实例。

独立 SQLite 文件保存下次到期时间、脱敏错误及运行租约，不保存授权凭据。手动同步、自动同步、回调和断开连接使用同一个租约，避免多个 worker 或开发热更新重复执行。租约持续续期，异常退出后可恢复；重启不会清除成功间隔或失败退避。数据库导入本身也具备重放保护。

**不要同时给 sidecar 加 `--scheduler`。** sidecar 的独立定时器只会更新快照，不能导入 GameNote；应用发现 sidecar 定时器已开启会返回 `scheduler_conflict`。仅手动模式无需启用自动任务，租约文件默认位于所选应用数据库旁的 `moon-scheduler.sqlite`。

## API 与验证

`GET /api/moon-connector/status`；`POST /api/moon-connector/authorize`、`callback`、`sync`、`disconnect`。全部要求当前注册管理员的有效会话，写入要求同源 Origin，并限制请求体与频率。回调只接受 POST JSON 的唯一 `callbackUrl` 字段（最多 4096 字符），拒绝查询字符串、额外字段及超限请求；不回显或记录回调内容。

授权地址只允许 Nintendo 官方域名及 Moon client ID `54789befb391a838`。Unix socket 客户端限制响应大小、请求总时限和公开错误码，浏览器状态不透传任意上游字段。

```sh
npm test -- tests/moon-runtime.test.ts tests/moon-import.test.ts tests/moon-sidecar-client.test.ts tests/moon-scheduler.test.ts tests/moon-route-security.test.ts
```

测试使用隔离数据库和构造响应，验证安全边界、重复导入、日报修订、关联保留、失败重试、多进程租约与重启到期时间。真实账号验收另需完成本地 Moon 授权并核对官方日报；测试通过不代表已部署到生产环境或已启用生产定时任务。
