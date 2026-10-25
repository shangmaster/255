"""
学习通位置签到 · 自动签到核心库（纯标准库，不依赖第三方包）

设计原则
--------
1. 只用 HTTPS 直连 mobilelearn.chaoxing.com / i.chaoxing.com，不模拟浏览器自动化，
   （模拟浏览器会引入 webdriver 指纹，反而更容易被识别）。
2. 所有"业务判断"都是纯函数（纯逻辑），可以脱网单测；网络与磁盘 IO 收在薄薄一层。
3. 位置签到失败时，服务端会返回"距离签到地点还有 X 米"——这就是一次距离测量。
   用多条测量做圆相交 / 最小二乘，逼近签到地点，直到签上。

坐标约定
--------
所有内部计算一律使用 GCJ-02（国内地图坐标），提交前不再换算。
"""

from __future__ import annotations

import datetime as _dt
import json
import math
import os
import random
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Iterable, Sequence

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------

SIGN_HOST = "https://mobilelearn.chaoxing.com"
ACTIVE_LIST_PATH = "/v2/apis/active/student/activelist"
SIGN_PATH = "/pptSign/stuSignajax"

WEEKDAY_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]

M_PER_DEG_LAT = 111320.0

# 判断"距离"用的正则：服务端文案形如 "还有1568米" "约 1.2 公里" "还差300m"
DISTANCE_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(千米|公里|km|米|m)(?![a-z])", re.I)
RANGE_RE = re.compile(r"(?:范围|半径)[^0-9]{0,6}(\d+(?:\.\d+)?)\s*(千米|公里|km|米|m)", re.I)


def meters_per_deg_lon(lat: float) -> float:
    return M_PER_DEG_LAT * math.cos(math.radians(lat))


# ---------------------------------------------------------------------------
# 1) 时段
# ---------------------------------------------------------------------------


def parse_clock(text: Any) -> int | None:
    """'08:00' / '8:00' / '0800' / '24:00' -> 分钟数；非法返回 None。"""
    if text is None:
        return None
    s = str(text).strip()
    if not s:
        return None
    m = re.fullmatch(r"(\d{1,2})[:：.]?(\d{1,2})?", s)
    if not m:
        return None
    h = int(m.group(1))
    mi = int(m.group(2)) if m.group(2) is not None else 0
    if h == 24 and mi == 0:
        return 24 * 60
    if h > 23 or mi > 59:
        return None
    return h * 60 + mi


def format_clock(minutes: float) -> str:
    n = int(round(minutes)) % 1440
    return f"{n // 60:02d}:{n % 60:02d}"


def is_active_weekday(day: _dt.date, weekdays: Sequence[int]) -> bool:
    """weekdays 为空 = 每天。"""
    if not weekdays:
        return True
    return day.isoweekday() % 7 in {int(d) for d in weekdays}


def describe_weekdays(weekdays: Sequence[int]) -> str:
    lst = sorted({int(d) for d in (weekdays or [])})
    if not lst or len(lst) == 7:
        return "每天"
    names = [WEEKDAY_NAMES[d] for d in lst]
    if len(lst) >= 3 and lst == list(range(lst[0], lst[0] + len(lst))) and 0 not in lst:
        return f"{names[0]}至{names[-1]}"
    return "、".join(names)


@dataclass
class Schedule:
    active: bool
    in_window: bool
    reason: str
    phase: str  # in / pre / post / off
    next_at: _dt.datetime | None = None


