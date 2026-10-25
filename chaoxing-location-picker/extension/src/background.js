/*
 * Service worker：代发签到请求 + 地址解析 + 自动签到引擎。
 * 放在后台发起请求的好处：自动带上该域名下的账号 Cookie，不受页面 CORS 限制。
 *
 * 三个脚本的加载顺序有讲究：
 *   lib.js        协议纯函数（签到参数、类型判定…）
 *   auto.js       自动签到的纯逻辑（时段、三点定位、返回归类）
 *   auto-runner.js 自动签到的执行引擎（alarms 驱动，self.CXLAutoRunner）
 */
importScripts('lib.js', 'auto.js', 'auto-runner.js');

var CXL = self.CXL;
var CXLAutoRunner = self.CXLAutoRunner;

var SIGN_HOST = 'https://mobilelearn.chaoxing.com';

/**
 * 把服务端返回的中文提示翻译成人话。
 * 实测（未登录直接请求接口）会返回「请先登录再进行签到」。
 */
function explainResponse(text, status) {
  if (text === 'success') return { ok: true, message: '服务端返回 success，签到已提交成功。' };
  if (text === 'success2') {
    return { ok: true, message: '服务端返回 success2：已记录，但提交时间晚于老师设定的截止时间。' };
  }
  if (!text) return { ok: false, message: '服务端返回空内容（HTTP ' + status + '），通常说明登录态失效或 activeId 无效。' };
  if (/请先登录|未登录|登录已过期|not login/i.test(text)) {
    return { ok: false, message: '未登录或登录状态已失效：' + text + '\n请先在当前浏览器里登录 i.chaoxing.com，再回来重试。' };
  }
  if (/已签到|重复签到|请勿重复/.test(text)) return { ok: false, message: '这次签到你已经签过了：' + text };

  // 拍照签到的服务端校验：图片/参数没通过（PCR = parameter check rule）
  if (/photoAuthError/i.test(text)) {
    var code = (text.match(/photoAuthError_?(\w+)/) || [])[1] || '';
    return {
      ok: false,
      photoAuth: true,
      message: '服务端拒绝了这次拍照签到：' + text + '\n' +
        '（' + (code ? code + '：' : '') + '这是拍照签到的服务端校验没通过。）\n' +
        '两种可能：\n' +
        '  1) 提交参数不符合这次活动的规则 —— 已按"极简参数 + GET"再试，若仍报此错请看第 2 条；\n' +
        '  2) 这次活动要求本机现场拍照，网页端（包括本扩展）拿不到那个凭证 ——\n' +
        '     学习通自己的 H5 签到页在这种活动上也只显示"请使用手机APP，在本课程任务下签到"。\n' +
        '如果是第 2 种，就只能用学习通 APP 完成。'
    };
  }
  if (/\[face\]/.test(text)) {
    return {
      ok: false,
      needApp: true,
      message: '这是"位置+人脸"类签到，服务端要求人脸活体校验：' + text + '\n' +
        '网页端拿不到活体凭证（check-face-result 只会发给原生端发起的活体会话），' +
        '请用学习通 APP 完成，或先在学习通里录入人脸后重试。'
    };
  }
  if (/签到失败，请重新扫描|重新扫描/.test(text)) {
    return { ok: false, message: '这是二维码签到，需要二维码里的 enc 参数（只在老师屏幕上、且几十秒就换一次）：' + text };
  }
  if (/已结束|结束|过期|失效/.test(text)) return { ok: false, message: '签到活动已结束或已过期：' + text };
  if (/validate|校验|参数/.test(text)) {
    return { ok: false, message: '服务端要求额外校验：' + text + '\n（可能是超出老师设定的范围、参数不完整，或签到方式不对）' };
  }
  return { ok: false, message: '服务端返回：' + text };
}

