/*
 * Service worker：三个动作
 *   1) 查课程活动列表，拿到这次拍照签到的 activeId（不用手动填）
 *   2) 把本地图片上传到学习通网盘，换回 objectId
 *   3) 带上 objectId 提交 stuSignajax（极简参数 + GET，与公开可用的实现一致）
 *
 * 全程在后台发起请求：自动带该域名下的登录 Cookie，也不受页面 CORS 限制。
 */
importScripts('lib.js');

var CXL = self.CXL;

var SIGN_HOST = 'https://mobilelearn.chaoxing.com';

/**
 * 把服务端返回的中文提示翻译成人话。
 * 拍照签到常见的那几个错误码都要能看懂，不能只把原文甩给用户。
 */
function explainResponse(text, status) {
  if (text === 'success') return { ok: true, message: '服务端返回 success，签到已提交成功。' };
  if (text === 'success2') {
    return { ok: true, message: '服务端返回 success2：已记录，但提交时间晚于老师设定的截止时间。' };
  }
  if (!text) return { ok: false, message: '服务端返回空内容（HTTP ' + status + '），通常说明登录态失效或签到编号不对。' };
  if (/请先登录|未登录|登录已过期|not login/i.test(text)) {
    return { ok: false, needLogin: true, message: '未登录或登录状态已失效：' + text + '\n请先在浏览器里登录 i.chaoxing.com，再回来重试。' };
  }
  if (/您已签到过了|已签到|重复签到|请勿重复/.test(text)) {
    return { ok: true, already: true, message: '这次签到你已经签过了：' + text };
  }
  if (/photoAuthError/i.test(text)) {
    var code = (text.match(/photoAuthError_?(\w+)/) || [])[1] || '';
    return {
      ok: false,
      photoAuth: true,
      message: '服务端拒绝了这次拍照签到：' + text + '\n' +
        '（' + code + '：拍照签到的服务端校验没通过）\n\n' +
        '最可能的原因：**这次活动根本不是拍照签到**。\n' +
        '给一个"普通签到"塞 objectId，服务端会走进拍照校验分支、发现这个活动\n' +
        '没有拍照上下文，就回这个错。\n' +
        '→ 请改用面板里另一个按钮「按普通签到提交」（不带图片）。\n\n' +
        '如果那个也失败，才考虑：这次活动要求"本机现场拍照"，网页端拿不到凭证。'
    };
  }
  if (/已结束|结束|过期|失效/.test(text)) return { ok: false, message: '签到活动已结束或已过期：' + text };
  if (/validate|校验|参数/.test(text)) {
    return { ok: false, message: '服务端要求额外校验：' + text + '\n（可能是签到已截止，或这次活动不是拍照签到）' };
  }
  return { ok: false, message: '服务端返回：' + text };
}

// ---------- 1) 自动获取 activeId ----------

/** 从 Cookie 里补 fid / uid（页面里读不到 HttpOnly 的 _uid） */
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
    } catch (e) { /* 忽略单个读取失败 */ }
  }
  return out;
}

/** 用当前标签页地址当 Referer，尽量贴近网页自己的请求 */
function pageReferer(tabId) {
  return new Promise(function (resolve) {
    if (tabId == null || !chrome.tabs || !chrome.tabs.get) { resolve(''); return; }
    try {
      chrome.tabs.get(tabId, function (tab) {
        void chrome.runtime.lastError;
        var url = (tab && tab.url) || '';
        resolve(/^https?:\/\/([^/]*\.)?chaoxing\.com/i.test(url) ? url : '');
      });
    } catch (e) { resolve(''); }
  });
}

/**
 * 问服务端"这个课程现在有哪些活动"，挑出进行中的那个。
 * 只认进行中的：老活动的编号拿去提交，服务端只会回一句"已结束"。
 */
