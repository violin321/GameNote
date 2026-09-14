# GameNote

GameNote 是一个面向个人部署的游戏收藏与购买记录应用，支持 Nintendo Switch、PlayStation、游玩历史、PS Plus 游戏目录、会员记录、价格统计、JSON 备份和 AI 订单截图识别。

应用采用 Next.js、React、TypeScript 与 SQLite 构建，默认通过 Docker Compose 部署。游客可以只读浏览收藏，管理员登录后才能修改数据和使用管理工具。

## 主要功能

### 游戏收藏

- Nintendo Switch 与 PlayStation 独立游戏库。
- 记录游戏名称、平台、实体/数字版、版本地区、买入价格、币种、购买日期、渠道和备注。
- 游戏可记录卖出日期、价格和币种；已卖出的记录会变灰并排列在当前收藏之后。
- PS Plus 会员到期后，自动加入的会免记录会冻结、变灰并排列到当前收藏之后；续费生效后自动恢复。
- 封面网格和紧凑列表两种展示方式。
- 支持名称搜索、地区版本、数字版/实体版筛选、排序、平台统计和人民币汇率折算。
- 繁体中文标题自动规范为简体中文，搜索时进行繁简归一化。

### 官方数据查询

- Nintendo 香港、国行及 Nintendo 官方数据源的游戏名称、封面、页面与部分数字版价格。
- PlayStation 香港商店的游戏名称、封面、官方页面和价格。
- 可按游戏名称搜索，也可粘贴官方页面 URL 获取数据。
- 官方页面或接口改版后，相应解析规则可能需要更新。

### 游玩历史

- 通过通用 JSON 格式导入带开始、结束时间的游玩记录，导入前先进行服务端校验和预览。
- 可连接 Nintendo Switch 家长控制（Moon）读取官方日历日报，也可连接 Nintendo Store 保存账号累计时长与近期日报。
- “最近游玩”按日期展示最近 7、30 或 90 天的精确时间线和日报；“历史游玩”保留来源与时间语义，累计快照不会和日报重复相加。
- 按官方 URL 或规范化标题建议对应收藏，也可以手动选择、忽略建议或重新关联。
- 游玩数据与收藏保存在同一个 SQLite 文件中，但使用独立数据表；删除收藏不会删除游玩历史。

### PS Plus 与会员

- PS Plus 游戏库独立页面，展示港区升级与高级会员目录、中文名、封面和支持平台。
- PS Plus 目录使用 SQLite 缓存，默认每 12 小时后台刷新一次；管理员可以手动刷新。
- PlayStation Plus 和 Nintendo Switch Online 按起止时间记录会员周期、购买价格及币种，过期记录会保留。
- 可从 PlayStation Blog 识别本月 PS Plus 会免阵容，再按准确游戏名从港区 PlayStation Store 获取官方页面与封面，去重后加入收藏。
- 历史会免补录会根据已保存的 PS Plus 会员时间段列出过往月份，预览该月阵容后可勾选实际领取过的游戏批量入库。

### AI 购买截图识别

- 支持兼容 OpenAI Responses API 的视觉服务。
- AI 地址、API Key 和视觉模型全部在管理员“设置”页面维护，不需要写入 Docker Compose。
- 设置页面支持“获取模型”和“测试接口”。
- AI 配置成功后显示“识别购买图”入口。
- 一次最多上传 6 张 JPEG、PNG 或 WebP 图片，单张不超过 12MB。
- 识别结果加入收藏前可以修改平台、价格、版本、形态、渠道和日期。

### 设置与备份

- 设置网站标题、头像和满足可读性要求的主题色。
- 选择侧边栏需要展示的 Nintendo Switch、PlayStation、PS Plus 游戏库和会员工具。
- 在“Nintendo 游玩数据”中完成授权、回调、手动同步、断开连接和凭据失效后的重新授权。
- JSON 导入和导出统一位于“设置 → 数据备份”，备份包含购买记录和非敏感应用设置。
- JSON 文件最大 5MB，最多包含 2,000 条记录。
- 收藏分享图支持价格、购买日期、卖出信息和备注；单张图最多展示前 160 条记录，并限制封面加载并发数。

### 账户与数据安全

