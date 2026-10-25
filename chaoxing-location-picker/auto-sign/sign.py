"""
学习通位置签到 · 自动签到主程序（开机级，无需打开浏览器）

用法
----
  python sign.py --run            跑一轮（计划任务用；时段外直接退出）
  python sign.py --daemon         常驻：到点自己跑，跑完继续等下一次
  python sign.py --once           无视时段，立刻跑一轮（手测用）
  python sign.py --status         看配置 / cookie / 最近日志
  python sign.py --verify         只验证 cookie 还能不能用
  python sign.py --set start_time=07:30 --set end_time=13:30
  python sign.py --install        注册 Windows 计划任务（开机自启，无需管理员）
  python sign.py --uninstall      删掉计划任务

目录
----
  auto-sign/
    config.json      配置（时段、起始坐标、课程清单、姓名…）
    cookies.json     登录态（由浏览器书签到出，见 export-cookies.html）
    state.json       今天的进度（防止一天里反复重跑）
    logs/sign-YYYY-MM-DD.log
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import core  # noqa: E402

BASE = Path(__file__).resolve().parent
CONFIG = BASE / "config.json"
COOKIES = BASE / "cookies.json"
STATE = BASE / "state.json"
LOGS = BASE / "logs"
TASK_NAME = "ChaoxingAutoSign"


def _setup_console() -> None:
    """
    Windows 控制台默认是 GBK/cp936，打印中文和 ✓ 会直接抛 UnicodeEncodeError
    （计划任务里没有控制台时同样会出问题）。这里统一改成 UTF-8，并允许降级。
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


def _safe(text: str) -> str:
    """最外层兜底：当前终端编不出这个字符就换成 ?，绝不让打印把程序搞崩。"""
    enc = getattr(sys.stdout, "encoding", None) or "utf-8"
    try:
        text.encode(enc)
        return text
    except (UnicodeEncodeError, LookupError):
        return text.encode(enc, "replace").decode(enc, "replace")


def say(text: str = "") -> None:
    # pythonw（计划任务）下没有控制台，print 会静默失败；日志是唯一的记录渠道，
    # 所以这里吞掉输出异常，绝不让"写日志"这件事把整轮跑挂。
    try:
        print(_safe(text), flush=True)
    except (OSError, ValueError, AttributeError):
        pass


DEFAULT_CONFIG: dict = {
    "enabled": True,
    "start_time": "08:00",
    "end_time": "14:00",
    "weekdays": [1, 2, 3, 4, 5],
    "start_point": {"lat": None, "lon": None, "address": ""},
    "courses": [],
    "name": "",
    "uid": "",
    "fid": "",
    "max_rounds": 10,
    "max_probe_m": 800,
    "good_enough_m": 25,
    "poll_seconds": 20,
    "max_minutes_per_day": 180,
    "stop_after_success": True,
}


# ---------------------------------------------------------------------------
# 文件读写
# ---------------------------------------------------------------------------


