# Nintendo Store 游玩历史后端

这个切片提供 Nintendo Account 授权、累计游玩时长同步、滚动日报保存和审计快照。它只依赖通用游玩历史与管理员会话，不包含任何账号、Token、服务器地址或生产数据。

> Nintendo Store 接口不是稳定的公共开发者 API。上游客户端或接口调整后，可能需要重新授权或更新固定的请求格式。

## 私有数据目录

必须显式配置一个绝对路径；未配置、相对路径或文件系统根目录都会返回 `not_configured`：

```dotenv
NINTENDO_STORE_DATA_DIR=/srv/gamenote/private/nintendo-store
```

目录用于保存：

- `pending.json`：15 分钟有效的 PKCE state 与 verifier。
- `secret.key`：本地随机生成的 256 位加密密钥。
- `session.enc`：AES-256-GCM 加密的长期 Nintendo session token。
- `scheduler.sqlite`：跨 worker 的低频同步租约、退避与脱敏错误码。

进程会将目录权限收紧为 `0700`、凭据文件收紧为 `0600`，并拒绝符号链接目录或不属于当前进程用户的目录。不要把这个目录放进 Git、公开备份、共享卷或 Web 根目录。

## 授权与权限范围

授权使用 Nintendo Store 客户端的 PKCE `S256` 流程。当前 scope 为：

```text
openid user user.mii user.links[].id
```

游玩历史不需要邮箱权限，因此不申请邮箱 scope。回调只接受 Nintendo 自定义 scheme URL，并同时校验一次性 state；state 在交换 code 前即被销毁，避免回放。

## 管理员 API

所有端点都返回 `Cache-Control: no-store`，写操作要求管理员会话和可验证的同源请求：

| 方法   | 路径                             | 用途                                          |
| ------ | -------------------------------- | --------------------------------------------- |
| `POST` | `/api/nintendo-store/authorize`  | 创建或复用未过期的授权请求                    |
| `POST` | `/api/nintendo-store/callback`   | 提交 `{ "callbackUrl": "…" }` 完成授权        |
| `POST` | `/api/nintendo-store/sync`       | 手动执行一次同步                              |
| `GET`  | `/api/nintendo-store/status`     | 读取本地连接、同步和凭据状态，不访问 Nintendo |
| `POST` | `/api/nintendo-store/disconnect` | 删除待处理授权和加密 session                  |

上游拒绝长期 session 时，同步返回 `store_reauthorization_required`；状态接口同时公开 `reauthorizationRequired` 和脱敏的 `lastSchedulerError`。本地密钥或密文损坏时，`credentialStatus` 为 `invalid`，不会把异常消息、路径或 Token 返回给浏览器。

## 快照与数据语义

同步不会把累计时长相加，而是用 Store 当前累计值替换 `play_games` 中该来源的值。缺失的日期或游戏不会被当成删除，因为 Store 的近期日报窗口可能缩短。

每次成功同步在同一个应用 SQLite 中写入：

- `nintendo_store_sync_snapshots`：抓取时间、固定错误安全元数据和 payload SHA-256。
- `nintendo_store_game_snapshots`：该次累计时长的不可变快照。
- `nintendo_store_daily_snapshots`：该次日报窗口的不可变快照。
- `nintendo_store_daily_history`：按官方日期保留的最新日报值与首次、最后见到时间。

这些表不包含 Nintendo session token。通用收藏建议通过共享的 `ensureSuggestedPurchaseLink` 生成，不依赖其他私有连接器。

## 低频自动同步

自动同步默认关闭。长生命周期 Node 服务可以显式启用：

```dotenv
NINTENDO_STORE_AUTO_SYNC_ENABLED=1
```

GameNote 的 `instrumentation.ts` 会在长生命周期 Node 服务启动时注册调度器。调度周期为 24 小时；瞬时失败按 15 分钟、1 小时、6 小时、12 小时、24 小时退避。SQLite 租约防止多个 worker 重复同步，持久化内容只包含固定错误码。

构建阶段和 Edge runtime 不会启动调度器。无有效连接时自动 tick 不访问网络。

## 备份与恢复

完整恢复需要同时备份应用 SQLite 和 `NINTENDO_STORE_DATA_DIR`。只恢复 SQLite 可以保留历史快照，但需要重新授权；只恢复凭据目录不会恢复游玩历史。JSON 收藏备份不包含 Store 凭据或这些审计表。