async function doSign(msg) {
  var settings = await CXL.getSettings();
  var dryRun = !!(msg.dryRun || settings.dryRun);
  var payload = msg.payload || {};
  var kind = (typeof payload.kind === 'string') ? payload.kind : (payload.kind && payload.kind.key) || 'location';

  // 拍照签到走"极简参数 + GET"（与公开可用的第三方实现一致）：
  // 多带字段会被判成参数不符合规则，见 lib.js 里 buildPhotoSignParams 的说明。
  var isPhoto = (kind === 'photo' && payload.objectId);
  var pairs = isPhoto ? CXL.buildPhotoSignParams(payload) : CXL.buildSignParams(payload);
  var usePost = isPhoto ? false : CXL.signUsesPost(payload);
  var body = CXL.encodeSignParams(pairs);
  var url = SIGN_HOST + '/pptSign/stuSignajax' + (usePost ? '' : '?' + body);

  if (dryRun) {
    return {
      ok: true,
      dry: true,
      message: '试运行模式：未发送任何请求。\n（' + (usePost ? 'POST 表单' : 'GET 查询串') + '，共 ' +
        pairs.length + ' 个参数' + (payload.objectId ? '，含 objectId=' + payload.objectId : '') + '）',
      url: url,
      method: usePost ? 'POST' : 'GET',
      params: body
    };
  }

  try {
    var res = await fetch(url, usePost
      ? {
        method: 'POST',
        credentials: 'include',
        headers: {
          Accept: '*/*',
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: body,
        redirect: 'follow'
      }
      : {
        method: 'GET',
        credentials: 'include',
        headers: { Accept: '*/*' },
        redirect: 'follow'
      });
    var text = (await res.text()).trim();
    var verdict = explainResponse(text, res.status);
    if (text === 'success' || /"success"\s*:\s*true/i.test(text)) verdict.ok = true;
    return {
      ok: verdict.ok,
      message: verdict.message + '（HTTP ' + res.status + '）',
      raw: text.slice(0, 500),
      url: url,
      method: usePost ? 'POST' : 'GET',
      params: usePost ? body : ''
    };
  } catch (e) {
    return { ok: false, message: '请求失败：' + (e && e.message ? e.message : String(e)), url: url };
  }
}

// ---------- 拍照签到：上传图片换 objectId ----------

/**
 * 把用户选的图片上传到学习通网盘，换回一个 objectid —— 这就是拍照签到要提交的东西。
 * 两步（与官方客户端一致）：
 *   1) GET  /api/token/uservalid  拿 _token
 *   2) POST /upload  multipart：puid + _token + file
 * 全程在后台做：自动带 Cookie，也不受页面 CORS 限制。
 */
async function doUploadPhoto(msg) {
  msg = msg || {};
  var dataUrl = String(msg.dataUrl || '');
  var m = dataUrl.match(/^data:([^;,]*);base64,([\s\S]*)$/);
  if (!m) return { ok: false, error: '图片数据格式不对（需要 dataURL），换一张试试' };

  var type = String(msg.mime || msg.fileType || m[1] || 'image/jpeg').toLowerCase();
  var b64 = m[2].replace(/\s+/g, '');
  var bin;
  try {
    bin = atob(b64);
  } catch (e) {
    return { ok: false, error: '图片数据解码失败，换一张试试' };
  }
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  // 就算内容脚本已经校验过，这里再核一遍（大小/类型）
  var check = CXL.validatePhoto({ size: bytes.length, type: type, name: msg.name });
  if (!check.ok) return { ok: false, error: check.error };

  var cookies = await readAuthCookies();
  var uid = msg.uid || cookies.uid || '';
  if (!uid) {
    return { ok: false, needLogin: true, error: '读不到账号 uid（浏览器可能没登录学习通），先在 i.chaoxing.com 登录再试' };
  }

  // 1) 取上传令牌
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

  // 2) multipart 上传
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
      return {
        ok: false,
        error: '服务端没有返回 objectid：' + (utext.slice(0, 160) || ('HTTP ' + ur.status)),
        raw: utext.slice(0, 300)
      };
    }
    return { ok: true, objectId: objectId, size: bytes.length, name: fname, uid: uid, token: token };
  } catch (e) {
    return { ok: false, error: '上传图片失败：' + (e && e.message ? e.message : String(e)) };
  }
}

/** 自检：上传通道是否可用（只看能不能拿到令牌，不传图片） */
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
        ? 'HTTP ' + r.status + '，已拿到上传令牌。拍照签到可以正常上传图片。'
        : 'HTTP ' + r.status + '，接口返回：' + (t.slice(0, 160) || '(空)') +
          (j && j.msg ? '\n（' + j.msg + '：通常是浏览器没登录学习通）' : '')
    };
  } catch (e) {
    return { ok: false, message: '请求失败：' + (e && e.message ? e.message : String(e)) };
  }
}


