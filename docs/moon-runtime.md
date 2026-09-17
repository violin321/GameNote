# Moon 本地只读采集服务

Moon 使用 Nintendo Switch 家长控制的独立授权，客户端 ID 为 `54789befb391a838`。用户须先在官方家长控制 App 中关联主机。NSO 登录不能复用为 Moon 授权。本服务不使用 Fancy，不加载远程配置，也不修改主机家长控制设置。

## 启动

要求 Node.js 22.13 或更高版本、Unix socket 和当前用户拥有的私有目录。目录不要放进 Git 仓库；macOS socket 路径长度有限，请保持路径简短。

```sh
node services/moon-sidecar/cli.mjs init --directory /absolute/private/gamenote-moon
node services/moon-sidecar/cli.mjs serve --directory /absolute/private/gamenote-moon
```

`init` 以独占创建方式生成三个互不相同的随机 32 字节密钥，不覆盖已有密钥。目录权限必须是 `0700`；密钥文件、加密状态文件和 socket 权限为 `0600`。拒绝符号链接、不安全权限、其他用户所有权和密钥复用。密钥文件内容为 base64url 文本。

GameNote 服务端配置：

```dotenv
MOON_SIDECAR_SOCKET_PATH=/absolute/private/gamenote-moon/run/sidecar.sock
MOON_SIDECAR_API_KEY_FILE=/absolute/private/gamenote-moon/secrets/api-key
```

master-key 和 installation-key 仅供 sidecar 读取，不能提供给前端。GameNote 只需 socket 与 API key。凭据、PKCE 待授权状态、规范化快照和运行状态统一以 AES-256-GCM 加密保存在 `state/moon-state.enc`；access token 仅保留于当前请求内存。API key 与加密密钥独立，installation-key 决定账号、设备的稳定假名，备份/迁移时必须保留该密钥才能维持映射。

生产建议让进程管理器持久运行 `serve` 并按失败重启。本实现不会安装系统服务，也不会操作宿主机或云平台配置。停止进程不会删除授权，下次启动从加密文件恢复；断开连接才清除本 sidecar 保存的凭据、待授权与快照。断开不会远程撤销 Nintendo App 授权，也不会删除 GameNote 已导入历史。

## 授权和接口

除健康检查外所有接口都要求 `Authorization: Bearer <api-key>`，仅绑定 Unix socket，不启用 TCP。错误只返回固定安全错误码，不能返回 Nintendo 响应、身份或凭据。所有响应 `Cache-Control: no-store`。

| 方法/路径                 | 请求                   | 响应                                                      |
| ------------------------- | ---------------------- | --------------------------------------------------------- |
| GET `/healthz`            | 无                     | `{ "status": "ok" }`                                      |
| GET `/v1/status`          | 已认证                 | `lib/moon/types.ts` 的 `MoonStatus`                       |
| POST `/v1/auth/authorize` | 已认证                 | `{ authorizationUrl, expiresAt }`，expiresAt 为毫秒时间戳 |
| POST `/v1/auth/callback`  | JSON `{ callbackUrl }` | 204                                                       |
| POST `/v1/sync`           | 已认证                 | `MoonSnapshot`                                            |
| GET `/v1/snapshot`        | 已认证                 | 上次完整成功快照；无快照为 404                            |
| DELETE `/v1/link`         | 已认证                 | 204                                                       |

授权使用随机 state、S256 PKCE 和 15 分钟有效期。重复发起会返回尚未过期的同一次授权，避免破坏用户已打开的 Nintendo 登录页。回调必须是 `npf54789befb391a838://auth`，严格校验域、state、重复参数与有效期；state 校验成功的 code 会在请求 Nintendo 前持久化为已消费，失败后也不能重放。成功取得的 token 检查 Moon audience 和有效期，随后直接向 Nintendo 读取账号身份，才保存连接。回调链接最大 4096 字符，请求体最大 8 KiB。浏览器 Origin 请求被拒绝，前端必须经过 GameNote 服务端。