async function doLookupActiveId(msg) {
  msg = msg || {};
  var ctx = CXL.parseCourseContext([msg.url, msg.courseId, msg.classId, msg.fid]);
  var courseId = msg.courseId || ctx.courseId || '';
  var classId = msg.classId || ctx.classId || '';
  if (!courseId || !classId) {
    return { ok: false, error: '拿不到课程/班级编号：请在课程页面里打开面板' };
  }

  var cookies = await readAuthCookies();
  var fid = msg.fid || ctx.fid || cookies.fid || '';
  var url = CXL.buildActiveListUrl({ fid: fid, courseId: courseId, classId: classId });
  var referer = await pageReferer(msg.tabId);

  var headers = { Accept: 'application/json, text/plain, */*' };
  if (referer) headers.Referer = referer;

  var res, text = '';
  try {
    res = await fetch(url, { method: 'GET', credentials: 'include', headers: headers });
    text = await res.text();
  } catch (e) {
    return { ok: false, error: '活动列表请求失败：' + (e && e.message ? e.message : String(e)), url: url };
  }

  var body = String(text || '').trim();
  if (/passport2\.chaoxing\.com|\/login/i.test(String(res.url || '')) || /^\s*</.test(body)) {
    return { ok: false, needLogin: true, error: '服务端把请求跳到登录页了：这个浏览器当前没登录学习通。', url: url };
  }

  var json = null;
  try { json = JSON.parse(body); } catch (e) { json = null; }
  if (!json) return { ok: false, error: '活动列表返回的不是 JSON（HTTP ' + res.status + '）。', url: url };
  if (json.result !== undefined && Number(json.result) !== 1) {
    return {
      ok: false,
      error: '服务端没给活动列表：' + (CXL.lookupErrorMessage(json, res.status) || ('result=' + json.result)),
      url: url
    };
  }

  var acts = CXL.extractActivities(json);
  var target = CXL.pickActiveTarget(json, { allowNotStarted: false });
  if (!target) {
    return {
      ok: false,
      error: acts.length
        ? '这个课程现在没有"进行中"的活动（共 ' + acts.length + ' 个）。等老师发布签到后再点一次。'
        : '这个课程暂时没有任何活动记录（老师还没发布过签到，或课程/班级编号不对）。',
      url: url
    };
  }

  // 活动列表里的 otherId/activeType 不足以判断签到类型（实测：一个"二维码签到"，
  // 列表给的是普通，服务端却要二维码的 enc）。所以再查一次活动详情拿 activeSort。
  var detail = null;
  var kind = target.kind;
  try {
    var infoUrl = CXL.buildActiveInfoUrl(target.id);
    var ir = await fetch(infoUrl, {
      method: 'GET',
      credentials: 'include',
      headers: headers
    });
    var itext = (await ir.text()).trim();
    var ijson = null;
    try { ijson = JSON.parse(itext); } catch (e) { ijson = null; }
    if (ijson && (ijson.result === undefined || Number(ijson.result) === 1)) {
      var info = CXL.normalizeActiveInfo(ijson);
      // 详情里的字段更权威：用它重新判一次（名字仍作为兜底证据）
      var merged = {
        activeSort: info.activeSort !== null ? info.activeSort : target.activeSort,
        otherId: info.otherId !== null ? info.otherId : target.otherId,
        ifphoto: info.ifphoto !== null ? info.ifphoto : target.ifphoto,
        openCheckFaceFlag: info.openCheckFaceFlag,
        ifrefreshewm: info.ifrefreshewm,
        name: info.name || target.name
      };
      var byDetail = CXL.detectSignKind(merged);
      // 只有详情确实提供了字段，才采用它的结论；否则保留列表的判定
      if (info.activeSort !== null || info.otherId !== null || info.ifrefreshewm !== null) {
        kind = byDetail;
      }
      detail = info;
    }
  } catch (e) { /* 拿不到详情就沿用列表的判定 */ }

  return {
    ok: true,
    activeId: target.id,
    name: target.name,
    label: target.label,
    kind: kind,
    detail: detail,
    // 把"当前所有进行中的活动"都列出来，面板让用户自己挑
    // （同一门课可能有好几个签到在进行中，自动挑最新的不一定是用户想签的那个）
    candidates: acts
      .filter(function (a) { return a.status === 1; })
      .sort(function (a, b) {
        var ta = Number(a.startTime) || 0;
        var tb = Number(b.startTime) || 0;
        if (ta !== tb) return tb - ta;
        return Number(b.id) - Number(a.id);
      })
      .map(function (a) {
        return {
          id: a.id,
          name: a.name,
          startTime: a.startTime,
          kind: CXL.detectSignKind(a)
        };
      }),
    activityCount: acts.length,
    uid: msg.uid || cookies.uid || '',
    fid: fid,
    url: url
  };
}

// ---------- 2) 上传本地图片换 objectId ----------

/**
 * 图片 -> 学习通网盘 -> objectid。两步（与官方客户端一致）：
 *   1) GET  /api/token/uservalid  拿 _token
 *   2) POST /upload  multipart：puid + _token + file
 */
