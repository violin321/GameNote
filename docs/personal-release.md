# 个人维护分支与镜像发布

`violin321/GameNote` 是公开 Fork；私有 `gamenote-moon-codex-handoff` 仅保存脱敏交接材料，不作为应用源码或 Docker 构建源。个人版应从公开 Fork 的 `main` 派生独立分支，避免把 OVH 实验分支的历史直接推到公开仓库。提交前按路径和内容审查所有新增文件；数据库、备份、日志、`.env.local`、Moon/Store 加密状态和任何凭据不得入库。推送后在新的干净检出中运行质量检查、迁移与生产构建。

当前上游 GitHub 仓库的许可证元数据为空，未找到 LICENSE 文件。**将衍生镜像发布到 Docker Hub 前，应先向上游作者确认明确的再分发许可。** 本文提供技术操作路径，不视为发布授权；未确认许可前不创建版本标签、运行发布工作流或公开镜像。

## 现有发布工作流

`.github/workflows/publish-docker.yml` 在 `v*` 标签或手动触发时才构建并推送镜像，不因普通代码提交自动推送。它先调用质量工作流（锁文件安装、依赖安全审计、格式、Lint、类型、测试、生产构建），然后在 `ubuntu-24.04` 原生构建 `linux/amd64`，在 `ubuntu-24.04-arm` 原生构建 `linux/arm64`，不使用 QEMU。两个架构构建依次运行，每个最多 30 分钟；最后的 manifest 合并最多 10 分钟。合并后检查正式镜像确实含有两个 Linux 架构。

构建中间产物分别推送为 `amd64-<完整提交哈希>` 和 `arm64-<完整提交哈希>`，**不代表完整发版**。两个架构均成功后才合并为 `sha-<提交短哈希>` 和语义化版本标签；从默认分支手动触发时还会产生 `latest`。应用版本以 `package.json` 为准，发布标签必须为 `v<应用版本>`，锁文件版本也必须一致；不匹配会在构建前失败。Git 标签 `v1.0.15-ns.4` 对应不带 `v` 的 Docker 版本标签 `1.0.15-ns.4`。镜像标签记录应用版本和完整 Git 提交，设置页展示应用版本与短提交，更新说明见 `CHANGELOG.md`。如果 ARM 构建失败，amd64 中间标签可能已存在，但不会发布正式多架构标签；排障时可使用中间标签，生产升级应等正式标签及 digest 验证通过。不要重写已有版本标签来重试，新修复使用新的版本号。正式部署应固定经过验证的 manifest digest，不依赖 `latest`。

在许可、源代码审核和 Docker Hub 账号确认后，先在 Fork 的仓库 Settings → Secrets and variables → Actions 中设置：

- Repository variable `DOCKERHUB_USERNAME`：自己的 Docker Hub 用户名或组织名。
- Repository secret `DOCKERHUB_TOKEN`：专用于发布的 Docker Hub access token，仅授予目标仓库所需的写入权限。不要将 token 写入 `.env`、命令历史、PR 或 Git 文件。

先确定 Docker Hub 上该命名空间的 `gamenote` 仓库、可见性和发布权限，再在 GitHub Actions 检查质量任务成功。发布时，由受信任的发布提交创建并推送新的 `vX.Y.Z` 标签；工作流完成后在 Docker Hub 核对镜像摘要、`linux/amd64` 与 `linux/arm64`、版本标签和来源提交。手动触发只适合在工作流已进入默认分支后使用，不能假定个人功能分支上会显示手动运行按钮。

## 部署边界

`docker-compose.yml` 默认仍指向上游 `dingding229/gamenote:latest`。使用个人镜像时必须显式设置 `GAMENOTE_IMAGE=<自己的命名空间>/gamenote@sha256:<经验证的摘要>`，且不要把 NS2 数据库交给上游镜像。升级前用 `docs/ns2-backup.md` 做完整在线备份、校验和隔离恢复演练；Moon/Store 授权状态与密钥单独保管。先在隔离环境验证数据迁移、页面与授权状态，再考虑单实例生产切换和回滚，不在发布工作流中自动部署 OVH。
