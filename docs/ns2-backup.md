# NS2 业务库备份与恢复

`设置 → 数据备份` 的 JSON 仅包含收藏记录。完整 NS2 SQLite 库还包含历史游戏、日报、Store 快照、收藏关联和账户/设置。数据库**不包含**独立 Moon/Store 服务的加密授权状态、加密主密钥、installation-key、API key 及本机 JWT 密钥；恢复数据库不会恢复这些授权。

要求 Node.js 22.16+（应用本身最低 22.13），在可访问业务库的受信任机器上操作。输出位置须在仓库外，目标文件必须不存在，目录应仅对当前用户可访问。脚本拒绝覆盖，备份和恢复文件设为 `0600`。

```sh
mkdir -m 700 -p "$HOME/.local/share/gamenote/backups"
npm run backup:ns2 -- backup "$HOME/.local/share/gamenote/data/ns2.sqlite" "$HOME/.local/share/gamenote/backups/ns2-YYYY-MM-DD.sqlite"
npm run backup:ns2 -- verify "$HOME/.local/share/gamenote/backups/ns2-YYYY-MM-DD.sqlite"

# 演练：只恢复到隔离目录中的全新文件，不替换在线库。
mkdir -m 700 -p "$HOME/.local/share/gamenote/restore-drill"
npm run backup:ns2 -- restore "$HOME/.local/share/gamenote/backups/ns2-YYYY-MM-DD.sqlite" "$HOME/.local/share/gamenote/restore-drill/ns2-restored.sqlite"
npm run backup:ns2 -- verify "$HOME/.local/share/gamenote/restore-drill/ns2-restored.sqlite"
```

命令检查 NS2 身份、schema v6、`integrity_check`、`foreign_key_check` 和主要表行数。在线备份使用 SQLite backup API，会包含 WAL 中已提交的数据；它不暂停写入服务。输出行数只能辅助对账，不能代替在隔离环境中按实际场景抽查页面、登录与数据源。恢复演练不会触碰运行中的数据库。

正式回滚时先停写并确认应用、Moon 导入及 Store 导入进程都停止。确认目标库和备份身份、版本、备份时间、权限及外部授权目录。备份当前目标后，由管理员在维护窗口手工切换到已验证的新文件并重启、逐项核对；脚本**没有**覆盖在线库的选项。若采用替换文件，先确认同名 `-wal`/`-shm` 不再被进程使用，绝不可让旧 WAL 与新库混合。不要把任何 DB、备份、密钥、token 或加密状态提交到 Git、PR 或公开日志。

本地 Moon 授权目录与安装密钥按 [Moon 运行说明](moon-runtime.md) 单独备份；Store 授权目录也需独立、加密和限制权限保存。数据库与相应授权状态的备份应当成同一恢复点管理，但不要将凭据复制进项目目录。
