#!/usr/bin/env python3
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import quote

HERE = os.path.dirname(os.path.abspath(__file__))


def load_env_file(path):
    if not os.path.isfile(path):
        return
    with open(path, "rb") as f:
        raw = f.read()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("gbk", errors="replace")
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v


load_env_file(os.path.join(HERE, ".env"))

os.environ.setdefault("PYTHONUTF8", "1")
os.environ.setdefault("PYTHONIOENCODING", "utf-8")


def resolve(p):
    if p and not os.path.isabs(p):
        return os.path.normpath(os.path.join(HERE, p))
    return p


WORKER_URL = os.environ.get("WORKER_URL", "").rstrip("/")
ADMIN_SECRET = os.environ.get("ADMIN_SECRET", "")
TIEBA_BDUSS = os.environ.get("TIEBA_BDUSS", "")
TIEBA_ARCHIVER_SRC = resolve(os.environ.get("TIEBA_ARCHIVER_SRC", os.path.join(HERE, "..", "TiebaArchiver", "src")))
TIEBA_OUTPUT_DIR = resolve(os.environ.get("TIEBA_OUTPUT_DIR", ""))
WAF_COOKIE = os.environ.get("WAF_COOKIE", "")
WAF_UA = os.environ.get("WAF_UA", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36")
PYTHON = os.environ.get("PYTHON", "python")
INTERVAL = int(os.environ.get("POLL_INTERVAL_SECONDS", "3600"))

HEADLESS_SCRIPT = os.path.join(TIEBA_ARCHIVER_SRC, "headless_scrape.py")
TXT_EXPORT_SCRIPT = os.path.join(HERE, "txt_export.py")


def log(msg):
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)


def http_json(url, method="GET", body=None, headers=None):
    h = {
        "x-admin-secret": ADMIN_SECRET,
        "user-agent": WAF_UA,
        "accept": "application/json, text/plain, */*",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    }
    if WAF_COOKIE:
        h["cookie"] = WAF_COOKIE
    if headers:
        h.update(headers)
    data = None
    if body is not None:
        if isinstance(body, (bytes, bytearray)):
            data = bytes(body)
        else:
            data = json.dumps(body).encode("utf-8")
            h.setdefault("content-type", "application/json")
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"error": raw}
    except urllib.error.URLError as e:
        return 0, {"error": str(e)}


def run(cmd, cwd=None, env=None):
    log("执行: " + " ".join(cmd))
    return subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True,
                          encoding="utf-8", errors="replace")


def process_job(job):
    tid = job["tid"]

    sc, claim = http_json(f"{WORKER_URL}/api/internal/jobs/{tid}/claim", "POST", b"")
    if sc != 200 or not claim.get("ok"):
        log(f"[{tid}] claim 失败: {claim}")
        return
    log(f"[{tid}] 已领取，开始抓取")

    try:
        env = os.environ.copy()
        env["TIEBA_BDUSS"] = TIEBA_BDUSS
        cwd = TIEBA_OUTPUT_DIR or TIEBA_ARCHIVER_SRC

        proc = run([PYTHON, HEADLESS_SCRIPT, str(tid)], cwd=cwd, env=env)
        if proc.returncode != 0:
            raise RuntimeError(f"抓取失败: {proc.stderr.strip()[-500:]}")
        item_dir = proc.stdout.strip().splitlines()[-1].strip()
        log(f"[{tid}] 抓取完成: {item_dir}")

        proc = run([PYTHON, TXT_EXPORT_SCRIPT, item_dir])
        if proc.returncode != 0:
            raise RuntimeError(f"导出失败: {proc.stderr.strip()[-500:]}")
        result = json.loads(proc.stdout.strip().splitlines()[-1])
        txt_path = result["txt_path"]
        title = result.get("title", "")
        with open(txt_path, "rb") as f:
            txt_bytes = f.read()
        log(f"[{tid}] 导出完成: {txt_path} ({len(txt_bytes)} 字节)")

        sc, done = http_json(
            f"{WORKER_URL}/api/internal/jobs/{tid}/complete?title={quote(title)}",
            "POST", txt_bytes, {"content-type": "text/plain; charset=utf-8"},
        )
        if sc != 200 or not done.get("ok"):
            raise RuntimeError(f"上传失败: {done}")
        log(f"[{tid}] 完成，下载: {done.get('downloadUrl')}")

    except Exception as e:
        log(f"[{tid}] 失败: {e}")
        http_json(f"{WORKER_URL}/api/internal/jobs/{tid}/fail", "POST", {"error": str(e)})


def main():
    if not (WORKER_URL and ADMIN_SECRET and TIEBA_BDUSS):
        log("缺少配置：请设置 WORKER_URL / ADMIN_SECRET / TIEBA_BDUSS（见 local/.env.example）")
        return 2

    if not os.path.isfile(HEADLESS_SCRIPT):
        log(f"未找到 TiebaArchiver 无头入口: {HEADLESS_SCRIPT}")
        return 2

    log(f"启动轮询，间隔 {INTERVAL}s，目标 {WORKER_URL}")
    while True:
        try:
            sc, data = http_json(f"{WORKER_URL}/api/internal/jobs/pending")
            if sc == 200 and data.get("ok"):
                jobs = data.get("jobs", [])
                if jobs:
                    log(f"发现 {len(jobs)} 个待处理任务")
                for job in jobs:
                    process_job(job)
            else:
                log(f"拉取任务失败: {data}")
        except Exception as e:
            log(f"轮询异常: {e}")
        time.sleep(INTERVAL)


if __name__ == "__main__":
    sys.exit(main())
