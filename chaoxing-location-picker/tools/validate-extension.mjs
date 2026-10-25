/*
 * 结构检查：模拟 Chrome 加载扩展时的校验（不依赖浏览器）。
 * 运行：node tools/validate-extension.mjs
 *
 * 仓库里有两个扩展，本脚本对它们各跑一遍：
 *   extension/             自由选点签到（位置 + 拍照）
 *   photo-sign-extension/  只做拍照签到的精简版
 *
 * 检查项：
 *   1) manifest.json 是否合法、引用的文件是否都存在、图标尺寸是否匹配声明
 *   2) content_scripts / web_accessible_resources 是否配齐、关键字段是否正确
 *   3) HTML 里引用的资源是否存在、id 与 JS 里的引用是否一一对应
 *   4) 所有 JS 文件语法是否正确、同一作用域有没有重复函数声明
 *   5) 每个 JS 文件里出现的 chrome.* API 是否在 manifest 中声明了对应权限
 *   6) 关键常量/接口两端是否一致（可选，按扩展类型给不同清单）
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

let pass = 0;
let fail = 0;
const problems = [];

function ok(name) {
  pass++;
  console.log('  ✓ ' + name);
}
function bad(name, detail) {
  fail++;
  problems.push(name + (detail ? '  →  ' + detail : ''));
  console.log('  ✗ ' + name + (detail ? '  →  ' + detail : ''));
}
function section(t) {
  console.log('\n' + t);
}

// ---------------------------------------------------------------------------
// 单个扩展的检查
// ---------------------------------------------------------------------------

/**
 * @param {string} relDir      相对仓库根的扩展目录
 * @param {object} expected    该扩展特有的期望值：
 *        - scripts:  必须被 content_scripts 注入的脚本
 *        - optional: 允许出现在目录里、但不做接线检查的脚本
 *        - pages:    [html, js] 要互相对照 id 的页面
 *        - needs:    必须声明的权限
 *        - strings:  必须在某些文件里同时出现的字符串（跨文件一致性）
 */
