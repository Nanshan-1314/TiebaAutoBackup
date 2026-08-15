#!/usr/bin/env python3
"""TiebaArchiver 无头抓取入口。用法: python headless_scrape.py <tid>"""

import asyncio
import json
import os
import sys

from tieba_auth import TiebaAuth
from scrape_config import ScrapeConfig, PostFilterType, DownloadUserAvatarMode
from modules.scrape_module import scrape
from container.container import Container


def main() -> int:
    if len(sys.argv) < 2:
        print("用法: python headless_scrape.py <tid>", file=sys.stderr)
        return 2
    try:
        tid = int(sys.argv[1])
    except ValueError:
        print("tid 必须为整数", file=sys.stderr)
        return 2

    bduss = os.environ.get("TIEBA_BDUSS", "").strip()
    if bduss:
        TiebaAuth.BDUSS = bduss
    else:
        auth_path = os.path.join(os.getcwd(), "tieba_auth.json")
        if os.path.isfile(auth_path):
            with open(auth_path, "r", encoding="utf-8") as f:
                TiebaAuth.from_dict(json.load(f))
        else:
            print("缺少 BDUSS：请设置 TIEBA_BDUSS 或准备 tieba_auth.json", file=sys.stderr)
            return 2

    ScrapeConfig.POST_FILTER_TYPE = os.environ.get(
        "TIEBA_FILTER", PostFilterType.AUTHOR_POSTS_ONLY
    )
    ScrapeConfig.DOWNLOAD_USER_AVATAR_MODE = os.environ.get(
        "TIEBA_AVATAR", DownloadUserAvatarMode.NONE
    )
    ScrapeConfig.SCRAPE_SHARE_ORIGIN = os.environ.get("TIEBA_SHARE_ORIGIN", "0") == "1"

    Container.scrape_data_path_builder = None
    Container.tid = 0
    Container.scrape_timestamp = 0
    Container.scrape_logger = None
    Container.content_db = None

    asyncio.run(scrape(tid))

    builder = Container.scrape_data_path_builder
    if builder is None:
        print("抓取失败（帖子可能不存在/被删除，或网络/BDUSS 异常）", file=sys.stderr)
        return 1

    print(os.path.abspath(builder.get_item_dir()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
