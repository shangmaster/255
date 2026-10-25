/*
 * 自动签到引擎（跑在后台 service worker 里）。
 *
 * 定位很清楚：**只签位置签到**。
 *   - 到点（用户设定的星期 + 起止时间）才动手，过了点就收工；
 *   - 一次只处理一门课里「进行中」的那个位置签到活动；
 *   - 识别出来是普通 / 二维码 / 签到码 / 手势 / 要人脸 / 要拍照，
 *     一律只写日志、不提交、不重试 —— 交给用户自己判断怎么处理；
 *   - 位置签到如果因为"离签到地点太远"失败，就把服务端返回的距离当成一次测量，
 *     配合前几次测量用三点定位算出签到地点，再去试，直到签上或者判明不是距离问题。
 *
 * 为什么要挪也要重开：chrome.alarms 的间隔最短 30 秒，而位置签到通常只有几分钟，
 * 所以"每 20 秒查一次"靠 alarms 自己续命（alarm 触发后 handler 里再排下一个）。
 * service worker 被回收也不怕：状态全部在 chrome.storage.local 里。
 */
importScripts('lib.js', 'auto.js');

var CXL = self.CXL;

var SIGN_ENDPOINT = 'https://mobilelearn.chaoxing.com/pptSign/stuSignajax';
var ALARM_POLL = 'cxl-auto-poll';
var ALARM_BOOT = 'cxl-auto-boot';
var WORK_KEY = 'autoWork';               // { startedAt, hour, school } 已开工标记
var MAX_HOURS = 3;                       // 单门课连续找多久还没结果就放弃（别无限刷服务端）
var SUBMIT_TIMEOUT_MS = 15000;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function todayKey(d) {
  var t = d || new Date();
  return t.getFullYear() + '-' + ('0' + (t.getMonth() + 1)).slice(-2) + '-' + ('0' + t.getDate()).slice(-2);
}

function readStore(keys) {
  return new Promise(function (resolve) {
    try {
      chrome.storage.local.get(keys, function (res) { resolve(res || {}); });
    } catch (e) { resolve({}); }
  });
}

function writeStore(obj) {
  return new Promise(function (resolve) {
    try {
      chrome.storage.local.set(obj, function () { void chrome.runtime.lastError; resolve(); });
    } catch (e) { resolve(); }
  });
}

async function readAuto() {
  var res = await readStore([CXL.AUTO_KEYS.auto]);
  return Object.assign({}, CXL.AUTO_DEFAULTS, res[CXL.AUTO_KEYS.auto] || {});
}

async function readState() {
  var res = await readStore([CXL.AUTO_KEYS.autoState]);
  return Object.assign(CXL.emptyAutoState(), res[CXL.AUTO_KEYS.autoState] || {});
}

async function patchState(patch) {
  var cur = await readState();
  var next = Object.assign({}, cur, patch);
  var map = {};
  map[CXL.AUTO_KEYS.autoState] = next;
  await writeStore(map);
  return next;
}