function validateExtension(relDir, expected) {
  const extDir = path.join(root, relDir);
  const read = (p) => fs.readFileSync(path.join(extDir, p), 'utf8');
  const exists = (p) => fs.existsSync(path.join(extDir, p));

  section('【' + relDir + '】1) manifest.json');

  let manifest;
  try {
    manifest = JSON.parse(read('manifest.json'));
    ok('manifest.json 是合法 JSON');
  } catch (e) {
    bad('manifest.json 解析失败', e.message);
    return;
  }

  ok('manifest_version = 3', manifest.manifest_version === 3);
  ok('有 name / version / description', !!(manifest.name && manifest.version && manifest.description));
  ok('version 格式合法', /^\d+(\.\d+){0,3}$/.test(manifest.version), manifest.version);

  const refs = [];
  if (manifest.background && manifest.background.service_worker) refs.push(manifest.background.service_worker);
  if (manifest.action && manifest.action.default_popup) refs.push(manifest.action.default_popup);
  if (manifest.options_ui && manifest.options_ui.page) refs.push(manifest.options_ui.page);
  for (const v of Object.values(manifest.icons || {})) refs.push(v);
  for (const v of Object.values((manifest.action && manifest.action.default_icon) || {})) refs.push(v);
  for (const r of refs) {
    if (exists(r)) ok('存在：' + r);
    else bad('manifest 引用的文件不存在：' + r);
  }

  const pngSize = (file) => {
    const buf = fs.readFileSync(path.join(extDir, file));
    if (buf.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  };
  for (const [declared, file] of Object.entries(manifest.icons || {})) {
    const dim = pngSize(file);
    if (!dim) bad('图标不是合法 PNG：' + file);
    else if (String(dim.w) !== String(declared) || String(dim.h) !== String(declared)) {
      bad(`图标 ${file} 实际 ${dim.w}x${dim.h}，与声明的 ${declared} 不符`);
    } else ok(`图标 ${file} 尺寸 = ${declared}`);
  }

  // ---- content_scripts ----
  section('【' + relDir + '】2) content_scripts 与权限');

  const cs = manifest.content_scripts || [];
  ok('声明了 content_scripts（否则装好扩展后页面里什么都不会发生）', cs.length > 0);
  const csFiles = cs.flatMap((c) => c.js || []);
  for (const f of expected.scripts) {
    if (csFiles.includes(f)) ok('content_scripts 包含 ' + f);
    else bad('content_scripts 缺少 ' + f + '（该文件不会被自动注入）');
  }

  const uiEntry = cs.find((c) => (c.js || []).includes(expected.scripts[expected.scripts.length - 1]));
  if (!uiEntry) bad('找不到注入界面脚本的 content_scripts 条目');
  else {
    ok('UI 脚本注入所有 frame（签到界面常被套在 iframe 里）', uiEntry.all_frames === true);
    ok('UI 脚本匹配 about:blank 子框架', uiEntry.match_about_blank === true);
    ok('UI 脚本匹配 blob:/data: 子框架', uiEntry.match_origin_as_fallback === true);
  }

  ok('minimum_chrome_version >= 111', parseInt(manifest.minimum_chrome_version, 10) >= 111,
    manifest.minimum_chrome_version);

  const war = [];
  for (const entry of manifest.web_accessible_resources || []) {
    for (const r of entry.resources || []) war.push(r);
  }
  for (const f of war) {
    if (exists(f)) ok('web_accessible_resources 文件存在：' + f);
    else bad('web_accessible_resources 指向不存在的文件：' + f);
  }

  // ---- chrome.* 与权限 ----
  const jsFiles = fs.readdirSync(path.join(extDir, 'src'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => 'src/' + f);

  const apiPermission = {
    'chrome.storage': 'storage',
    'chrome.scripting': 'scripting',
    'chrome.cookies': 'cookies',
    'chrome.alarms': 'alarms',
    'chrome.tabs': null,          // 读 url 需要 host 权限或 activeTab
    'chrome.runtime': null        // 始终可用
  };
  const declaredPerms = new Set(manifest.permissions || []);
  for (const p of expected.needs) {
    if (declaredPerms.has(p)) ok('声明了 ' + p + ' 权限');
    else bad('缺少 ' + p + ' 权限');
  }
  ok('声明了 chaoxing 域名的 host_permissions',
    (manifest.host_permissions || []).some((h) => h.includes('chaoxing.com')));

  for (const f of jsFiles) {
    const code = read(f);
    for (const [api, perm] of Object.entries(apiPermission)) {
      if (!code.includes(api)) continue;
      if (perm && !declaredPerms.has(perm)) bad(`${f} 使用了 ${api}，但 manifest 未声明 "${perm}" 权限`);
      else ok(`${f} 使用 ${api}（权限已声明）`);
    }
  }

  // ---- HTML / JS 接线 ----
  section('【' + relDir + '】3) HTML 资源引用与 id 对应关系');

  const htmlIds = (html) => new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const jsIdRefs = (code) => {
    const ids = new Set();
    for (const m of code.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)) ids.add(m[1]);
    for (const m of code.matchAll(/\$\(\s*['"]([^'"]+)['"]\s*\)/g)) ids.add(m[1]);
    return ids;
  };

  for (const [html, js] of expected.pages) {
    const htmlText = read(html);
    const ids = htmlIds(htmlText);
    const refs = jsIdRefs(read(js));

    for (const m of htmlText.matchAll(/<script src="([^"]+)"/g)) {
      if (exists(path.join(path.dirname(html), m[1]))) ok(`${html} 引用 ${m[1]} 存在`);
      else bad(`${html} 引用的 ${m[1]} 不存在`);
    }
    for (const id of refs) {
      if (ids.has(id)) ok(`${js} 里的 #${id} 在 ${html} 中存在`);
      else bad(`${js} 引用了 ${html} 里不存在的 id：#${id}`);
    }
    const unused = [...ids].filter((id) => !refs.has(id));
    if (unused.length) console.log('  · 提示：' + html + ' 中未被 JS 引用的 id：' + unused.join(', '));
  }

  // ---- 语法 & 重复声明 ----
  section('【' + relDir + '】4) JS 语法与重复函数声明');

  for (const f of jsFiles) {
    try {
      new vm.Script(read(f), { filename: f });
      ok(f + ' 语法正确');
    } catch (e) {
      bad(f + ' 语法错误：' + e.message);
    }
  }
  for (const f of jsFiles) {
    const lines = read(f).split(/\r?\n/);
    const seen = new Map();
    const dups = [];
    lines.forEach((line, i) => {
      const m = line.match(/^(\s*)function\s+([A-Za-z_$][\w$]*)\s*\(/);
      if (!m) return;
      const key = m[1].length + '|' + m[2];
      if (seen.has(key)) dups.push(`${m[2]}() 第 ${seen.get(key)} 行 与 第 ${i + 1} 行`);
      else seen.set(key, i + 1);
    });
    if (dups.length) bad(f + ' 存在重复函数声明', dups.join('；'));
    else ok(f + ' 无重复函数声明');
  }

  // ---- 跨文件一致性（按扩展类型给清单）----
  if (expected.strings && expected.strings.length) {
    section('【' + relDir + '】5) 关键常量与接口一致性');
    for (const s of expected.strings) {
      const missing = s.files.filter((f) => !read(f).includes(s.text));
      if (!missing.length) ok(s.name);
      else bad(s.name + '：' + missing.join(', ') + ' 里找不到 ' + JSON.stringify(s.text));
    }
  }
}

// ---------------------------------------------------------------------------
// 两个扩展各自的期望
// ---------------------------------------------------------------------------

const SIGN_HOST = 'mobilelearn.chaoxing.com';
const SIGN_PATH = '/pptSign/stuSignajax';
const PAN_HOST = 'pan-yz.chaoxing.com';

validateExtension('extension', {
  scripts: ['src/injected.js', 'src/lib.js', 'src/map.js', 'src/content.js'],
  pages: [['src/popup.html', 'src/popup.js'], ['src/options.html', 'src/options.js']],
  needs: ['storage', 'scripting', 'activeTab', 'cookies', 'alarms'],
  strings: [
    { name: '签到域名一致', files: ['src/lib.js', 'src/background.js'], text: SIGN_HOST },
    { name: '签到路径存在', files: ['src/lib.js'], text: SIGN_PATH },
    { name: '网盘上传域名一致', files: ['src/lib.js'], text: PAN_HOST },
    { name: '消息类型 lookupActiveId 两端都在', files: ['src/lib.js'], text: 'activeId' },
    { name: '拍照提交用极简参数函数', files: ['src/lib.js', 'src/background.js'], text: 'buildPhotoSignParams' },
    // 自动签到：引擎必须被后台加载，且四处的算法是同一个实现
    { name: '后台加载了自动签到共享模块', files: ['src/background.js'], text: "importScripts('lib.js', 'auto.js', 'auto-runner.js')" },
    { name: '自动签到引擎挂在 global 上（后台要用）', files: ['src/auto-runner.js', 'src/background.js'], text: 'CXLAutoRunner' },
    { name: '三点定位算法只有一份（lib 里不重复实现）',
      files: ['src/auto.js'], text: 'CXL.solveTrilateration' },
    { name: '服务端距离文案解析在各处复用', files: ['src/auto.js'], text: 'classifySignResponse' },
    { name: '内容脚本会把课程报给自动签到', files: ['src/content.js', 'src/background.js'], text: 'autoTarget' },
    { name: '设置页加载了 auto.js（时段/星期要能校验）', files: ['src/options.html', 'src/popup.html'], text: 'auto.js' },
    // Chrome 116 之前 alarms.create/clear 没有 Promise 返回值，必须走回调（最低版本是 111）
    { name: 'alarms 用回调式封装（不 await 其返回值）', files: ['src/auto-runner.js'], text: 'function alarmsCreate(' },
    // 自动签到不能要求"先去课程页登记"：课表接口是它独立工作的前提
    { name: 'lib 里有课表接口', files: ['src/lib.js'], text: 'backclazzdata' },
    { name: '引擎会自己拉课表', files: ['src/auto-runner.js'], text: 'resolveTargets' },
    { name: '设置页能拉课表并勾选监控课程', files: ['src/options.js', 'src/background.js'], text: 'autoCourses' }
  ]
});

validateExtension('photo-sign-extension', {
  scripts: ['src/lib.js', 'src/content.js'],
  pages: [['src/popup.html', 'src/popup.js'], ['src/options.html', 'src/options.js']],
  needs: ['storage', 'scripting', 'activeTab', 'cookies'],
  strings: [
    { name: '签到域名一致', files: ['src/lib.js', 'src/background.js'], text: SIGN_HOST },
    { name: '签到路径存在', files: ['src/lib.js'], text: SIGN_PATH },
    { name: '网盘上传域名一致', files: ['src/lib.js'], text: PAN_HOST },
    { name: '拍照提交用极简参数函数', files: ['src/lib.js', 'src/background.js'], text: 'buildPhotoSignParams' },
    { name: '消息类型 photoSign 两端都在', files: ['src/content.js', 'src/background.js'], text: 'photoSign' },
    { name: '消息类型 uploadPhoto 两端都在', files: ['src/content.js', 'src/background.js'], text: 'uploadPhoto' },
    { name: '消息类型 lookupActiveId 两端都在', files: ['src/content.js', 'src/background.js'], text: 'lookupActiveId' }
  ]
});

// ---------------------------------------------------------------------------
// 两个扩展共用的协议代码必须保持一致（复制粘贴最容易漂移的地方）
// ---------------------------------------------------------------------------

section('两个扩展的协议代码一致性');

const libA = fs.readFileSync(path.join(root, 'extension', 'src', 'lib.js'), 'utf8');
const libB = fs.readFileSync(path.join(root, 'photo-sign-extension', 'src', 'lib.js'), 'utf8');

/** 把某个函数体从源码里抠出来做逐字比较 */
function fnBody(src, name) {
  const i = src.indexOf('CXL.' + name + ' = ');
  if (i < 0) return null;
  return src.slice(i, src.indexOf('\n  };', i) + 5);
}

for (const fn of ['buildActiveListUrl', 'extractActivities', 'pickActiveTarget', 'validatePhoto',
  'buildPanTokenUrl', 'buildPanUploadUrl', 'photoFileName', 'pickObjectId',
  'buildPhotoSignParams', 'buildPhotoSignUrl', 'buildPlainSignParams', 'buildPlainSignUrl',
  'encodeSignParams', 'parseExtraParams', 'parseCourseContext',
  'parseCourseContextFromHtml', 'isActiveId', 'lookupErrorMessage', 'detectSignKind']) {
  const a = fnBody(libA, fn);
  const b = fnBody(libB, fn);
  if (!a || !b) bad('两份 lib.js 都应有 ' + fn + '()', (!a ? 'extension 缺' : '') + (!b ? ' photo-sign 缺' : ''));
  else if (a === b) ok(fn + '() 两份实现逐字一致');
  else bad(fn + '() 两份实现不一致（改了一边忘了另一边）');
}

// ---------------------------------------------------------------------------

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
if (problems.length) {
  console.log('\n需要修复：');
  for (const p of problems) console.log('  - ' + p);
}
process.exit(fail ? 1 : 0);
