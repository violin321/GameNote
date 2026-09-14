# Moon 数据模型

Moon 的导入边界是 `gamenote.moon.daily.v1` 规范化快照。sidecar 在数据进入应用数据库前完成结构校验、URL 白名单处理和标识符脱敏。

## 快照结构

```text
MoonSnapshot
├─ fetchedAt
├─ accountScope          安装范围内的账号伪名
├─ devices[].id          安装范围内的主机伪名
└─ dailyReports[]
   ├─ deviceId
   ├─ date               Nintendo 官方日期 YYYY-MM-DD
   ├─ timeZoneOffsetSeconds
   ├─ result             CALCULATING / ACHIEVED / UNACHIEVED / UNKNOWN
   ├─ updatedAt          官方日报修订时间，可为空
   ├─ totalSeconds
   └─ games[]
      ├─ externalId
      ├─ title / titleId
      ├─ officialUrl / imageUrl
      └─ totalSeconds
```

`accountScope` 和主机 ID 使用每次安装随机生成的密钥进行 HMAC 伪名化。数据库和浏览器状态不会得到原始 Nintendo 账号 ID、主机 ID、玩家 ID 或昵称。不同安装的伪名不可直接关联。

## SQLite 表

| 表                            | 作用                                                |
| ----------------------------- | --------------------------------------------------- |
| `moon_connector_accounts`     | 每个账号伪名的抓取高水位、快照摘要和最后导入时间    |
| `moon_connector_devices`      | 账号伪名与主机伪名的映射                            |
| `moon_connector_reports`      | 每台主机每天一条官方日报及其修订元数据              |
| `moon_connector_games`        | Moon 游戏标识到共享 `play_games` 的映射与图片元数据 |
| `moon_connector_report_games` | 日报、共享游戏和当日秒数的关系                      |
| `play_observations`           | UI 可消费的通用日报／累计快照物化层                 |

共享 `play_games` 行使用：

- `source = moon_connector`
- `source_id = accountScope`
- `platform = Nintendo Switch`
- `time_semantics = daily_aggregate`

Moon 不写入 `play_sessions`。每款游戏日报会物化成 `daily_aggregate` 类型的 `play_observations`，且没有伪造的开始／结束时间；日报修订会替换同一 observation。UI 和统计代码因此可以明确区分“官方日报汇总”“精确时间线”和“累计快照”，避免把不同语义的数字直接相加。

## 重放与日报修订

导入先验证完整快照，再开启单个 `BEGIN IMMEDIATE` 事务：

1. `fetchedAt` 低于账号高水位的快照被视为旧重放。
2. 同一 `fetchedAt` 但摘要不同会报 `snapshot_revision_conflict`。
3. 同一账号、主机和官方日期的新内容替换旧日报，不累加。
4. 如果新抓取携带更旧的 `updatedAt`，保留数据库中较新的官方修订。
5. 替换后从日报明细重新计算游戏总秒数、游玩天数和首末日期。
6. 修订为零秒会从游玩天数和首末日期计算中排除，但日报本身仍被审计保存。

任一步失败都会回滚账号高水位、日报、游戏映射和汇总数字。

## 收藏关联

新建或修订 Moon 游戏后会调用共享收藏关联逻辑。只有唯一的官方 URL 或规范化标题匹配才会创建 `suggested` 关联；已有的建议、确认、拒绝或手工关联不会被同步覆盖。

## 已知限制

- 日报可能延迟出现、被后续修订，或只覆盖 Nintendo 当前仍提供的历史窗口。
- 当前契约按主机和游戏保存数据，不保存玩家维度。
- 日报总时长不等于 Nintendo Store 展示的账号累计时长。
- 游戏标题、图片和商店 URL 属于上游元数据，可能缺失或变化。
- 同一账号在不同安装中会得到不同伪名；需要跨安装合并时应设计显式、可审计的迁移，而不是复制密钥。