/** 日志：写存储 + 打 console（service worker 的日志在扩展页的"服务程序"里看） */
async function log(text, kind) {
  var res = await readStore([CXL.AUTO_KEYS.autoLog]);
  var logObj = res[CXL.AUTO_KEYS.autoLog] || CXL.emptyAutoLog();
  var next = CXL.appendLog(logObj, { text: text, kind: kind || 'info' });
  var map = {};
  map[CXL.AUTO_KEYS.autoLog] = next;
  await writeStore(map);
  try { console.log('[自动签到] ' + text); } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Chrome Cookie 读取（和 background.js 里那份同语义；那边是主插件用，这里独立一份）
// ---------------------------------------------------------------------------

async function readAuthCookies() {
  var out = { fid: '', uid: '' };
  if (!chrome.cookies || typeof chrome.cookies.get !== 'function') return out;
  var targets = [
    ['fid', 'https://mobilelearn.chaoxing.com', 'fid'],
    ['fid', 'https://i.chaoxing.com', 'fid'],
    ['uid', 'https://i.chaoxing.com', '_uid'],
    ['uid', 'https://i.chaoxing.com', 'UID']
  ];
  for (var i = 0; i < targets.length; i++) {
    var key = targets[i][0];
    if (out[key]) continue;
    try {
      var c = await chrome.cookies.get({ url: targets[i][1], name: targets[i][2] });
      if (c && c.value) out[key] = String(c.value);
    } catch (e) { /* 忽略单个失败 */ }
  }
  return out;
}

async function readName() {
  try {
    var res = await readStore(['userName']);
    return res.userName || '';
  } catch (e) { return ''; }
}

async function readAddress() {
  try {
    var res = await readStore(['point']);
    var p = res.point;
    return (p && p.address) || '';
  } catch (e) { return ''; }
}

// ---------------------------------------------------------------------------
// 查询进行中的位置签到
// ---------------------------------------------------------------------------

async function fetchJson(url, referer) {
  var headers = { Accept: 'application/json, text/plain, */*' };
  if (referer) headers.Referer = referer;
  var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
  var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 12000) : null;
  try {
    var res = await fetch(url, {
      method: 'GET', credentials: 'include', headers: headers,
      signal: ctrl ? ctrl.signal : undefined
    });
    var text = await res.text();
    if (timer) clearTimeout(timer);
    return { ok: true, status: res.status, url: String(res.url || ''), text: text };
  } catch (e) {
    if (timer) clearTimeout(timer);
    return { ok: false, error: (e && e.message) ? e.message : String(e) };
  }
}

/**
 * 在若干门课里找「进行中」的位置签到。
 * 返回 { found:true, ... } / { found:false, reason } / { needLogin:true }
 */
/**
 * 拉课表：自动签到不该要求"先去课程页打开一次"。
 * 只要浏览器登录着 i.chaoxing.com，这个接口就认得你，会返回全部课程/班级。
 */
async function fetchCourseList() {
  var url = CXL.buildCourseListUrl();
  var r = await fetchJson(url, 'https://mooc2-ans.chaoxing.com/');
  if (!r.ok) return { ok: false, error: '课表请求失败：' + r.error };
  if (/passport2|\/login/i.test(r.url) || /^\s*</.test(r.text || '')) {
    return { ok: false, needLogin: true, error: '课表接口返回登录页（浏览器没登录学习通）' };
  }
  var json = null;
  try { json = JSON.parse(r.text); } catch (e) { json = null; }
  if (!json) return { ok: false, error: '课表返回不是 JSON' };
  if (json.result !== undefined && Number(json.result) === 0) {
    return { ok: false, needLogin: true, error: CXL.lookupErrorMessage(json) || '服务端要求重新登录' };
  }
  var courses = CXL.extractCourses(json);
  if (!courses.length) {
    return { ok: false, error: '课表里没解析出课程（可能这学期没有课，或接口结构又变了）' };
  }
  return { ok: true, courses: courses };
}

/**
 * 拿到要监控的课程清单：
 *   1) 优先用用户在设置页手填/勾选的 courses（可精确控制监控哪几门）
 *   2) 没有再退回到"打开页面时自动登记"的 autoTargets
 *   3) 都没有就去拉课表
 */
async function resolveTargets(auto) {
  var manual = (auto && auto.courses) || [];
  if (manual.length) {
    return manual.filter(function (c) { return c && c.courseId && c.classId; }).map(function (c) {
      return {
        courseId: String(c.courseId), classId: String(c.classId),
        fid: String(c.fid || ''), courseName: String(c.courseName || c.name || ''),
        url: String(c.referer || '')
      };
    });
  }
  var res = await readStore([CXL.AUTO_KEYS.autoTargets]);
  var seen = ((res[CXL.AUTO_KEYS.autoTargets] || [])).filter(function (t) {
    return t && t.courseId && t.classId;
  });
  if (seen.length) return seen;

  var fetched = await fetchCourseList();
  if (!fetched.ok) {
    return { error: fetched.error, needLogin: !!fetched.needLogin };
  }
  // 缓存下来，别每分钟都拉一次课表
  var list = fetched.courses.map(function (c) {
    return {
      courseId: c.courseId, classId: c.classId, fid: c.fid || '',
      courseName: c.name || '', url: 'https://mooc2-ans.chaoxing.com/'
    };
  });
  var map = {};
  map[CXL.AUTO_KEYS.autoTargets] = list.slice(0, 20);
  await writeStore(map);
  await log('已从课表自动取到 ' + list.length + ' 门课程（' +
    list.slice(0, 5).map(function (c) { return c.courseName; }).filter(Boolean).join('、') +
    (list.length > 5 ? ' 等' : '') + '）', 'info');
  return list;
}

