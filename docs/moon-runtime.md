# Moon sidecar 运行与安全边界

Moon 被拆成两个进程：

```text
管理员浏览器
    │ 现有管理员会话 + 同源校验
    ▼
GameNote Route Handlers
    │ Bearer API key + Unix socket
    ▼
Moon sidecar
    │ 固定 HTTPS allowlist
    ▼
Nintendo Accounts / Parental Controls
```

应用负责管理员权限、调度租约、SQLite 导入和 UI 状态；sidecar 负责 OAuth、凭据加密、Nintendo 请求、响应规范化和账号／主机伪名化。浏览器永远不直接持有 sidecar API key 或 Nintendo token。

## 私有运行目录与 IPC 目录

单目录模式执行 `node services/moon-sidecar/cli.mjs init` 后会创建：

```text
$MOON_RUNTIME_DIR/
├─ run/sidecar.sock
├─ secrets/api-key
├─ secrets/master-key
├─ secrets/installation-key
└─ state/moon-state.enc
```

生产部署应使用独立的 IPC 目录：

```text
$MOON_RUNTIME_DIR/              # 仅 sidecar 挂载
├─ secrets/master-key
├─ secrets/installation-key
└─ state/moon-state.enc
$MOON_IPC_DIRECTORY/            # 应用与 sidecar 共享
├─ run/sidecar.sock
└─ secrets/api-key
```

目录与子目录权限为 `0700`，密钥、加密状态和 Unix socket 权限为 `0600`。初始化使用排他创建；加载时会拒绝符号链接、不安全权限、错误所有者、长度不符的密钥以及密钥复用。`MOON_IPC_DIRECTORY` 未配置时，CLI 回退到 `MOON_RUNTIME_DIR`，保持单目录开发模式兼容。应用容器只应挂载 IPC 目录，不能挂载 sidecar 私有目录。

`moon-state.enc` 使用 AES-256-GCM 保存 session token、待完成 PKCE、规范化快照和调度状态。主密钥与安装伪名密钥只存在于 sidecar 私有目录；API key 只存在于 IPC 目录。不要将任一运行目录复制到仓库或不受控的共享存储。

## OAuth 生命周期

1. `authorize` 生成随机 state、PKCE verifier 和 S256 challenge。
2. 管理员在 Nintendo 官方页面完成 Moon 客户端授权。
3. `callback` 校验自定义 scheme、client ID、state、参数唯一性和过期时间。
4. state 在交换 code 前即被持久化销毁，失败也不能重放。
5. 返回的 session token 会校验签发方、受众和过期时间，再加密保存。
6. `disconnect` 删除凭据、待授权状态和快照。

授权回调 URL 含有一次性 code，应当按凭据处理，不能写入日志或错误响应。

## 固定网络边界

sidecar 不读取代理环境变量、不跟随重定向，也不接受远端配置或任意 URL。允许的请求只有：

- Nintendo Accounts 的 session token 与 access token 交换；
- Nintendo Accounts 当前用户读取；
- Parental Controls 的账号主机列表读取；
- Parental Controls 的单台主机日报列表读取。

Moon 数据路径只允许 `GET`。响应有总大小限制，请求有绝对时限；只有幂等读取可对暂时性网络错误重试一次。返回到应用的错误码经过 allowlist 过滤，不会透传上游响应正文。

固定 client ID、scope、端点、App 版本和请求头是协议兼容参数而非用户凭据。由于接口未公开，这些参数仍可能随官方客户端升级而失效。

## 自动同步

推荐由应用调度器执行同步，因为一次成功任务必须同时完成：

1. sidecar 抓取；
2. 重新读取规范化快照；
3. GameNote 原子导入。

设置 `MOON_AUTO_SYNC_ENABLED=1` 后，成功任务的下一次运行间隔为 6 小时；普通失败默认 5 分钟后重试，并在 Nintendo 限流时采用受上限约束的 `Retry-After`。持久化 SQLite 租约会串行化手动同步、自动同步、授权回调和断开连接，并允许异常退出后的租约恢复。

GameNote 的 `instrumentation.ts` 会在长生命周期 Node 服务启动时注册调度器；构建阶段和 Edge runtime 不会启动。Docker Compose 用户还需要通过 `--profile nintendo-play` 启动隔离的 sidecar 服务。Compose 将应用 scheduler 状态放在 `/data/private/moon-app/scheduler.sqlite`，不放入 sidecar 私有或 IPC 目录。

`MOON_SCHEDULER_STATE_FILE` 必须是绝对 `.sqlite` 路径，且不能指向应用主数据库。未显式配置时，单实例开发环境会尝试放在应用数据库旁；多 worker 部署应显式配置所有 worker 可见的同一本地持久化文件。

不要同时使用 sidecar 的 `serve --scheduler` 与应用调度器。sidecar 自带调度只更新加密快照，不能完成 GameNote 数据库导入；应用发现双调度会返回 `scheduler_conflict`。

## Locale 与时区

Nintendo 请求配置来自：

- `MOON_LOCALE`：默认 `en-US`，必须可被 `Intl.getCanonicalLocales` 解析；
- `MOON_TIME_ZONE`：默认 `UTC`，必须是 `Intl.DateTimeFormat` 支持的 IANA 时区。

这些值只影响发送给 Nintendo 的客户端请求配置。数据库仍保存 Nintendo 日报返回的官方日期与 `timeZoneOffsetSeconds`，不会根据服务器本地时区重新切日。

## 运维检查

- sidecar `/healthz` 不需要密钥，只返回固定健康状态；其他 Unix 路由都要求 API key 并拒绝 `Origin`。
- 应用 `status` 同时区分抓取成功时间、调度状态和数据库最后导入时间。
- `moon_reauthorization_required` 表示凭据失效，应提示管理员重新授权，不应自动尝试其他账号。
- 备份或复制 SQLite 时必须连同一致性策略处理 `-wal`、`-shm`，但这些运行文件不能提交到 Git。
