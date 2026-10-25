"""
auto-sign/core.py 的脱网单测：时段、返回归类、三点定位、逼近循环、协议组装。

运行：python -m unittest tests.test_core -v   （在 auto-sign/ 目录下）
"""

from __future__ import annotations

import datetime as dt
import json
import math
import random
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import core  # noqa: E402


# ---------------------------------------------------------------------------
# 1) 时段
# ---------------------------------------------------------------------------


class ScheduleTests(unittest.TestCase):
    CFG = {"enabled": True, "start_time": "08:00", "end_time": "14:00", "weekdays": [1, 2, 3, 4, 5]}

    def at(self, s):
        return dt.datetime.fromisoformat(s)

    def test_parse_clock_variants(self):
        self.assertEqual(core.parse_clock("08:00"), 480)
        self.assertEqual(core.parse_clock("8:00"), 480)
        self.assertEqual(core.parse_clock("0800"), 480)
        self.assertEqual(core.parse_clock("24:00"), 1440)
        self.assertIsNone(core.parse_clock("25:00"))
        self.assertIsNone(core.parse_clock("8:75"))
        self.assertIsNone(core.parse_clock(""))
        self.assertIsNone(core.parse_clock(None))

    def test_format_clock(self):
        self.assertEqual(core.format_clock(480), "08:00")
        self.assertEqual(core.format_clock(1440), "00:00")

    def test_inside_window(self):
        s = core.check_schedule(self.at("2026-03-02T09:30:00"), self.CFG)  # 周一
        self.assertTrue(s.active)
        self.assertEqual(s.phase, "in")

    def test_before_and_after(self):
        self.assertFalse(core.check_schedule(self.at("2026-03-02T07:10:00"), self.CFG).active)
        self.assertFalse(core.check_schedule(self.at("2026-03-02T15:00:00"), self.CFG).active)

    def test_weekend_skipped(self):
        s = core.check_schedule(self.at("2026-03-01T10:00:00"), self.CFG)  # 周日
        self.assertFalse(s.active)
        self.assertIn("不在选定的星期", s.reason)

    def test_disabled(self):
        cfg = dict(self.CFG, enabled=False)
        self.assertFalse(core.check_schedule(self.at("2026-03-02T09:30:00"), cfg).active)

    def test_empty_weekdays_means_every_day(self):
        cfg = dict(self.CFG, weekdays=[])
        self.assertTrue(core.check_schedule(self.at("2026-03-01T10:00:00"), cfg).active)

    def test_overnight_window(self):
        cfg = {"enabled": True, "start_time": "22:00", "end_time": "02:00", "weekdays": []}
        self.assertTrue(core.check_schedule(self.at("2026-03-02T23:30:00"), cfg).active)
        self.assertTrue(core.check_schedule(self.at("2026-03-03T01:00:00"), cfg).active)
        self.assertFalse(core.check_schedule(self.at("2026-03-02T15:00:00"), cfg).active)

    def test_overnight_uses_previous_day_for_weekday(self):
        # 周一 22:00 - 周二 02:00：周二凌晨 1 点仍应算在时段内
        cfg = {"enabled": True, "start_time": "22:00", "end_time": "02:00", "weekdays": [1]}
        self.assertTrue(core.check_schedule(self.at("2026-03-03T01:00:00"), cfg).active)

    def test_next_start(self):
        now = self.at("2026-03-02T07:00:00")   # 周一
        self.assertEqual(core.next_start(now, self.CFG), self.at("2026-03-02T08:00:00"))
        # 周一下午 -> 周二早上
        now2 = self.at("2026-03-02T20:00:00")
        self.assertEqual(core.next_start(now2, self.CFG), self.at("2026-03-03T08:00:00"))
        # 周五下午 -> 下周一
        now3 = self.at("2026-03-06T20:00:00")
        self.assertEqual(core.next_start(now3, self.CFG), self.at("2026-03-09T08:00:00"))

    def test_describe_weekdays(self):
        self.assertEqual(core.describe_weekdays([1, 2, 3, 4, 5]), "周一至周五")
        self.assertEqual(core.describe_weekdays([]), "每天")
        self.assertEqual(core.describe_weekdays([1, 3]), "周一、周三")


# ---------------------------------------------------------------------------
# 2) 返回归类
# ---------------------------------------------------------------------------