async function findLocationActivity(auto) {
  var targets = await resolveTargets(auto);
  if (!Array.isArray(targets)) {
    return { found: false, needLogin: !!targets.needLogin, reason: targets.error || '拿不到课程清单' };
  }
  if (!targets.length) {
    return { found: false, reason: '没有可监控的课程（设置页可以手填，或确认浏览器已登录学习通）' };
  }
  var cookies = await readAuthCookies();
  var fid = cookies.fid || '';

  var skipped = [];
  var others = [];
  for (var i = 0; i < targets.length; i++) {
    var t = targets[i];
    var url = CXL.buildActiveListUrl({
      fid: t.fid || fid,
      courseId: t.courseId,
      classId: t.classId
    });
    if (!url) continue;
    var r = await fetchJson(url, t.url || '');
    if (!r.ok) { skipped.push(t.courseName + '：请求失败 ' + r.error); continue; }
    if (/passport2\.chaoxing\.com|\/login/i.test(r.url) || /^\s*</.test(r.text || '')) {
      return { needLogin: true, reason: '服务端把请求跳到登录页了（浏览器当前没登录学习通）' };
    }
    var json = null;
    try { json = JSON.parse(r.text); } catch (e) { json = null; }
    if (!json) { skipped.push(t.courseName + '：返回不是 JSON'); continue; }

    var acts = CXL.extractActivities(json);
    var running = acts.filter(function (a) { return a.status === 1; });
    if (!running.length) { skipped.push(t.courseName + '：没有进行中的活动'); continue; }

    running.sort(function (a, b) {
      var ta = Number(a.startTime) || 0, tb = Number(b.startTime) || 0;
      if (ta !== tb) return tb - ta;
      return Number(b.id) - Number(a.id);
    });

    for (var k = 0; k < running.length; k++) {
      var a = running[k];
      var kind = CXL.detectSignKind(a);
      if (kind.key === 'location') {
        return {
          found: true,
          activeId: a.id,
          activeName: a.name,
          kind: kind,
          courseName: t.courseName || '',
          courseId: t.courseId,
          classId: t.classId,
          fid: t.fid || fid,
          uid: cookies.uid || ''
        };
      }
      // 非位置签到：记下来，让上层写一条"检测到了但不处理"的日志
      others.push({ courseName: t.courseName || '', activeName: a.name || a.id, kind: kind });
      skipped.push((t.courseName || '课程') + '「' + (a.name || a.id) + '」是' + kind.label + '签到');
    }
  }
  return {
    found: false,
    others: others,
    reason: skipped.length ? skipped.join('；') : '没有可签的位置签到'
  };
}

// ---------------------------------------------------------------------------
// 提交（只此一种：位置签到）
// ---------------------------------------------------------------------------

async function submitLocation(ctx, lat, lon, address) {
  var cookies = await readAuthCookies();
  var uid = ctx.uid || cookies.uid || '';
  var fid = ctx.fid || cookies.fid || '';
  var name = await readName();

  var params = CXL.encodeSignParams(CXL.buildSignParams({
    activeId: ctx.activeId,
    uid: uid,
    fid: fid,
    courseId: ctx.courseId || '',
    name: name,
    lat: lat,
    lon: lon,
    datum: 'gcj02',                 // 内部一律用 GCJ-02 计算，提交前不再换算
    address: address || '',
    kind: 'location',
    appType: '15',
    ifTiJiao: '1'
  }));

  var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
  var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, SUBMIT_TIMEOUT_MS) : null;
  var text = '';
  var status = 0;
  try {
    var res = await fetch(SIGN_ENDPOINT, {
      method: 'POST',
      credentials: 'include',
      headers: {
        Accept: '*/*',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params,
      redirect: 'follow',
      signal: ctrl ? ctrl.signal : undefined
    });
    status = res.status;
    text = (await res.text() || '').trim();
    if (timer) clearTimeout(timer);
  } catch (e) {
    if (timer) clearTimeout(timer);
    return { cls: { ok: false, kind: 'other', message: '请求失败：' + ((e && e.message) || e) }, lat: lat, lon: lon };
  }
  return { cls: CXL.classifySignResponse(text, status), lat: lat, lon: lon, raw: text };
}