def check_schedule(now: _dt.datetime, cfg: dict[str, Any]) -> Schedule:
    """
    硬约束：只在设定的星期 + 起止时间内干活。
    支持跨夜时段（22:00 - 02:00）。
    """
    if not cfg.get("enabled", False):
        return Schedule(False, False, "自动签到没打开", "off")

    start = parse_clock(cfg.get("start_time", "08:00"))
    end = parse_clock(cfg.get("end_time", "14:00"))
    if start is None:
        start = 8 * 60
    if end is None:
        end = 14 * 60
    days = cfg.get("weekdays") or []

    today_ok = is_active_weekday(now.date(), days)
    ms = now.hour * 3600 + now.minute * 60 + now.second

    if start == end:
        return Schedule(False, False, "起止时间相同，等于没有时段", "pre")

    if start < end:
        if not today_ok:
            return Schedule(False, False, f"今天不在选定的星期里（{describe_weekdays(days)}）", "pre")
        if ms < start * 60:
            return Schedule(False, False, f"还没到 {format_clock(start)}", "pre")
        if ms < end * 60:
            return Schedule(True, True, f"在时段内（{format_clock(start)}-{format_clock(end)}）", "in")
        return Schedule(False, False, f"今天的时段已过（{format_clock(end)}）", "post")

    # 跨夜：起点之后，或次日终点之前
    span = f"在跨夜时段内（{format_clock(start)}-次日 {format_clock(end)}）"
    if ms >= start * 60:
        if not today_ok:
            return Schedule(False, False, f"今天不在选定的星期里（{describe_weekdays(days)}）", "pre")
        return Schedule(True, True, span, "in")
    if ms < end * 60:
        # 次日凌晨这一段：星期看"前一天"，否则周一 22:00-周二 02:00 会被周二前的星期判断挡掉
        yesterday = now.date() - _dt.timedelta(days=1)
        if is_active_weekday(yesterday, days):
            return Schedule(True, True, span, "in")
    return Schedule(False, False, f"还没到 {format_clock(start)}", "pre")


