/*
 * auto.js 的逻辑测试：时段判断、返回归类、三点定位、逼近策略。
 * 这些是"自动签到"能不能靠得住的地方，所以单独一组，跑到真实的 lib.js + auto.js 上。
 *
 * 运行：node tools/selftest-auto.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'extension', 'src');

let pass = 0;
let fail = 0;
const problems = [];

function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    problems.push(name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : ''));
    console.log('  ✗ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : ''));
  }
}
function near(a, b, tol) { return Math.abs(a - b) <= tol; }
function section(t) { console.log('\n' + t); }

// ---------------------------------------------------------------------------
// 加载 lib.js + auto.js（和浏览器里一样，它们只依赖 globalThis）
// ---------------------------------------------------------------------------

const libSource = fs.readFileSync(path.join(srcDir, 'lib.js'), 'utf8');
const autoSource = fs.readFileSync(path.join(srcDir, 'auto.js'), 'utf8');

const sandbox = {
  chrome: { storage: { local: { get() {}, set() {} } }, onChanged: { addListener() {} } },
  Math, JSON, Object, Array, String, Number, Boolean, Error, RegExp, Date, Promise, Map, Set,
  parseInt, parseFloat, isFinite, isNaN, console
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(libSource, sandbox);
vm.runInContext(autoSource, sandbox);
const CXL = sandbox.CXL;

function at(str) { return new Date(str); }

// ---------------------------------------------------------------------------
// 1) 时段
// ---------------------------------------------------------------------------

section('1) 时段判断（星期 + 起止时间）');

const WORK_WEEK = { enabled: true, startTime: '08:00', endTime: '14:00', weekdays: [1, 2, 3, 4, 5] };

ok('parseClock "08:00" -> 480', CXL.parseClock('08:00') === 480);
ok('parseClock "8:00" -> 480', CXL.parseClock('8:00') === 480);
ok('parseClock "0800" -> 480', CXL.parseClock('0800') === 480);
ok('parseClock "24:00" -> 1440（当天结束）', CXL.parseClock('24:00') === 1440);
ok('parseClock "25:00" 非法 -> null', CXL.parseClock('25:00') === null);
ok('parseClock "8:75" 非法 -> null', CXL.parseClock('8:75') === null);
ok('parseClock 空值 -> null', CXL.parseClock('') === null);
ok('formatClock 480 -> "08:00"', CXL.formatClock(480) === '08:00');
ok('formatClock 1440 回绕为 "00:00"', CXL.formatClock(1440) === '00:00');

const schMon = CXL.checkSchedule(at('2026-03-02T09:30:00'), WORK_WEEK);   // 星期一
ok('周一 09:30 在 08:00-14:00 内 -> active',
  schMon.active === true && schMon.inWindow === true && schMon.phase === 'in', schMon);
const schMonEarly = CXL.checkSchedule(at('2026-03-02T07:10:00'), WORK_WEEK);
ok('周一 07:10 还没到点 -> 不干活', schMonEarly.active === false && schMonEarly.phase === 'pre', schMonEarly);
const schMonLate = CXL.checkSchedule(at('2026-03-02T15:00:00'), WORK_WEEK);
ok('周一 15:00 已过点 -> 不干活', schMonLate.active === false && schMonLate.phase === 'post', schMonLate);
const schSun = CXL.checkSchedule(at('2026-03-01T10:00:00'), WORK_WEEK);   // 星期日
ok('周日 10:00 不在勾选的星期里 -> 不干活',
  schSun.active === false && /不在选定的星期/.test(schSun.reason), schSun);
const schSat = CXL.checkSchedule(at('2026-02-28T10:00:00'), WORK_WEEK);
ok('周六 10:00 不干活（周一至周五的默认）', schSat.active === false, schSat);

const schJustAfter = CXL.checkSchedule(at('2026-03-02T14:05:00'), WORK_WEEK);
ok('刚过结束时间 5 分钟 -> 收尾中（还给一次机会）',
  schJustAfter.active === true && schJustAfter.awaiting === true && schJustAfter.phase === 'post', schJustAfter);
const schWayAfter = CXL.checkSchedule(at('2026-03-02T14:30:00'), WORK_WEEK);
ok('过了结束时间 30 分钟 -> 收工', schWayAfter.active === false, schWayAfter);

const schOff = CXL.checkSchedule(at('2026-03-02T09:30:00'), Object.assign({}, WORK_WEEK, { enabled: false }));
ok('总开关关掉 -> 永远不干活', schOff.active === false && schOff.phase === 'off', schOff);

const schAllDays = CXL.checkSchedule(at('2026-03-01T10:00:00'), Object.assign({}, WORK_WEEK, { weekdays: [] }));
ok('星期全不选 = 每天都跑（周日 10:00 也 active）', schAllDays.active === true, schAllDays);

const schNight = { enabled: true, startTime: '22:00', endTime: '02:00', weekdays: [] };
ok('跨夜时段 23:30 在内 -> active', CXL.checkSchedule(at('2026-03-02T23:30:00'), schNight).active === true);
ok('跨夜时段 次日 01:00 在内 -> active', CXL.checkSchedule(at('2026-03-03T01:00:00'), schNight).active === true);
ok('跨夜时段 15:00 不在内 -> 不干活', CXL.checkSchedule(at('2026-03-02T15:00:00'), schNight).active === false);

ok('describeWeekdays [1..5] -> "周一至周五"', CXL.describeWeekdays([1, 2, 3, 4, 5]) === '周一至周五',
  CXL.describeWeekdays([1, 2, 3, 4, 5]));
ok('describeWeekdays 空 -> "每天"', CXL.describeWeekdays([]) === '每天');
ok('describeWeekdays 不连续 -> 逐个列出', CXL.describeWeekdays([1, 3]) === '周一、周三', CXL.describeWeekdays([1, 3]));
ok('describeSchedule 默认就是"周一至周五 08:00-14:00"',
  CXL.describeSchedule(CXL.AUTO_DEFAULTS) === '周一至周五 08:00-14:00', CXL.describeSchedule(CXL.AUTO_DEFAULTS));
ok('自动签到默认是关的（不能装完就自己跑）', CXL.AUTO_DEFAULTS.enabled === false);
ok('自动签到默认只做位置签到', CXL.AUTO_DEFAULTS.locationOnly === true);

// ---------------------------------------------------------------------------
// 2) 服务端返回归类
// ---------------------------------------------------------------------------

section('2) 服务端返回归类');

const cls = CXL.classifySignResponse;
ok('success -> 成功', cls('success').ok === true && cls('success').kind === 'success');
ok('success2 -> 也算成功', cls('success2').ok === true);
ok('"您已签到过了" -> already', cls('您已签到过了').kind === 'already');
ok('"请先登录再进行签到" -> login', cls('请先登录再进行签到').kind === 'login');
ok('空返回 -> empty', cls('').kind === 'empty');

const far1 = cls('签到失败，您当前距离签到地点还有850米，请到签到地点后再试');
ok('"距离签到地点还有850米" -> tooFar 且量出 850',
  far1.kind === 'tooFar' && far1.meters === 850, far1);
ok('tooFar 不被算成成功', far1.ok === false);

const far2 = cls('您不在签到范围内，距离签到点约 1.2 公里');
ok('公里单位会换算成 1200 米', far2.kind === 'tooFar' && far2.meters === 1200, far2);

const far3 = cls('签到失败 距离签到地点过远 还差1234.5m');
ok('米/小数都能读出来', far3.kind === 'tooFar' && near(far3.meters, 1234.5, 1e-6), far3);

const far4 = cls('当前距离签到地点 300 米，签到范围 200 米');
ok('同时读出距离与允许范围', far4.kind === 'tooFar' && far4.meters === 300 && far4.range === 200, far4);

ok('[face] -> 要人脸且指向 APP',
  cls('[face]活体协议验证不通过').kind === 'face' && cls('[face]活体协议验证不通过').needApp === true);
ok('"请重新扫描" -> 二维码', cls('签到失败，请重新扫描').kind === 'qr');
ok('photoAuthError -> photoAuth', cls('photoAuthError_PCR007').kind === 'photoAuth');
ok('"活动已结束" -> expired', cls('签到活动已结束').kind === 'expired');
ok('"validate" -> validate', cls('validate').kind === 'validate');
ok('没见过的返回 -> other 且原样保留',
  cls('某段没见过的返回').kind === 'other' && cls('某段没见过的返回').message === '某段没见过的返回');

ok('explainSignResult 对 tooFar 说清楚还差多远',
  /850/.test(CXL.explainSignResult(far1)), CXL.explainSignResult(far1));
ok('explainSignResult 对成功能说"签到成功"', /签到成功/.test(CXL.explainSignResult(cls('success'))));

// ---------------------------------------------------------------------------
// 3) 三点定位
// ---------------------------------------------------------------------------

section('3) 三点定位（由距离反推签到地点）');

const TRUE_POINT = { lat: 38.041234, lon: 114.512345 };     // 假设的签到地点
const BASE = { lat: 38.060000, lon: 114.530000 };           // 学生选的起始点（约 2 km 外）

function observe(from) {
  return { lat: from.lat, lon: from.lon, meters: CXL.distance(from.lat, from.lon, TRUE_POINT.lat, TRUE_POINT.lon) };
}

// 一条测量：只能得到"圆"，落点就是测量点本身
const one = CXL.solveTrilateration([observe(BASE)]);
ok('一条测量也能给出结果（模式 circle）', !!one && one.mode === 'circle', one);
ok('一条测量时结果就是被测点本身',
  !!one && near(one.lat, BASE.lat, 1e-6) && near(one.lon, BASE.lon, 1e-6), one);

// 两条测量：最少二乘在这种情况会退化（两点连线方向能定，垂直方向只能猜）
const p2 = CXL.probePoint(BASE, 500, 90);
const two = CXL.solveTrilateration([observe(BASE), observe(p2)]);
ok('两条测量能得到一个可用解（不会瞎跑）',
  !!two && CXL.distance(two.lat, two.lon, BASE.lat, BASE.lon) < 1200, two && Math.round(CXL.distance(two.lat, two.lon, BASE.lat, BASE.lon)));
ok('两条测量时先保守地停在两点的中点（方向还定不了，不瞎指）',
  two.mode === 'midpoint', two.mode);
const twoExact = CXL.solveTrilaterationExact([observe(BASE), observe(p2)]);
ok('两条测量的圆相交给出候选（但存在镜像解，不会直接采用）',
  !!twoExact && twoExact.mode === 'exact' && twoExact.residual < 1, twoExact);

// 三条测量：这就是真正的三点定位
const p3 = CXL.probePoint(two, 700, 200);
const three = CXL.solveTrilateration([observe(BASE), observe(p2), observe(p3)]);
const err3 = CXL.distance(three.lat, three.lon, TRUE_POINT.lat, TRUE_POINT.lon);
ok('三条测量后误差 < 5 米', err3 < 5, Math.round(err3));
ok('三条测量后残差很小', three.used === 3 && three.residual < 5, three.residual);
ok('算出来的点在中国境内（不会被脏数据带飞）',
  three.lat > 3 && three.lat < 54 && three.lon > 73 && three.lon < 136);

// 用噪声测量（服务端把距离取整了）也要收敛
const noisy = [
  { lat: BASE.lat, lon: BASE.lon, meters: Math.round(CXL.distance(BASE.lat, BASE.lon, TRUE_POINT.lat, TRUE_POINT.lon)) },
  { lat: p2.lat, lon: p2.lon, meters: Math.round(CXL.distance(p2.lat, p2.lon, TRUE_POINT.lat, TRUE_POINT.lon)) },
  { lat: p3.lat, lon: p3.lon, meters: Math.round(CXL.distance(p3.lat, p3.lon, TRUE_POINT.lat, TRUE_POINT.lon)) }
];
const noisySolved = CXL.solveTrilateration(noisy);
ok('距离被取整到米，误差仍然 < 15 米',
  CXL.distance(noisySolved.lat, noisySolved.lon, TRUE_POINT.lat, TRUE_POINT.lon) < 15,
  Math.round(CXL.distance(noisySolved.lat, noisySolved.lon, TRUE_POINT.lat, TRUE_POINT.lon)));

// 三个点共线（都在同一条经线上）：方程退化，必须能给出一个可用解而不是 NaN
const lineObs = [
  { lat: BASE.lat, lon: BASE.lon, meters: 500 },
  { lat: BASE.lat + 0.002, lon: BASE.lon, meters: 400 },
  { lat: BASE.lat + 0.004, lon: BASE.lon, meters: 700 }
];
const lineSol = CXL.solveTrilateration(lineObs);
ok('共线测量也能给出有限解（不会 NaN）',
  !!lineSol && isFinite(lineSol.lat) && isFinite(lineSol.lon), lineSol);

ok('空观测 -> null', CXL.solveTrilateration([]) === null);
ok('脏观测被丢掉', CXL.solveTrilateration([{ lat: 'x', lon: null }]) === null);

// 坐标偏移工具
const off = CXL.offsetPoint(30, 120, 100, 100);
const dOff = CXL.distance(30, 120, off.lat, off.lon);
ok('offsetPoint 走 100+100 米 => 直线距离 ≈ 141 米', near(dOff, 141.4, 2), Math.round(dOff));
const dm = CXL.deltaMeters(30, 120, off.lat, off.lon);
ok('deltaMeters 拆出北/东分量', near(dm.north, 100, 2) && near(dm.east, 100, 2), dm);

// 方向选择：要尽量分散
ok('pickDirection 在没用过任何方向时给一个确定的方向',
  !!CXL.pickDirection([], 0) && typeof CXL.pickDirection([], 0).deg === 'number');
const d0 = CXL.pickDirection([], 0);
const d1 = CXL.pickDirection([d0.deg], 1);
ok('第二次测量方向与第一次的夹角 >= 45 度',
  Math.abs(((d1.deg - d0.deg) % 360)) >= 44, [d0.deg, d1.deg]);
const d2 = CXL.pickDirection([d0.deg, d1.deg], 2);
ok('第三次测量方向与两个已有方向都拉开',
  Math.abs(((d2.deg - d0.deg + 540) % 360) - 180) >= 44 &&
  Math.abs(((d2.deg - d1.deg + 540) % 360) - 180) >= 44, [d0.deg, d1.deg, d2.deg]);

// ---------------------------------------------------------------------------
// 4) 逼近策略（planProbe）
// ---------------------------------------------------------------------------

section('4) 逼近策略 planProbe');

const plan0 = CXL.planProbe([], {});
ok('没有任何测量时：先用用户给的起点试一次', plan0.first === true && plan0.center === null);

const plan1 = CXL.planProbe([observe(BASE)], {});
ok('有一条测量时给出下一个探点', !!plan1.center && isFinite(plan1.center.lat));
ok('探点半径受 maxProbeMeters 限制',
  plan1.radius <= CXL.AUTO_DEFAULTS.maxProbeMeters, plan1.radius);
ok('探点说明是人话（日志里能看懂）', /三点定位|再测一次|细调/.test(plan1.why), plan1.why);

const converged = CXL.planProbe(
  [observe(BASE), observe(p2), observe(p3)],
  {}
);
ok('三条测量后进入细调模式（不再撒大圈）',
  converged.refine === true && converged.radius > 0 && converged.radius <= 60, converged);
ok('细调时给得出下一个点（真的会往解附近挪）',
  !!converged.center && CXL.distance(converged.center.lat, converged.center.lon, converged.solution.lat, converged.solution.lon) > 1,
  converged.center);

// 模拟整条自动流程：起点在 2 km 外，最多 10 次内必须签上
function simulate(startPoint, maxRounds, radiusMeters) {
  let cur = { lat: startPoint.lat, lon: startPoint.lon };
  const obs = [];
  const tried = new Set();
  for (let round = 1; round <= maxRounds; round++) {
    tried.add(cur.lat.toFixed(6) + ',' + cur.lon.toFixed(6));
    const meters = CXL.distance(cur.lat, cur.lon, TRUE_POINT.lat, TRUE_POINT.lon);
    if (meters <= radiusMeters) return { ok: true, round, meters };
    obs.push({ lat: cur.lat, lon: cur.lon, meters });
    const plan = CXL.planProbe(obs, { maxProbeMeters: 800, goodEnoughMeters: 25 });
    if (!plan || !plan.center) break;
    cur = plan.center;
    if (tried.has(cur.lat.toFixed(6) + ',' + cur.lon.toFixed(6))) break;
  }
  return { ok: false, obs: obs.length };
}
const sim1 = simulate(BASE, 10, 200);
ok('起点在 2 km 外、允许范围 200 米：10 次内签上', sim1.ok === true, sim1);
ok('而且用的次数不多（<= 6 次）', sim1.ok && sim1.round <= 6, sim1.round);

const sim2 = simulate(BASE, 10, 50);
ok('允许范围只有 50 米也能在 10 次内签上', sim2.ok === true, sim2);

const near1800 = CXL.offsetPoint(TRUE_POINT.lat, TRUE_POINT.lon, 1800, 0);   // 正北 1.8 km
const sim3 = simulate(near1800, 10, 200);
ok('起点在正北 1.8 km：同样能签上', sim3.ok === true, sim3);

// ---------------------------------------------------------------------------
// 5) 日志与状态
// ---------------------------------------------------------------------------

section('5) 日志与状态');

let logObj = CXL.emptyAutoLog();
for (let i = 0; i < 80; i++) logObj = CXL.appendLog(logObj, { text: 'line ' + i });
ok('日志最多保留上限条数', logObj.items.length === 60, logObj.items.length);
ok('保留的是最新的那些', logObj.items[logObj.items.length - 1].text === 'line 79');
ok('describeLog 输出 HH:MM + 文本', /^\d\d:\d\d\s+hello$/.test(CXL.describeLog({ at: Date.now(), text: 'hello' })),
  CXL.describeLog({ at: Date.now(), text: 'hello' }));

const st = CXL.emptyAutoState();
ok('空状态包含统计与上次错误字段',
  !!st.stats && st.stats.success === 0 && st.lastError === '' && st.enabled === false);
ok('describeAutoState 未启用时说明时段',
  /未启用/.test(CXL.describeAutoState(st, CXL.AUTO_DEFAULTS)) &&
  /周一至周五 08:00-14:00/.test(CXL.describeAutoState(st, CXL.AUTO_DEFAULTS)),
  CXL.describeAutoState(st, CXL.AUTO_DEFAULTS));

// ---------------------------------------------------------------------------
// 4.5) 引擎层的逼近循环：把真实的 auto-runner 逻辑跑一遍
//      （假的 fetch：按提交坐标算与签到地点的距离，超出半径就回"还差 xxx 米"）
// ---------------------------------------------------------------------------

section('4.5) 自动签到引擎的逼近循环（auto-runner.js）');

const runnerSource = fs.readFileSync(path.join(srcDir, 'auto-runner.js'), 'utf8');

function makeRunner(opts) {
  const store = Object.assign({}, opts.store || {});
  const submitted = [];
  const alarmCalls = [];
  const alarmClears = [];
  const TRUE = opts.truePoint;
  const radiusM = opts.radius;
  const rs = {
    // chrome.storage.local
    chrome: {
      storage: {
        local: {
          get(keys, cb) {
            const out = {};
            for (const k of keys) if (store[k] !== undefined) out[k] = store[k];
            cb(out);
          },
          set(obj, cb) { Object.assign(store, obj); if (cb) cb(); }
        }
      },
      cookies: { get: async () => null },
      alarms: {
        create: (n, i, cb) => { alarmCalls.push({ name: n, info: i }); if (cb) cb(); },
        clear: (n, cb) => { alarmClears.push(n); if (cb) cb(true); }
      },
      runtime: {}
    },
    console: { log() {}, warn() {}, error() {} },
    importScripts() {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    AbortController: undefined,
    // 假的服务端
    fetch: async (url, init) => {
      if (/activelist/.test(url)) {
        return {
          status: 200, url,
          text: async () => JSON.stringify({
            result: 1,
            data: {
              activeList: [{
                id: '4000175553141', nameOne: '位置签到', status: 1,
                activeSort: 4, otherId: 4, startTime: 1792081000000
              }]
            }
          })
        };
      }
      if (/stuSignajax/.test(url)) {
        const body = String((init && init.body) || '');
        const lat = parseFloat((body.match(/latitude=([-\d.]+)/) || [])[1]);
        const lon = parseFloat((body.match(/longitude=([-\d.]+)/) || [])[1]);
        submitted.push({ lat, lon });
        const d = CXL.distance(lat, lon, TRUE.lat, TRUE.lon);
        if (d <= radiusM) return { status: 200, url, text: async () => 'success' };
        return {
          status: 200, url,
          text: async () => '签到失败，您当前距离签到地点还有' + Math.round(d) + '米，请到签到地点后再试'
        };
      }
      return { status: 404, url, text: async () => '' };
    },
    Math, JSON, Object, Array, String, Number, Boolean, Error, RegExp, Date, Promise, Map, Set,
    parseInt, parseFloat, isFinite, isNaN, encodeURIComponent, decodeURIComponent, Uint8Array
  };
  rs.globalThis = rs;
  rs.self = rs;
  vm.createContext(rs);
  vm.runInContext(libSource, rs);
  vm.runInContext(autoSource, rs);
  let code = runnerSource;
  // 引擎里用 ES module 语法挂接口，这里换成直接给沙箱一个全局变量
  code = code.replace('if (typeof module !== \'undefined\' && module.exports) module.exports = api;', 'self.__api = api;');
  vm.runInContext(code, rs);
  return { sandbox: rs, api: rs.__api, store, submitted, alarmCalls, alarmClears };
}

const engine = makeRunner({
  truePoint: TRUE_POINT,
  radius: 200,
  store: {
    point: { lat: BASE.lat, lon: BASE.lon, datum: 'gcj02', address: '石家庄 XX 大学' },
    autoTargets: [{
      courseId: '268194985', classId: '157462133', fid: '135774',
      courseName: '测试课程', url: 'https://mooc2-ans.chaoxing.com/x'
    }],
    auto: Object.assign({}, CXL.AUTO_DEFAULTS, {
      enabled: true, startTime: '00:00', endTime: '23:59',
      weekdays: [], intervalMs: 20000, maxRounds: 10
    })
  }
});

await engine.api.tick('test');
const stEngine = engine.store.autoState;
ok('引擎真的提交了（不是空跑）', engine.submitted.length >= 1, engine.submitted.length);
ok('起点在 2 km 外时，引擎自己挪到了签到地点附近',
  !!stEngine && stEngine.stats && stEngine.stats.success === 1, stEngine && stEngine.stats);
const lastSubmit = engine.submitted[engine.submitted.length - 1];
ok('最后一次提交的坐标离签到地点 <= 200 米（在允许范围内）',
  lastSubmit && CXL.distance(lastSubmit.lat, lastSubmit.lon, TRUE_POINT.lat, TRUE_POINT.lon) <= 200,
  lastSubmit && Math.round(CXL.distance(lastSubmit.lat, lastSubmit.lon, TRUE_POINT.lat, TRUE_POINT.lon)));
ok('提交次数控制在 maxRounds 以内', engine.submitted.length <= 10, engine.submitted.length);
ok('界面上的状态是"已签到"', /已签到/.test(stEngine.status || ''), stEngine.status);
const logText = (engine.store.autoLog && engine.store.autoLog.items || []).map((x) => x.text).join('\n');
ok('日志里记下了每次还差多少米', /还差/.test(logText), logText.slice(0, 200));
ok('日志里带上了三点定位算出的坐标', /签到点约/.test(logText), logText.slice(0, 300));

// 非位置签到：只记录，不提交
const engine2 = makeRunner({
  truePoint: TRUE_POINT,
  radius: 200,
  store: {
    point: { lat: BASE.lat, lon: BASE.lon, datum: 'gcj02' },
    autoTargets: [{ courseId: '1', classId: '2', fid: '3', courseName: '只有普通签到的课' }],
    auto: Object.assign({}, CXL.AUTO_DEFAULTS, {
      enabled: true, startTime: '00:00', endTime: '23:59', weekdays: []
    })
  }
});
engine2.sandbox.fetch = async (url) => {
  if (/activelist/.test(url)) {
    return {
      status: 200, url,
      text: async () => JSON.stringify({
        result: 1,
        data: { activeList: [{ id: '4000175553999', nameOne: '普通签到', status: 1, activeSort: 1, otherId: 1 }] }
      })
    };
  }
  engine2.submitted.push({ url });
  return { status: 200, url, text: async () => 'success' };
};
await engine2.api.tick('test');
ok('识别出普通签到时不发任何提交请求（不是位置签到就不管）',
  engine2.submitted.length === 0, engine2.submitted.length);
const log2 = (engine2.store.autoLog && engine2.store.autoLog.items || []).map((x) => x.text).join('\n');
ok('但会写一条"检测到普通签到、不自动处理"的日志',
  /普通签到/.test(log2) && /不自动处理/.test(log2), log2);

// 时段外：一次请求都不发
const engine3 = makeRunner({
  truePoint: TRUE_POINT,
  radius: 200,
  store: {
    point: { lat: BASE.lat, lon: BASE.lon, datum: 'gcj02' },
    autoTargets: [{ courseId: '1', classId: '2', fid: '3' }],
    auto: Object.assign({}, CXL.AUTO_DEFAULTS, {
      enabled: true, startTime: '03:00', endTime: '03:10', weekdays: []
    })
  }
});
let fetched3 = 0;
engine3.sandbox.fetch = async (url) => { fetched3++; return { status: 200, url, text: async () => '{}' }; };
await engine3.api.tick('test');
ok('时段外（03:00-03:10）不查活动、不发请求', fetched3 === 0, fetched3);
ok('时段外状态里说明了原因（还没到 / 已过 / 不在星期里）',
  /还没到|已过|不在选定的星期/.test(engine3.store.autoState.status || ''), engine3.store.autoState.status);
// MV3 的 service worker 会被回收：时段外必须留下"到点叫醒"的 alarm，
// 否则第二天到点没人来跑（这是最容易被忽略的不工作原因）。
const wakeAlarm = engine3.alarmCalls.filter((x) => x.name === 'cxl-auto-poll').pop();
ok('时段外仍然排了一条 alarm 指向下一次开门（否则明天不会自动跑）',
  !!wakeAlarm && (wakeAlarm.info.delayInMinutes !== undefined || wakeAlarm.info.when !== undefined),
  wakeAlarm && wakeAlarm.info);
ok('这条 alarm 把"下一次开工时间"回报到状态里', typeof engine3.store.autoState.nextAt === 'number',
  engine3.store.autoState.nextAt);

// 手动"立刻跑一轮"必须无视时段（否则点下去毫无反应，像坏了）
const manualEngine = makeRunner({
  truePoint: TRUE_POINT,
  radius: 200,
  store: {
    point: { lat: TRUE_POINT.lat, lon: TRUE_POINT.lon, datum: 'gcj02' },
    autoTargets: [{ courseId: '1', classId: '2', fid: '3' }],
    // 设成"今天永远不会开门"的时段；不打开 enabled，验证手动触发也能跑
    auto: Object.assign({}, CXL.AUTO_DEFAULTS, {
      enabled: false, startTime: '03:00', endTime: '03:10', weekdays: []
    })
  }
});
await manualEngine.api.runNow();
ok('手动触发会无视时段和总开关，真的去签', manualEngine.submitted.length >= 1, manualEngine.submitted.length);

// ---------------------------------------------------------------------------
// 4.6) 后台消息路由：设置页/弹窗发的 autoStatus / autoConfig 必须真的能用
//      （这里是为了挡住"调用了 lib 里不存在的私有函数"这类只在运行时才炸的错误）
// ---------------------------------------------------------------------------

section('4.6) 后台消息路由（autoStatus / autoConfig / autoTarget）');

const bgSource = fs.readFileSync(path.join(srcDir, 'background.js'), 'utf8');

function makeBackground(store) {
  const listeners = [];
  const bs = {
    chrome: {
      runtime: {
        lastError: undefined,
        onMessage: { addListener(fn) { listeners.push(fn); } },
        getManifest() { return { version: 'test' }; }
      },
      storage: {
        local: {
          get(keys, cb) {
            const out = {};
            for (const k of keys) if (store[k] !== undefined) out[k] = store[k];
            cb(out);
          },
          set(obj, cb) { Object.assign(store, obj); if (cb) cb(); },
          onChanged: { addListener() {} }
        }
      },
      cookies: { get: async () => null },
      tabs: { get(a, cb) { if (cb) cb(null); } },
      scripting: { executeScript() {} },
      alarms: { create: (n, i, cb) => { if (cb) cb(); }, clear: (n, cb) => { if (cb) cb(true); } },
      runtime_events: null
    },
    console: { log() {}, warn() {}, error() {} },
    importScripts() {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    AbortController: undefined,
    fetch: async () => ({ status: 200, url: '', text: async () => '' }),
    Math, JSON, Object, Array, String, Number, Boolean, Error, RegExp, Date, Promise, Map, Set,
    parseInt, parseFloat, isFinite, isNaN, encodeURIComponent, decodeURIComponent, Uint8Array
  };
  bs.globalThis = bs;
  bs.self = bs;
  vm.createContext(bs);
  vm.runInContext(libSource, bs);
  vm.runInContext(autoSource, bs);
  vm.runInContext(runnerSource.replace(
    'if (typeof module !== \'undefined\' && module.exports) module.exports = api;', 'self.__api = api;'), bs);
  vm.runInContext(bgSource, bs);
  return { sandbox: bs, listeners };
}

function send(bg, msg) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) resolve({ timeout: true }); }, 3000);
    for (const fn of bg.listeners) {
      const keep = fn(msg, { tab: null }, (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(res);
      });
      if (keep === true) return;
    }
    settled = true;
    clearTimeout(timer);
    resolve({ noHandler: true });
  });
}

const bgStore = {
  auto: Object.assign({}, CXL.AUTO_DEFAULTS, { enabled: true, startTime: '08:00', endTime: '14:00' })
};
const bg = makeBackground(bgStore);

const r1 = await send(bg, { type: 'autoStatus' });
ok('autoStatus 有响应且不报错', !!r1 && r1.ok === true, r1);
ok('autoStatus 带回了时段摘要',
  !!r1 && /周一至周五 08:00-14:00/.test(r1.summary || ''), r1 && r1.summary);
ok('autoStatus 带回了 schedule（当前是否在时段内）', !!r1 && !!r1.schedule && !!r1.schedule.phase, r1 && r1.schedule);

const r2 = await send(bg, { type: 'autoConfig', auto: { startTime: '7:30', endTime: '9:45', weekdays: [6, 0] } });
ok('autoConfig 保存成功', !!r2 && r2.ok === true, r2);
const savedAuto = bgStore.auto;
ok('时间段被规范化（7:30 -> 07:30）', savedAuto.startTime === '07:30', savedAuto.startTime);
ok('星期被存下来', Array.isArray(savedAuto.weekdays) && savedAuto.weekdays.join(',') === '6,0', savedAuto.weekdays);
ok('只做位置签到这一条不会被用户配置冲掉', savedAuto.locationOnly === true);

const r3 = await send(bg, { type: 'autoTarget', target: { courseId: '268194985', classId: '157462133', fid: '135774', courseName: '高等数学' } });
ok('autoTarget 登记成功', !!r3 && r3.ok === true, r3);
ok('课程进了自动签到的查询清单',
  (bgStore.autoTargets || []).some((t) => t.courseId === '268194985' && t.classId === '157462133'),
  bgStore.autoTargets);

const r4 = await send(bg, { type: 'autoReset' });
ok('autoReset 有响应', !!r4 && r4.ok === true, r4);

// 时段内没签上（老师还没发签到）不该把当天锁死：进入"收尾"与下一个时段还要继续找
const engine4 = makeRunner({
  truePoint: TRUE_POINT,
  radius: 200,
  store: {
    point: { lat: BASE.lat, lon: BASE.lon, datum: 'gcj02' },
    autoTargets: [{ courseId: '1', classId: '2', fid: '3' }],
    // 时段设成一整天，保证 tick 一定在窗口内
    auto: Object.assign({}, CXL.AUTO_DEFAULTS, {
      enabled: true, startTime: '00:00', endTime: '23:59', weekdays: [], intervalMs: 20000
    })
  }
});
let polls4 = 0;
engine4.sandbox.fetch = async (url) => {
  if (/activelist/.test(url)) {
    polls4++;
    return { status: 200, url, text: async () => JSON.stringify({ result: 1, data: { activeList: [] } }) };
  }
  return { status: 200, url, text: async () => '' };
};
await engine4.api.tick('test');
await engine4.api.tick('test');
ok('时段内没有活动时会继续轮询（不会被"今天已开工"锁死）', polls4 >= 2, polls4);
ok('没活动时不报错、也不改统计里的成功数',
  (engine4.store.autoState.stats.success || 0) === 0, engine4.store.autoState.stats);

// 已经签过的那个活动不再重复提交
const engine5 = makeRunner({
  truePoint: TRUE_POINT,
  radius: 200,
  store: {
    point: { lat: TRUE_POINT.lat, lon: TRUE_POINT.lon, datum: 'gcj02' },
    autoTargets: [{ courseId: '1', classId: '2', fid: '3' }],
    auto: Object.assign({}, CXL.AUTO_DEFAULTS, {
      enabled: true, startTime: '00:00', endTime: '23:59', weekdays: []
    })
  }
});
await engine5.api.tick('test');
const firstCount = engine5.submitted.length;
engine5.sandbox.fetch = async (url, init) => {
  if (/activelist/.test(url)) {
    return {
      status: 200, url,
      text: async () => JSON.stringify({
        result: 1, data: { activeList: [{ id: '4000175553141', nameOne: '位置签到', status: 1, activeSort: 4 }] }
      })
    };
  }
  return { status: 200, url, text: async () => '您已签到过了' };
};
await engine5.api.tick('test');
ok('第一次提交就成功了（起点就在范围内）', firstCount >= 1, firstCount);
ok('服务端说"已签到"时不继续硬试',
  engine5.submitted.length - firstCount <= 1, engine5.submitted.length - firstCount);

// ---------------------------------------------------------------------------
// 4.7) 课表：不打开课程页面也要能自动跑（这是"手动"的最后一个尾巴）
// ---------------------------------------------------------------------------

section('4.7) 课表自动获取 + 无课程页登记时的完整链路');

ok('课表地址指向 backclazzdata 接口',
  /^https:\/\/mooc1-api\.chaoxing\.com\/mycourse\/backclazzdata\?view=json/.test(CXL.buildCourseListUrl()),
  CXL.buildCourseListUrl());

// 形状一：channelList -> content.course.data[]
const courseShape1 = {
  result: 1,
  channelList: [{
    id: 157462133, name: '2024级1班',
    content: {
      course: {
        data: [{ id: '268194985', name: '高等数学' }]
      }
    }
  }]
};
const c1 = CXL.extractCourses(courseShape1);
ok('解析 channelList 结构', c1.length === 1 && c1[0].courseId === '268194985' && c1[0].classId === '157462133', c1);
ok('课程名与班级名拼在一起', /高等数学/.test(c1[0].name) && /2024级1班/.test(c1[0].name), c1[0].name);

// 形状二：data: [...] 直接给数组
const courseShape2 = {
  data: [{ id: 157462134, name: '2班', course: { data: [{ id: '268194986', name: '线性代数' }] } }]
};
const c2 = CXL.extractCourses(courseShape2);
ok('解析 data 数组结构', c2.length === 1 && c2[0].courseId === '268194986', c2);

// 形状三：直接是数组
const c3 = CXL.extractCourses([
  { id: 100001, name: 'A班', course: { data: [{ id: '200001', name: '概率论' }] } }
]);
ok('直接给数组也能解析', c3.length === 1 && c3[0].classId === '100001', c3);

// 脏数据：编号不像编号的丢掉
ok('编号不合法（太短/非数字）的被丢掉',
  CXL.extractCourses({ data: [{ id: 1, course: { data: [{ id: '2' }] } }] }).length === 0);
ok('同一门课重复出现只保留一条',
  CXL.extractCourses({
    data: [
      { id: 157462133, course: { data: [{ id: '268194985' }] } },
      { id: 157462133, course: { data: [{ id: '268194985' }] } }
    ]
  }).length === 1);
ok('空/脏输入返回空数组',
  CXL.extractCourses(null).length === 0 && CXL.extractCourses({}).length === 0 && CXL.extractCourses('x').length === 0);

// --- 引擎：没有登记过任何课程，也能自己拉课表找到并签到 ---
const freshEngine = makeRunner({
  truePoint: TRUE_POINT,
  radius: 200,
  store: {
    point: { lat: TRUE_POINT.lat, lon: TRUE_POINT.lon, datum: 'gcj02' },
    // 注意：这里故意不给 autoTargets / auto.courses —— 模拟"从没打开过课程页面"
    auto: Object.assign({}, CXL.AUTO_DEFAULTS, {
      enabled: true, startTime: '00:00', endTime: '23:59', weekdays: []
    })
  }
});
let courseListCalls = 0;
freshEngine.sandbox.fetch = async (url, init) => {
  if (/backclazzdata/.test(url)) {
    courseListCalls++;
    return {
      status: 200, url,
      text: async () => JSON.stringify(courseShape1)
    };
  }
  if (/activelist/.test(url)) {
    return {
      status: 200, url,
      text: async () => JSON.stringify({
        result: 1,
        data: { activeList: [{ id: '4000175553141', nameOne: '位置签到', status: 1, activeSort: 4 }] }
      })
    };
  }
  if (/stuSignajax/.test(url)) {
    const body = String((init && init.body) || '');
    const lat = parseFloat((body.match(/latitude=([-\d.]+)/) || [])[1]);
    const lon = parseFloat((body.match(/longitude=([-\d.]+)/) || [])[1]);
    const d = CXL.distance(lat, lon, TRUE_POINT.lat, TRUE_POINT.lon);
    if (d <= 200) return { status: 200, url, text: async () => 'success' };
    return { status: 200, url, text: async () => '距离签到地点还有' + Math.round(d) + '米' };
  }
  return { status: 200, url, text: async () => '' };
};
await freshEngine.api.tick('test');
ok('没打开过课程页面时，引擎自己去拉了课表', courseListCalls >= 1, courseListCalls);
ok('而且真的签上了（起点就在范围内）',
  (freshEngine.store.autoState.stats || {}).success === 1, freshEngine.store.autoState.stats);
ok('拉到的课程缓存进 autoTargets（下次不用再拉）',
  (freshEngine.store.autoTargets || []).some((t) => t.courseId === '268194985'),
  freshEngine.store.autoTargets);

// 第二轮不应再拉课表
const beforeCalls = courseListCalls;
await freshEngine.api.tick('test');
ok('第二轮直接用缓存，不再重复拉课表', courseListCalls === beforeCalls, courseListCalls);

// --- 用户手填了 courses：只查这些，不查课表 ---
const coursesEngine = makeRunner({
  truePoint: TRUE_POINT,
  radius: 200,
  store: {
    point: { lat: TRUE_POINT.lat, lon: TRUE_POINT.lon, datum: 'gcj02' },
    auto: Object.assign({}, CXL.AUTO_DEFAULTS, {
      enabled: true, startTime: '00:00', endTime: '23:59', weekdays: [],
      courses: [{ courseId: '999888', classId: '777666', courseName: '只听这门' }]
    })
  }
});
let coursesCalls = 0;
let coursesActUrls = [];
coursesEngine.sandbox.fetch = async (url) => {
  if (/backclazzdata/.test(url)) { coursesCalls++; return { status: 200, url, text: async () => '{}' }; }
  if (/activelist/.test(url)) { coursesActUrls.push(url); return { status: 200, url, text: async () => JSON.stringify({ result: 1, data: { activeList: [] } }) }; }
  return { status: 200, url, text: async () => '' };
};
await coursesEngine.api.tick('test');
ok('指定了 courses 时不去拉课表', coursesCalls === 0, coursesCalls);
ok('并且只查指定的那门课',
  coursesActUrls.length === 1 && /courseId=999888/.test(coursesActUrls[0]), coursesActUrls);

// --- 课表返回登录页：要能识别成"需要登录"，而不是静默空跑 ---
const loginEngine = makeRunner({
  truePoint: TRUE_POINT,
  radius: 200,
  store: {
    point: { lat: TRUE_POINT.lat, lon: TRUE_POINT.lon, datum: 'gcj02' },
    auto: Object.assign({}, CXL.AUTO_DEFAULTS, {
      enabled: true, startTime: '00:00', endTime: '23:59', weekdays: []
    })
  }
});
loginEngine.sandbox.fetch = async (url) => ({
  status: 200, url,
  text: async () => '<!DOCTYPE html><html><head><title>用户登录</title>'
});
await loginEngine.api.tick('test');
ok('课表返回登录页时状态写明需要登录',
  /登录/.test(loginEngine.store.autoState.status || '') ||
  /登录/.test(loginEngine.store.autoState.lastError || ''),
  { status: loginEngine.store.autoState.status, err: loginEngine.store.autoState.lastError });

// ---------------------------------------------------------------------------

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');if (problems.length) {
  console.log('\n需要修复：');
  for (const p of problems) console.log('  - ' + p);
}
process.exit(fail ? 1 : 0);