// ---------------------------------------------------------------------------
// 一次"处理一个位置签到"：测量 -> 定位 -> 逼近 -> 成功
// ---------------------------------------------------------------------------

async function workOnActivity(auto, found, basePoint) {
  var ctx = {
    activeId: found.activeId,
    activeName: found.activeName,
    courseName: found.courseName,
    courseId: found.courseId,
    classId: found.classId,
    fid: found.fid,
    uid: found.uid
  };
  var address = (basePoint && basePoint.address) || (await readAddress());
  var cur = { lat: Number(basePoint.lat), lon: Number(basePoint.lon) };
  if (!isFinite(cur.lat) || !isFinite(cur.lon)) {
    return { ok: false, reason: '没有可用选点（先去面板上选一个大概位置）' };
  }

  var obs = [];                       // 测量历史：{lat, lon, meters}
  var tried = {};                     // 试过的点，避免原地重复提交
  var bestGap = null;                 // 目前最小的"还差多少米"
  var maxRounds = Math.max(1, Math.min(30, Number(auto.maxRounds) || CXL.AUTO_DEFAULTS.maxRounds));

  for (var round = 1; round <= maxRounds; round++) {
    var key = cur.lat.toFixed(6) + ',' + cur.lon.toFixed(6);
    if (tried[key]) {
      // 这个点试过了：按策略换一个点
      var plan0 = CXL.planProbe(obs, { maxProbeMeters: auto.maxProbeMeters, goodEnoughMeters: auto.goodEnoughMeters, usedDegs: [] });
      if (!plan0 || !plan0.center) break;
      cur = plan0.center;
      key = cur.lat.toFixed(6) + ',' + cur.lon.toFixed(6);
      if (tried[key]) break;
    }
    tried[key] = true;

    await patchState({
      current: {
        activeId: ctx.activeId,
        activeName: ctx.activeName,
        courseName: ctx.courseName,
        kind: 'location',
        courseId: ctx.courseId,
        classId: ctx.classId
      },
      progress: {
        round: round,
        meters: bestGap,
        point: { lat: cur.lat, lon: cur.lon },
        solution: CXL.solveTrilateration(obs, {}),
        note: '第 ' + round + ' 次提交 (' + cur.lat.toFixed(6) + ', ' + cur.lon.toFixed(6) + ')'
      }
    });

    var r = await submitLocation(ctx, cur.lat, cur.lon, address);
    var cls = r.cls;

    if (cls.ok) {
      await log('✅ 签到成功：' + (ctx.courseName || '') + '「' + (ctx.activeName || ctx.activeId) + '」，' +
        '第 ' + round + ' 次提交，坐标 ' + cur.lat.toFixed(6) + ', ' + cur.lon.toFixed(6), 'ok');
      return { ok: true, rounds: round, point: cur, solution: CXL.solveTrilateration(obs, {}) };
    }
    if (cls.kind === 'already') {
      await log('这个签到已经签过了（' + (ctx.activeName || ctx.activeId) + '），不再重复提交。', 'ok');
      return { ok: true, already: true };
    }
    if (cls.kind === 'tooFar' && cls.meters !== null) {
      obs.push({ lat: cur.lat, lon: cur.lon, meters: cls.meters });
      if (bestGap === null || cls.meters < bestGap) bestGap = cls.meters;
      var sol = CXL.solveTrilateration(obs, {});
      await log('第 ' + round + ' 次提交：离签到地点还差 ' + CXL.formatDistance(cls.meters) +
        (sol ? '；已算出的签到点约 ' + sol.lat.toFixed(6) + ', ' + sol.lon.toFixed(6) +
          '（残差 ' + Math.round(sol.residual) + ' m，用了 ' + sol.used + ' 条测量）' : ''), 'warn');

      // 已经在范围边上、却还是被拒：继续挪意义不大（多半不是距离问题），
      // 停手交给用户，别把服务端刷爆。
      var alreadyInside = (sol && sol.residual < 3 &&
        (cls.meters <= 1 || (cls.range && cls.meters <= cls.range)));
      if (alreadyInside) {
        await log('服务端说只差 ' + CXL.formatDistance(cls.meters) +
          (cls.range ? '（允许范围 ' + CXL.formatDistance(cls.range) + '）' : '') +
          ' 却仍然拒绝，看起来不是距离问题（可能老师把范围设得极小、或加了设备/网络校验），停止自动重试。', 'err');
        return { ok: false, reason: '距离已经不是主要原因：' + cls.message };
      }

      var plan = CXL.planProbe(obs, {
        maxProbeMeters: auto.maxProbeMeters,
        goodEnoughMeters: auto.goodEnoughMeters,
        usedDegs: []
      });
      if (!plan || !plan.center) {
        await log('测量数据不足以继续定位，停止重试。', 'err');
        return { ok: false, reason: '定位失败：' + CXL.explainSignResult(cls) };
      }
      cur = plan.center;
      await log('下一步：' + plan.why, 'info');
      continue;
    }

    // 其它失败：不是位置问题，一次就停（这也是"别的签到我判断之后不管"的地方）
    var why = CXL.explainSignResult(cls);
    await log('停止处理「' + (ctx.activeName || ctx.activeId) + '」：' + why, 'err');
    return { ok: false, reason: why, kind: cls.kind };
  }

  await log('已经提交 ' + maxRounds + ' 次仍未签上（最小差距 ' +
    (bestGap === null ? '未知' : CXL.formatDistance(bestGap)) + '），本次放弃。', 'err');
  return { ok: false, reason: '超过最大重试次数' };
}

