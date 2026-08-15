-- 用户许可协议同意记录（与 jobs 表分离，仅用于审计/风控）
CREATE TABLE IF NOT EXISTS consents (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ip         TEXT,             -- 客户端 IP（CF-Connecting-IP）
    tid        INTEGER,          -- 请求备份的帖子 ID
    agreed     INTEGER NOT NULL DEFAULT 1, -- 是否同意协议（1 同意）
    user_agent TEXT,             -- 客户端 User-Agent
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_consents_created ON consents (created_at);
CREATE INDEX IF NOT EXISTS idx_consents_ip ON consents (ip);