/** 地址 -> 坐标：优先高德（需 key），否则退回 OpenStreetMap Nominatim */
async function doGeocode(msg) {
  var settings = await CXL.getSettings();
  var address = msg.address || '';
  if (!address) return { ok: false, error: '地址为空' };

  if (settings.amapKey) {
    try {
      var u =
        'https://restapi.amap.com/v3/geocode/geo?key=' +
        encodeURIComponent(settings.amapKey) +
        '&address=' +
        encodeURIComponent(address) +
        (msg.city ? '&city=' + encodeURIComponent(msg.city) : '');
      var r = await fetch(u);
      var j = await r.json();
      if (j && j.status === '1' && j.geocodes && j.geocodes.length) {
        var g = j.geocodes[0];
        var parts = String(g.location).split(',');
        return {
          ok: true,
          lat: parseFloat(parts[1]),
          lon: parseFloat(parts[0]),
          formatted: g.formatted_address || address,
          provider: 'amap'
        };
      }
    } catch (e) { /* 落到下面的免费方案 */ }
  }

  try {
    var u2 =
      'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&accept-language=zh-CN&q=' +
      encodeURIComponent(address);
    var r2 = await fetch(u2, { headers: { Accept: 'application/json' } });
    var j2 = await r2.json();
    if (!j2 || !j2.length) {
      return { ok: false, error: '没有搜索到该地址，可试试填更完整的「城市+路名+门牌」' };
    }

    // 关键：免费接口对中文地址经常给出"看着像但其实不是"的结果
    // （实测搜「河北师范大学」返回了北京的「北京师范大学」），
    // 所以这里做一次名称相似度校验，不达标就宁可让用户手动选点。
    var best = null;
    var bestScore = 0;
    for (var i = 0; i < j2.length; i++) {
      var s = CXL.nameSimilarity(address, j2[i].display_name || '');
      if (s > bestScore) { bestScore = s; best = j2[i]; }
    }

    if (!best || bestScore < 0.45) {
      var top = j2[0];
      return {
        ok: false,
        error:
          '搜索结果和你要找的名称对不上，已放弃自动定位（避免给错坐标）。\n' +
          '接口返回的最接近结果是：\n  ' + (top.display_name || '').slice(0, 120) + '\n' +
          '请直接在地图上手动找位置点一下，或换个更具体的说法再搜。'
      };
    }

    // Nominatim 返回 WGS-84，转成 GCJ-02 供国内地图使用
    var wgs = [parseFloat(best.lat), parseFloat(best.lon)];
    var gcj = CXL.wgs84ToGcj02(wgs[0], wgs[1]);
    return {
      ok: true,
      lat: gcj[0],
      lon: gcj[1],
      formatted: best.display_name || address,
      provider: 'nominatim',
      confidence: Math.round(bestScore * 100) / 100
    };
  } catch (e) {
    return { ok: false, error: '地址搜索失败：' + (e && e.message ? e.message : String(e)) + '（可在高级设置里填高德 key）' };
  }
}

/**
 * 很轻量的名称相似度（实现见 lib.js 的 CXL.nameSimilarity）：
 * 用来挡住「河北师范大学 → 北京师范大学」这类错误匹配。
 */

/** 坐标 -> 地址：优先高德逆地理，否则 Nominatim */
async function doRegeo(msg) {
  var settings = await CXL.getSettings();
  var lat = Number(msg.lat);
  var lon = Number(msg.lon);

  if (settings.amapKey) {
    try {
      var u =
        'https://restapi.amap.com/v3/geocode/regeo?key=' +
        encodeURIComponent(settings.amapKey) +
        '&location=' +
        lon.toFixed(6) +
        ',' +
        lat.toFixed(6);
      var r = await fetch(u);
      var j = await r.json();
      if (j && j.status === '1' && j.regeocode) {
        return { ok: true, address: j.regeocode.formatted_address || '', provider: 'amap' };
      }
    } catch (e) { /* ignore */ }
  }

  try {
    var wgs = CXL.gcj02ToWgs84(lat, lon);
    var u2 =
      'https://nominatim.openstreetmap.org/reverse?format=json&accept-language=zh-CN&zoom=18&lat=' +
      wgs[0].toFixed(6) +
      '&lon=' +
      wgs[1].toFixed(6);
    var r2 = await fetch(u2, { headers: { Accept: 'application/json' } });
    var j2 = await r2.json();
    if (j2 && j2.display_name) return { ok: true, address: j2.display_name, provider: 'nominatim' };
    return { ok: false, error: '解析不到地址' };
  } catch (e) {
    return { ok: false, error: '逆地理失败：' + (e && e.message ? e.message : String(e)) };
  }
}

