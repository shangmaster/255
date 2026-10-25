"""
端到端演示：不联网，用一个假的学习通服务端把整条链路跑一遍。

用法（在 auto-sign/ 目录下）：
    python demo.py

它会：
  1. 造一份 config.json / cookies.json（临时，跑完删掉）
  2. 让 sign.py --once 真正执行一次
  3. 用假服务端返回真实的"距离还差多少米"，观察程序自己算坐标逼近
"""

from __future__ import annotations

import io
import json
import shutil
import sys
import tempfile
from pathlib import Path

BASE = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE))

import core  # noqa: E402
import sign  # noqa: E402

# 假设：签到地点在这里，学校把允许范围设成 200 米
TRUE_LAT, TRUE_LON = 38.041234, 114.512345
RADIUS = 200.0
# 起点故意放在 2 公里外
START_LAT, START_LON = 38.060000, 114.530000


class FakeChaoxing(core.Http):
    """顶替 core.Http：activelist 返回一个位置签到，stuSignajax 按真实距离作答。"""

    def __init__(self, cookies, timeout=15):
        super().__init__(cookies, timeout)
        self.attempts = []

    def request(self, url, data=None, referer=""):
        if "activelist" in url:
            return 200, json.dumps({
                "result": 1,
                "data": {
                    "activeList": [{
                        "activeId": "4000175553141",
                        "nameOne": "位置签到",
                        "status": 1,
                        "activeSort": 4,
                        "otherId": 4,
                        "startTime": 1792081000000,
                    }]
                },
            })
        if "stuSignajax" in url:
            lat = float(data["latitude"])
            lon = float(data["longitude"])
            self.attempts.append((lat, lon))
            d = core.distance(lat, lon, TRUE_LAT, TRUE_LON)
            if d <= RADIUS:
                return 200, "success"
            return 200, f"签到失败，您当前距离签到地点还有{round(d)}米，请到签到地点后再试"
        return 200, ""


def main() -> int:
    sign._setup_console()
    work = Path(tempfile.mkdtemp(prefix="cxl-demo-"))
    print(f"临时目录：{work}\n")
    try:
        cfg = dict(sign.DEFAULT_CONFIG)
        cfg.update({
            "enabled": True,
            "start_time": "00:00",
            "end_time": "23:59",
            "weekdays": [],
            "start_point": {"lat": START_LAT, "lon": START_LON, "address": "演示起点"},
            "courses": [{"name": "演示课程", "course_id": "268194985",
                         "class_id": "157462133", "fid": "135774"}],
            "uid": "342160606",
            "fid": "135774",
            "name": "张三",
            "max_rounds": 10,
        })
        (work / "config.json").write_text(json.dumps(cfg, ensure_ascii=False), encoding="utf-8")
        (work / "cookies.json").write_text(
            json.dumps({"cookies": {"_uid": "342160606", "fid": "135774"}}), encoding="utf-8")

        # 把 sign.py 的路径常量指向临时目录，并换上假服务端
        sign.CONFIG = work / "config.json"
        sign.COOKIES = work / "cookies.json"
        sign.STATE = work / "state.json"
        sign.LOGS = work / "logs"

        fake = FakeChaoxing({"fid": "135774"})
        real_http = core.Http

        def factory(cookies, timeout=15):
            return fake

        core.Http = factory  # type: ignore[assignment]
        try:
            rc = sign.run_once(sign.load_config(), force=True)
        finally:
            core.Http = real_http  # type: ignore[assignment]

        print()
        print("=" * 60)
        print(f"返回码          : {rc}  (0 = 成功)")
        print(f"共提交          : {len(fake.attempts)} 次")
        for i, (lat, lon) in enumerate(fake.attempts, 1):
            d = core.distance(lat, lon, TRUE_LAT, TRUE_LON)
            print(f"  第 {i} 次: ({lat:.6f}, {lon:.6f})  距签到地点 {d:7.1f} m"
                  f"  {'✓ 在范围内' if d <= RADIUS else ''}")
        final = fake.attempts[-1]
        err = core.distance(final[0], final[1], TRUE_LAT, TRUE_LON)
        print(f"最终误差        : {err:.1f} m （允许范围 {RADIUS:.0f} m）")
        print("=" * 60)
        return 0 if rc == 0 else 1
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
