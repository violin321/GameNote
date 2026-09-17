# 本地空库运行

该命令仅用于本机 `127.0.0.1:3018`，不改变 Docker 的 `/data/ns2.sqlite`
生产约束。Nintendo 授权状态继续位于仓库外的私有 Moon 和 Store
目录，GameNote 的新业务库固定在 `~/.local/share/gamenote/data/ns2.sqlite`。

在 `.env.local` 中配置绝对路径（此文件被 Git 忽略并设为 `0600`），
但不要写任何密钥内容。首次运行会在
`~/.local/share/gamenote/secrets/jwt-secret` 生成独立的 `0600` 会话密钥。

```sh
npm run local:doctor
npm run local:up
npm run local:status
npm run local:down
```

`local:up` 先执行 NS2 v6 迁移并构建正式版，再启动缺失的 Moon
采集服务和 3018 应用。它不会清除已有数据库、授权或凭据。`local:down`
只停止这套命令自行启动并经命令路径验证的进程，不会停止外部已经运行的
Moon 服务。日志和 PID 文件位于 `~/.local/share/gamenote/run`，无需保留
终端窗口。首次空库启动后，在页面中自行注册管理员账号，再检查 Moon 和
Store 的状态并同步。既有账号 Cookie 在新空库上自然失效。
