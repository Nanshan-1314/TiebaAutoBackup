# 贴吧帖子备份

网页提交贴吧帖子链接/ID，本地端定时抓取楼主数据，导出为 txt 后上传云端，web端可查询备份。

**为了开源社区可持续性正向发展 二次分发此项目时 请遵循AGPL-3.0许可证 感谢您的付出 愿您的贡献随着开源精神生生不息**

> 如果项目反复报错 丢给任意Agent排查启动是最高效的解决方案
- **云端**：Cloudflare Worker + D1 + R2
- **本地**：Python 轮询脚本，调用 TiebaArchiver 无头抓取，再导出 txt 上传


## 目录结构

```
├── src/index.ts              # Worker 后端
├── public/                   # 前端静态页面
├── migrations/               # D1 迁移（jobs / consents）
├── local/
│   ├── poll_worker.py        # 本地轮询主程序
│   ├── txt_export.py         # content.db -> txt
│   └── .env.example          # 本地配置示例
├── TiebaArchiver/            # 修改版
├── TiebaArchiver-original/   # 原版（未修改，遵循MIT协议）
├── wrangler.toml
├── package.json / package-lock.json / tsconfig.json
└── .dev.vars.example
```

`TiebaArchiver/` 基于 [TiebaArchiver](https://github.com/Sorceresssis/TiebaArchiver)
改动：新增 `src/headless_scrape.py` 无头入口，并加了 `author_posts_only`（仅楼主楼层）过滤模式。`TiebaArchiver-original/` 是未修改的原版源码。

## 数据流

```
用户提交 tid ─▶ Worker 校验/去重 ─▶ D1 插入(pending)
     │
本地每 1h ─▶ 拉取 pending ─▶ claim ─▶ headless_scrape.py(仅楼主)
     │                                    └─▶ txt_export.py
     └─▶ 上传 txt 到 R2 + D1 标记 done ◀────────┘
用户查询 ─▶ D1 状态 done ─▶ /download/:tid 从 R2 返回 txt
```

## 一、部署云端（Cloudflare）

前置：安装 [Node.js](https://nodejs.org) 与 [Wrangler](https://developers.cloudflare.com/workers/wrangler/)。

```bash
npm install
npx wrangler login
```

1. 创建 D1 与 R2
   ```bash
   npx wrangler d1 create tieba-backup-db
   npx wrangler r2 bucket create tieba-backup-files
   ```
   手动创建 D1 后把 `database_id` 填入 `wrangler.toml`。

2. 建表：
   ```bash
   npx wrangler d1 migrations apply tieba-backup-db --remote
   ```

3. 设置内部 API 密钥：
   ```bash
   npx wrangler secret put ADMIN_SECRET
   ```

4. 部署：
   ```bash
   npx wrangler deploy
   ```

### 本地开发调试

```bash
cp .dev.vars.example .dev.vars
npx wrangler dev
```

## 二、配置并运行本地端

前置：Python 3.10+，安装 TiebaArchiver 依赖：

```bash
cd TiebaArchiver
pip install -r requirements.txt
```

1. 准备配置：
   ```bash
   cd ../local
   cp .env.example .env
   ```

2. 运行（前台，或注册为系统服务/计划任务）：
   ```bash
   python poll_worker.py
   ```

3. 手动测试单条抓取+导出：
   ```bash
   cd ../TiebaArchiver/src
   python headless_scrape.py 8173224373
   python ../../local/txt_export.py <抓取结果目录>
   ```

## 三、配置项说明

### 云端（wrangler.toml + 密钥）

| 项 | 位置 | 说明 |
|----|------|------|
| `DB` | `[[d1_databases]]` | D1 绑定，任务状态表 |
| `BUCKET` | `[[r2_buckets]]` | R2 绑定，txt 文件存储 |
| `ASSETS` | `[assets]` | 静态前端目录 `./public` |
| `ADMIN_SECRET` | `wrangler secret put` | 内部 API 密钥（敏感） |

### 本地端（local/.env）

| 变量 | 必填 | 说明 |
|------|------|------|
| `WORKER_URL` | ✅ | Worker 地址 |
| `ADMIN_SECRET` | ✅ | 与云端一致 |
| `TIEBA_BDUSS` | ✅ | 身份凭证 |
| `TIEBA_ARCHIVER_SRC` | 否 | TiebaArchiver src 目录，默认 `../TiebaArchiver/src` |
| `TIEBA_OUTPUT_DIR` | 否 | 抓取输出目录，默认输出到 TiebaArchiver/src/scraped_data |
| `POLL_INTERVAL_SECONDS` | 否 | 轮询间隔，默认 3600 |
| `WAF_COOKIE` | 否 | 本地直连跳过 WAF 质询的 cookie（本地专用，勿提交） |
| `WAF_UA` | 否 | 对应 UA（本地专用，勿提交） |

### 抓取行为（headless_scrape.py 环境变量）

| 变量 | 默认 | 说明 |
|------|------|------|
| `TIEBA_FILTER` | `author_posts_only` | 仅楼主楼层；可改 `author_posts_with_subposts` / `author_posts_with_author_subposts` |
| `TIEBA_AVATAR` | `none` | 不保存头像；可选 `low` / `high` |
| `TIEBA_SHARE_ORIGIN` | `0` | 不抓取转发原帖 |

## 四、API 概览

公开：

- `POST /api/submit` — body `{url|tid, agreed}`，返回 `CREATED` / `EXISTS` / `IN_PROGRESS` / `REQUEUED`
- `GET /api/query?tid=` — 返回 `DONE` / `IN_PROGRESS` / `NOT_FOUND` / `FAILED`
- `GET /download/:tid` — 从 R2 流式返回 txt

内部（需 `x-admin-secret` 头）：

- `GET /api/internal/jobs/pending`
- `POST /api/internal/jobs/:tid/claim`
- `POST /api/internal/jobs/:tid/complete?title=...`
- `POST /api/internal/jobs/:tid/fail`

## 参考

- [Cloudflare Workers 配置](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Cloudflare Workers 静态资源](https://developers.cloudflare.com/workers/static-assets/)
- [Cloudflare R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [Cloudflare D1](https://developers.cloudflare.com/d1/)
- [TiebaArchiver](https://github.com/Sorceresssis/TiebaArchiver)

## 特别鸣谢

- 本项目备份核心代码均取自 [TiebaArchiver](https://github.com/Sorceresssis/TiebaArchiver)
- 在此致敬每一个无私奉献的开源开发者

## 许可证

Copyright (c) 2026 Nanshan-1314

本项目采用 GNU Affero General Public License v3.0（AGPL-3.0）许可证。

完整许可证文本请参见项目根目录的 `LICENSE` 文件。