def next_start(now: _dt.datetime, cfg: dict[str, Any]) -> _dt.datetime | None:
    """下一次开门时刻（给计划任务/睡眠用）。"""
    start = parse_clock(cfg.get("start_time", "08:00"))
    if start is None:
        start = 8 * 60
    days = cfg.get("weekdays") or []
    for d in range(0, 9):
        cand_date = now.date() + _dt.timedelta(days=d)
        cand = _dt.datetime.combine(
            cand_date, _dt.time(start // 60 % 24, start % 60), tzinfo=now.tzinfo
        )
        if cand <= now:
            continue
        if is_active_weekday(cand_date, days):
            return cand
    return None


# ---------------------------------------------------------------------------
# 2) 服务端返回的归类
# ---------------------------------------------------------------------------


@dataclass
class SignResult:
    ok: bool
    kind: str  # success / already / too_far / face / qr / login / expired / photo / validate / empty / other
    meters: float | None = None
    allowed_range: float | None = None
    raw: str = ""

    @property
    def need_app(self) -> bool:
        return self.kind in ("face", "qr")


def _to_meters(num: float, unit: str) -> float:
    unit = unit.lower()
    if unit in ("千米", "公里", "km"):
        return num * 1000.0
    return num


def classify(text: str) -> SignResult:
    """把 stuSignajax 的返回翻译成结构化结果。"""
    raw = (text or "").strip()
    if raw in ("success", "success2") or re.search(r'"success"\s*:\s*true', raw, re.I):
        return SignResult(True, "success", raw=raw)
    if not raw:
        return SignResult(False, "empty", raw=raw)
    if re.search(r"请先登录|未登录|登录已过期|not\s*login", raw, re.I):
        return SignResult(False, "login", raw=raw)
    if re.search(r"已签到|重复签到|请勿重复|签到过了", raw):
        return SignResult(False, "already", raw=raw)

    m = DISTANCE_RE.search(raw)
    farthest = re.search(r"范围|距离|太远|过远|不在.*(范围|区域)|超出", raw)
    if m and (farthest or re.search(r"签到地点|签到范围", raw)):
        meters = _to_meters(float(m.group(1)), m.group(2))
        allowed = None
        mr = RANGE_RE.search(raw)
        if mr:
            allowed = _to_meters(float(mr.group(1)), mr.group(2))
        return SignResult(False, "too_far", meters=meters, allowed_range=allowed, raw=raw)

    if re.search(r"\[face\]|人脸|活体", raw):
        return SignResult(False, "face", raw=raw)
    if re.search(r"重新扫描|二维码", raw):
        return SignResult(False, "qr", raw=raw)
    if re.search(r"photoAuthError", raw, re.I):
        return SignResult(False, "photo", raw=raw)
    if re.search(r"已结束|过期|失效", raw):
        return SignResult(False, "expired", raw=raw)
    if re.search(r"validate|校验|参数", raw):
        return SignResult(False, "validate", raw=raw)
    return SignResult(False, "other", raw=raw)


def explain(res: SignResult) -> str:
    table = {
        "success": "签到成功",
        "already": "之前已经签过了",
        "too_far": "离签到地点太远",
        "face": "要人脸活体（网页/接口方式拿不到凭证，只能用 APP）",
        "qr": "要扫老师屏幕上的二维码（enc 参数拿不到，只能用 APP）",
        "login": "登录态失效，需要重新导出 cookie",
        "expired": "活动已结束或已过期",
        "photo": "服务端拒绝了（拍照凭证校验）",
        "validate": "服务端要求额外校验（可能参数不符或被判异常）",
        "empty": "服务端返回空内容（多半是登录态失效）",
    }
    tail = table.get(res.kind, "未识别的返回")
    if res.kind == "too_far" and res.meters is not None:
        extra = f"，还差 {res.meters:.0f} 米"
        if res.allowed_range:
            extra += f"（允许范围约 {res.allowed_range:.0f} 米）"
        return tail + extra
    return tail


# ---------------------------------------------------------------------------
# 3) 三点定位
# ---------------------------------------------------------------------------


@dataclass
class Observation:
    """在 (lat, lon) 提交，服务端说还差 meters 米。"""

    lat: float
    lon: float
    meters: float
    deg: float | None = None  # 探点方向（度，0=正北，顺时针）


@dataclass
class SolveResult:
    lat: float
    lon: float
    residual: float
    mode: str
    used: int


def _project(points: Sequence[Observation], origin: tuple[float, float]):
    mlon = meters_per_deg_lon(origin[0])
    out = []
    for p in points:
        out.append(
            (
                (p.lon - origin[1]) * mlon,
                (p.lat - origin[0]) * M_PER_DEG_LAT,
                float(p.meters),
            )
        )
    return out


def _mean_residual(x: float, y: float, pts: Sequence[tuple[float, float, float]]) -> float:
    if not pts:
        return float("inf")
    s = 0.0
    for px, py, r in pts:
        s += abs(math.hypot(x - px, y - py) - r)
    return s / len(pts)


def solve_exact(obs: Sequence[Observation]) -> SolveResult | None:
    """
    圆相交：两个圆交出两个候选点，多个圆对里取"对所有测量最不矛盾"的那个。
    只有它能把"点在圆的哪一侧"的符号信息保住（最小二乘会丢）。
    """
    pts_in = [o for o in obs if o and o.meters >= 0 and math.isfinite(o.meters)]
    if len(pts_in) < 2:
        return None

    o_lat = sum(o.lat for o in pts_in) / len(pts_in)
    o_lon = sum(o.lon for o in pts_in) / len(pts_in)
    mlon = meters_per_deg_lon(o_lat)
    pts = _project(pts_in, (o_lat, o_lon))
    n = len(pts)

    def err_at(x: float, y: float) -> float:
        return _mean_residual(x, y, pts)

    best = None
    for i in range(n):
        for j in range(i + 1, n):
            ax, ay, ar = pts[i]
            bx, by, br = pts[j]
            dx, dy = bx - ax, by - ay
            d = math.hypot(dx, dy)
            if d < 1e-9:
                continue
            r1, r2 = ar, br
            # 相离 / 内含时把半径拉到刚好相切，仍然给出可用候选
            if d > r1 + r2:
                k = d / (r1 + r2) if (r1 + r2) > 1e-9 else 0
                if k <= 0:
                    continue
                r1 *= k
                r2 *= k
            elif d < abs(r1 - r2):
                big, small = max(r1, r2), min(r1, r2)
                mid = (big + d + small) / 2
                if r1 >= r2:
                    r1, r2 = mid, mid - d
                else:
                    r2, r1 = mid, mid - d
                if r1 < 0 or r2 < 0:
                    continue
            a_len = (d * d + r1 * r1 - r2 * r2) / (2 * d)
            h2 = r1 * r1 - a_len * a_len
            h = math.sqrt(h2) if h2 > 0 else 0.0
            mx = ax + dx * a_len / d
            my = ay + dy * a_len / d
            ux, uy = -dy / d, dx / d
            for sx, sy in ((mx + ux * h, my + uy * h), (mx - ux * h, my - uy * h)):
                e = err_at(sx, sy)
                if math.isfinite(e) and (best is None or e < best[2]):
                    best = (sx, sy, e)

    if best is None:
        return None
    x, y, e = best
    return SolveResult(
        lat=round(o_lat + y / M_PER_DEG_LAT, 6),
        lon=round(o_lon + x / mlon, 6),
        residual=round(e, 1),
        mode="exact",
        used=len(pts_in),
    )


def solve(obs: Sequence[Observation]) -> SolveResult | None:
    """
    主解算：
      - 3 条以上不同位置的测量 -> 圆相交（唯一解，方向定得住）
      - 2 条 -> 圆相交有两个镜像解，取"离已测量点更近"的那个当**下一步的方向提示**，
                但结果标记为 midpoint_guided：别把它当最终答案，只是别让探点原地打转
      - 1 条 -> 就是那个测量点
    """
    pts_in = [o for o in obs if o and math.isfinite(o.meters) and o.meters >= 0]
    if not pts_in:
        return None

    seen: dict[tuple[float, float], Observation] = {}
    for o in pts_in:
        seen[(round(o.lat, 6), round(o.lon, 6))] = o
    uniq = list(seen.values())

    if len(uniq) >= 3:
        exact = solve_exact(uniq)
        if exact:
            return exact

    if len(uniq) == 2:
        # 两条测量：两个圆的交点关于两点连线对称，无法判定"点在线的哪一侧"。
        # 但用它做**探点方向**比用中点好得多 —— 中点会让下一次探点退回到连线上，
        # 永远拉不开方位（实测会连续两次往同一方向走，白跑一两轮）。
        # 所以这里返回交点，并明确标成 midpoint_guided，语义是"方向参考，不是结论"。
        cand = solve_exact(uniq)
        if cand:
            cand.mode = "guided"
            return cand

    lat = sum(o.lat for o in uniq) / len(uniq)
    lon = sum(o.lon for o in uniq) / len(uniq)
    if len(uniq) == 1:
        lat, lon = uniq[0].lat, uniq[0].lon
    pts = _project(uniq, (lat, lon))
    return SolveResult(
        lat=round(lat, 6),
        lon=round(lon, 6),
        residual=round(_mean_residual(0.0, 0.0, pts), 1),
        mode="circle" if len(uniq) == 1 else "midpoint",
        used=len(pts_in),
    )


def offset_point(lat: float, lon: float, north: float, east: float) -> tuple[float, float]:
    return (
        round(lat + north / M_PER_DEG_LAT, 6),
        round(lon + east / meters_per_deg_lon(lat), 6),
    )


def probe_point(lat: float, lon: float, radius: float, deg: float) -> tuple[float, float]:
    rad = math.radians(deg)
    return offset_point(lat, lon, math.cos(rad) * radius, math.sin(rad) * radius)


DIRECTIONS = [
    (0.0, "正北"),
    (90.0, "正东"),
    (180.0, "正南"),
    (270.0, "正西"),
    (45.0, "东北"),
    (135.0, "东南"),
    (225.0, "西南"),
    (315.0, "西北"),
]


def angle_gap(a: float, b: float) -> float:
    d = abs(a - b) % 360.0
    return 360.0 - d if d > 180.0 else d


def pick_direction(used: Iterable[float]) -> tuple[float, str]:
    """挑一个离已有测量方向最远的方位（三点定位最怕三条测量挤在一起）。"""
    used = [float(u) % 360.0 for u in used]
    best = None
    for deg, name in DIRECTIONS:
        score = 360.0 if not used else min(angle_gap(deg, u) for u in used)
        score -= deg * 1e-6
        if best is None or score > best[2]:
            best = (deg, name, score)
    return best[0], best[1]


@dataclass
class Plan:
    lat: float | None
    lon: float | None
    radius: float
    why: str
    solution: SolveResult | None = None
    direction: str = ""
    refine: bool = False
    deg: float | None = None


def _deg_of(plan: Plan | None) -> float | None:
    """从 plan 里取方位角（名字 -> 角度），给下一轮"避开已测方位"用。"""
    if not plan or not plan.direction:
        return None
    for deg, name in DIRECTIONS:
        if name == plan.direction:
            return deg
    return None


def plan_probe(
    obs: Sequence[Observation],
    max_probe_m: float = 800.0,
    good_enough_m: float = 25.0,
) -> Plan | None:
    """给下一步：往哪、多远、为什么。"""
    if not obs:
        return Plan(None, None, 0.0, "还没有测量，先用起始点试一次")

    last = obs[-1]
    sol = solve(obs)
    if sol is None:
        return Plan(last.lat, last.lon, min(max_probe_m, max(30.0, last.meters * 2)), "数据不够，扩半径再试")

    used = [o.deg for o in obs if o.deg is not None]

    # guided：两条测量给出的交点，只当方向参考。它和真实点可能差很远，
    # 所以这里不"贴着解细调"，而是从解出发换一个没试过的方位、给足半径去测。
    if sol.mode == "guided":
        deg, name = pick_direction(used)
        r = max(60.0, min(max_probe_m, max((last.meters or 0) * 1.4, 300.0)))
        lat, lon = probe_point(sol.lat, sol.lon, r, deg)
        return Plan(
            lat, lon, r,
            f"两条测量还分不清左右，先按圆交点的{name}方向 {r:.0f} m 处再测一次",
            sol, name, deg=deg,
        )

    if sol.residual <= good_enough_m:
        # 已收敛：在解附近按方位一点点挪，把最后那几十米磨掉
        deg, name = pick_direction(used)
        r = max(12.0, min(60.0, (last.meters or 0) * 0.6 + 12.0))
        lat, lon = probe_point(sol.lat, sol.lon, r, deg)
        return Plan(
            lat, lon, r,
            f"定位已收敛（残差 {sol.residual:.0f} m），把解往{name}挪 {r:.0f} m 细调",
            sol, name, refine=True, deg=deg,
        )

    deg, name = pick_direction(used)
    r = max(20.0, min(max_probe_m, max(sol.residual * 1.6, (last.meters or 0) + 60.0)))
    lat, lon = probe_point(sol.lat, sol.lon, r, deg)
    return Plan(
        lat, lon, r,
        f"按三点定位（残差 {sol.residual:.0f} m），往{name} {r:.0f} m 处再测一次",
        sol, name, deg=deg,
    )


# ---------------------------------------------------------------------------
# 4) 协议：地址组装 / 类型判定 / 提交参数
# ---------------------------------------------------------------------------


def build_active_list_url(course_id: str, class_id: str, fid: str = "") -> str:
    qs = urllib.parse.urlencode(
        {
            "fid": fid,
            "courseId": course_id,
            "classId": class_id,
            "showNotStartedActive": "0",
            "_": str(int(time.time() * 1000)),
        }
    )
    return f"{SIGN_HOST}{ACTIVE_LIST_PATH}?{qs}"


ACTIVE_SORT_KINDS = {1: "plain", 2: "plain", 3: "plain", 4: "location", 5: "location",
                     6: "qr", 7: "qr", 8: "qr", 9: "code", 16: "gesture"}
OTHER_ID_KINDS = {0: "plain", 1: "plain", 2: "plain", 3: "gesture", 4: "location",
                  5: "code", 6: "qr", 7: "qr", 8: "qr"}
KIND_LABELS = {"plain": "普通", "location": "位置", "qr": "二维码",
               "code": "签到码", "gesture": "手势", "unknown": "未知"}


def _num(v: Any) -> float | None:
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def detect_kind(item: dict[str, Any]) -> str:
    """
    基础类型只看服务端字段：activeSort 最准，其次 otherId。
    注意 ifphoto 只是"要求拍照"的附加标志，不是类型（当成类型会误判）。
    """
    sort = _num(item.get("activeSort"))
    other = _num(item.get("otherId"))
    if sort is not None and int(sort) in ACTIVE_SORT_KINDS:
        return ACTIVE_SORT_KINDS[int(sort)]
    if other is not None and int(other) in OTHER_ID_KINDS:
        return OTHER_ID_KINDS[int(other)]
    # 字段都没有时才看名字（老师起名通常很直白）
    name = str(item.get("nameOne") or item.get("name") or "")
    if re.search(r"位置|定位|签到地点", name):
        return "location"
    if re.search(r"二维码|扫码", name):
        return "qr"
    if re.search(r"手势", name):
        return "gesture"
    if re.search(r"签到码|数字码", name):
        return "code"
    if re.search(r"普通|常规", name):
        return "plain"
    return "unknown"


def extract_activities(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """把 activelist 的返回归一化成活动数组（只保留有编号、进行中的）。"""
    out: list[dict[str, Any]] = []
    data = payload.get("data") if isinstance(payload, dict) else None
    lst = None
    if isinstance(payload, dict):
        if isinstance(payload.get("activeList"), list):
            lst = payload["activeList"]
        elif isinstance(data, dict) and isinstance(data.get("activeList"), list):
            lst = data["activeList"]
        elif isinstance(data, dict) and isinstance(data.get("data"), dict) \
                and isinstance(data["data"].get("activeList"), list):
            lst = data["data"]["activeList"]
    if not lst:
        return out
    for item in lst:
        if not isinstance(item, dict):
            continue
        aid = str(item.get("activeId") or item.get("activePrimaryId") or item.get("id") or "").strip()
        if not re.fullmatch(r"\d{6,}", aid):
            continue
        status = _num(item.get("activeStatus", item.get("status")))
        out.append(
            {
                "activeId": aid,
                "status": int(status) if status is not None else 0,
                "name": re.sub(r"<[^>]*>", " ", str(item.get("nameOne") or item.get("name") or "")).strip(),
                "activeSort": item.get("activeSort"),
                "otherId": item.get("otherId"),
                "ifphoto": item.get("ifphoto"),
                "startTime": _num(item.get("startTime")) or 0.0,
                "kind": detect_kind(item),
            }
        )
    return out


def pick_location_activity(payload: dict[str, Any]) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    """
    在活动列表里挑出这次要签的：
      返回 (位置签到活动 or None, 被跳过的其它类型活动)
    """
    acts = [a for a in extract_activities(payload) if a["status"] == 1]
    acts.sort(key=lambda a: (a["startTime"], int(a["activeId"])), reverse=True)
    others = [a for a in acts if a["kind"] != "location"]
    locs = [a for a in acts if a["kind"] == "location"]
    return (locs[0] if locs else None), others


def build_sign_params(
    active_id: str,
    uid: str,
    fid: str,
    lat: float,
    lon: float,
    name: str = "",
    address: str = "",
    course_id: str = "",
    app_type: str = "15",
    if_tijiao: str = "1",
) -> dict[str, str]:
    """
    位置签到的表单字段（照官方 H5 页面）。
    坐标统一按 GCJ-02 六位小数的字符串提交；ifTiJiao / vp* 这些位置签到固定带的采集状态位也照抄。
    """
    params = {
        "activeId": str(active_id),
        "courseId": str(course_id or ""),
        "uid": str(uid),
        "clientip": "",
        "latitude": f"{lat:.6f}",
        "longitude": f"{lon:.6f}",
        "fid": str(fid),
        "appType": str(app_type),
        "name": name or "",
        "address": address or "",
        "ifTiJiao": str(if_tijiao),
        "vpProbability": "",
        "vpStrategy": "",
        "currentFaceId": "",
        "ifCFP": "0",
        "faceEnc": "",
        "faceCode": "",
    }
    return params


def distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """球面距离（米）。"""
    r = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlat = p2 - p1
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def parse_lat_lon(text: str) -> tuple[float, float] | None:
    """'30.1,120.2' / '纬度30.1 经度120.2' / '120.2,30.1'（自动纠正）-> (lat, lon)。"""
    if not text:
        return None
    s = re.sub(r"latitude|longitude|经度|纬度|坐标|经纬度", " ", str(text), flags=re.I)
    s = re.sub(r"[a-zA-Z_]{1,}\s*[:=]?", " ", s)
    s = re.sub(r"[，、；;：:()\[\]{}\s,°]", " ", s)
    nums = [float(x) for x in re.findall(r"-?\d+(?:\.\d+)?", s)]
    if len(nums) < 2:
        return None
    for lat, lon in ((nums[0], nums[1]), (nums[1], nums[0])):
        if 3 <= lat <= 54 and 73 <= lon <= 136:
            return lat, lon
    return None


# ---------------------------------------------------------------------------
# 5) 网络层（薄薄一层，方便测试替换）
# ---------------------------------------------------------------------------


class Http:
    """极简 HTTPS 客户端：带 cookie、带 UA、超时、可重试。"""

    UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
          "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

    def __init__(self, cookies: dict[str, str], timeout: int = 15):
        self.cookies = dict(cookies)
        self.timeout = timeout

    def cookie_header(self) -> str:
        return "; ".join(f"{k}={v}" for k, v in self.cookies.items() if v)

    def request(self, url: str, data: dict[str, str] | None = None,
                referer: str = "") -> tuple[int, str]:
        body = None
        headers = {
            "User-Agent": self.UA,
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "zh-CN,zh;q=0.9",
            "Cookie": self.cookie_header(),
        }
        if referer:
            headers["Referer"] = referer
        if data is not None:
            body = urllib.parse.urlencode(data).encode()
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        req = urllib.request.Request(url, data=body, headers=headers,
                                     method="POST" if body else "GET")
        last_err = None
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    return resp.status, resp.read().decode("utf-8", "replace")
            except urllib.error.HTTPError as e:
                return e.code, e.read().decode("utf-8", "replace")
            except Exception as e:  # 网络抖动：退避重试
                last_err = e
                time.sleep(1.5 * (attempt + 1) + random.random())
        raise RuntimeError(f"请求失败：{last_err}")


# ---------------------------------------------------------------------------
# 6) 一次签到的完整流程（编排层，IO 可注入以便测试）
# ---------------------------------------------------------------------------


@dataclass
class SignAttempt:
    lat: float
    lon: float
    result: SignResult


@dataclass
class WorkOutcome:
    ok: bool
    reason: str
    attempts: list[SignAttempt] = field(default_factory=list)
    activity: dict[str, Any] | None = None
    solution: SolveResult | None = None


def work_location_sign(
    http: Http,
    activity: dict[str, Any],
    start_lat: float,
    start_lon: float,
    uid: str,
    fid: str,
    name: str = "",
    address: str = "",
    max_rounds: int = 10,
    max_probe_m: float = 800.0,
    good_enough_m: float = 25.0,
    log=lambda msg, level="info": None,
    sleep=time.sleep,
) -> WorkOutcome:
    """
    只做位置签到：起点可能离得远，一轮轮用"服务端返回的距离"逼近签到地点。
    遇到非距离原因的失败立即收手（人脸/二维码/已结束…），不硬刷服务端。
    """
    cur = (float(start_lat), float(start_lon))
    obs: list[Observation] = []
    attempts: list[SignAttempt] = []
    tried: set[tuple[float, float]] = set()
    best_gap: float | None = None
    # 当前这个点是从"哪个方位"探出来的 —— 记下来，下一次换方向时才能避开它。
    # 不记的话每次都会挑同一个"最远方向"，连续两轮往同一条线上走（实测白跑一轮）。
    cur_deg: float | None = None

    for rnd in range(1, max_rounds + 1):
        key = (round(cur[0], 6), round(cur[1], 6))
        if key in tried:
            plan = plan_probe(obs, max_probe_m, good_enough_m)
            if not plan or plan.lat is None:
                break
            cur = (plan.lat, plan.lon)
            cur_deg = _deg_of(plan)
            key = (round(cur[0], 6), round(cur[1], 6))
            if key in tried:
                log("算出来的下一个点试过了，换方位", "warn")
                break
        tried.add(key)

        params = build_sign_params(
            activity["activeId"], uid, fid, cur[0], cur[1],
            name=name, address=address,
        )
        log(f"第 {rnd} 次提交 ({cur[0]:.6f}, {cur[1]:.6f})", "info")

        url = f"{SIGN_HOST}{SIGN_PATH}"
        status, text = http.request(url, data=params)
        res = classify(text)
        attempts.append(SignAttempt(cur[0], cur[1], res))

        if res.ok:
            log(f"✅ 签到成功（第 {rnd} 次提交）", "ok")
            return WorkOutcome(True, "签到成功", attempts, activity, solve(obs))

        if res.kind == "already":
            log("之前已经签过了，不再重复提交", "ok")
            return WorkOutcome(True, "已签到", attempts, activity, solve(obs))

        if res.kind == "too_far" and res.meters is not None:
            obs.append(Observation(cur[0], cur[1], res.meters, cur_deg))
            if best_gap is None or res.meters < best_gap:
                best_gap = res.meters
            sol = solve(obs)
            extra = ""
            if sol:
                extra = f"；已算出签到点约 {sol.lat:.6f}, {sol.lon:.6f}（残差 {sol.residual:.0f} m）"
            log(f"离签到地点还差 {res.meters:.0f} 米{extra}", "warn")

            inside = (
                sol is not None and sol.residual < 3.0 and
                (res.meters <= 1.0 or (res.allowed_range and res.meters <= res.allowed_range))
            )
            if inside:
                log("已经在范围边上却被拒，判断不是距离问题，停止重试", "err")
                return WorkOutcome(False, "距离已不是主要原因", attempts, activity, sol)

            plan = plan_probe(obs, max_probe_m, good_enough_m)
            if not plan or plan.lat is None:
                log("测量数据不足以继续定位，停止", "err")
                return WorkOutcome(False, explain(res), attempts, activity, sol)
            cur = (plan.lat, plan.lon)
            cur_deg = _deg_of(plan)
            log("下一步：" + plan.why, "info")
            sleep(1.2 + random.random() * 1.3)  # 别把服务端刷得太急
            continue

        # 其它失败：不是位置问题，一次就停
        log(f"停止处理：{explain(res)}（原文：{res.raw[:120]}）", "err")
        return WorkOutcome(False, explain(res), attempts, activity, solve(obs))

    log(f"已提交 {max_rounds} 次仍未签上（最小差距 "
        f"{'未知' if best_gap is None else f'{best_gap:.0f} 米'}），放弃", "err")
    return WorkOutcome(False, "超过最大重试次数", attempts, activity, solve(obs))


def find_activity(http: Http, courses: Sequence[dict[str, Any]], fid: str) -> tuple[
        dict[str, Any] | None, list[dict[str, Any]], dict[str, Any] | None]:
    """
    遍历登记的课程，找进行中的位置签到。
    返回 (位置签到, 其它类型活动, 命中的课程)
    """
    others_all: list[dict[str, Any]] = []
    for course in courses:
        url = build_active_list_url(course["course_id"], course["class_id"], course.get("fid") or fid)
        try:
            status, text = http.request(url, referer=course.get("referer", ""))
        except RuntimeError:
            continue
        if status in (301, 302) or "passport2" in text[:400] or text.strip().startswith("<"):
            raise PermissionError("登录态失效：服务端把请求跳到登录页了")
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            continue
        # 未登录时接口也会返回 200，只是 result=0 + "请重新登录"
        if isinstance(payload, dict) and _num(payload.get("result")) == 0:
            msg = str(payload.get("msg") or payload.get("errorMsg") or "")
            if re.search(r"登录|login", msg, re.I):
                raise PermissionError(f"登录态失效：{msg or '服务端要求重新登录'}")
            continue
        loc, others = pick_location_activity(payload)
        if loc:
            loc["course_name"] = course.get("name", "")
            return loc, others, course
        others_all.extend(others)
    return None, others_all, None