/** 识别出非位置签到时的处理：记一笔，然后什么都不做 */
async function noteNonLocation(found) {
  var kind = found.kind || { label: '未知' };
  var head = '检测到「' + (found.courseName || '') + ' ' + (found.activeName || '') + '」是' + kind.label + '签到';
  if (!kind.needsLocation && !kind.needsPhoto && !kind.needsFace) {
    await log(head + ' —— 按你的要求，非位置签到不自动处理，请自行判断是否要签。', 'warn');
  } else {
    await log(head + '（' + CXL.describeNeeds(kind) + '），不做自动处理。', 'warn');
  }
}

// ---------------------------------------------------------------------------
// 主循环：alarms 驱动
// ---------------------------------------------------------------------------

var tickRunning = false;

/**
 * 包一层 alarms API。
 * 注意：chrome.alarms.create / clear 在 Chrome 116 之前**没有** Promise 返回值
 * （manifest 的最低版本是 111），所以这里一律用回调式，别 await 它们的返回值。
 */
function alarmsCreate(name, info) {
  return new Promise(function (resolve) {
    try {
      chrome.alarms.create(name, info, function () {
        void chrome.runtime.lastError;
        resolve(true);
      });
    } catch (e) { resolve(false); }
  });
}

function alarmsClear(name) {
  return new Promise(function (resolve) {
    try {
      chrome.alarms.clear(name, function (wasCleared) {
        void chrome.runtime.lastError;
        resolve(!!wasCleared);
      });
    } catch (e) { resolve(false); }
  });
}

async function scheduleNext(auto, delayMs) {
  var when = Date.now() + Math.max(1000, delayMs || auto.intervalMs || 20000);
  // 时段内：一次性 alarm，自己续排（Chrome 的周期 alarm 最短 30 秒，跟不上 20 秒的节奏）
  await alarmsCreate(ALARM_POLL, { when: when });
  return when;
}