// ---------- 自动获取 activeId ----------

/**
 * 从 Cookie 里补 fid / uid。
 * 内容脚本在页面里读不到 HttpOnly 的 _uid，而签到请求必须带上它，
 * 所以这里用 cookies API 兜一层（拿不到也不致命，继续用调用方传来的值）。
 */
async function readAuthCookies() {
  var out = { fid: '', uid: '' };
  if (!chrome.cookies || typeof chrome.cookies.get !== 'function') return out;

  // 域名不同、Cookie 名也可能不同（老账号是 UID，新的是 _uid），都试一遍
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
    } catch (e) { /* 忽略单个 Cookie 读取失败 */ }
  }
  return out;
}

/** 从标签页里取一个 chaoxing 页面作为 Referer，尽量贴近网页自己的请求头 */
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
 * 查这个课程当前有哪些活动，把 activeId 取回来。
 * 这条路径不依赖页面里有没有签到入口，也不需要用户去找老师发的签到消息：
 * 只要浏览器登录着、且给出了 courseId + classId，就能问服务端要到编号。
 */
async function doLookupActiveId(msg) {
  msg = msg || {};
  var ctx = CXL.parseCourseContext([msg.url, msg.courseId, msg.classId, msg.fid]);
  var courseId = msg.courseId || ctx.courseId || '';
  var classId = msg.classId || ctx.classId || '';
  if (!courseId || !classId) {
    return { ok: false, error: '拿不到课程/班级编号：请在课程页面里打开面板，或点「刷新识别」' };
  }

  var cookies = await readAuthCookies();
  var fid = msg.fid || ctx.fid || cookies.fid || '';
  var uid = msg.uid || cookies.uid || '';
  // 学习通有 fid=1 这种全校统一号，所以 fid 不算必需；缺了也照发，服务端会用登录态里的值
  var url = CXL.buildActiveListUrl({ fid: fid, courseId: courseId, classId: classId });
  var referer = await pageReferer(msg.tabId);

  var headers = { Accept: 'application/json, text/plain, */*' };
  if (referer) headers.Referer = referer;

  var res, text = '';
  try {
    var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 12000) : null;
    res = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: headers,
      signal: ctrl ? ctrl.signal : undefined
    });
    text = await res.text();
    if (timer) clearTimeout(timer);
  } catch (e) {
    return {
      ok: false,
      error: '活动列表请求失败：' + (e && e.message ? e.message : String(e)),
      url: url
    };
  }

  var body = String(text || '').trim();
  // 未登录时 mobilelearn 会 302 到 passport2 登录页，且返回的是 HTML —— 这是最常见的一种失败
  var finalUrl = String(res.url || '');
  if (/passport2\.chaoxing\.com|\/login/i.test(finalUrl) || /^\s*</.test(body)) {
    return {
      ok: false,
      needLogin: true,
      error: '服务端把请求跳到登录页了，说明这个浏览器当前没登录学习通（先在 i.chaoxing.com 登录，再回来点一次）。',
      url: url,
      finalUrl: finalUrl
    };
  }

  var json = null;
  try { json = JSON.parse(body); } catch (e) { json = null; }
  if (!json) {
    return { ok: false, error: '活动列表返回的不是 JSON，无法解析（HTTP ' + res.status + '）。', url: url, raw: body.slice(0, 300) };
  }
  if (json.result !== undefined && Number(json.result) !== 1) {
    return {
      ok: false,
      error: '服务端没给活动列表：' + (CXL.lookupErrorMessage(json, res.status) || ('result=' + json.result)),
      url: url,
      raw: body.slice(0, 300)
    };
  }

  // 只认「进行中」的活动：老活动的 activeId 拿去提交，服务端只会回一句"已结束"
  var target = CXL.pickActiveTarget(json, { allowNotStarted: false });
  var acts = CXL.extractActivities(json);
  var running = acts.filter(function (a) { return a.status === 1; }).length;

  if (!target) {
    return {
      ok: false,
      error: acts.length
        ? '这个课程的活动列表里没有「进行中」的签到（共 ' + acts.length + ' 个活动，进行中 ' + running + ' 个）。等老师发布签到后再点一次。'
        : '这个课程暂时没有任何活动记录（老师还没发布过签到，或者课程/班级编号不对）。',
      url: url,
      activityCount: acts.length
    };
  }

  return {
    ok: true,
    activeId: target.id,
    name: target.name,
    label: target.label,
    signType: target.signType,
    // 这次签到要"位置"还是"拍照"，字段来自活动列表（otherId / activeSort / ifphoto）
    kind: target.kind,
    activityCount: acts.length,
    uid: uid,
    fid: fid,
    url: url
  };
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
      return { ok: true, message: '已登录：能打开账号管理页（HTTP ' + res.status + '）。可以正常提交签到了。' };
    }
    if (res.url.indexOf('/login') >= 0 || /用户登录/.test(text)) {
      return { ok: false, message: '未登录：请求被跳转到登录页。请先在浏览器里登录 i.chaoxing.com 再回来。' };
    }
    return { ok: true, message: 'HTTP ' + res.status + '，最终地址：' + res.url + '\n（内容无法确定登录状态，但网络是通的）' };
  } catch (e) {
    return { ok: false, message: '请求失败：' + (e && e.message ? e.message : String(e)) };
  }
}

