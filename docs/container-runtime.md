# 单镜像 NS2：家长控制日报与 Store 累计时长

个人 NS2 镜像同时包含 GameNote Web、Moon 家长控制采集器和 Nintendo Store 探测代码。启动时 Web 入口会先检查 `/data` 可写、迁移数据库、在新数据卷内初始化 Moon 私钥，再启动 Moon Unix socket 服务并等待其健康检查成功，最后启动 Web。Moon 进程异常退出时容器会退出，由 Docker 的重启策略恢复；容器健康检查同时检查 Web 和 Moon。无需在宿主机另装 Moon 服务。

镜像**不包含**账号、授权、密钥、日报或累计时长。Store 的客户端代码在镜像内运行，不是第三个常驻进程。每个实例需在设置页分别连接家长控制和 Nintendo Store；自动同步默认开启，Moon 每 6 小时、Store 每 24 小时低频运行。Nintendo 接口不可用、账号授权失效或未绑定家长控制主机时仍可能无法同步；镜像不能绕过这些条件。

## 数据卷和启动

`/data` 是唯一必需的持久化卷。数据库是 `/data/ns2.sqlite`；Moon 的三个私钥和加密授权状态在 `/data/moon`；Store 的加密授权、加密密钥和调度状态在 `/data/nintendo-store`。不要把整个 `/data` 放进 Git 或镜像构建上下文。**升级时复用同一卷并备份整卷**；只备份数据库不能恢复授权。不要共享同一数据卷运行两个实例，也不要修改这些目录或文件的权限和所有者。

将 `.env.example` 复制为 `.env`，填写独立随机的 `JWT_SECRET` 和已经发布、固定版本的 `GAMENOTE_IMAGE`。在 Linux bind mount 模式下，先创建 `./data` 并确保它可由容器 UID:GID `10001:10001` 写入；或将 compose 的 `./data:/data` 换成 Docker 命名卷。然后运行 `docker compose up -d`。镜像的 `VOLUME /data` 便于单独 `docker run`，但为确保升级后继续使用同一数据卷，应显式指定命名卷或 bind mount，而不是依赖匿名卷。

首次启动仅在 `/data/moon` **不存在**时创建私钥。发现已有但不完整、权限不安全的目录会拒绝启动，不会重新生成覆盖密钥。Store 目录同样必须归运行 UID 所有、不可被其他用户访问。若首次授权失败，先查看容器健康状态与设置页错误码，不要删除现有密钥或数据库来“重试”。

从旧版 NS2 升级时，原数据库中已导入的游戏、日报与快照仍在；旧版若授权文件保存在镜像可写层或另一台机器上，升级不会自动迁移这些私人文件。可在新实例的设置页重新授权两个独立连接。需要保留旧 Moon 加密授权时，必须连同三个原始密钥及加密状态完整、离线地迁移，并验证所有权与 `0700`/`0600` 权限；不要把它们提交到仓库或放进公开镜像。

`gamenote-nintendo-sidecar` 是旧 Coral/NSO 数据源，和这里的 Moon、Store 独立；原有配置不会自动成为 Moon 或 Store 授权。非容器部署继续参照 `docs/moon-runtime.md` 手动管理 Moon 进程。