## 采集和数据口径

固定直连地址：

- POST `https://accounts.nintendo.com/connect/1.0.0/api/session_token`
- POST `https://accounts.nintendo.com/connect/1.0.0/api/token`
- GET `https://api.accounts.nintendo.com/2.0.0/users/me`
- GET `https://api-lp1.pctl.srv.nintendo.net/moon/v1/users/{id}/devices`
- GET `https://api-lp1.pctl.srv.nintendo.net/moon/v1/devices/{id}/daily_summaries`

每次 sync 重新换取短期 access token，再取全部当前可用日报。整次采集 120 秒截止，超时会中止 HTTPS 请求且不保存半批快照；单请求 15 秒总超时、8 MiB 响应上限；最多 16 台设备，每台最多 400 份日报。只有幂等 GET 的临时网络/上游失败重试一次；OAuth code 不重试。未启用任何自定义 URL、代理环境变量、重定向、远程配置或生产 fixture 开关。应用身份固定为已验证的 Android Moon `2.4.0`、build `660`；未来 Nintendo 强制升级时需要审核后更新代码。

规范化基于 [nxapi 固定版本的 Moon 类型](https://github.com/samuelthomas2774/nxapi/blob/ec69f589c8671614c870014bf02634908d232676/src/api/moon-types.ts) 及其 [日报显示代码](https://github.com/samuelthomas2774/nxapi/blob/ec69f589c8671614c870014bf02634908d232676/src/cli/pctl/daily-summaries.ts)：`playingTime` 本身单位是秒。`playedApps` 只提供标题信息，每个游戏的日报时长从 `devicePlayers[].playedApps[]` 与 `anonymousPlayer.playedApps[]` 聚合。保持设备日报总时长独立，不强行等同于各玩家游戏时长之和，不生成精确游玩起止时间，不把未知历史补成零。缺失必要标题、日期异常、重复日报等均拒绝整批快照，保留上次成功快照。

Moon 设备日报的 `date`、`timeZoneUtcOffsetSeconds`、`result` 原样保留；当天 `CALCULATING` 数据以后可能更正。Moon Unix 秒时间戳转为 ISO 时间，也兼容明确的毫秒数值，避免把秒当成毫秒显示为 1970 年。只有官方明确提供时长的标题才可构成完整快照，缺失玩家时长的标题不能默认算零；明确返回空游戏列表的零时长日期正常保留。保留所有返回的日期以便上层幂等修订导入。账号和设备 ID 由 installation-key 做带域区分的 HMAC；快照不包含原始账号、主机序列号、玩家 ID、昵称、配对码或凭据。游戏 applicationId 是公开标题标识，规范为 `moon:<16 位小写十六进制 ID>`，导入时还需在 accountScope 内隔离关联。

## 自动运行

GameNote 的自动同步须同时完成采集和数据库导入，应由应用统一调度；默认 **sidecar 不调度**，其 `scheduler.enabled=false`、`nextSyncAt=null`。按 app scheduler 的部署文档配置 `MOON_AUTO_SYNC_ENABLED=1`。

仅在独立采集、由其他系统负责导入的场景可以显式添加 `serve --scheduler`：实际循环每 6 小时采集一次，失败 5 分钟后重试，日程与安全错误随加密状态持久化。启动时已有授权且无计划会立即安排；未连接时不调度。不能与 `MOON_AUTO_SYNC_ENABLED=1` 同时启动，避免双重调度。关闭进程时循环停止，不宣称离线进程仍会执行。手动 sync 失败不会消费 6 小时冷却；并发授权、回调、同步、断开在服务内串行保护。

## 验证

```sh
npx vitest run tests/moon-runtime.test.ts
```

测试仅通过构造函数注入内存 transport/store，不读取或提交真实 Nintendo 凭据。覆盖秒单位、匿名玩家合并、官方日期、账号假名、异常数据、OAuth state/PKCE/audience/单次消费、固定端点、只读重试、加密/文件权限、Unix 认证、失败恢复与实际调度。