async function doUploadPhoto(msg) {
  msg = msg || {};
  var dataUrl = String(msg.dataUrl || '');
  var m = dataUrl.match(/^data:(image\/[^;,]*);base64,([\s\S]*)$/);
  if (!m) return { ok: false, error: '图片数据格式不对（需要图片的 dataURL），换一张试试' };

  var type = String(msg.mime || m[1] || 'image/jpeg').toLowerCase();
  var b64 = m[2].replace(/\s+/g, '');
  var bin;
  try {
    bin = atob(b64);
  } catch (e) {
    return { ok: false, error: '图片数据解码失败，换一张试试' };
  }
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  var check = CXL.validatePhoto({ size: bytes.length, type: type, name: msg.name });
  if (!check.ok) return { ok: false, error: check.error };

  var cookies = await readAuthCookies();
  var uid = msg.uid || cookies.uid || '';
  if (!uid) {
    return { ok: false, needLogin: true, error: '读不到账号 uid（浏览器可能没登录学习通），先去 i.chaoxing.com 登录' };
  }

  var token = '';
  try {
    var tr = await fetch(CXL.buildPanTokenUrl(), {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json, text/plain, */*' }
    });
    var ttext = (await tr.text()).trim();
    var tjson = null;
    try { tjson = JSON.parse(ttext); } catch (e) { tjson = null; }
    if (!tjson || tjson.result !== true || !tjson._token) {
      return {
        ok: false,
        needLogin: /passport2|\/login/i.test(String(tr.url || '')),
        error: '拿不到上传令牌：' + ((tjson && (tjson.msg || tjson.errorMsg)) || ttext.slice(0, 120) || ('HTTP ' + tr.status))
      };
    }
    token = String(tjson._token);
  } catch (e) {
    return { ok: false, error: '取上传令牌失败：' + (e && e.message ? e.message : String(e)) };
  }

  try {
    var fd = new FormData();
    fd.append('puid', String(uid));
    fd.append('_token', token);
    var fname = CXL.photoFileName(msg.name, type);
    fd.append('file', new Blob([bytes], { type: type || 'image/jpeg' }), fname);

    var ur = await fetch(CXL.buildPanUploadUrl(), {
      method: 'POST',
      credentials: 'include',
      body: fd,
      headers: { Accept: 'application/json, text/plain, */*' }
    });
    var utext = (await ur.text()).trim();
    var ujson = null;
    try { ujson = JSON.parse(utext); } catch (e) { ujson = null; }
    var objectId = CXL.pickObjectId(ujson);
    if (!objectId) {
      return { ok: false, error: '服务端没有返回 objectid：' + (utext.slice(0, 160) || ('HTTP ' + ur.status)) };
    }
    // 把上传返回的完整字段也带回去：如果服务端在上传这一步就给了签到时需要的凭证，
    // 那网页端这条路就是通的（这是唯一还没排查过的一环）
    return {
      ok: true,
      objectId: objectId,
      size: bytes.length,
      name: fname,
      uid: uid,
      uploadRaw: utext.slice(0, 1200),
      uploadFields: ujson && typeof ujson === 'object' ? Object.keys(ujson) : []
    };
  } catch (e) {
    return { ok: false, error: '上传图片失败：' + (e && e.message ? e.message : String(e)) };
  }
}

// ---------- 3) 提交 ----------

/**
 * 提交签到。两种形状：
 *   kind='photo' → 9 个参数，带 objectId（拍照签到）
 *   kind='plain' → 8 个参数，不带 objectId（普通签到）
 *
 * 为什么要分：活动名叫「普通签到」的那种活动，塞 objectId 进去会被服务端
 * 判成"拍照校验不通过"（photoAuthError_PCR007），因为那活动没有拍照上下文。
 * 反过来，拍照签到不带 objectId 也会失败。先判类型再决定发什么。
 */
