#!/usr/bin/env python3
"""把 TiebaArchiver 抓取结果导出为 txt，stdout 输出 {"title","txt_path","tid"}。"""

import json
import os
import sqlite3
import sys
from datetime import datetime


def fmt_time(ts):
    if not ts:
        return ""
    try:
        return datetime.fromtimestamp(int(ts)).strftime("%Y-%m-%d %H:%M")
    except Exception:
        return str(ts)


def frag_to_text(frag):
    """把单个内容碎片映射成文本。type 枚举见 TiebaArchiver/src/pojo/content_frag.py"""
    t = frag.get("type")
    if t == 1:  # 文本
        return frag.get("text", "")
    if t == 2:  # 表情
        return f"[表情:{frag.get('desc', '')}]"
    if t == 3:  # 图片
        src = frag.get("tb_origin_src") or frag.get("filename", "")
        return f"[图片:{src}]"
    if t == 4:  # @某人
        return frag.get("text", "")
    if t == 5:  # 链接
        title = frag.get("title", "")
        url = frag.get("raw_url", "")
        return f"[链接:{title} {url}]".strip()
    if t == 6:  # 贴吧Plus广告
        return f"[广告:{frag.get('text', '')}]" if frag.get("text") else ""
    if t == 7:  # 视频
        src = frag.get("tb_origin_src") or frag.get("filename", "")
        return f"[视频:{src}]"
    if t == 8:  # 语音
        src = frag.get("tb_origin_src") or frag.get("filename", "")
        return f"[语音:{src}]"
    if t == -1:  # 爬取错误标记
        return f"[爬取失败:{frag.get('error_frag_name', '')}]"
    return ""


def contents_to_text(contents):
    try:
        frags = json.loads(contents)
    except Exception:
        return contents or ""
    return "".join(frag_to_text(f) for f in frags).strip()


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "缺少参数: item_dir"}), file=sys.stderr)
        return 2
    item_dir = sys.argv[1]
    if not os.path.isdir(item_dir):
        print(json.dumps({"error": "目录不存在"}), file=sys.stderr)
        return 2

    # 确定 main_thread
    tid = None
    info_path = os.path.join(item_dir, "scrape_info.json")
    if os.path.isfile(info_path):
        with open(info_path, encoding="utf-8") as f:
            info = json.load(f)
            tid = info.get("main_thread")
    if not tid:
        threads_dir = os.path.join(item_dir, "threads")
        if os.path.isdir(threads_dir):
            subs = [d for d in os.listdir(threads_dir) if d.isdigit()]
            if subs:
                tid = int(subs[0])
    if not tid:
        print(json.dumps({"error": "无法确定帖子 ID"}), file=sys.stderr)
        return 2

    tid_dir = os.path.join(item_dir, "threads", str(tid))
    db_path = os.path.join(tid_dir, "content.db")
    if not os.path.isfile(db_path):
        print(json.dumps({"error": f"content.db 不存在: {db_path}"}), file=sys.stderr)
        return 2

    # 元信息
    title, forum_name, author_id = "", "", None
    thread_path = os.path.join(tid_dir, "thread.json")
    if os.path.isfile(thread_path):
        with open(thread_path, encoding="utf-8") as f:
            th = json.load(f)
            title = th.get("title", "")
            forum_name = th.get("forum_name", "")
            author_id = th.get("user_id")
    forum_path = os.path.join(tid_dir, "forum.json")
    if not forum_name and os.path.isfile(forum_path):
        with open(forum_path, encoding="utf-8") as f:
            forum_name = json.load(f).get("name", "")

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    users = {}
    try:
        for row in cur.execute("SELECT id, nickname, username, level FROM user"):
            users[row["id"]] = {
                "name": row["nickname"] or row["username"] or str(row["id"]),
                "level": row["level"],
            }
    except Exception:
        pass

    def uname(uid):
        u = users.get(uid)
        return u["name"] if u else f"用户{uid}"

    lines = []
    lines.append(f"标题：{title}")
    lines.append(f"吧名：{forum_name}")
    if author_id:
        lines.append(f"楼主：{uname(author_id)}")
    lines.append(f"帖子ID：{tid}")
    lines.append("=" * 60)
    lines.append("")

    floors = list(cur.execute("SELECT * FROM post WHERE parent_id = 0 ORDER BY floor ASC"))
    for p in floors:
        nm = uname(p["user_id"])
        tag = " [楼主]" if p["is_thread_author"] else ""
        sign = f" ｜ {p['sign']}" if p["sign"] else ""
        header = (
            f"【{p['floor']}楼】{nm}{tag} ｜ {fmt_time(p['create_time'])}"
            f" ｜ 赞{p['agree']} 踩{p['disagree']}{sign}"
        )
        lines.append(header)
        body = contents_to_text(p["contents"])
        if body:
            lines.append(body)
        subs = list(cur.execute("SELECT * FROM post WHERE parent_id = ? ORDER BY create_time ASC", (p["id"],)))
        for c in subs:
            cname = uname(c["user_id"])
            reply = f"回复 {uname(c['reply_to_id'])}：" if c["reply_to_id"] else ""
            ctext = contents_to_text(c["contents"])
            lines.append(f"    └ {cname}：{reply}{ctext}")
        lines.append("")
        lines.append("-" * 60)
        lines.append("")

    conn.close()

    out_path = os.path.join(item_dir, f"{tid}.txt")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    print(json.dumps({"title": title, "txt_path": os.path.abspath(out_path), "tid": tid}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