- 首次使用时注册唯一管理员账号。
- 密码使用异步 scrypt 哈希，不保存明文。
- 登录失败按客户端地址与账号限流。
- 会话 Cookie 使用 HttpOnly、SameSite=Strict 和签名 JWT。
- 游戏和会员记录删除前均使用站内确认对话框进行二次确认。
- 修改密码或生成临时密码会立即撤销全部旧登录会话。
- 忘记密码时可在登录窗口生成 `data/password` 文件；使用文件中的临时密码登录后必须设置新密码。
- 收藏保存使用 `updatedAt` 乐观锁，避免多个页面或 PS Plus 同步相互覆盖数据。
- 分享图封面代理仅允许已登录管理员访问，只接受通过文件签名校验的 JPEG、PNG、WebP 和 AVIF。
- Nintendo session、PKCE、连接器 API key 和加密密钥只保存在部署端私有目录，不进入浏览器持久化、JSON 导出或 Git。

## 页面与权限

| 页面或操作                 | 游客 | 管理员 |
| -------------------------- | :--: | :----: |
| 浏览 NS / PlayStation 收藏 |  ✓   |   ✓    |
| 浏览 PS Plus 游戏库        |  ✓   |   ✓    |
| 新增、编辑、删除记录       |      |   ✓    |
| 官方游戏数据查询           |      |   ✓    |
| AI 购买截图识别            |      |   ✓    |
| 会员记录和会免同步         |      |   ✓    |
| 游玩历史、数据源与收藏关联 |      |   ✓    |
| JSON 导入、导出与分享图    |      |   ✓    |
| 网站、内容与 AI 设置       |      |   ✓    |

## 快速部署

要求：Docker Engine、Docker Compose、`curl` 与 `openssl`。部署只会从 Docker Hub 拉取预构建镜像，不需要在服务器安装 Node.js、下载源码或执行本地构建。

```bash
mkdir -p gamenote/data
cd gamenote
curl -fsSLO https://raw.githubusercontent.com/dingding229/GameNote/main/docker-compose.yml
umask 077
printf 'JWT_SECRET=%s\n' "$(openssl rand -base64 48)" > .env
```

随后拉取镜像并启动：

```bash
docker compose pull
docker compose up -d
```

浏览器访问 `http://localhost:3000`。第一次访问时点击“注册管理员”，然后进入设置页面配置游戏库、会员信息及 AI 服务。

Nintendo Store 可直接在设置页授权。若要启用家长控制日报，再启动 Compose 中隔离的 Moon sidecar：

```bash
docker compose --profile nintendo-play up -d
```

Moon sidecar 不开放网络端口，只通过共享命名卷中的 Unix socket 与 GameNote 通信。首次启动会在该卷内生成独立 API key、加密密钥和安装伪名密钥；这些值不需要也不应写入 `.env`。

## Docker Compose 镜像安装

`docker-compose.yml` 直接使用 Docker Hub 镜像，不包含 `build` 配置：

```yaml
services:
  gamenote:
    image: ${GAMENOTE_IMAGE:-dingding229/gamenote:latest}
    container_name: gamenote
    restart: unless-stopped
    init: true
    ports:
      - "3000:3000"
    environment:
      PS_PLUS_CATALOG_REFRESH_HOURS: ${PS_PLUS_CATALOG_REFRESH_HOURS:-12}
      JWT_SECRET: ${JWT_SECRET:?请复制 .env.example 为 .env，并配置 JWT_SECRET}
      APP_DATABASE_FILE: "/data/records.sqlite"
      NINTENDO_STORE_DATA_DIR: "/data/private/nintendo-store"
      NINTENDO_STORE_AUTO_SYNC_ENABLED: ${NINTENDO_STORE_AUTO_SYNC_ENABLED:-0}
    volumes:
      - ./data:/data
```

| 环境变量                           | 是否必需 | 默认值                         | 说明                                                           |
| ---------------------------------- | :------: | ------------------------------ | -------------------------------------------------------------- |
| `GAMENOTE_IMAGE`                   |    否    | `dingding229/gamenote:latest`  | Docker Hub 镜像。                                              |
| `JWT_SECRET`                       |    是    | 无                             | JWT 会话签名密钥，生产环境至少 32 字节。修改后现有会话会失效。 |
| `APP_DATABASE_FILE`                |    否    | `/data/records.sqlite`         | SQLite 数据库文件路径，Docker 配置已经写入。                   |
| `PS_PLUS_CATALOG_REFRESH_HOURS`    |    否    | `12`                           | PS Plus 游戏目录缓存刷新间隔，单位为小时。                     |
| `NINTENDO_STORE_DATA_DIR`          |    否    | `/data/private/nintendo-store` | Store 加密 session 与调度租约的私有目录。                      |
| `NINTENDO_STORE_AUTO_SYNC_ENABLED` |    否    | `0`                            | 改为 `1` 后每 24 小时低频同步 Store。                          |
| `MOON_AUTO_SYNC_ENABLED`           |    否    | `0`                            | 改为 `1` 后每 6 小时低频同步家长控制日报。                     |
| `MOON_LOCALE`                      |    否    | `en-US`                        | Moon 请求使用的 BCP 47 locale。                                |
| `MOON_TIME_ZONE`                   |    否    | `UTC`                          | Moon 请求使用的 IANA 时区。                                    |

