CREATE TABLE IF NOT EXISTS rate_limits (
    ip           TEXT PRIMARY KEY,
    timestamps   TEXT NOT NULL,
    banned_until INTEGER NOT NULL DEFAULT 0
);