class ClassifyTests(unittest.TestCase):
    def test_success(self):
        for t in ("success", "success2", '{"success":true}'):
            self.assertTrue(core.classify(t).ok, t)

    def test_empty(self):
        self.assertEqual(core.classify("").kind, "empty")

    def test_login(self):
        self.assertEqual(core.classify("请先登录再进行签到").kind, "login")

    def test_already(self):
        self.assertEqual(core.classify("您已签到过了").kind, "already")

    def test_too_far_meters(self):
        r = core.classify("签到失败，您当前距离签到地点还有850米，请到签到地点后再试")
        self.assertEqual(r.kind, "too_far")
        self.assertEqual(r.meters, 850)

    def test_too_far_km(self):
        r = core.classify("您不在签到范围内，距离签到点约 1.2 公里")
        self.assertEqual(r.kind, "too_far")
        self.assertAlmostEqual(r.meters, 1200.0)

    def test_too_far_decimal(self):
        r = core.classify("签到失败 距离签到地点过远 还差1234.5m")
        self.assertEqual(r.kind, "too_far")
        self.assertAlmostEqual(r.meters, 1234.5)

    def test_too_far_with_range(self):
        r = core.classify("当前距离签到地点 300 米，签到范围 200 米")
        self.assertEqual(r.meters, 300)
        self.assertEqual(r.allowed_range, 200)

    def test_app_required(self):
        self.assertTrue(core.classify("[face]活体协议验证不通过").need_app)
        self.assertTrue(core.classify("签到失败，请重新扫描").need_app)
        self.assertEqual(core.classify("[face]活体协议验证不通过").kind, "face")
        self.assertEqual(core.classify("签到失败，请重新扫描").kind, "qr")

    def test_expired_and_validate(self):
        self.assertEqual(core.classify("签到活动已结束").kind, "expired")
        self.assertEqual(core.classify("validate").kind, "validate")

    def test_unknown_keeps_raw(self):
        r = core.classify("某段没见过的返回")
        self.assertEqual(r.kind, "other")
        self.assertEqual(r.raw, "某段没见过的返回")

    def test_explain_mentions_distance(self):
        self.assertIn("850", core.explain(core.classify("距离签到地点还有850米")))


# ---------------------------------------------------------------------------
# 3) 三点定位
# ---------------------------------------------------------------------------

TRUE_LAT, TRUE_LON = 38.041234, 114.512345
BASE_LAT, BASE_LON = 38.060000, 114.530000


def obs_at(lat, lon, deg=None):
    return core.Observation(lat, lon, core.distance(lat, lon, TRUE_LAT, TRUE_LON), deg)

