// 下载速率限制 建议搭配 rate limit 使用

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  ADMIN_SECRET: string;
}

interface JobRow {
  tid: number;
  status: string;
  source: string | null;
  title: string | null;
  r2_key: string | null;
  file_size: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

interface RateLimitRow {
  ip: string;
  timestamps: string;
  banned_until: number;
}

const STATUS = {
  PENDING: "pending",
  PROCESSING: "processing",
  DONE: "done",
  FAILED: "failed",
} as const;

const RATE_WINDOWS = [
  { seconds: 30, max: 3, ban: 10 },
  { seconds: 90, max: 6, ban: 60 },
  { seconds: 180, max: 10, ban: 3600 },
];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function extractTid(input: string): number | null {
  if (!input) return null;
  const s = String(input).trim();
  if (/^\d+$/.test(s)) {
    const tid = parseInt(s, 10);
    return tid > 0 && tid <= Number.MAX_SAFE_INTEGER ? tid : null;
  }
  const m = s.match(/tieba\.baidu\.com\/p\/(\d+)/i);
  if (m) {
    const tid = parseInt(m[1], 10);
    return tid > 0 ? tid : null;
  }
  return null;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function authorized(request: Request, env: Env): boolean {
  const secret = env.ADMIN_SECRET || "";
  if (!secret) return false;
  return request.headers.get("x-admin-secret") === secret;
}

function safeName(s: string | null): string | null {
  if (!s) return null;
  const cleaned = s.replace(/[\\/:*?"<>|#%&\s]+/g, "_").slice(0, 80);
  return cleaned || null;
}

async function rateLimit(ip: string, env: Env): Promise<boolean> {
  const now = nowSec();
  const row = await env.DB.prepare("SELECT * FROM rate_limits WHERE ip = ?")
    .bind(ip)
    .first<RateLimitRow>();

  if (row) {
    if (row.banned_until > now) return false;
    let timestamps: number[] = [];
    try {
      timestamps = JSON.parse(row.timestamps || "[]");
    } catch {
      timestamps = [];
    }
    timestamps.push(now);
    timestamps = timestamps.filter((t) => now - t < RATE_WINDOWS[RATE_WINDOWS.length - 1].seconds);
    let banSeconds = 0;
    for (const w of RATE_WINDOWS) {
      if (timestamps.filter((t) => now - t < w.seconds).length > w.max) {
        banSeconds = Math.max(banSeconds, w.ban);
      }
    }
    if (banSeconds > 0) {
      await env.DB.prepare("UPDATE rate_limits SET timestamps = ?, banned_until = ? WHERE ip = ?")
        .bind(JSON.stringify(timestamps), now + banSeconds, ip)
        .run();
      return false;
    }
    await env.DB.prepare("UPDATE rate_limits SET timestamps = ? WHERE ip = ?")
      .bind(JSON.stringify(timestamps), ip)
      .run();
    return true;
  }

  await env.DB.prepare("INSERT INTO rate_limits (ip, timestamps, banned_until) VALUES (?, ?, 0)")
    .bind(ip, JSON.stringify([now]))
    .run();
  return true;
}

async function handleSubmit(request: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, code: "INVALID_BODY", message: "请求体不是合法 JSON" }, 400);
  }
  const agreed = body.agreed === true;
  if (!agreed) {
    return json({ ok: false, code: "NOT_AGREED", message: "请先阅读并同意用户许可协议与免责协议" }, 403);
  }

  const raw = String(body.url ?? body.tid ?? "");
  const tid = extractTid(raw);
  if (tid === null) {
    return json({ ok: false, code: "INVALID_TID", message: "无效的帖子链接或 ID，请检查后重试" }, 400);
  }

  const ip = request.headers.get("cf-connecting-ip") || "";
  const ua = request.headers.get("user-agent") || "";

  const existing = await env.DB.prepare("SELECT * FROM jobs WHERE tid = ?")
    .bind(tid)
    .first<JobRow>();

  const alreadyDone = existing != null && existing.status === STATUS.DONE && existing.r2_key != null;

  if (!alreadyDone) {
    if (!(await rateLimit(ip, env))) {
      return json({ ok: false, code: "RATE_LIMITED", message: "请求速度过快" }, 429);
    }
  }

  await env.DB.prepare(
    "INSERT INTO consents (ip, tid, agreed, user_agent, created_at) VALUES (?, ?, 1, ?, ?)"
  )
    .bind(ip, tid, ua, nowSec())
    .run();

  if (existing) {
    if (alreadyDone) {
      return json({
        ok: true,
        code: "EXISTS",
        status: STATUS.DONE,
        title: existing.title,
        downloadUrl: `/download/${tid}`,
        message: "该帖子已有备份数据",
      });
    }
    if (existing.status === STATUS.PENDING || existing.status === STATUS.PROCESSING) {
      return json({
        ok: true,
        code: "IN_PROGRESS",
        status: existing.status,
        message:
          existing.status === STATUS.PROCESSING
            ? "备份正在处理中，请稍后查询"
            : "备份任务已存在，等待本地端处理",
      });
    }
    if (existing.status === STATUS.FAILED) {
      await env.DB.prepare("UPDATE jobs SET status = ?, error = NULL, updated_at = ? WHERE tid = ?")
        .bind(STATUS.PENDING, nowSec(), tid)
        .run();
      return json({ ok: true, code: "REQUEUED", status: STATUS.PENDING, message: "上次备份失败，已重新排队，请稍后查询" });
    }
    return json({ ok: true, code: "IN_PROGRESS", status: existing.status });
  }

  const now = nowSec();
  await env.DB.prepare("INSERT INTO jobs (tid, status, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .bind(tid, STATUS.PENDING, raw, now, now)
    .run();

  return json({
    ok: true,
    code: "CREATED",
    status: STATUS.PENDING,
    message: "备份任务已创建，请稍后查询下载",
  });
}

async function handleQuery(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const tid = extractTid(url.searchParams.get("tid") || "");
  if (tid === null) {
    return json({ ok: false, code: "INVALID_TID", message: "请输入有效的帖子 ID" }, 400);
  }
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE tid = ?")
    .bind(tid)
    .first<JobRow>();
  if (!job) {
    return json({ ok: true, code: "NOT_FOUND", status: "not_found", message: "暂无该帖子的备份记录" });
  }
  if (job.status === STATUS.DONE && job.r2_key) {
    return json({
      ok: true,
      code: "DONE",
      status: STATUS.DONE,
      title: job.title,
      downloadUrl: `/download/${tid}`,
      fileSize: job.file_size,
    });
  }
  if (job.status === STATUS.FAILED) {
    return json({ ok: true, code: "FAILED", status: STATUS.FAILED, message: "备份失败", error: job.error });
  }
  return json({
    ok: true,
    code: "IN_PROGRESS",
    status: job.status,
    message: job.status === STATUS.PROCESSING ? "正在处理中，请稍后查询" : "排队中，等待本地端处理",
  });
}

async function handleDownload(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const tid = extractTid(url.pathname.split("/")[2] || "");
  if (tid === null) return new Response("Not Found", { status: 404 });

  const ip = request.headers.get("cf-connecting-ip") || "";
  if (!(await rateLimit(ip, env))) {
    return json({ ok: false, code: "RATE_LIMITED", message: "下载速度过快" }, 429);
  }

  const job = await env.DB.prepare("SELECT * FROM jobs WHERE tid = ?")
    .bind(tid)
    .first<JobRow>();
  if (!job || job.status !== STATUS.DONE || !job.r2_key) {
    return new Response("Not Found", { status: 404 });
  }

  const object = await env.BUCKET.get(job.r2_key);
  if (!object) return new Response("Not Found", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "public, max-age=3600");
  const base = safeName(job.title) || `tieba_${tid}`;
  headers.set("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(base + ".txt")}`);
  return new Response(object.body, { headers });
}

async function handlePending(request: Request, env: Env): Promise<Response> {
  if (!authorized(request, env)) return json({ ok: false, code: "UNAUTHORIZED" }, 401);
  const rows = await env.DB.prepare("SELECT * FROM jobs WHERE status = ? ORDER BY created_at ASC LIMIT 20")
    .bind(STATUS.PENDING)
    .all<JobRow>();
  return json({ ok: true, jobs: rows.results });
}

async function handleClaim(request: Request, env: Env): Promise<Response> {
  if (!authorized(request, env)) return json({ ok: false, code: "UNAUTHORIZED" }, 401);
  const tid = extractTid(new URL(request.url).pathname.split("/")[4] || "");
  if (tid === null) return json({ ok: false, code: "INVALID_TID" }, 400);
  const res = await env.DB.prepare("UPDATE jobs SET status = ?, updated_at = ? WHERE tid = ? AND status = ?")
    .bind(STATUS.PROCESSING, nowSec(), tid, STATUS.PENDING)
    .run();
  if (res.meta.changes === 0) {
    return json({ ok: false, code: "ALREADY_CLAIMED", message: "任务已被处理或不存在" }, 409);
  }
  return json({ ok: true, tid });
}

async function handleComplete(request: Request, env: Env): Promise<Response> {
  if (!authorized(request, env)) return json({ ok: false, code: "UNAUTHORIZED" }, 401);
  const tid = extractTid(new URL(request.url).pathname.split("/")[4] || "");
  if (tid === null) return json({ ok: false, code: "INVALID_TID" }, 400);

  const url = new URL(request.url);
  const title = url.searchParams.get("title") || "";
  const body = await request.arrayBuffer();

  const key = `txt/${tid}.txt`;
  await env.BUCKET.put(key, body, {
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
  });

  await env.DB.prepare(
    "UPDATE jobs SET status = ?, r2_key = ?, title = ?, file_size = ?, error = NULL, updated_at = ? WHERE tid = ?"
  )
    .bind(STATUS.DONE, key, title, body.byteLength, nowSec(), tid)
    .run();

  return json({ ok: true, status: STATUS.DONE, downloadUrl: `/download/${tid}` });
}

async function handleFail(request: Request, env: Env): Promise<Response> {
  if (!authorized(request, env)) return json({ ok: false, code: "UNAUTHORIZED" }, 401);
  const tid = extractTid(new URL(request.url).pathname.split("/")[4] || "");
  if (tid === null) return json({ ok: false, code: "INVALID_TID" }, 400);
  let error = "";
  try {
    const b = (await request.json()) as { error?: unknown };
    error = String(b.error ?? "").slice(0, 1000);
  } catch {
    /* ignore */
  }
  await env.DB.prepare("UPDATE jobs SET status = ?, error = ?, updated_at = ? WHERE tid = ?")
    .bind(STATUS.FAILED, error, nowSec(), tid)
    .run();
  return json({ ok: true, status: STATUS.FAILED });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      if (path === "/api/submit" && method === "POST") return await handleSubmit(request, env);
      if (path === "/api/query" && method === "GET") return await handleQuery(request, env);
      if (path.startsWith("/download/")) return await handleDownload(request, env);

      if (path === "/api/internal/jobs/pending" && method === "GET") return await handlePending(request, env);
      if (/^\/api\/internal\/jobs\/\d+\/claim$/.test(path) && method === "POST") return await handleClaim(request, env);
      if (/^\/api\/internal\/jobs\/\d+\/complete$/.test(path) && method === "POST") return await handleComplete(request, env);
      if (/^\/api\/internal\/jobs\/\d+\/fail$/.test(path) && method === "POST") return await handleFail(request, env);

      if (path.startsWith("/api/") || path.startsWith("/download/")) {
        return json({ ok: false, code: "NOT_FOUND", message: "接口不存在" }, 404);
      }
      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error(err);
      return json({ ok: false, code: "INTERNAL", message: "服务器内部错误" }, 500);
    }
  },
};