async function clearSchedule() {
  await alarmsClear(ALARM_POLL);
}

/**
 * 时段外：排一条指向"下一次开门"的 alarm。
 *
 * 为什么要专门做这一步：MV3 的 service worker 空闲几十秒就会被回收，
 * 定时器也随之消失。如果时段外什么都不排，第二天到点根本没人叫醒它 ——
 * 看起来就像"自动签到昨天能跑今天不跑了"。所以时段外也要留一条 alarm，
 * 而且它自己有周期（每 30 分钟）兜底，跨日期/改系统时间都不会漏。
 */
var ALARM_MIN_MINUTES = 1;         // Chrome 允许的最小分钟数
var ALARM_MAX_MINUTES = 720;       // 12 小时：留得更长没意义，周期兜底会接上

async function scheduleWake(auto, sch, now) {
  var at = now || new Date();
  var startMin = CXL.parseClock(auto.startTime || '08:00');
  if (startMin === null) startMin = 8 * 60;

  // 从今天往后最多找 8 天：找到第一个"星期匹配、且该时刻还没过"的开门时刻
  var best = null;
  for (var d = 0; d < 8 && !best; d++) {
    var cand = new Date(at.getTime());
    cand.setDate(cand.getDate() + d);
    cand.setHours(Math.floor((startMin % 1440) / 60), startMin % 60, 0, 0);
    if (cand.getTime() <= at.getTime() + 30 * 1000) continue;      // 已经过了（留 30 秒余量）
    if (!CXL.isActiveWeekday(cand, auto.weekdays)) continue;
    best = cand;
  }
  if (!best) return null;

  var minutes = (best.getTime() - at.getTime()) / 60000;
  // 太远就先排一条 30 分钟后的兜底，等接近了再排准确的
  if (minutes > ALARM_MAX_MINUTES) minutes = 30;
  minutes = Math.max(ALARM_MIN_MINUTES, Math.round(minutes * 10) / 10);
  await alarmsCreate(ALARM_POLL, { delayInMinutes: minutes, periodInMinutes: 30 });
  return Date.now() + minutes * 60000;
}