class TrilaterationTests(unittest.TestCase):
    def test_single_observation_is_that_point(self):
        s = core.solve([obs_at(BASE_LAT, BASE_LON)])
        self.assertEqual(s.mode, "circle")
        self.assertAlmostEqual(s.lat, BASE_LAT, places=6)

    def test_two_observations_return_guided_direction(self):
        """
        两条测量时圆有两个镜像解，无法确定"点在连线哪一侧"，
        所以结果只作为**方向参考**（mode=guided），不能当成最终答案。
        用中点会让下一次探点退回到连线上，永远拉不开方位。
        """
        p2 = core.probe_point(BASE_LAT, BASE_LON, 500, 90)
        s = core.solve([obs_at(BASE_LAT, BASE_LON), obs_at(*p2)])
        self.assertEqual(s.mode, "guided")
        # 方向参考点不该和起点重合（否则下一步没意义）
        self.assertGreater(core.distance(s.lat, s.lon, BASE_LAT, BASE_LON), 10)

    def test_two_observations_plan_takes_a_fresh_direction(self):
        p2 = core.probe_point(BASE_LAT, BASE_LON, 500, 90)
        obs = [obs_at(BASE_LAT, BASE_LON, deg=0), obs_at(*p2, deg=180)]
        plan = core.plan_probe(obs, max_probe_m=800)
        self.assertIsNotNone(plan.lat)
        self.assertIn("还分不清左右", plan.why)
        # 新探点必须明显离开已有两个测量点，否则等于白跑一轮
        d1 = core.distance(plan.lat, plan.lon, BASE_LAT, BASE_LON)
        d2 = core.distance(plan.lat, plan.lon, p2[0], p2[1])
        self.assertGreater(min(d1, d2), 100)

    def test_three_observations_converge(self):
        p2 = core.probe_point(BASE_LAT, BASE_LON, 500, 90)
        p3 = core.probe_point(BASE_LAT, BASE_LON, 700, 200)
        s = core.solve([obs_at(BASE_LAT, BASE_LON), obs_at(*p2), obs_at(*p3)])
        self.assertEqual(s.mode, "exact")
        err = core.distance(s.lat, s.lon, TRUE_LAT, TRUE_LON)
        self.assertLess(err, 5, f"误差 {err:.1f} m")

    def test_noisy_rounded_distances(self):
        p2 = core.probe_point(BASE_LAT, BASE_LON, 500, 90)
        p3 = core.probe_point(BASE_LAT, BASE_LON, 700, 200)
        obs = [
            core.Observation(BASE_LAT, BASE_LON, round(obs_at(BASE_LAT, BASE_LON).meters)),
            core.Observation(*p2, round(obs_at(*p2).meters)),
            core.Observation(*p3, round(obs_at(*p3).meters)),
        ]
        s = core.solve(obs)
        self.assertLess(core.distance(s.lat, s.lon, TRUE_LAT, TRUE_LON), 20)

    def test_collinear_points_dont_crash(self):
        obs = [
            core.Observation(BASE_LAT, BASE_LON, 500),
            core.Observation(BASE_LAT + 0.002, BASE_LON, 400),
            core.Observation(BASE_LAT + 0.004, BASE_LON, 700),
        ]
        s = core.solve(obs)
        self.assertIsNotNone(s)
        self.assertTrue(math.isfinite(s.lat) and math.isfinite(s.lon))

    def test_empty_observations(self):
        self.assertIsNone(core.solve([]))

    def test_offset_and_probe(self):
        lat, lon = core.offset_point(30.0, 120.0, 100, 100)
        self.assertAlmostEqual(core.distance(30.0, 120.0, lat, lon), 141.4, delta=2)

    def test_direction_spreading(self):
        d0, _ = core.pick_direction([])
        d1, _ = core.pick_direction([d0])
        self.assertGreaterEqual(core.angle_gap(d0, d1), 44)


class PlanningTests(unittest.TestCase):
    def test_no_obs_uses_start_point(self):
        p = core.plan_probe([])
        self.assertIsNone(p.lat)
        self.assertIn("起始点", p.why)

    def test_radius_capped(self):
        p = core.plan_probe([obs_at(BASE_LAT, BASE_LON)], max_probe_m=800)
        self.assertLessEqual(p.radius, 800)

    def test_refine_when_converged(self):
        p2 = core.probe_point(BASE_LAT, BASE_LON, 500, 90)
        p3 = core.probe_point(BASE_LAT, BASE_LON, 700, 200)
        p = core.plan_probe([obs_at(BASE_LAT, BASE_LON), obs_at(*p2), obs_at(*p3)])
        self.assertTrue(p.refine)
        self.assertGreater(p.radius, 0)
        # 细调点应该真的挪动了
        self.assertGreater(core.distance(p.lat, p.lon, p.solution.lat, p.solution.lon), 1)


# ---------------------------------------------------------------------------
# 4) 协议：类型判定与参数
# ---------------------------------------------------------------------------


