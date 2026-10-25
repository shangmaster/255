/*
 * 联网联调：用真实登录态把「课表 -> 活动列表 -> 类型判定」整条链跑一遍。
 * 关键：这里**不会提交任何签到请求**，只看"能不能找到进行中的位置签到"。
 *
 * 用法：
 *   node tools/live-check.mjs                          # 只做接口连通性检查（不需要登录）
 *   node tools/live-check.mjs --cookie "k=v; k2=v2"     # 带登录态做真实查询
 *   node tools/live-check.mjs --cookie-file path/to/cookies.json
 *
 * lib.js 用的是扩展里同一份实现，所以这里跑通 = 扩展里也跑得通。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'extension', 'src');

// ---- 加载 lib.js（不复制逻辑，跑的就是扩展要用的那份）----
const libSource = fs.readFileSync(path.join(srcDir, 'lib.js'), 'utf8');
const sandbox = {
  chrome: { storage: { local: { get() {}, set() {} } }, onChanged: { addListener() {} } },
  Math, JSON, Object, Array, String, Number, Boolean, Error, RegExp, Date, Promise, Map, Set,
  parseInt, parseFloat, isFinite, isNaN, encodeURIComponent
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(libSource, sandbox);
const CXL = sandbox.CXL;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function readCookieArg() {
  const i = process.argv.indexOf('--cookie');
  if (i > 0) return process.argv[i + 1] || '';
  const j = process.argv.indexOf('--cookie-file');
  if (j > 0) {
    const p = process.argv[j + 1];
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      const obj = raw.cookies || raw;
      return Object.entries(obj).map(([k, v]) => k + '=' + v).join('; ');
    } catch (e) {
      console.log('读 cookie 文件失败：' + e.message);
    }
  }
  return '';
}

const COOKIE = readCookieArg();

async function get(url, referer) {
  const headers = { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' };
  if (COOKIE) headers.Cookie = COOKIE;
  if (referer) headers.Referer = referer;
  const res = await fetch(url, { headers, redirect: 'follow' });
  const text = await res.text();
  return { status: res.status, text, finalUrl: res.url || '' };
}

/**
 * 未登录时学习通**照样回 200**，只是正文是登录页。
 * 只看状态码会把"已失效"当"可用"，所以这里必须看正文。
 */
function looksLikeLogin(text, finalUrl) {
  if (/passport2\/|\/login/i.test(finalUrl || '')) return true;
  const head = (text || '').slice(0, 3000);
  return /用户登录|passport2-static|id="loginPhone"/.test(head);
}

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  →  ' + extra : '')); }
}
function section(t) { console.log('\n' + t); }

(async () => {
  console.log('登录态：' + (COOKIE ? '已提供（' + COOKIE.length + ' 字符）' : '未提供'));

  section('1) 签到接口可达性');
  try {
    const r = await get('https://mobilelearn.chaoxing.com/pptSign/stuSignajax?activeId=1');
    ok('签到接口有响应', r.status > 0, 'HTTP ' + r.status);
    console.log('    响应：' + JSON.stringify((r.text || '').slice(0, 120)));
  } catch (e) {
    ok('签到接口有响应', false, String(e));
  }

  section('2) 课表接口（决定"能否不打开课程页面就自动签到"）');
  const listUrl = CXL.buildCourseListUrl();
  console.log('    地址：' + listUrl);
  let courses = [];
  try {
    const r = await get(listUrl, 'https://mooc2-ans.chaoxing.com/');
    if (!COOKIE) {
      ok('未带登录态（加 --cookie 做真实解析）', true);
      console.log('    响应：' + JSON.stringify((r.text || '').slice(0, 160)));
    } else if (looksLikeLogin(r.text, r.finalUrl)) {
      ok('登录态有效', false, '服务端返回登录页 —— cookie 已失效或缺 JSESSIONID');
    } else {
      let json = null;
      try { json = JSON.parse(r.text); } catch { json = null; }
      ok('课表返回 JSON', !!json, (r.text || '').slice(0, 160));
      if (json) {
        ok('不是"请重新登录"', Number(json.result) !== 0, CXL.lookupErrorMessage(json) || '');
        courses = CXL.extractCourses(json);
        ok('解析出的课程字段完整',
          courses.length > 0 && courses.every((c) => /^\d{5,}$/.test(c.courseId) && /^\d{3,}$/.test(c.classId)),
          JSON.stringify(courses.slice(0, 3)));
        console.log('    课程数：' + courses.length);
        courses.slice(0, 12).forEach((c) =>
          console.log(`      - ${c.name || '(未命名)'}   courseId=${c.courseId} classId=${c.classId}`));
      }
    }
  } catch (e) {
    ok('课表接口有响应', false, String(e));
  }

  section('3) 活动列表 + 签到类型判定');
  if (!COOKIE || !courses.length) {
    ok('跳过（需要有效登录态 + 至少一门课）', true);
  } else {
    let anyRunning = 0;
    for (const c of courses.slice(0, 8)) {
      const url = CXL.buildActiveListUrl({ fid: c.fid, courseId: c.courseId, classId: c.classId });
      try {
        const r = await get(url, 'https://mooc2-ans.chaoxing.com/');
        if (looksLikeLogin(r.text, r.finalUrl)) {
          ok(c.name + '：登录态有效', false, '返回登录页');
          continue;
        }
        const json = JSON.parse(r.text);
        const acts = CXL.extractActivities(json);
        const running = acts.filter((a) => a.status === 1);
        anyRunning += running.length;
        console.log(`    ${c.name || c.courseId}：活动 ${acts.length} 个 / 进行中 ${running.length} 个`);
        running.forEach((a) => {
          const k = CXL.detectSignKind(a);
          console.log(`      ·「${a.name || a.id}」→ ${k.label}（${CXL.describeEvidence(k)}）`);
        });
        ok(c.name + '：活动列表可解析', true);
      } catch (e) {
        ok(c.name + '：活动列表可解析', false, String(e));
      }
    }
    console.log('\n    进行中的活动共 ' + anyRunning + ' 个' +
      (anyRunning ? '（上面列了各自的类型）' : '（现在没有签到在跑，等老师发）'));
  }

  section('结果');
  console.log(`${pass} 通过，${fail} 失败`);
  if (!COOKIE) {
    console.log('\n提示：加 --cookie "k=v; k2=v2" 或 --cookie-file cookies.json 可做真实查询。');
  }
  process.exit(fail ? 1 : 0);
})();