def load_json(path: Path, default):
    try:
        with path.open("r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    tmp.replace(path)


def load_config() -> dict:
    cfg = dict(DEFAULT_CONFIG)
    cfg.update(load_json(CONFIG, {}))
    return cfg


def today_key(now: dt.datetime | None = None) -> str:
    return (now or dt.datetime.now()).strftime("%Y-%m-%d")


def log_line(msg: str, level: str = "info") -> None:
    stamp = dt.datetime.now().strftime("%H:%M:%S")
    line = f"[{stamp}] [{level}] {msg}"
    say(line)
    try:
        LOGS.mkdir(parents=True, exist_ok=True)
        path = LOGS / f"sign-{today_key()}.log"
        with path.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


# ---------------------------------------------------------------------------
# cookie
# ---------------------------------------------------------------------------


def load_cookies() -> dict[str, str]:
    data = load_json(COOKIES, {})
    if isinstance(data, dict) and "cookies" in data:
        data = data["cookies"]
    if not isinstance(data, dict):
        return {}
    return {str(k): str(v) for k, v in data.items() if v}


def cookies_age_hours() -> float | None:
    try:
        mtime = COOKIES.stat().st_mtime
    except OSError:
        return None
    return (time.time() - mtime) / 3600.0


def verify_cookies(http: core.Http) -> tuple[bool, str]:
    """
    验证登录态。
    坑：学习通在未登录时**依然返回 HTTP 200**，只是正文换成登录页（"用户登录"），
    所以只看状态码会把"已失效"判成"可用"。这里必须看正文特征。
    """
    try:
        status, text = http.request("https://i.chaoxing.com/base")
    except RuntimeError as e:
        return False, f"网络不通：{e}"
    if status >= 400:
        return False, f"HTTP {status}"

    head = text[:3000]
    if "用户登录" in head or "passport2-static" in head or 'id="loginPhone"' in head:
        return False, "cookie 已失效（服务端返回的是登录页）—— 请重新导出 cookies.json"
    if "passport2.chaoxing.com" in head and "accountManage" not in head:
        return False, "cookie 已失效（被重定向到登录页）"

    # 能从页面里读出 uid/姓名，说明确实是登录态
    m = re.search(r"userid[\"':\s=]+(\d{5,})", text, re.I) or \
        re.search(r"_uid=(\d{5,})", text)
    hint = f"，uid={m.group(1)}" if m else ""
    return True, "cookie 可用" + hint


def read_identity(cfg: dict) -> tuple[str, str]:
    """uid / fid：配置里优先，其次 cookie。"""
    ck = load_cookies()
    uid = str(cfg.get("uid") or ck.get("_uid") or ck.get("UID") or "")
    fid = str(cfg.get("fid") or ck.get("fid") or "")
    return uid, fid


# ---------------------------------------------------------------------------
# 一轮
# ---------------------------------------------------------------------------


def load_state() -> dict:
    st = load_json(STATE, {})
    if st.get("day") != today_key():
        st = {"day": today_key(), "success": False, "poll_count": 0,
              "first_poll_at": None, "last_status": ""}
    return st


def save_state(st: dict) -> None:
    save_json(STATE, st)


def run_once(cfg: dict, force: bool = False) -> int:
    """返回码：0 成功/无需动作，1 失败，2 需要人工（重新导出 cookie 等）。"""
    now = dt.datetime.now()
    sch = core.check_schedule(now, cfg)
    if not force and not sch.active:
        nxt = core.next_start(now, cfg)
        # 每分钟触发一次，别把"不在时段内"刷成几百行：
        # 同一句原因每 30 分钟才记一次，其余时候静默退出。
        st0 = load_state()
        same = st0.get("off_reason") == sch.reason
        last_off = float(st0.get("off_logged_at") or 0)
        if not same or (time.time() - last_off) > 1800:
            log_line(f"不在时段内：{sch.reason}"
                     + (f"；下次开门 {nxt:%Y-%m-%d %H:%M}" if nxt else ""))
            st0["off_reason"] = sch.reason
            st0["off_logged_at"] = time.time()
            save_state(st0)
        return 0

    st = load_state()
    if st.get("success") and cfg.get("stop_after_success", True) and not force:
        log_line("今天已经签过了，跳过")
        return 0

    # 幂等：同一个"今天第几次查询"的记录防止一分钟内重复写日志刷屏
    last_poll = float(st.get("last_poll_at") or 0)
    quiet_window = max(10.0, float(cfg.get("poll_seconds", 20)) * 0.8)
    if not force and last_poll and (time.time() - last_poll) < quiet_window:
        return 0

    started = st.get("first_poll_at")
    if started and not force:
        elapsed_min = (time.time() - float(started)) / 60.0
        limit = float(cfg.get("max_minutes_per_day", 180))
        if elapsed_min > limit:
            log_line(f"今天已经连续找了 {elapsed_min:.0f} 分钟（上限 {limit:.0f}），暂停")
            return 1

    cookies = load_cookies()
    if not cookies:
        log_line("没有 cookies.json：请先用 export-cookies.html 在浏览器里导出登录态", "err")
        return 2

    uid, fid = read_identity(cfg)
    if not uid:
        log_line("读不到 uid（cookie 里没有 _uid），请在 config.json 里手填 uid", "err")
        return 2

    courses = cfg.get("courses") or []
    if not courses:
        log_line("config.json 里没有课程清单（courses）：先运行 --list-courses 抓一次，或手填 courseId/classId", "err")
        return 2

    point = cfg.get("start_point") or {}
    if point.get("lat") is None or point.get("lon") is None:
        log_line("config.json 里没有起始坐标 start_point（随便填个大概位置就行，程序会自己逼近）", "err")
        return 2

    http = core.Http(cookies)
    if st.get("first_poll_at") is None:
        st["first_poll_at"] = time.time()
    st["poll_count"] = int(st.get("poll_count", 0)) + 1
    st["last_poll_at"] = time.time()
    save_state(st)

    log_line(f"开始查询（今天第 {st['poll_count']} 次）")

    try:
        activity, others, course = core.find_activity(http, courses, fid)
    except PermissionError as e:
        log_line(str(e), "err")
        st["last_status"] = "cookie-expired"
        save_state(st)
        return 2

    if activity is None:
        if others:
            labels = "、".join(f"{o['name'] or o['activeId']}={core.KIND_LABELS.get(o['kind'], '?')}"
                               for o in others)
            log_line(f"只找到非位置签到（{labels}），按设置不处理", "warn")
            st["last_status"] = "non-location-only"
        else:
            log_line("没有进行中的签到")
            st["last_status"] = "no-activity"
        save_state(st)
        return 0

    log_line(f"发现位置签到：{course.get('name', '')}「{activity['name'] or activity['activeId']}」"
             f" activeId={activity['activeId']}")

    outcome = core.work_location_sign(
        http, activity,
        float(point["lat"]), float(point["lon"]),
        uid=uid, fid=fid,
        name=str(cfg.get("name") or ""),
        address=str(point.get("address") or ""),
        max_rounds=int(cfg.get("max_rounds", 10)),
        max_probe_m=float(cfg.get("max_probe_m", 800)),
        good_enough_m=float(cfg.get("good_enough_m", 25)),
        log=log_line,
    )

    if outcome.ok:
        st["success"] = True
        st["last_status"] = "success"
        st["signed_at"] = now.isoformat(timespec="seconds")
        save_state(st)
        sol = outcome.solution
        if sol:
            log_line(f"已签到。最终定位 {sol.lat:.6f}, {sol.lon:.6f}（残差 {sol.residual:.0f} m）", "ok")
        # 把算出来的点写回去，下一次直接从这个点开始，省掉逼近
        last = outcome.attempts[-1] if outcome.attempts else None
        if last:
            point["lat"], point["lon"] = last.lat, last.lon
            cfg["start_point"] = point
            save_json(CONFIG, cfg)
        return 0

    st["last_status"] = outcome.reason
    save_state(st)
    log_line(f"这次没签上：{outcome.reason}", "err")
    return 1


# ---------------------------------------------------------------------------
# 课程清单
# ---------------------------------------------------------------------------


def list_courses(cfg: dict) -> int:
    """
    课表接口：GET https://mooc1-api.chaoxing.com/mycourse/backclazzdata?view=json
    返回里挑出 courseid / clazzid / fid。
    """
    cookies = load_cookies()
    if not cookies:
        log_line("没有 cookies.json，先导出 cookie", "err")
        return 2
    http = core.Http(cookies)
    url = "https://mooc1-api.chaoxing.com/mycourse/backclazzdata?view=json"
    try:
        status, text = http.request(url, referer="https://mooc2-ans.chaoxing.com/")
    except RuntimeError as e:
        log_line(f"请求课表失败：{e}", "err")
        return 1
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        log_line(f"课表返回不是 JSON（HTTP {status}）：{text[:160]}", "err")
        return 1

    found = []

    def walk(node):
        if isinstance(node, dict):
            course = node.get("course") if isinstance(node.get("course"), dict) else {}
            cid = course.get("data", [{}])[0].get("id") if isinstance(course.get("data"), list) and course.get("data") else None
            cname = course.get("data", [{}])[0].get("name") if isinstance(course.get("data"), list) and course.get("data") else None
            class_id = node.get("id")
            class_name = node.get("name")
            if cid and class_id:
                found.append({
                    "name": f"{cname or ''} / {class_name or ''}".strip(" /"),
                    "course_id": str(cid),
                    "class_id": str(class_id),
                    "fid": "",
                    "referer": "https://mooc2-ans.chaoxing.com/",
                })
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(payload)
    uniq = {}
    for c in found:
        uniq[(c["course_id"], c["class_id"])] = c
    items = list(uniq.values())
    if not items:
        log_line("课表里没解析出课程；可以手填 config.json 的 courses（含 course_id / class_id）", "warn")
        return 1

    cfg["courses"] = items
    save_json(CONFIG, cfg)
    log_line(f"已写入 {len(items)} 门课到 config.json：", "ok")
    for c in items:
        log_line(f"  {c['name']}  course_id={c['course_id']} class_id={c['class_id']}")
    return 0


# ---------------------------------------------------------------------------
# 计划任务
# ---------------------------------------------------------------------------


def python_exe() -> str:
    return sys.executable or "python"


def install_task(cfg: dict) -> int:
    """
    注册 Windows 计划任务：
      - 登录时启动一次
      - 之后每 1 分钟触发一次（签到窗口常常只有几分钟，15 分钟会漏）
    --run 模式下不在时段内会立刻退出（开销极低），只有时段内才真的发请求。
    用 pythonw.exe，全程无窗口。不需要管理员权限。
    """
    script = Path(__file__).resolve()
    exe = Path(python_exe())
    pyw = exe.with_name("pythonw.exe")
    runner = str(pyw if pyw.exists() else exe)
    args = f'"{runner}" "{script}" --run'

    cmd = [
        "schtasks", "/Create", "/F",
        "/TN", TASK_NAME,
        "/TR", args,
        "/SC", "MINUTE",
        "/MO", "1",
        "/RL", "LIMITED",
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except Exception as e:
        log_line(f"注册计划任务失败：{e}", "err")
        return 1
    if r.returncode != 0:
        log_line(f"注册计划任务失败：{(r.stdout or '') + (r.stderr or '')}".strip(), "err")
        return 1
    log_line(f"已注册计划任务「{TASK_NAME}」（每分钟检查一次，时段外立刻退出）", "ok")
    log_line("开机/登录后自动运行，不需要打开浏览器，也不需要你点任何东西")
    log_line("第一次要先放好 cookies.json 并跑一次 --list-courses 抓课程清单")
    return 0


def uninstall_task() -> int:
    try:
        r = subprocess.run(["schtasks", "/Delete", "/F", "/TN", TASK_NAME],
                           capture_output=True, text=True, timeout=60)
    except Exception as e:
        log_line(f"删除计划任务失败：{e}", "err")
        return 1
    if r.returncode != 0:
        log_line("删除失败：" + ((r.stdout or "") + (r.stderr or "")).strip(), "warn")
        return 1
    log_line("已删除计划任务", "ok")
    return 0


def run_daemon(cfg: dict) -> int:
    """常驻进程：时段内按 poll_seconds 轮询，时段外睡到下一次开门。"""
    log_line("守护模式启动")
    while True:
        cfg = load_config()
        now = dt.datetime.now()
        sch = core.check_schedule(now, cfg)
        if sch.active:
            try:
                run_once(cfg)
            except Exception as e:  # 守护进程不能因为一次异常就退出
                log_line(f"本轮异常：{e!r}", "err")
            time.sleep(max(10, int(cfg.get("poll_seconds", 20))))
        else:
            nxt = core.next_start(now, cfg)
            if not nxt:
                log_line("没有下一次开门时间，10 分钟后再看")
                time.sleep(600)
                continue
            wait = max(30.0, (nxt - now).total_seconds())
            log_line(f"等待下一次开门 {nxt:%Y-%m-%d %H:%M}（{wait / 60:.0f} 分钟后）")
            time.sleep(min(wait, 1800))


# ---------------------------------------------------------------------------
# 状态
# ---------------------------------------------------------------------------


def show_status(cfg: dict) -> int:
    now = dt.datetime.now()
    sch = core.check_schedule(now, cfg)
    st = load_state()
    uid, fid = read_identity(cfg)
    age = cookies_age_hours()
    pt = cfg.get("start_point") or {}

    say("== 学习通自动签到 ==")
    say(f"配置文件   : {CONFIG}  {'✓' if CONFIG.exists() else '✗ 缺失'}")
    say(f"登录态     : {COOKIES}  {'✓' if COOKIES.exists() else '✗ 缺失'}"
          + (f"（{age:.1f} 小时前导出）" if age is not None else ""))
    say(f"时段       : {core.describe_weekdays(cfg.get('weekdays'))} "
          f"{cfg.get('start_time')}-{cfg.get('end_time')}  当前：{sch.phase} · {sch.reason}")
    nxt = core.next_start(now, cfg)
    say(f"下次开门   : {nxt:%Y-%m-%d %H:%M}" if nxt else "下次开门   : —")
    say(f"uid / fid  : {uid or '✗'} / {fid or '—'}")
    say(f"起始坐标   : {pt.get('lat')}, {pt.get('lon')}  {pt.get('address') or ''}")
    say(f"课程数     : {len(cfg.get('courses') or [])}")
    for c in (cfg.get("courses") or [])[:20]:
        say(f"           - {c.get('name')}  ({c.get('course_id')}/{c.get('class_id')})")
    say(f"今天       : 查询 {st.get('poll_count', 0)} 次 · "
          f"{'已签到' if st.get('success') else st.get('last_status') or '未开始'}")
    say()
    say("== 最近日志 ==")
    log_path = LOGS / f"sign-{today_key()}.log"
    if log_path.exists():
        lines = log_path.read_text(encoding="utf-8", errors="replace").splitlines()
        for line in lines[-15:]:
            say(line)
    else:
        say("（今天还没有日志）")

    if COOKIES.exists():
        http = core.Http(load_cookies())
        ok, msg = verify_cookies(http)
        say()
        say(f"cookie 自检: {'✓ ' if ok else '✗ '}{msg}")
    return 0


# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    _setup_console()
    ap = argparse.ArgumentParser(description="学习通位置签到 · 自动签到")
    ap.add_argument("--run", action="store_true", help="按计划跑一轮（尊重时段）")
    ap.add_argument("--once", action="store_true", help="无视时段立刻跑一轮")
    ap.add_argument("--daemon", action="store_true", help="常驻：到点自己跑")
    ap.add_argument("--status", action="store_true", help="查看状态与最近日志")
    ap.add_argument("--list-courses", action="store_true", help="抓课程清单写进 config.json")
    ap.add_argument("--verify", action="store_true", help="只验证 cookie")
    ap.add_argument("--install", action="store_true", help="注册 Windows 计划任务")
    ap.add_argument("--uninstall", action="store_true", help="删除计划任务")
    ap.add_argument("--set", action="append", default=[], metavar="KEY=VALUE", help="改配置项")
    args = ap.parse_args(argv)

    cfg = load_config()
    if not CONFIG.exists():
        save_json(CONFIG, cfg)

    if args.set:
        for pair in args.set:
            if "=" not in pair:
                continue
            k, v = pair.split("=", 1)
            k = k.strip()
            v = v.strip()
            if k in ("weekdays", "courses", "start_point"):
                cfg[k] = json.loads(v)
            elif k in ("point", "start_latlon"):
                # 允许 --set point=38.0412,114.5123（比手写 JSON 省事）
                parsed = core.parse_lat_lon(v)
                if not parsed:
                    log_line(f"{v} 不是一个合法坐标（写 纬度,经度，例如 38.0412,114.5123）", "err")
                    return 1
                old = cfg.get("start_point") or {}
                cfg["start_point"] = {
                    "lat": parsed[0],
                    "lon": parsed[1],
                    "address": old.get("address") or v,
                }
            elif k in ("max_rounds", "max_probe_m", "good_enough_m", "poll_seconds", "max_minutes_per_day"):
                cfg[k] = float(v) if "." in v else int(v)
            elif k in ("enabled", "stop_after_success"):
                cfg[k] = v.lower() in ("1", "true", "yes", "on")
            elif k in ("start_time", "end_time"):
                minutes = core.parse_clock(v)
                if minutes is None:
                    log_line(f"{k}={v} 不是合法时间（写 08:00 / 8:00 / 0800 都行）", "err")
                    return 1
                cfg[k] = core.format_clock(minutes)
            else:
                cfg[k] = v
        save_json(CONFIG, cfg)
        log_line(f"已更新配置：{', '.join(args.set)}", "ok")
        # 改完顺手把状态打出来，省得再跑一次 --status
        return show_status(load_config()) if not (args.install or args.uninstall
                                                  or args.list_courses or args.verify) else 0

    if args.install:
        return install_task(load_config())
    if args.uninstall:
        return uninstall_task()
    if args.list_courses:
        return list_courses(cfg)
    if args.status:
        return show_status(load_config())
    if args.verify:
        ck = load_cookies()
        if not ck:
            log_line("没有 cookies.json", "err")
            return 2
        ok, msg = verify_cookies(core.Http(ck))
        log_line(f"{'✓' if ok else '✗'} {msg}", "ok" if ok else "err")
        return 0 if ok else 2
    if args.daemon:
        return run_daemon(load_config())
    if args.once:
        return run_once(load_config(), force=True)
    if args.run:
        return run_once(load_config(), force=False)

    ap.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