以下配置在管理员设置页面中维护：

- AI API 地址、API Key 和视觉模型。
- 需要展示或统计的游戏平台与工具。
- PS Plus 和 Nintendo Switch Online 会员状态。
- Nintendo 游玩数据源的授权、同步和断开操作。

这些配置保存在 SQLite 中。

## Docker Run 镜像安装

不使用 Docker Compose 时，可以直接运行同一个镜像：

```bash
mkdir -p gamenote/data
cd gamenote
umask 077
printf 'JWT_SECRET=%s\n' "$(openssl rand -base64 48)" > .env

docker pull dingding229/gamenote:latest
docker run -d \
  --name gamenote \
  --restart unless-stopped \
  --init \
  -p 3000:3000 \
  --env-file .env \
  -e APP_DATABASE_FILE=/data/records.sqlite \
  -e PS_PLUS_CATALOG_REFRESH_HOURS=12 \
  -v "$(pwd)/data:/data" \
  dingding229/gamenote:latest
```

容器使用宿主机当前目录下的 `data` 文件夹持久化 SQLite 数据。删除或重建容器不会删除该文件夹。

## 忘记管理员密码

打开登录窗口，填写管理员账号并点击“重置密码”。确认后，程序会在 SQLite 数据库所在目录生成 `password` 文件。

```bash
# Docker Compose
docker compose exec gamenote cat /data/password

# Docker Run
docker exec gamenote cat /data/password
```

使用临时密码登录后，程序会要求立即设置新密码。设置成功后 `password` 文件自动删除，所有旧登录会话失效。

## 更新、日志与停止

### Docker Compose

```bash
# 更新镜像并重建容器，保留 data 数据
docker compose pull
docker compose up -d --remove-orphans

# 查看日志
docker compose logs -f gamenote

# 停止服务但保留数据
docker compose down
```

如果需要同步最新版 Compose 配置，可以在部署目录重新下载：

```bash
curl -fsSLO https://raw.githubusercontent.com/dingding229/GameNote/main/docker-compose.yml
```

### Docker Run

```bash
# 更新镜像并重建容器，保留 data 数据
docker pull dingding229/gamenote:latest
docker stop gamenote
docker rm gamenote

docker run -d \
  --name gamenote \
  --restart unless-stopped \
  --init \
  -p 3000:3000 \
  --env-file .env \
  -e APP_DATABASE_FILE=/data/records.sqlite \
  -e PS_PLUS_CATALOG_REFRESH_HOURS=12 \
  -v "$(pwd)/data:/data" \
  dingding229/gamenote:latest

# 查看状态和日志
docker inspect gamenote --format '{{.State.Status}} {{.State.Health.Status}}'
docker logs -f gamenote

# 停止服务但保留数据
docker stop gamenote
```

## 数据存储与备份

默认 SQLite 文件位于宿主机：

```text
./data/records.sqlite
```

推荐同时采用两种备份：

1. 定期在“设置 → 数据备份”中导出 JSON。
2. 停止容器后复制 `data/records.sqlite`。

设置页的 JSON 备份只包含购买记录与应用设置，不包含游玩历史、关联结果、审计快照或 Nintendo 凭据。要完整备份历史数据，请停止容器后复制 `data/records.sqlite`；恢复 SQLite 时也应保持容器停止，避免复制写入中的数据库文件。Store 凭据位于 `data/private/nintendo-store`，Moon 凭据位于 Compose 的 `moon-runtime` 命名卷；恢复历史数据时也可以选择不恢复凭据并重新授权。

### 游玩记录导入格式

游玩历史页面接受不超过 2 MB 的 JSON 文件。每个游戏和会话都需要稳定、非敏感的 `externalId`，时间必须包含 `Z` 或明确的时区偏移。示例：