async function tick(reason) {
  if (tickRunning) return;
  tickRunning = true;
  var source = reason || 'alarm-poll';
  try {
    var auto = await readAuto();
    var now = new Date();
    var sch = CXL.checkSchedule(now, auto);
    var state = await readState();
    var tk = todayKey(now);

    // 跨天：清掉当天的计数
    var stats = state.stats || { polls: 0, submitted: 0, success: 0 };
    if (state.today !== tk) stats = { polls: 0, submitted: 0, success: 0 };

    // 手动触发时无视时段（用户点了"立刻跑一轮"就一定得动）
    if (forceRun && !sch.active) {
      sch.active = true;
      sch.inWindow = true;
      sch.phase = 'in';
      sch.reason = '手动触发（临时放行时段）';
    }

    if (!auto.enabled && !forceRun) {
      await patchState({ enabled: false, phase: 'off', status: '未启用', today: tk, stats: stats });
      await clearSchedule();
      return;
    }
    if (!sch.active && !sch.awaiting) {
      await patchState({
        enabled: !!auto.enabled, phase: sch.phase, status: sch.reason, today: tk, stats: stats,
        looking: false, nextAt: null
      });
      // 时段外不排"每 20 秒"的轮询，但必须留一条定时器指向下一个开门时刻：
      // MV3 的 service worker 会被回收，没有 alarm 就再也没人来叫醒它。
      var wake = await scheduleWake(auto, sch, now);
      await patchState({ nextAt: wake });
      return;
    }

    // ---- 今天的"开工"判断：每门课只开工一次（除了收尾阶段）----
    var work = (await readStore([WORK_KEY]))[WORK_KEY] || {};
    var sameDay = work.day === tk;

    if (sch.inWindow) {
      if (!sameDay) work = { day: tk, startedAt: Date.now(), done: {} };
      else if (!work.startedAt) work.startedAt = Date.now();
    } else if (!sameDay) {
      // 时段已过：今天没开工，就等明天
      await patchState({ enabled: true, phase: sch.phase, status: sch.reason, today: tk, stats: stats });
      await clearSchedule();
      return;
    }

    // 连续找太久就放弃
    if (work.startedAt && Date.now() - work.startedAt > MAX_HOURS * 3600 * 1000) {
      await patchState({
        enabled: true, phase: 'post', looking: false, today: tk, stats: stats,
        status: '这门课已经连续找了 ' + MAX_HOURS + ' 小时，先停下'
      });
      await log('连续找了 ' + MAX_HOURS + ' 小时还没签上，先停下（多半今天的签到不在自动识别的课程里）。', 'err');
      await clearSchedule();
      return;
    }

    // ---- 查一次活动 ----
    stats.polls = (stats.polls || 0) + 1;
    await patchState({
      enabled: true,
      phase: sch.inWindow ? 'in' : 'post',
      status: '正在查询课程活动…',
      looking: true,
      source: source,
      today: tk,
      stats: stats,
      lastLookupAt: Date.now()
    });

    var found = await findLocationActivity(auto);

    if (found.needLogin) {
      await patchState({ looking: false, lastError: found.reason, status: '需要重新登录学习通' });
      await log('⚠ ' + found.reason + '。自动签到暂停到下一个时段。', 'err');
      await clearSchedule();
      return;
    }

    if (!found.found) {
      // ---- 只报告，不处理：识别出来是别的签到类型，按"别的签到我判断之后不管"的原则 ----
      var others = found.others || [];
      if (others.length) {
        var seenKey = others.map(function (o) { return o.courseName + '|' + o.activeName + '|' + o.kind.label; }).join(';');
        if (state.lastOthers !== seenKey) {
          for (var oi = 0; oi < others.length; oi++) await noteNonLocation(others[oi]);
        }
        await patchState({
          looking: false,
          lastError: '',
          lastOthers: seenKey,
          status: '当前只有非位置签到（' + others.map(function (o) { return o.kind.label; }).join('/') +
            '），按设置不自动处理'
        });
      } else {
        await patchState({
          looking: false,
          lastError: '',
          status: '没找到进行中的位置签到（' + (sch.inWindow ? '时段内会继续查' : '收尾') + '）'
        });
      }
      var next = await scheduleNext(auto, auto.intervalMs);
      await patchState({ nextAt: next });
      return;
    }

    // ---- 找到了位置签到 ----
    var basePoint = (await readStore(['point'])).point;
    if (!basePoint) {
      await patchState({
        looking: false,
        status: '找到位置签到「' + (found.activeName || '') + '」，但没有选点',
        lastError: '没有选点'
      });
      await log('找到位置签到「' + (found.activeName || '') + '」，但还没有选点：请先在面板上选一个大概位置。', 'err');
      await clearSchedule();
      return;
    }

    await log('发现位置签到：' + (found.courseName || '') + '「' + (found.activeName || found.activeId) +
      '」（activeId=' + found.activeId + '），开始提交。', 'info');

    var result = await workOnActivity(auto, found, basePoint);

    stats.submitted = (stats.submitted || 0) + (result.rounds || 1);
    if (result.ok) {
      stats.success = (stats.success || 0) + 1;
      if (!work.done) work.done = {};
      work.done[found.activeId] = true;
      await patchState({
        enabled: true,
        phase: sch.inWindow ? 'in' : 'post',
        looking: false,
        status: '已签到：' + (found.courseName || '') + '「' + (found.activeName || '') + '」',
        stats: stats,
        lastError: '',
        progress: { round: result.rounds || 1, solution: result.solution || null, note: '成功' }
      });
      if (auto.stopAfterSuccess) {
        await clearSchedule();
      } else {
        var nx = await scheduleNext(auto, auto.intervalMs);
        await patchState({ nextAt: nx });
      }
    } else {
      await patchState({
        looking: false,
        stats: stats,
        lastError: result.reason || '',
        status: '这次没签上：' + (result.reason || '未知原因')
      });
      var nextB = await scheduleNext(auto, auto.intervalMs);
      await patchState({ nextAt: nextB });
    }

    var map = {};
    map[WORK_KEY] = work;
    await writeStore(map);
  } catch (e) {
    try { console.error('[自动签到] tick 出错', e); } catch (err) { /* ignore */ }
    await log('自动签到内部出错：' + ((e && e.message) || e), 'err');
  } finally {
    tickRunning = false;
    // 让 service worker 多活一会儿，别在请求发到一半时被回收
    try { if (self.__cxlKeepAliveTimer) clearTimeout(self.__cxlKeepAliveTimer); } catch (e) { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

/**
 * 用户点"立刻开始"：无视时段跑一轮（仍然只处理位置签到）。
 * 时段判断在 tick 里是硬约束，用户显式点了就临时放行 —— 否则点下去什么都不发生，
 * 看起来像扩展坏了。做法：临时改一个内存标记，tick 认它。
 */
var forceRun = false;
async function runNow() {
  await log('手动触发一次自动签到（只处理位置签到）。', 'info');
  forceRun = true;
  try {
    await tick('manual');
  } finally {
    forceRun = false;
  }
  return { ok: true };
}

/** 记录课程/班级：内容脚本每次打开页面都会报一次，后台据此找活动 */
async function registerTarget(target) {
  if (!target || !target.courseId || !target.classId) return { ok: false };
  var res = await readStore([CXL.AUTO_KEYS.autoTargets]);
  var list = (res[CXL.AUTO_KEYS.autoTargets] || []).slice();
  var idx = -1;
  for (var i = 0; i < list.length; i++) {
    if (String(list[i].courseId) === String(target.courseId) &&
        String(list[i].classId) === String(target.classId)) { idx = i; break; }
  }
  var entry = {
    courseId: String(target.courseId),
    classId: String(target.classId),
    fid: String(target.fid || ''),
    courseName: String(target.courseName || ''),
    url: String(target.url || ''),
    at: Date.now()
  };
  if (idx >= 0) list[idx] = Object.assign({}, list[idx], entry);
  else list.push(entry);
  if (list.length > 10) list = list.slice(-10);
  var map = {};
  map[CXL.AUTO_KEYS.autoTargets] = list;
  await writeStore(map);
  return { ok: true, count: list.length };
}

/** 清掉当天的开工标记（用户手动重置用） */
async function resetToday() {
  var map = {};
  map[WORK_KEY] = {};
  await writeStore(map);
  await patchState({ today: todayKey(), status: '已重置今天的自动签到记录', progress: null });
  return { ok: true };
}

/** 排定时器（boot / 配置变更 / 到点切换都走这里） */
async function reschedule() {
  var now = new Date();
  await alarmsCreate(ALARM_BOOT, { delayInMinutes: 1, periodInMinutes: 1 });
  var auto = await readAuto();
  var sch = CXL.checkSchedule(now, auto);
  if (auto.enabled && sch.active) {
    var next = await scheduleNext(auto, 1500);
    await patchState({ nextAt: next });
  } else {
    // 时段外也留一条"到点叫醒"的 alarm，否则 service worker 被回收后永远醒不过来
    var wake = await scheduleWake(auto, sch, now);
    await patchState({ nextAt: wake });
  }
  return sch;
}

var api = {
  tick: tick,
  runNow: runNow,
  registerTarget: registerTarget,
  resetToday: resetToday,
  reschedule: reschedule,
  log: log,
  readAuto: readAuto
};

if (typeof self.CXLAutoRunner === 'undefined') self.CXLAutoRunner = api;
if (typeof module !== 'undefined' && module.exports) module.exports = api;

// ---------------------------------------------------------------------------
// 事件接线（在扩展里运行时才有 chrome.alarms）
// ---------------------------------------------------------------------------

if (typeof chrome !== 'undefined' && chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener(function (alarm) {
    if (!alarm) return;
    if (alarm.name === ALARM_POLL) tick('alarm-poll');
    else if (alarm.name === ALARM_BOOT) tick('alarm-boot');
  });
}

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onInstalled) {
  chrome.runtime.onInstalled.addListener(function () { reschedule(); });
}
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(function () { reschedule(); });
}