async function doSign(msg) {
  var payload = msg.payload || {};
  var kind = payload.kind === 'plain' ? 'plain' : 'photo';
  var url = kind === 'plain'
    ? CXL.buildPlainSignUrl(payload, SIGN_HOST)
    : CXL.buildPhotoSignUrl(payload, SIGN_HOST);

  // 附加参数：给"已经知道某个字段该怎么填"的情况留的口子
  // （例如确认了 photoResult 的形状后，直接在面板里粘进来就能用，不必再改代码）
  var extra = CXL.parseExtraParams(payload.extra);
  if (extra.length) {
    url += '&' + CXL.encodeSignParams(extra);
  }

  if (msg.dryRun) {
    var pairs = kind === 'plain'
      ? CXL.buildPlainSignParams(payload)
      : CXL.buildPhotoSignParams(payload);
    pairs = pairs.concat(extra);
    return {
      ok: true,
      dry: true,
      method: 'GET',
      kind: kind,
      message: '试运行：没有发送任何请求。\n' + (kind === 'plain' ? '普通签到' : '拍照签到') +
        ' 一共 ' + pairs.length + ' 个参数：\n' +
        pairs.map(function (kv) { return '  ' + kv[0] + '=' + kv[1]; }).join('\n'),
      url: url
    };
  }

  try {
    var res = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: '*/*' },
      redirect: 'follow'
    });
    var text = (await res.text()).trim();
    var verdict = explainResponse(text, res.status);
    return {
      ok: verdict.ok,
      already: !!verdict.already,
      photoAuth: !!verdict.photoAuth,
      needLogin: !!verdict.needLogin,
      method: 'GET',
      kind: kind,
      message: verdict.message + '（HTTP ' + res.status + '）',
      raw: text.slice(0, 500),
      url: url
    };
  } catch (e) {
    return { ok: false, method: 'GET', kind: kind, message: '请求失败：' + (e && e.message ? e.message : String(e)), url: url };
  }
}

/** 读当前登录账号的姓名（普通签到的 name 字段通常要带上） */
async function doWhoAmI() {
  try {
    var res = await fetch('https://passport2.chaoxing.com/mooc/accountManage', {
      credentials: 'include',
      redirect: 'follow'
    });
    var text = await res.text();
    if (/\/login/.test(String(res.url || '')) || /用户登录/.test(text)) {
      return { ok: false, needLogin: true, name: '' };
    }
    var m = text.match(/id="messageName"[^>]*value="([^"]*)"/) ||
            text.match(/messageName[^>]*value="([^"]*)"/) ||
            text.match(/id="messageName"\s+value="([^"]*)"/);
    var name = m ? m[1].trim() : '';
    return { ok: !!name, name: name };
  } catch (e) {
    return { ok: false, name: '', error: e && e.message ? e.message : String(e) };
  }
}

// ---------- 协议探测：找 photoResult 这类拍照凭证的出处 ----------

/**
 * 用当前登录态把"可能的拍照签到页面"都拉一遍，看哪个页面/接口里出现
 * photoResult、signToken、CLIENT_ 这些字样，并把命中片段带回来。
 *
 * 目的：拍照签到的提交参数里到底要不要 photoResult、它是什么形状，
 * 网页端没有任何公开线索，只能从真实页面里找。有登录态才拉得到这些页面。
 */
async function doProbePhoto(msg) {
  msg = msg || {};
  var activeId = String(msg.activeId || '');
  var courseId = String(msg.courseId || '');
  var classId = String(msg.classId || '');
  var fid = String(msg.fid || '');
  var uid = String(msg.uid || '');
  if (!activeId) return { ok: false, error: '先拿到 activeId 再探测' };

  var qs = function (o) {
    return Object.keys(o)
      .filter(function (k) { return o[k] !== undefined && o[k] !== null && o[k] !== ''; })
      .map(function (k) { return k + '=' + encodeURIComponent(o[k]); })
      .join('&');
  };
  var base = { courseId: courseId, classId: classId, activeId: activeId, fid: fid };

  var targets = [
    ['活动详情', SIGN_HOST + '/v2/apis/active/getPPTActiveInfo?' + qs({ activeId: activeId })],
    ['签到页', SIGN_HOST + '/page/sign/signIn?' + qs(base)],
    ['拍照签到页A', SIGN_HOST + '/page/sign/photoSign?' + qs(base)],
    ['拍照签到页B', SIGN_HOST + '/page/sign/signPhoto?' + qs(base)],
    ['预签到页', SIGN_HOST + '/newsign/preSign?' + qs({
      general: 1, sys: 1, ls: 1, appType: 15, tid: '', ut: 's', uid: uid,
      activePrimaryId: activeId, courseId: courseId, classId: classId
    })],
    ['桥接脚本', 'https://mobilelearn-static.chaoxing.com/mobilelearn/front/mobile/sign/js/CXJSBridge.js']
  ];

  var KEYS = ['photoResult', 'signToken', 'CLIENT_', 'objectId', 'getUserMedia', 'camera'];
  var out = [];
  for (var i = 0; i < targets.length; i++) {
    var name = targets[i][0];
    var url = targets[i][1];
    var rec = { name: name, url: url, status: 0, len: 0, hits: {}, snippets: [] };
    try {
      var r = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        redirect: 'follow',
        headers: { Accept: 'text/html,application/json,*/*' }
      });
      rec.status = r.status;
      rec.finalUrl = String(r.url || '');
      var body = await r.text();
      rec.len = body.length;
      for (var k = 0; k < KEYS.length; k++) {
        var kw = KEYS[k];
        var n = body.split(kw).length - 1;
        if (n) rec.hits[kw] = n;
      }
      // 把命中片段截出来（最多 2 段、每段 200 字）
      for (var j = 0; j < KEYS.length && rec.snippets.length < 2; j++) {
        var pos = body.indexOf(KEYS[j]);
        if (pos >= 0) {
          rec.snippets.push(body.slice(Math.max(0, pos - 90), pos + 160).replace(/\s+/g, ' '));
        }
      }
    } catch (e) {
      rec.error = e && e.message ? e.message : String(e);
    }
    out.push(rec);
  }

  // 额外：把活动详情的原始 JSON 带回来（字段最全，能看出服务端到底给了什么）
  try {
    var iu = CXL.buildActiveInfoUrl(activeId);
    var ir = await fetch(iu, { method: 'GET', credentials: 'include', headers: { Accept: 'application/json,*/*' } });
    var itext = (await ir.text()).trim();
    out.push({
      name: '活动详情原始JSON',
      url: iu,
      status: ir.status,
      len: itext.length,
      hits: {},
      snippets: [itext.slice(0, 900)]
    });
  } catch (e) {
    out.push({ name: '活动详情原始JSON', status: 0, len: 0, hits: {}, snippets: [], error: String(e) });
  }

  return { ok: true, activeId: activeId, probes: out };
}

