-- 备份任务表
CREATE TABLE IF NOT EXISTS jobs (
    tid        INTEGER PRIMARY KEY,
    status     TEXT    NOT NULL DEFAULT 'pending', -- pending | processing | done | failed
    source     TEXT,                               -- 用户提交的原始 url 或 tid
    title      TEXT,                               -- 帖子标题（完成时回填）
    r2_key     TEXT,                               -- R2 对象 key
    file_size  INTEGER,                            -- txt 字节数
    error      TEXT,                               -- 失败原因
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs (created_at);