/** 自检：签到接口是否可达（不带有效参数，只看连通性） */
async function doTestReach() {
  try {
    var res = await fetch(SIGN_HOST + '/pptSign/stuSignajax?activeId=1', {
      credentials: 'include',
      redirect: 'follow'
    });
    var text = (await res.text()).trim();
    return {
      ok: res.ok,
      message:
        'HTTP ' + res.status + '，接口返回：' + (text ? text.slice(0, 200) : '(空)') + '\n' +
        '空返回属正常现象（参数无效时服务端就是这样），说明接口可达。'
    };
  } catch (e) {
    return { ok: false, message: '请求失败：' + (e && e.message ? e.message : String(e)) };
  }
}

/**
 * 跨框架点名：向标签页里所有框架发一条消息，把每个框架的自报情况收集起来。
 * 学习通把签到界面套在 iframe 里（实测是
 * mobilelearn.chaoxing.com/page/active/stuActiveList），
 * 只看最外层永远看不到它，所以需要这一层"点名"。
 */
function inspectAllFrames(tabId) {
  return new Promise(function (resolve) {
    chrome.tabs.sendMessage(tabId, { type: 'frameReport' }, function () {
      void chrome.runtime.lastError;
      resolve(true);
    });
  }).then(function () {
    // 各框架收到 frameReport 后会各自回一条 frameState，这里给它们一点时间
    return new Promise(function (r) { setTimeout(r, 900); });
  }).then(function () {
    return collectFrameStates(tabId);
  });
}