class ProtocolTests(unittest.TestCase):
    def test_detect_kind_by_active_sort(self):
        self.assertEqual(core.detect_kind({"activeSort": 4}), "location")
        self.assertEqual(core.detect_kind({"activeSort": 1}), "plain")
        self.assertEqual(core.detect_kind({"activeSort": 6}), "qr")
        self.assertEqual(core.detect_kind({"activeSort": 9}), "code")
        self.assertEqual(core.detect_kind({"activeSort": 16}), "gesture")

    def test_detect_kind_by_other_id(self):
        self.assertEqual(core.detect_kind({"otherId": 4}), "location")
        self.assertEqual(core.detect_kind({"otherId": 3}), "gesture")

    def test_active_sort_beats_other_id(self):
        self.assertEqual(core.detect_kind({"activeSort": 4, "otherId": 1}), "location")

    def test_ifphoto_is_not_a_type(self):
        # 普通签到 + 要求拍照，仍然是普通签到
        self.assertEqual(core.detect_kind({"activeSort": 3, "ifphoto": 1}), "plain")

    def test_name_fallback(self):
        self.assertEqual(core.detect_kind({"nameOne": "位置签到"}), "location")
        self.assertEqual(core.detect_kind({"nameOne": "手势签到"}), "gesture")
        self.assertEqual(core.detect_kind({}), "unknown")

    def test_extract_activities(self):
        payload = {
            "result": 1,
            "data": {
                "activeList": [
                    {"activeId": "4000175553141", "nameOne": "<p>位置签到</p>", "status": 1, "activeSort": 4},
                    {"id": "4000175553000", "nameOne": "手势", "status": 2, "activeSort": 16},
                    {"id": "noise", "status": 1},
                ]
            },
        }
        acts = core.extract_activities(payload)
        self.assertEqual(len(acts), 2)
        self.assertEqual(acts[0]["name"], "位置签到")
        self.assertEqual(acts[0]["kind"], "location")

    def test_pick_location_activity(self):
        payload = {
            "data": {
                "activeList": [
                    {"id": "4000175553141", "status": 1, "activeSort": 1, "startTime": 200},
                    {"id": "4000175553142", "status": 1, "activeSort": 4, "startTime": 100},
                    {"id": "4000175553143", "status": 1, "activeSort": 4, "startTime": 300},
                ]
            }
        }
        loc, others = core.pick_location_activity(payload)
        self.assertIsNotNone(loc)
        self.assertEqual(loc["activeId"], "4000175553143")   # 最新的位置签到
        self.assertEqual(len(others), 1)
        self.assertEqual(others[0]["kind"], "plain")

    def test_no_location_only_others(self):
        payload = {"data": {"activeList": [{"id": "4000175553141", "status": 1, "activeSort": 6}]}}
        loc, others = core.pick_location_activity(payload)
        self.assertIsNone(loc)
        self.assertEqual(others[0]["kind"], "qr")

    def test_sign_params_shape(self):
        p = core.build_sign_params("4000175553141", "8888", "1403", 30.1234567, 120.7654321,
                                   name="张三", address="某大学", course_id="268194985")
        self.assertEqual(p["activeId"], "4000175553141")
        self.assertEqual(p["latitude"], "30.123457")
        self.assertEqual(p["longitude"], "120.765432")
        self.assertEqual(p["ifTiJiao"], "1")
        self.assertEqual(p["ifCFP"], "0")
        self.assertIn("address", p)

    def test_parse_lat_lon(self):
        self.assertEqual(core.parse_lat_lon("30.1,120.2"), (30.1, 120.2))
        self.assertEqual(core.parse_lat_lon("120.2,30.1"), (30.1, 120.2))
        self.assertEqual(core.parse_lat_lon("纬度30.1 经度120.2"), (30.1, 120.2))
        self.assertIsNone(core.parse_lat_lon("某某大学"))


# ---------------------------------------------------------------------------
# 5) 逼近循环（假 HTTP）
# ---------------------------------------------------------------------------


class FakeHttp:
    """假服务端：按提交坐标算真实距离，超出半径就回"还差 xxx 米"。"""

    def __init__(self, true_pt, radius_m, mode="normal"):
        self.true_pt = true_pt
        self.radius = radius_m
        self.mode = mode
        self.attempts = []

    def request(self, url, data=None, referer=""):
        lat = float(data["latitude"])
        lon = float(data["longitude"])
        self.attempts.append((lat, lon))
        if self.mode == "already":
            return 200, "您已签到过了"
        if self.mode == "face":
            return 200, "[face]活体协议验证不通过"
        d = core.distance(lat, lon, self.true_pt[0], self.true_pt[1])
        if d <= self.radius:
            return 200, "success"
        return 200, f"签到失败，您当前距离签到地点还有{round(d)}米，请到签到地点后再试"