/** 自检：上传通道能不能拿到令牌 */
async function doTestPan() {
  try {
    var r = await fetch(CXL.buildPanTokenUrl(), {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json, text/plain, */*' }
    });
    var t = (await r.text()).trim();
    var j = null;
    try { j = JSON.parse(t); } catch (e) { j = null; }
    var okToken = !!(j && j.result === true && j._token);
    return {
      ok: okToken,
      message: okToken
        ? 'HTTP ' + r.status + '，已拿到上传令牌，图片上传通道正常。'
        : 'HTTP ' + r.status + '，接口返回：' + (t.slice(0, 160) || '(空)') +
          (j && j.msg ? '\n（' + j.msg + '：通常是浏览器没登录学习通）' : '')
    };
  } catch (e) {
    return { ok: false, message: '请求失败：' + (e && e.message ? e.message : String(e)) };
  }
}

/** 自检：当前浏览器是否已登录学习通 */
async function doTestLogin() {
  try {
    var res = await fetch('https://passport2.chaoxing.com/mooc/accountManage', {
      credentials: 'include',
      redirect: 'follow'
    });
    var text = await res.text();
    if (/accountManage|账号管理|手机号|邮箱/.test(text) && res.url.indexOf('passport2.chaoxing.com/mooc/') === 0) {
      return { ok: true, message: '已登录：能打开账号管理页（HTTP ' + res.status + '）。' };
    }
    if (res.url.indexOf('/login') >= 0 || /用户登录/.test(text)) {
      return { ok: false, message: '未登录：请求被跳转到登录页。请先登录 i.chaoxing.com。' };
    }
    return { ok: true, message: 'HTTP ' + res.status + '，最终地址：' + res.url };
  } catch (e) {
    return { ok: false, message: '请求失败：' + (e && e.message ? e.message : String(e)) };
  }
}

// ---------- 消息路由 ----------

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return;

  function guard(promise) {
    promise.then(sendResponse, function (e) {
      sendResponse({ ok: false, error: '出错：' + (e && e.message ? e.message : String(e)) });
    });
    return true;
  }

  if (msg.type === 'lookupActiveId') {
    if (msg.tabId == null && sender && sender.tab) msg.tabId = sender.tab.id;
    return guard(doLookupActiveId(msg));
  }
  if (msg.type === 'uploadPhoto') return guard(doUploadPhoto(msg));
  // 消息名沿用 photoSign，但由 payload.kind 决定是"拍照"还是"普通"两种形状
  if (msg.type === 'photoSign') return guard(doSign(msg));
  if (msg.type === 'whoAmI') return guard(doWhoAmI());
  if (msg.type === 'probePhoto') return guard(doProbePhoto(msg));
  if (msg.type === 'testPan') return guard(doTestPan());
  if (msg.type === 'testLogin') return guard(doTestLogin());
  if (msg.type === 'openOptions') {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return true;
  }
});