function collectFrameStates(tabId) {
  return new Promise(function (resolve) {
    chrome.scripting.executeScript(
      {
        target: { tabId: tabId, allFrames: true },
        func: function () {
          var t = '';
          try { t = (document.body && document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 300); } catch (e) { t = ''; }
          var cand = null;
          try {
            var html = document.documentElement.innerHTML;
            var m = html.match(/activePrimaryId["'\s:=]+(\d{6,})/) || html.match(/activeId["'\s:=]+(\d{6,})/);
            cand = m ? m[1] : null;
          } catch (e) { /* ignore */ }
          var frames = [];
          try {
            var fs = document.querySelectorAll('iframe, frame');
            for (var i = 0; i < fs.length && i < 20; i++) {
              frames.push(String(fs[i].getAttribute('src') || '').slice(0, 160));
            }
          } catch (e) { /* ignore */ }
          return {
            url: String(location.href).slice(0, 200),
            hookReady: !!window.__CXL_MAIN_READY,
            hasSignText: /签到/.test(t),
            activeIdCandidate: cand,
            textSample: t.slice(0, 160),
            childFrames: frames
          };
        }
      },
      function (results) {
        void chrome.runtime.lastError;
        resolve((results || []).map(function (r) { return r && r.result; }).filter(Boolean));
      }
    );
  });
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return;
  if (msg.type === 'sign') {
    doSign(msg).then(sendResponse);
    return true;
  }
  if (msg.type === 'geocode') {
    doGeocode(msg).then(sendResponse);
    return true;
  }
  if (msg.type === 'regeo') {
    doRegeo(msg).then(sendResponse);
    return true;
  }
  if (msg.type === 'testLogin') {
    doTestLogin().then(sendResponse);
    return true;
  }
  if (msg.type === 'testReach') {
    doTestReach().then(sendResponse);
    return true;
  }
  if (msg.type === 'lookupActiveId') {
    doLookupActiveId(msg).then(function (res) {
      sendResponse(res);
    }, function (e) {
      sendResponse({ ok: false, error: '查询活动列表时出错：' + (e && e.message ? e.message : String(e)) });
    });
    return true;
  }
  if (msg.type === 'uploadPhoto') {
    doUploadPhoto(msg).then(function (res) {
      sendResponse(res);
    }, function (e) {
      sendResponse({ ok: false, error: '上传图片时出错：' + (e && e.message ? e.message : String(e)) });
    });
    return true;
  }
  if (msg.type === 'testPan') {
    doTestPan().then(sendResponse);
    return true;
  }
  if (msg.type === 'inspectFrames') {
    var tabId = (msg.tabId != null)
      ? msg.tabId
      : (sender && sender.tab ? sender.tab.id : null);
    if (tabId == null) { sendResponse({ ok: false, error: '拿不到标签页 id' }); return true; }
    inspectAllFrames(tabId).then(function (frames) {
      sendResponse({ ok: true, frames: frames });
    });
    return true;
  }
  if (msg.type === 'openOptions') {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return true;
  }

  // ---------- 自动签到（只做位置签到） ----------

  if (msg.type === 'autoStatus') {
    Promise.all([readAuto(), readState(), readAutoLog()]).then(function (all) {
      sendResponse({
        ok: true,
        auto: all[0],
        state: all[1],
        log: all[2],
        schedule: CXL.checkSchedule(new Date(), all[0]),
        summary: CXL.describeAutoState(all[1], all[0])
      });
    }, function (e) {
      sendResponse({ ok: false, error: '读取自动签到状态失败：' + ((e && e.message) || e) });
    });
    return true;
  }
  if (msg.type === 'autoConfig') {
    // 注意键名：自动签到的配置单独放在 storage 顶层的 auto 里（引擎自己读这个键），
    // 不能混进 settings.auto，否则改了设置引擎根本看不见。
    (async function () {
      var cur = await readAuto();
      var next = Object.assign({}, cur, msg.auto || {});
      // 允许用户改这几项，但类型/开关的语义要在后台兜住
      next.enabled = !!next.enabled;
      next.locationOnly = true;
      next.autoSubmit = true;
      next.intervalMs = Math.max(10000, Math.min(600000, Number(next.intervalMs) || 20000));
      next.maxRounds = Math.max(1, Math.min(30, Number(next.maxRounds) || 10));
      next.weekdays = Array.isArray(next.weekdays)
        ? next.weekdays.map(Number).filter(function (d) { return d >= 0 && d <= 6; })
        : CXL.DEFAULT_WEEKDAYS;
      // 监控的课程清单：只收结构完整的条目
      next.courses = Array.isArray(next.courses)
        ? next.courses.filter(function (c) {
          return c && /^\d{4,}$/.test(String(c.courseId || '')) && /^\d{3,}$/.test(String(c.classId || ''));
        }).map(function (c) {
          return {
            courseId: String(c.courseId), classId: String(c.classId),
            fid: String(c.fid || ''), courseName: String(c.courseName || ''),
            referer: String(c.referer || 'https://mooc2-ans.chaoxing.com/')
          };
        }).slice(0, 50)
        : [];
      var start = CXL.parseClock(next.startTime);
      var end = CXL.parseClock(next.endTime);
      next.startTime = CXL.formatClock(start === null ? 8 * 60 : start);
      next.endTime = CXL.formatClock(end === null ? 14 * 60 : end);
      var patch = {};
      patch[CXL.AUTO_KEYS.auto] = next;
      await new Promise(function (resolve) {
        chrome.storage.local.set(patch, function () { void chrome.runtime.lastError; resolve(); });
      });
      var sch = await CXLAutoRunner.reschedule();
      sendResponse({ ok: true, auto: next, schedule: sch });
    })().catch(function (e) {
      sendResponse({ ok: false, error: '保存自动签到设置失败：' + ((e && e.message) || e) });
    });
    return true;
  }
  if (msg.type === 'autoRunNow') {
    CXLAutoRunner.runNow().then(function (r) {
      sendResponse(Object.assign({ ok: true }, r));
    }, function (e) {
      sendResponse({ ok: false, error: '触发出错：' + ((e && e.message) || e) });
    });
    return true;
  }
  if (msg.type === 'autoReset') {
    CXLAutoRunner.resetToday().then(function (r) { sendResponse(r); });
    return true;
  }
  if (msg.type === 'autoCourses') {
    // 用浏览器登录态拉课表：设置页据此列出"能监控哪些课"
    (async function () {
      var cookies = await readAuthCookies();
      var url = CXL.buildCourseListUrl();
      var res = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: { Accept: 'application/json, text/plain, */*' },
        redirect: 'follow'
      });
      var text = await res.text();
      var finalUrl = String(res.url || '');
      if (/passport2|\/login/i.test(finalUrl) || /^\s*</.test(text)) {
        sendResponse({ ok: false, needLogin: true, error: '浏览器当前没登录学习通（先在 i.chaoxing.com 登录）' });
        return;
      }
      var json = null;
      try { json = JSON.parse(text); } catch (e) { json = null; }
      if (!json) {
        sendResponse({ ok: false, error: '课表返回不是 JSON（HTTP ' + res.status + '）', raw: text.slice(0, 200) });
        return;
      }
      if (json.result !== undefined && Number(json.result) === 0) {
        sendResponse({ ok: false, needLogin: true, error: CXL.lookupErrorMessage(json) || '服务端要求重新登录' });
        return;
      }
      var courses = CXL.extractCourses(json).map(function (c) {
        return {
          courseId: c.courseId, classId: c.classId, fid: c.fid || cookies.fid || '',
          courseName: c.name || '', referer: 'https://mooc2-ans.chaoxing.com/'
        };
      });
      sendResponse({ ok: true, courses: courses, uid: cookies.uid || '', fid: cookies.fid || '' });
    })().catch(function (e) {
      sendResponse({ ok: false, error: '拉课表失败：' + ((e && e.message) || e) });
    });
    return true;
  }
  if (msg.type === 'autoTarget') {
    CXLAutoRunner.registerTarget(msg.target).then(function (r) {
      // 内容脚本刚刚报了一门课，趁着 service worker 活着顺手排一次定时器
      CXLAutoRunner.reschedule().then(function (sch) {
        sendResponse(Object.assign({ ok: true }, r, { schedule: sch }));
      });
    });
    return true;
  }
});

/** storage.local 的 Promise 包装（lib.js 里那份是私有的，这里要自己包一层） */
function readStore(keys) {
  return new Promise(function (resolve) {
    try {
      chrome.storage.local.get(keys, function (res) {
        void chrome.runtime.lastError;
        resolve(res || {});
      });
    } catch (e) { resolve({}); }
  });
}

/** 读自动签到配置 / 状态 / 日志（设置页与弹窗共用） */
async function readAuto() {
  var res = await readStore([CXL.AUTO_KEYS.auto]);
  return Object.assign({}, CXL.AUTO_DEFAULTS, res[CXL.AUTO_KEYS.auto] || {});
}

async function readState() {
  var res = await readStore([CXL.AUTO_KEYS.autoState]);
  return Object.assign(CXL.emptyAutoState(), res[CXL.AUTO_KEYS.autoState] || {});
}

async function readAutoLog() {
  var res = await readStore([CXL.AUTO_KEYS.autoLog]);
  return res[CXL.AUTO_KEYS.autoLog] || CXL.emptyAutoLog();
}