class WorkLoopTests(unittest.TestCase):
    ACTIVITY = {"activeId": "4000175553141", "name": "位置签到", "kind": "location"}

    def test_converges_from_2km(self):
        http = FakeHttp((TRUE_LAT, TRUE_LON), 200)
        out = core.work_location_sign(
            http, self.ACTIVITY, BASE_LAT, BASE_LON, uid="1", fid="2",
            max_rounds=10, log=lambda *a, **k: None, sleep=lambda s: None,
        )
        self.assertTrue(out.ok, out.reason)
        self.assertLessEqual(len(out.attempts), 10)
        last = http.attempts[-1]
        self.assertLessEqual(core.distance(last[0], last[1], TRUE_LAT, TRUE_LON), 200)

    def test_converges_from_1800m_north(self):
        start = core.offset_point(TRUE_LAT, TRUE_LON, 1800, 0)
        http = FakeHttp((TRUE_LAT, TRUE_LON), 100)
        out = core.work_location_sign(
            http, self.ACTIVITY, start[0], start[1], uid="1", fid="2",
            max_rounds=10, log=lambda *a, **k: None, sleep=lambda s: None,
        )
        self.assertTrue(out.ok, out.reason)

    def test_already_signed_stops_immediately(self):
        http = FakeHttp((TRUE_LAT, TRUE_LON), 200, mode="already")
        out = core.work_location_sign(
            http, self.ACTIVITY, BASE_LAT, BASE_LON, uid="1", fid="2",
            log=lambda *a, **k: None, sleep=lambda s: None,
        )
        self.assertTrue(out.ok)
        self.assertEqual(len(http.attempts), 1)

    def test_face_required_stops_immediately(self):
        http = FakeHttp((TRUE_LAT, TRUE_LON), 200, mode="face")
        out = core.work_location_sign(
            http, self.ACTIVITY, BASE_LAT, BASE_LON, uid="1", fid="2",
            log=lambda *a, **k: None, sleep=lambda s: None,
        )
        self.assertFalse(out.ok)
        self.assertEqual(len(http.attempts), 1, "人脸签到不该反复提交")

    def test_respects_max_rounds(self):
        http = FakeHttp((TRUE_LAT, TRUE_LON), 0.01)   # 半径极小，几乎签不上
        out = core.work_location_sign(
            http, self.ACTIVITY, BASE_LAT, BASE_LON, uid="1", fid="2",
            max_rounds=4, log=lambda *a, **k: None, sleep=lambda s: None,
        )
        self.assertFalse(out.ok)
        self.assertLessEqual(len(http.attempts), 4)

    def test_logs_progress(self):
        lines = []
        http = FakeHttp((TRUE_LAT, TRUE_LON), 200)
        core.work_location_sign(
            http, self.ACTIVITY, BASE_LAT, BASE_LON, uid="1", fid="2",
            log=lambda msg, level="info": lines.append(msg), sleep=lambda s: None,
        )
        joined = "\n".join(lines)
        self.assertIn("还差", joined)
        self.assertIn("签到点约", joined)


# ---------------------------------------------------------------------------
# 6) 登录态识别（这次踩的坑：未登录也返回 HTTP 200）
# ---------------------------------------------------------------------------


class LoginDetectionTests(unittest.TestCase):
    """
    学习通在未登录时**照样回 200**，只是正文换成登录页 / result=0。
    只看状态码会把"已失效"判成"可用"，然后一路以为在正常查询。
    """

    class _Http:
        def __init__(self, status, text):
            self._status = status
            self._text = text

        def request(self, url, data=None, referer=""):
            return self._status, self._text

    COURSE = [{"name": "x", "course_id": "1", "class_id": "2"}]

    def test_activelist_login_page_raises(self):
        html = "<!DOCTYPE html><html><head><title>用户登录</title>"
        with self.assertRaises(PermissionError):
            core.find_activity(self._Http(200, html), self.COURSE, "1403")

    def test_activelist_redirect_raises(self):
        with self.assertRaises(PermissionError):
            core.find_activity(self._Http(302, ""), self.COURSE, "1403")

    def test_activelist_result0_login_msg_raises(self):
        body = json.dumps({"result": 0, "msg": "请重新登录", "status": False})
        with self.assertRaises(PermissionError):
            core.find_activity(self._Http(200, body), self.COURSE, "1403")

    def test_activelist_ok_returns_activity(self):
        body = json.dumps({
            "result": 1,
            "data": {"activeList": [{"id": "4000175553141", "status": 1, "activeSort": 4}]},
        })
        loc, others, course = core.find_activity(self._Http(200, body), self.COURSE, "1403")
        self.assertIsNotNone(loc)
        self.assertEqual(loc["activeId"], "4000175553141")
        self.assertEqual(course["course_id"], "1")


if __name__ == "__main__":
    unittest.main(verbosity=2)