```json
{
  "version": 1,
  "sourceId": "example-console",
  "games": [
    {
      "externalId": "example-game-1",
      "title": "Skyward Atlas",
      "platform": "Nintendo Switch",
      "titleId": "EXAMPLE0001",
      "officialUrl": "https://example.com/games/skyward-atlas",
      "sessions": [
        {
          "externalId": "example-session-1",
          "startedAt": "2026-09-13T20:00:00+08:00",
          "endedAt": "2026-09-13T21:30:00+08:00",
          "playedDate": "2026-09-13",
          "durationSeconds": 5400
        }
      ]
    }
  ]
}
```

`sourceId` 是区分不同导出器的稳定命名空间；`playedDate` 可选，用于明确来源记录中的本地游玩日期，省略时取 `startedAt` 中的日期。不要在这些字段中放入账号、Token、设备序列号等敏感信息。相同 `sourceId` 和 `externalId` 的会话只会保存一次；再次导入同一文件是幂等的。

## 本地开发与质量检查

要求 Node.js `>=22.13.0`。

```bash
npm ci
npx next dev -p 3017
```

访问 `http://localhost:3017`。开发数据默认写入 `data/records.sqlite`。

```bash
npm run format:check  # Prettier 格式检查
npm run lint          # ESLint + Next.js Core Web Vitals
npm run typecheck     # TypeScript 类型检查
npm run test          # Vitest 自动测试
npm run check         # 依次执行以上全部检查
npm run build:docker  # Next.js 生产构建
```

## 项目结构

```text
app/
  api/                         Next.js API 路由
  nintendo-switch/             Nintendo Switch 页面
  playstation/                 PlayStation 页面
  ps-plus-catalog/             PS Plus 游戏目录页面
  memberships/                 会员记录页面
  play/                        最近游玩、历史游玩和收藏关联页面
features/ledger/
  components/                  工具栏、设置、会员和目录组件
  hooks/                       弹窗焦点与键盘复用逻辑
  ledger-client.tsx            收藏客户端入口与页面编排
  storage.ts                   浏览器端数据访问和导入规范化
  types.ts                     前端领域类型
  utils.ts                     统计、格式化和分享图工具
features/play-history/         游玩记录列表、导入和收藏关联界面
lib/
  auth/                        密码、登录限流、JWT 与访问校验
  game/                        标题规范化、翻译和官方名称解析
  ledger/                      数据限制、领域结构与 SQLite 仓储
  moon/                        家长控制 sidecar 客户端、日报导入与调度
  nintendo-store/              Store 授权、累计/日报快照与调度
  play-history/                游玩导入校验、数据表和查询仓储
  ui/                          主题色可读性工具
services/
  moon-sidecar/                隔离的家长控制 OAuth 与只读抓取进程
  nintendo-store/              固定端点 Store PKCE 与数据客户端
tests/                          Vitest 自动测试
public/                         静态资源
data/                           本地 SQLite 数据，不纳入版本控制
```

页面通过 `features/ledger/index.ts` 暴露收藏模块。API 路由负责 HTTP 输入输出，认证、领域校验、游戏标题解析和 SQLite 访问分别复用 `lib` 中的模块。

## 技术栈

- Next.js 16 / App Router / standalone output
- React 19
- TypeScript 5
- Tailwind CSS 4 / DaisyUI 5
- Node.js 内置 SQLite
- OpenCC 繁简转换
- Vitest / ESLint / Prettier
- Docker / Docker Compose

## 安全与部署建议

- 为每个部署生成不同的 `JWT_SECRET`，不要使用示例文本或短密码。
- 不要提交 `.env`、`data/records.sqlite` 或 JSON 备份。
- 不要把 Nintendo 授权回调、session、Moon 运行目录或 Store 私有目录复制到 Issue、日志或仓库。
- 公网部署应使用 HTTPS 反向代理，并在代理层增加速率限制和安全响应头。
- 登录限流保存在当前 Node 进程内；多实例部署时应改用 Redis 等共享限流存储。
- AI API Key 保存在本地 SQLite，请限制数据库文件权限并妥善备份。
- 定期执行 `npm audit`、`npm run check` 和生产构建检查。
- Nintendo、PlayStation、Wikidata、Google Translate 与 PlayStation Blog 不可用时，相应查询可能暂时降级；收藏读取不会等待外部标题翻译接口。
