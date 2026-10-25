/*
 * 内容脚本（运行在扩展隔离世界）：
 *   - 把 injected.js 注入页面主世界并同步配置；
 *   - 在页面上渲染一个影子 DOM 的「选点 + 签到」面板；
 *   - 与 background 通信，代为发起签到请求与地址解析。
 */
(function () {
  'use strict';

  var CXL = globalThis.CXL;
  if (!CXL) return;
  if (window.__cxlContentLoaded) return;
  window.__cxlContentLoaded = true;

  var CFG_EVENT = 'cxl:config';
  var REPORT_EVENT = 'cxl:report';
  var HOST_ID = 'cxl-overlay-host';
  /** 自动化测试开关：selftest 会先在 <html> 上打 data-cxl-test 标记 */
  var TEST_HOOK = (function () {
    try { return document.documentElement.hasAttribute('data-cxl-test'); } catch (e) { return false; }
  })();
  var IS_TOP = (function () {
    try { return window.top === window; } catch (e) { return false; }
  })();

  /** 本框架的地址（跨域 iframe 的 location 仍然读得到） */
  function currentUrl() {
    try { return location.href; } catch (e) { return ''; }
  }

  /**
   * 这个框架值不值得挂 UI？
   * 扩展用 all_frames + match_about_blank 注入（因为学习通会把签到界面套在
   * iframe 里），所以这里做运行时判断。
   * 注意不要把它当成"该不该显示按钮"的判据——显示与否由下面的框架协调决定。
   */
  function isRelevantFrame() {
    var url = currentUrl();
    if (!url || url === 'about:blank') return true;
    if (/chaoxing\.com/i.test(url)) return true;
    try {
      var text = (document.body && document.body.innerText || '').slice(0, 20000);
      if (/签到|签退/.test(text)) return true;
    } catch (e) { /* ignore */ }
    return false;
  }

  /** 这个框架是不是"签到活动"界面（iframe 名字/地址里有特征，或正文里有签到字样） */
  function isSignFrame() {
    var url = currentUrl();
    if (/stuActiveList|page\/active|pptSign|preSign|sign\/|stuSign/i.test(url)) return true;
    try {
      var text = (document.body && document.body.innerText || '').slice(0, 20000);
      if (/签到/.test(text) && /活动|剩余|已签到|签到码|手势|位置/.test(text)) return true;
      if (/请使用移动端|手机提供位置/.test(text)) return true;
    } catch (e) { /* ignore */ }
    return false;
  }

  /** 列出页面上所有 iframe，方便找出签到界面到底在哪一层 */
  function listFrames() {
    var out = [];
    var iframes = document.querySelectorAll('iframe, frame');
    for (var i = 0; i < iframes.length && i < 30; i++) {
      var f = iframes[i];
      out.push({
        index: i,
        name: f.getAttribute('name') || '',
        id: f.id || '',
        src: String(f.getAttribute('src') || f.src || '').slice(0, 200)
      });
    }
    return out;
  }

  /**
   * 框架协调：页面上常有多个层级都注入了本扩展（学习通自己就是层层套 iframe），
   * 如果每层都冒一个悬浮按钮就会叠在一起。
   * 做法：每个框架把自己的情况写进 storage，谁最后写谁是"值班框架"，
   * 优先选真正含签到界面的那一层，否则选最外层。
   */
  var FRAME_KEY = 'frameClaims';
  var FRAME_TTL = 15000;
  var myFrameKey = 'f' + Math.random().toString(36).slice(2, 10);

  function registerClaim() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get([FRAME_KEY], function (r) { resolve((r && r[FRAME_KEY]) || {}); });
      } catch (e) { resolve({}); }
    }).then(function (all) {
      var now = Date.now();
      var fresh = {};
      // 清掉已经不再上报的框架（关掉/跳走了），避免一直被它们压着
      Object.keys(all || {}).forEach(function (k) {
        if (all[k] && now - all[k].ts < FRAME_TTL) fresh[k] = all[k];
      });
      fresh[myFrameKey] = {
        ts: now,
        isTop: IS_TOP,
        sign: isSignFrame(),
        url: currentUrl().slice(0, 160)
      };
      var patch = {};
      patch[FRAME_KEY] = fresh;
      try { chrome.storage.local.set(patch); } catch (e) { /* ignore */ }
      return fresh;
    });
  }

  /** 按"含签到界面 > 最外层"的优先级挑一个值班框架，只有它显示悬浮按钮 */
  function isDutyFrame(claims) {
    var list = Object.keys(claims || {}).map(function (k) { return { key: k, c: claims[k] }; });
    if (!list.length) return true;
    list.sort(function (a, b) {
      if (a.c.sign !== b.c.sign) return a.c.sign ? -1 : 1;
      if (a.c.isTop !== b.c.isTop) return a.c.isTop ? -1 : 1;
      return a.c.ts - b.c.ts;
    });
    return list[0].key === myFrameKey;
  }

  /** 让本框架退出竞争（面板被关闭/销毁时用） */
  function dropClaim() {
    try {
      chrome.storage.local.get([FRAME_KEY], function (r) {
        var all = (r && r[FRAME_KEY]) || {};
        delete all[myFrameKey];
        var patch = {};
        patch[FRAME_KEY] = all;
        chrome.storage.local.set(patch);
      });
    } catch (e) { /* ignore */ }
  }

  function refreshDuty() {
    if (!overlay) return;
    registerClaim().then(function (claims) {
      var duty = isDutyFrame(claims);
      overlay.fab.style.display = duty ? '' : 'none';
      if (!duty && overlay.panel && !overlay.panel.hasAttribute('hidden')) {
        overlay.panel.setAttribute('hidden', 'hidden');
      }
    });
  }

  /**
   * 每次页面加载随机生成的一次性令牌。
   * 主世界的回传消息必须带上它才被采纳，避免页面脚本伪造 cxl:report
   * 去污染面板状态（协议本身随 injected.js 一起是公开的）。
   * 在文档早期就通过 CustomEvent 交给 injected.js；页面脚本要拿到它，
   * 得先在自己脚本运行前读 DOM 事件，而我们的脚本跑在它前面。
   */
  var TOKEN = (function () {
    var a = new Uint8Array(16);
    try { crypto.getRandomValues(a); } catch (e) {
      for (var i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256);
    }
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  })();

  var settings = null;
  var point = null;
  var presets = [];
  var injectedTag = null;
  var overlay = null;
  var ui = {};
  /** 拖放进入的层数（dragenter/dragleave 成对出现在子元素上，用计数才不会误清高亮） */
  var dragDepth = 0;

  /** 拖放高亮：虚线框加 over、整个面板加一圈提示 */
  function setDragHint(on) {
    dragDepth = on ? 1 : 0;
    var drop = overlay && overlay.drop;
    if (drop && drop.classList) {
      if (on) drop.classList.add('over');
      else drop.classList.remove('over');
    }
    var panel = overlay && overlay.panel;
    if (panel && panel.classList) {
      if (on) panel.classList.add('dragging');
      else panel.classList.remove('dragging');
    }
  }

  /** 从拖放事件里取出第一个图片文件（files 优先，再退回 items） */
  function fileFromDrop(e) {
    var dt = e && e.dataTransfer;
    var f = dt && dt.files && dt.files[0];
    if (f) return f;
    var items = (dt && dt.items) || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === 'file' && /^image\//.test(items[i].type || '')) {
        var got = items[i].getAsFile && items[i].getAsFile();
        if (got) return got;
      }
    }
    return null;
  }
  var runtime = {
    activeId: '',
    activeName: '',
    activeKind: null,          // 活动类型：location / photo / …（由活动列表判定）
    fid: '',
    uid: '',
    courseId: '',
    classId: '',
    userName: '',
    lastSignUrl: '',
    activeLookupAt: 0,
    mode: 'location',          // 当前要签的是哪种：location | photo
    modePickedByUser: false,   // 用户手动切过就不再自动改
    photo: null,               // { name, type, size, dataUrl, objectId }
    photoUploading: false,
    geoHits: 0,
    rewrites: 0,
    requests: [],
    net: [],
    status: '待命'
  };

  // ---------- 注入主世界脚本 ----------

  /**
   * 把钩子脚本补到页面主世界（MAIN）。
   * 正常情况下 popup 已经用 scripting 的 world:'MAIN' 注入过了，
   * 这里只是兜底：如果检测不到钩子（例如手动刷新过页面），就用 web_accessible
   * 资源 + script 标签的方式补一次。页面 CSP 若禁止会静默失败，不影响其它功能。
   */
  function injectMainWorld() {
    if (window.__CXL_MAIN_READY) return;
    if (injectedTag && injectedTag.isConnected) return;
    var el = document.createElement('script');
    el.src = chrome.runtime.getURL('src/injected.js');
    el.dataset.cxlConfig = JSON.stringify({
      enabled: settings.enabled,
      spoofGeo: settings.spoofGeo,
      spoofTiles: settings.spoofTiles,
      record: settings.record,
      datum: settings.datum,
      point: point
    });
    el.onload = function () {
      el.remove();
      // 回读确认钩子真的装上了；页面的 CSP 若禁止加载扩展脚本，这里会失败
      if (window.__CXL_MAIN_READY) {
        setStatus('主世界定位钩子已挂上。', 'ok');
      } else {
        setStatus('脚本加载完了但钩子没生效（可能被页面 CSP 拦了）。', 'err');
      }
    };
    el.onerror = function () {
      el.remove();
      setStatus(
        '没能把定位钩子注入页面主世界（多半是页面 CSP 拦截了扩展脚本）。\n' +
        '这会影响「写入页面并让网页签到」，但「直接签到」不受影响，仍然可以用。',
        'err'
      );
    };
    (document.head || document.documentElement).appendChild(el);
    injectedTag = el;
  }

  function pushConfig() {
    var detail = {
      token: TOKEN,
      enabled: settings.enabled,
      spoofGeo: settings.spoofGeo,
      spoofTiles: settings.spoofTiles,
      record: settings.record,
      datum: settings.datum,
      point: point
    };
    try {
      window.dispatchEvent(new CustomEvent(CFG_EVENT, { detail: detail }));
    } catch (e) { /* ignore */ }
  }

  // 文档早期先把令牌交给主世界钩子，保证它从第一条回传开始就能校验
  try {
    window.dispatchEvent(new CustomEvent(CFG_EVENT, { detail: { token: TOKEN } }));
  } catch (e) { /* ignore */ }

  // ---------- 接收主世界回传 ----------

  window.addEventListener('message', function (e) {
    if (e.source !== window) return;          // 只接受本窗口主世界的消息
    var d = e.data;
    if (!d || d.__cxl !== REPORT_EVENT) return;
    if (d.token !== TOKEN) return;            // 令牌不符：伪造或过期，直接丢弃
    var p = d.payload || {};
    if (d.type === 'ready') {
      runtime.status = '已在页面注入定位钩子';
    } else if (d.type === 'geo') {
      runtime.geoHits++;
      var lat = Number(p.lat);
      var lon = Number(p.lon);
      setStatus(
        '网页请求定位 → 已返回选点 (' +
        (isFinite(lat) ? lat.toFixed(5) : '?') + ', ' +
        (isFinite(lon) ? lon.toFixed(5) : '?') + ')'
      );
    } else if (d.type === 'rewrite') {
      runtime.rewrites++;
      setStatus('已改写网页定位请求参数');
    } else if (d.type === 'request') {
      var url = String(p.url || '');
      runtime.requests.push({ url: url, at: Date.now() });
      if (runtime.requests.length > 30) runtime.requests.shift();
      rememberCourseContext(url);
      var m = url.match(/[?&#]activeId=(\d{6,})/i) || url.match(/[?&#]activePrimaryId=(\d{6,})/i);
      if (m && !runtime.activeId) adoptActiveId(m[1], '页面请求');
      if (/stusignajax/i.test(url)) runtime.lastSignUrl = url;
    } else if (d.type === 'net') {
      // 旁路录制的网络活动（含响应体），用于找 activeId 和排查
      runtime.net.push({
        method: p.method,
        url: p.url,
        status: p.status,
        respLen: p.respLen,
        resp: p.resp,
        at: p.at
      });
      if (runtime.net.length > 40) runtime.net.shift();
      rememberCourseContext(p.url);
      renderNetwork();
    } else if (d.type === 'activeId' && p.activeId) {
      adoptActiveId(p.activeId, '页面接口');
    }
    renderRuntime();
    refreshBadge();
  });

  /** 网络活动列表 */
  function renderNetwork() {
    if (!ui.netLog) return;
    ui.netLog.textContent = '';
    if (!runtime.net.length) {
      ui.netLog.appendChild(el('div', { text: '暂无记录。展开本区块后，在页面上点一下签到、或刷新签到列表，记录就会出现在这里。' }));
      return;
    }
    runtime.net.slice(-12).reverse().forEach(function (r) {
      var short = String(r.url || '').replace(/^https?:\/\/[^/]+/, '');
      if (short.length > 96) short = short.slice(0, 96) + '…';
      var line = el('div', { text: (r.at || '') + '  ' + (r.method || '') + ' ' + (r.status || '') + '  ' + short });
      line.title = r.url + (r.resp ? '\n\n' + String(r.resp).slice(0, 800) : '');
      ui.netLog.appendChild(line);
    });
  }

  /** 跨框架点名：把页面里每一层框架的情况都列出来 */
  function showFrames() {
    setStatus('正在点名所有框架…', 'busy');
    chrome.runtime.sendMessage({ type: 'inspectFrames' }, function (res) {
      if (!res || !res.ok) {
        setStatus('点名失败：' + ((res && res.error) || '后台无响应'), 'err');
        return;
      }
      var frames = res.frames || [];
      if (!frames.length) {
        setStatus('没有框架回应。当前框架地址：' + currentUrl().slice(0, 120), 'err');
        return;
      }
      var lines = frames.map(function (f, i) {
        return '[' + i + '] ' + (f.hookReady ? '钩子✓' : '钩子✗') +
          (f.hasSignText ? ' 含签到✓' : '') +
          (f.activeIdCandidate ? ' activeId=' + f.activeIdCandidate : '') +
          '\n    ' + (f.url || '').slice(0, 110) +
          (f.textSample ? '\n    正文：' + f.textSample.slice(0, 70) : '');
      });
      setStatus('共 ' + frames.length + ' 个框架：\n' + lines.join('\n'), 'ok');
      // 顺手把结果也塞进诊断快照
      runtime.lastFrameReport = frames;
    });
  }

  /** 把当前页面的诊断信息复制到剪贴板，方便贴给他人排查 */
  function copyDiagnostics(btn) {
    var snap = {
      时间: new Date().toISOString(),
      页面: location.href,
      是否顶层: IS_TOP,
      本框架是否挂了UI: !!(overlay && overlay.host && document.documentElement.contains(overlay.host)),
      本框架是否值班: overlay ? overlay.fab.style.display !== 'none' : null,
      本框架是否签到界面: isSignFrame(),
      本页iframe: listFrames(),
      跨框架点名结果: runtime.lastFrameReport || '（没点过名，点一下「看本页有哪些框架」）',
      activeId: runtime.activeId || null,
      activeId来源活动: runtime.activeName || null,
      签到方式: runtime.mode + (runtime.modePickedByUser ? '（手动）' : ''),
      活动类型: runtime.activeKind ? runtime.activeKind.label : '（未识别）',
      图片: runtime.photo
        ? { 文件名: runtime.photo.name, 类型: runtime.photo.type, 字节: runtime.photo.size, objectId: runtime.photo.objectId || null }
        : null,
      activeId查询次数时间: runtime.activeLookupAt ? new Date(runtime.activeLookupAt).toISOString() : '（还没查过）',
      courseId: runtime.courseId || null,
      classId: runtime.classId || null,
      fid: runtime.fid || null,
      uid: runtime.uid || null,
      选点: point ? { lat: point.lat, lon: point.lon, datum: point.datum, address: point.address } : null,
      定位调用次数: runtime.geoHits,
      参数改写次数: runtime.rewrites,
      状态: runtime.status,
      勾子已装: !!window.__CXL_MAIN_READY,
      网络记录: runtime.net.slice(-20),
      捕获的签到请求: runtime.requests.slice(-10).map(function (x) { return x.url; }),
      页面特征: {
        正文前200字: (function () {
          try { return (document.body && document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 200); } catch (e) { return ''; }
        })(),
        有签到二字: /签到/.test(document.body ? document.body.innerText.slice(0, 20000) : ''),
        提示用移动端: /移动端|手机提供位置/.test(document.body ? document.body.innerText.slice(0, 20000) : ''),
        脚本数: document.scripts ? document.scripts.length : 0,
        activeId候选: (function () {
          var html = document.documentElement.innerHTML;
          var m = html.match(/activePrimaryId["'\s:=]+(\d{6,})/) || html.match(/activeId["'\s:=]+(\d{6,})/);
          return m ? m[1] : null;
        })()
      }
    };
    var text = JSON.stringify(snap, null, 2);
    var done = function (okText) {
      if (btn) {
        var old = btn.textContent;
        btn.textContent = okText;
        setTimeout(function () { btn.textContent = old; }, 1800);
      }
    };
    try {
      navigator.clipboard.writeText(text).then(function () { done('已复制 ✓'); }, function () { fallbackCopy(text, done); });
    } catch (e) {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
      (document.body || document.documentElement).appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      done('已复制 ✓');
    } catch (e) {
      done('复制失败，请手动选择');
    }
  }

  // status 文字统一由下面的 setStatus(text, kind) 处理（函数声明提升，可直接用）

  // ---------- 面板样式（放在 shadow root 里，避免被页面样式污染） ----------

  var CSS = [
    ':host { all: initial; }',
    '* { box-sizing: border-box; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; }',
    '.fab { position: fixed; right: 18px; bottom: 90px; z-index: 2147483000; width: 52px; height: 52px;',
    '  border-radius: 50%; border: none; cursor: pointer; background: #2f6fed; color: #fff;',
    '  box-shadow: 0 6px 18px rgba(0,0,0,.28); font-size: 11px; line-height: 1.1; font-weight: 600; }',
    '.fab:hover { background: #265fd0; }',
    '.fab.on { background: #1f9d55; }',
    '.fab.sub { background: #7a5af8; }',
    '.fab.sub.on { background: #6a4ae0; }',
    '.panel { position: fixed; right: 18px; bottom: 152px; z-index: 2147483001; width: 400px; max-width: calc(100vw - 36px);',
    '  background: #fff; border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.32); overflow: hidden;',
    '  display: flex; flex-direction: column; color: #1b1f24; font-size: 13px; }',
    '.panel[hidden] { display: none; }',
    '.hd { display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: #f5f7fb; border-bottom: 1px solid #e3e8f0; }',
    '.hd b { font-size: 14px; }',
    '.hd .sp { flex: 1; }',
    '.hd button { border: none; background: transparent; cursor: pointer; font-size: 15px; color: #5a6572; padding: 2px 6px; border-radius: 6px; }',
    '.hd button:hover { background: #e6ebf4; }',
    '.mapwrap { position: relative; height: 268px; background: #eef2f4; }',
    '.mapwrap .map { position: absolute; inset: 0; }',
    '.zoom { position: absolute; right: 8px; top: 8px; display: flex; flex-direction: column; gap: 4px; z-index: 2; }',
    '.zoom button { width: 30px; height: 30px; border: none; border-radius: 6px; background: rgba(255,255,255,.94); cursor: pointer; font-size: 16px; line-height: 1; color: #22303f; box-shadow: 0 1px 4px rgba(0,0,0,.2); }',
    '.zoom button:hover { background: #fff; }',
    '.tip { position: absolute; left: 8px; top: 8px; z-index: 2; background: rgba(28,36,48,.78); color: #fff; padding: 4px 8px; border-radius: 6px; font-size: 11px; }',
    '.coord { position: absolute; left: 8px; bottom: 8px; z-index: 2; background: rgba(28,36,48,.78); color: #fff; padding: 4px 8px; border-radius: 6px; font-size: 11px; font-variant-numeric: tabular-nums; }',
    '.bd { padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; max-height: 46vh; overflow: auto; }',
    '.row { display: flex; gap: 6px; align-items: center; }',
    '.row label { color: #4a5563; min-width: 62px; font-size: 12px; }',
    'input[type=text], input[type=number], select, textarea { flex: 1; min-width: 0; padding: 5px 7px; border: 1px solid #cfd7e3; border-radius: 6px; font-size: 12px; color: #1b1f24; background: #fff; }',
    'textarea { resize: vertical; min-height: 34px; }',
    'button.btn { border: none; border-radius: 7px; padding: 7px 10px; cursor: pointer; font-size: 12px; background: #e9eef7; color: #22303f; }',
    'button.btn:hover { background: #dde5f3; }',
    'button.btn.primary { background: #2f6fed; color: #fff; font-weight: 600; }',
    'button.btn.primary:hover { background: #265fd0; }',
    'button.btn.ghost { background: transparent; border: 1px dashed #cfd7e3; }',
    '.chips { display: flex; flex-wrap: wrap; gap: 6px; }',
    '.chip { border: 1px solid #cfd7e3; background: #fff; border-radius: 999px; padding: 4px 9px; cursor: pointer; font-size: 11px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.chip:hover { border-color: #2f6fed; color: #2f6fed; }',
    '.chip.cur { background: #2f6fed; color: #fff; border-color: #2f6fed; }',
    '.meta { font-size: 11px; color: #6b7787; line-height: 1.6; word-break: break-all; }',
    '.meta code { background: #f2f5fa; padding: 1px 4px; border-radius: 4px; }',
    '.modes { display: flex; gap: 0; border: 1px solid #cfd7e3; border-radius: 8px; overflow: hidden; }',
    '.modes button { flex: 1; border: none; background: #fff; padding: 7px 8px; cursor: pointer; font-size: 12px; color: #33415c; }',
    '.modes button + button { border-left: 1px solid #e3e8f0; }',
    '.modes button.cur { background: #2f6fed; color: #fff; font-weight: 600; }',
    '.modes button .k { font-size: 10px; opacity: .75; margin-left: 4px; }',
    '.drop { border: 1px dashed #b9c6d9; border-radius: 10px; padding: 12px; text-align: center; background: #fafbfd; cursor: pointer; }',
    '.drop:hover { border-color: #2f6fed; background: #f5f8ff; }',
    '.drop.over { border-color: #2f6fed; background: #eef4ff; box-shadow: 0 0 0 2px rgba(47,111,237,.25) inset; }',
    '.drop.has { border-style: solid; border-color: #b7d5c2; background: #f6fbf8; }',
    '.panel.dragging { outline: 2px dashed #2f6fed; outline-offset: -3px; }',
    '.drop b { display: block; font-size: 12px; color: #22303f; margin-bottom: 2px; }',
    '.drop .meta { font-size: 11px; }',
    '.thumb { display: block; max-width: 100%; max-height: 150px; margin: 6px auto 0; border-radius: 8px; }',
    // 作者样式里的 display:block 会盖掉浏览器默认的 [hidden]{display:none}，
    // 不显式再写一条的话，没选图时会出现"破图标 + alt 文字"
    '.thumb[hidden] { display: none; }',
    '.hint { font-size: 11px; color: #6b7787; line-height: 1.6; }',
    '.hint.warn { color: #8a5a00; background: #fff6e5; padding: 6px 8px; border-radius: 7px; }',
    '.status { font-size: 12px; padding: 7px 9px; border-radius: 7px; background: #f2f5fa; color: #33415c; white-space: pre-wrap; word-break: break-all; }',
    '.status.ok { background: #e6f7ed; color: #12683c; }',
    '.status.err { background: #fdecec; color: #a3241f; }',
    '.status.busy { background: #fff6e5; color: #8a5a00; }',
    '.ft { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid #e3e8f0; background: #fafbfd; }',
    '.ft button { flex: 1; }',
    '.sec { border-top: 1px dashed #e3e8f0; padding-top: 8px; margin-top: 2px; }',
    '.sec > summary { cursor: pointer; font-size: 12px; color: #4a5563; outline: none; }',
    '.sw { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #4a5563; }',
    '.toast { position: fixed; right: 18px; bottom: 152px; z-index: 2147483002; background: #1b1f24; color: #fff; padding: 8px 12px; border-radius: 8px; font-size: 12px; opacity: .96; max-width: 360px; }',
    '.mask { position: fixed; inset: 0; z-index: 2147483003; background: rgba(15,20,28,.38); display: flex; align-items: center; justify-content: center; }',
    '.dlg { background: #fff; border-radius: 12px; padding: 16px; width: 320px; box-shadow: 0 16px 44px rgba(0,0,0,.34); }',
    '.dlg h3 { margin: 0 0 10px; font-size: 14px; color: #1b1f24; font-weight: 600; }',
    '.dlg p { margin: 0 0 12px; font-size: 13px; color: #3c4759; line-height: 1.6; }',
    '.dlg input { width: 100%; padding: 7px 9px; border: 1px solid #cfd7e3; border-radius: 7px; font-size: 13px; margin-bottom: 12px; }',
    '.dlg .acts { display: flex; gap: 8px; justify-content: flex-end; }',
    '.dlg .acts button { padding: 7px 14px; font-size: 13px; }'
  ].join('\n');

  function el(tag, props, children) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        if (k === 'style') node.style.cssText = props[k];
        else if (k === 'text') node.textContent = props[k];
        else if (k === 'html') node.innerHTML = props[k];
        else if (k.indexOf('on') === 0 && typeof props[k] === 'function') node.addEventListener(k.slice(2), props[k]);
        else if (props[k] !== null && props[k] !== undefined) node.setAttribute(k, props[k]);
      });
    }
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  // ---------- 构建面板 ----------

  function buildOverlay() {
    if (document.getElementById(HOST_ID)) return false;
    if (!isRelevantFrame()) return false;   // 无关的页面不挂 UI
    var host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'all: initial;';
    var root = host.attachShadow({ mode: 'open' });
    var style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);

    var fab = el('button', { class: 'fab', title: '学习通自由选点签到（本页面是子框架）', text: IS_TOP ? '选点\n签到' : '子框架\n选点' });
    fab.addEventListener('click', function () { togglePanel(); });

    // ---- 地图 ----
    var mapBox = el('div', { class: 'map' });
    var coordLabel = el('div', { class: 'coord', text: '--' });
    var mapwrap = el('div', { class: 'mapwrap' }, [
      mapBox,
      el('div', { class: 'tip', text: '拖动地图移动，单击落点' }),
      el('div', { class: 'zoom' }, [
        el('button', { text: '+', title: '放大', onclick: function () { map.zoomIn(); } }),
        el('button', { text: '−', title: '缩小', onclick: function () { map.zoomOut(); } })
      ]),
      coordLabel
    ]);

    // ---- 表单 ----
    var latInput = el('input', { type: 'text', placeholder: '纬度 lat，如 30.123456' });
    var lonInput = el('input', { type: 'text', placeholder: '经度 lon，如 120.123456' });
    var addressInput = el('input', { type: 'text', placeholder: '签到地址（会显示给老师）' });
    var activeIdInput = el('input', { type: 'text', placeholder: '签到 activeId（留空即自动获取）' });
    var fidInput = el('input', { type: 'text', placeholder: '学校 fid（可留空）' });
    var nameInput = el('input', { type: 'text', placeholder: '姓名（留空则由服务端推断）' });
    var datumSelect = el('select', {}, [
      el('option', { value: 'gcj02', text: 'GCJ-02 高德/腾讯（推荐）' }),
      el('option', { value: 'wgs84', text: 'WGS-84 原始 GPS' }),
      el('option', { value: 'bd09', text: 'BD-09 百度' })
    ]);
    var status = el('div', { class: 'status', text: '待命' });
    var meta = el('div', { class: 'meta' });
    var chips = el('div', { class: 'chips' });

    // ---- 拍照签到：从本地选图 / 拖进来 / Ctrl+V 粘贴 ----
    var photoFile = el('input', { type: 'file', accept: 'image/*', style: 'display:none;' });
    var photoImg = el('img', { class: 'thumb', alt: '待提交的图片' });
    photoImg.hidden = true;
    var photoTitle = el('b', { text: '点这里选图片（或把图片拖进来 / Ctrl+V 粘贴）' });
    var photoHint = el('div', { class: 'meta', text: '支持 jpg / png / webp，单张不超过 10 MB' });
    var photoDrop = el('div', { class: 'drop', title: '点击选择本地图片，也可以直接拖拽或粘贴' }, [
      photoTitle, photoHint, photoImg
    ]);
    photoDrop.addEventListener('click', function () {
      if (photoFile.__proxyClick) photoFile.__proxyClick();
      else { try { photoFile.click(); } catch (e) { /* ignore */ } }
    });
    // 关键：dragover 必须 preventDefault，否则浏览器不会派发 drop 事件
    photoDrop.addEventListener('dragover', function (e) {
      e.preventDefault();
      if (e.dataTransfer) { try { e.dataTransfer.dropEffect = 'copy'; } catch (err) { /* ignore */ } }
      markDragOver(true);
    });
    photoDrop.addEventListener('dragenter', function (e) {
      e.preventDefault();
      markDragOver(true);
    });
    photoDrop.addEventListener('dragleave', function (e) {
      // 鼠标在框内子元素之间移动时 dragleave 也会触发，只有真正离开框才取消高亮
      var to = e.relatedTarget;
      if (to && photoDrop.contains && photoDrop.contains(to)) return;
      markDragOver(false);
    });
    photoDrop.addEventListener('drop', function (e) {
      e.preventDefault();
      markDragOver(false);
      var f = fileFromDrop(e);
      if (f) pickPhotoFile(f, '拖进来的图片');
      else flash('没读到拖进来的文件：请拖图片文件（jpg/png/webp），或用「点这里选图片」', 'err');
    });
    photoFile.addEventListener('change', function () {
      var f = photoFile.files && photoFile.files[0];
      if (f) pickPhotoFile(f, '本地文件');
    });

    var photoStatus = el('div', { class: 'hint' });    var photoClearBtn = el('button', { class: 'btn ghost', text: '清除图片', onclick: function () { clearPhoto(); } });
    var photoUploadBtn = el('button', { class: 'btn', text: '只上传图片', title: '只把图片传上去换 objectId，不提交签到', onclick: function () { uploadPickedPhoto({ manual: true }); } });
    var photoRow = el('div', { class: 'row' }, [photoUploadBtn, photoClearBtn]);

    // ---- 模式切换：位置 / 拍照（合并成一个面板，按活动类型自动切） ----
    var modeLocBtn = el('button', { text: '位置签到', onclick: function () { setMode('location', true); } });
    var modePhotoBtn = el('button', { text: '拍照签到', onclick: function () { setMode('photo', true); } });
    var modeRow = el('div', { class: 'modes' }, [modeLocBtn, modePhotoBtn]);
    var modeHint = el('div', { class: 'hint' });

    /**
     * 高亮"可以把图片丢进来"的状态。
     * 用计数而不是布尔：dragenter 会在每个子元素上重入一次，
     * 布尔量会被子元素的 dragleave 提前清掉，看起来就像"拖不进去"。
     */
    function markDragOver(on) {
      setDragHint(on);
    }

    function setDropClass() {
      if (!photoDrop || !photoDrop.classList) return;
      if (runtime.photo) photoDrop.classList.add('has');
      else photoDrop.classList.remove('has');
      if (dragDepth) photoDrop.classList.add('over');
      else photoDrop.classList.remove('over');
    }

    var applyBtn = el('button', { class: 'btn', text: '解析输入', onclick: function () {
      var p = CXL.parseLatLon((latInput.value || '') + ',' + (lonInput.value || ''));
      if (!p) { flash('坐标格式无法识别', 'err'); return; }
      setPoint(p[0], p[1], addressInput.value, 'manual');
    } });


    var searchBtn = el('button', { class: 'btn', text: '按地址搜索', onclick: function () { doGeocode(); } });
    var savePresetBtn = el('button', { class: 'btn ghost', text: '+ 存为常用点', onclick: function () { savePreset(); } });
    var fetchActiveIdBtn = el('button', { class: 'btn', text: '自动获取', title: '向课程活动列表查询当前进行中的签到编号', onclick: function () { lookupActiveId({}); } });
    var refreshBtn = el('button', { class: 'btn', text: '刷新识别', title: '重新扫描页面；页面上没有就向课程活动列表查询', onclick: function () { rescanAll(); } });
    var locateBtn = el('button', { class: 'btn', text: '用本机真实位置', onclick: function () { useRealLocation(); } });
    var keyInput = el('input', { type: 'text', placeholder: '高德 Web 服务 key（用于地址搜索，可留空）', value: settings.amapKey || '' });
    var keySave = el('button', { class: 'btn', text: '保存 key', onclick: function () {
      CXL.saveSettings({ amapKey: keyInput.value.trim() }).then(function () { flash('已保存'); });
    } });

    var adv = el('details', { class: 'sec' }, [
      el('summary', { text: '高级设置 / 请求参数' }),
      el('div', { class: 'row', style: 'margin-top:8px;' }, [el('label', { text: '坐标系' }), datumSelect]),
      el('div', { class: 'row' }, [el('label', { text: 'activeId' }), activeIdInput]),
      el('div', { class: 'row' }, [el('label', { text: 'fid' }), fidInput]),
      el('div', { class: 'row' }, [el('label', { text: '姓名' }), nameInput]),
      el('div', { class: 'row' }, [el('label', { text: '高德 key' }), keyInput, keySave]),
      el('div', { class: 'row', style: 'margin-top:4px;' }, [fetchActiveIdBtn, refreshBtn, locateBtn]),
      el('div', { class: 'meta', text: 'activeId 会自动获取：先看页面请求，再直接向当前课程的「活动列表」接口查询进行中的签到。查不到时才需要手填。' })
    ]);

    // 「识别不到 activeId」时的兜底：把签到消息/链接整段粘进来，自动抽出参数
    var pasteInput = el('textarea', { placeholder: '把老师发的签到消息、或签到页面的链接整段粘到这里，点右边按钮自动识别' });
    var pasteBtn = el('button', { class: 'btn', text: '解析', onclick: function () { applyPasted(); } });
    var pasteBox = el('details', { class: 'sec' }, [
      el('summary', { text: '识别不到签到编号？把签到消息/链接粘进来' }),
      el('div', { class: 'row', style: 'margin-top:8px; align-items:flex-start;' }, [pasteInput, pasteBtn]),
      el('div', { class: 'meta', text: '从文本里自动抽出 activeId / fid / courseId / classId / uid。识别成功后会自动填进上面的输入框。' })
    ]);

    // 网络活动：网页版位置签到会被服务端挡掉（提示"请使用移动端"），
    // 所以需要看清这个页面到底调了哪些接口，才能拿到 activeId
    var netLog = el('div', { class: 'meta', style: 'max-height:150px; overflow:auto; margin-top:6px;' });
    var copyBtn = el('button', { class: 'btn', text: '复制诊断信息', onclick: function () { copyDiagnostics(copyBtn); } });
    var netBtn = el('button', { class: 'btn', text: '刷新记录', onclick: function () { renderNetwork(); } });
    var frameBtn = el('button', { class: 'btn', text: '看本页有哪些框架', onclick: function () { showFrames(); } });
    var netBox = el('details', { class: 'sec' }, [
      el('summary', { text: '网络活动记录（找 activeId 用）' }),
      el('div', { class: 'row', style: 'margin-top:8px;' }, [netBtn, frameBtn, copyBtn]),
      netLog
    ]);

    // 位置签到区（地图 + 坐标 + 地址）与拍照签到区（选图）二选一显示
    var locSections = [
      chips,
      el('div', { class: 'row' }, [el('label', { text: '纬度 lat' }), latInput]),
      el('div', { class: 'row' }, [el('label', { text: '经度 lon' }), lonInput]),
      el('div', { class: 'row' }, [applyBtn, searchBtn, savePresetBtn]),
      el('div', { class: 'row' }, [el('label', { text: '签到地址' }), addressInput])
    ];
    var photoSections = [
      photoDrop,
      photoRow,
      photoStatus,
      el('div', { class: 'hint', text: '这一区只负责把图片传上去换 objectId；换好之后点下面的「直接签到」提交。' })
    ];

    var body = el('div', { class: 'bd' }, [
      modeRow,
      modeHint,
      status
    ].concat(locSections, photoSections, [meta, adv, pasteBox, netBox]));

    var preSignBtn = el('button', { class: 'btn', text: '写入页面并让网页签到', onclick: function () { armForPage(); } });
    var dryBtn = el('button', { class: 'btn ghost', text: '试运行', onclick: function () { submit(true); } });
    var signBtn = el('button', { class: 'btn primary', text: '直接签到', onclick: function () { submit(false); } });
    var foot = el('div', { class: 'ft' }, [dryBtn, preSignBtn, signBtn]);

    var closeBtn = el('button', { text: '✕', title: '收起', onclick: function () { togglePanel(false); } });
    var openOpts = el('button', { text: '⚙', title: '扩展设置', onclick: function () {
      try { chrome.runtime.sendMessage({ type: 'openOptions' }); } catch (e) { /* ignore */ }
    } });
    var head = el('div', { class: 'hd' }, [
      el('b', { text: '自由选点 / 拍照签到' }),
      el('span', { class: 'sp' }),
      openOpts,
      closeBtn
    ]);

    // 注意：要在下面的拖放处理之前声明（那些处理会用到它）
    var panel = el('div', { class: 'panel', hidden: 'hidden' }, [head, mapwrap, body, foot]);
    setDropClass();

    root.appendChild(fab);
    root.appendChild(panel);
    (document.body || document.documentElement).appendChild(host);

    overlay = { host: host, root: root, fab: fab, panel: panel, drop: photoDrop };
    ui = {
      latInput: latInput,
      lonInput: lonInput,
      addressInput: addressInput,
      activeIdInput: activeIdInput,
      fidInput: fidInput,
      nameInput: nameInput,
      datumSelect: datumSelect,
      status: status,
      meta: meta,
      chips: chips,
      coordLabel: coordLabel,
      mapwrap: mapwrap,
      locSections: locSections,
      photoSections: photoSections,
      photoDrop: photoDrop,
      photoFile: photoFile,
      photoImg: photoImg,
      photoTitle: photoTitle,
      photoStatus: photoStatus,
      modeRow: modeRow,
      modeLocBtn: modeLocBtn,
      modePhotoBtn: modePhotoBtn,
      modeHint: modeHint,
      signBtn: signBtn,
      panel: panel,
      fetchActiveIdBtn: fetchActiveIdBtn,
      pasteInput: pasteInput,
      netLog: netLog
    };

    // ---- 地图实例 ----
    var map = CXL.createMap(mapBox, {
      onPick: function (lat, lon) {
        setPoint(lat, lon, addressInput.value, 'map');
        reverseGeocode(lat, lon);
      },
      onViewChange: function () { updateCoordLabel(); }
    });
    map.tileTemplate = settings.tileUrl;
    map.tileSubdomains = settings.tileSubdomains;
    map.refresh(); // 模板是创建后才赋值的，这里触发一次重绘让瓦片开始加载
    ui.map = map;

    datumSelect.addEventListener('change', function () {
      CXL.saveSettings({ datum: datumSelect.value }).then(function () {
        settings.datum = datumSelect.value;
        pushConfig();
      });
    });

    // 输入框变化 -> 实时同步
    [latInput, lonInput].forEach(function (input) {
      input.addEventListener('change', function () {
        var p = CXL.parseLatLon((latInput.value || '') + ',' + (lonInput.value || ''));
        if (p) setPoint(p[0], p[1], addressInput.value, 'manual');
      });
    });
    addressInput.addEventListener('change', function () {
      updatePoint({ address: addressInput.value });
    });
    // 记录用户是否正在编辑地址框，避免 syncForm 把输入覆盖掉
    addressInput.addEventListener('focus', function () { ui.addressFocused = true; });
    addressInput.addEventListener('blur', function () { ui.addressFocused = false; });
    activeIdInput.addEventListener('change', function () {
      // 手填的优先级最高：用户明确写了就用它，但写错（太短/非数字）时给个提示
      var v = activeIdInput.value.trim();
      runtime.activeId = v;
      if (v && !CXL.isActiveId(v)) flash('activeId 看起来不对：它是 6 位以上的数字编号', 'err');
    });
    fidInput.addEventListener('change', function () { runtime.fid = fidInput.value.trim(); });
    nameInput.addEventListener('change', function () { runtime.userName = nameInput.value.trim(); });

    if (TEST_HOOK) {
      // 自动化测试用（tools/selftest.mjs 会先在 <html> 上打 data-cxl-test 标记）：
      // 把内部把手临时暴露出来，好让测试驱动"选图 → 上传 → 提交"整条链路，
      // 而不是只测各个函数。普通使用时这个属性不存在，不会暴露任何东西。
      window.__CXL_TEST_HANDLES__ = {
        ui: ui,
        runtime: runtime,
        openPanel: function () { togglePanel(true); }
      };
    }

    return true;
  }

  function togglePanel(force) {
    if (!overlay) return;
    var show = typeof force === 'boolean' ? force : overlay.panel.hasAttribute('hidden');
    if (show) overlay.panel.removeAttribute('hidden');
    else overlay.panel.setAttribute('hidden', 'hidden');
    if (show && ui.map) {
      ui.map.refresh();
      setTimeout(function () { ui.map.refresh(); }, 60);
    }
  }

  function refreshBadge() {
    // settings 是 await 之后才有的值，而 message 监听是同步注册的，
    // 这里必须防空，否则 boot 完成前收到回传会抛 TypeError
    if (!overlay || !settings) return;
    var on = settings.enabled && !!point;
    overlay.fab.className = 'fab' + (on ? ' on' : '') + (IS_TOP ? '' : ' sub');
    overlay.fab.title = (IS_TOP ? '' : '【子框架】') +
      (on
        ? '选点已生效：' + point.lat.toFixed(5) + ', ' + point.lon.toFixed(5)
        : '学习通自由选点签到（尚未选点）');
  }

  // ---------- 选点 ----------

  function setPoint(lat, lon, address, source) {
    var datum = settings.datum;
    point = {
      lat: CXL.round6(lat),
      lon: CXL.round6(lon),
      datum: datum,
      address: address || (point && point.address) || '',
      source: source || 'map'
    };
    CXL.setPoint(point);
    pushConfig();
    syncForm();
    refreshBadge();
  }

  function updatePoint(patch) {
    if (!point) return;
    point = Object.assign({}, point, patch);
    CXL.setPoint(point);
    pushConfig();
    syncForm();
    refreshBadge();
  }

  function syncForm() {
    if (!ui.latInput) return;
    if (point) {
      ui.latInput.value = point.lat.toFixed(6);
      ui.lonInput.value = point.lon.toFixed(6);
      // 地址框：只在用户没在编辑、且框里没内容时才回填，
      // 避免把用户正在输入的地址覆盖掉（影子 DOM 里 activeElement 判断不可靠）
      if (point.address && !ui.addressFocused && !ui.addressInput.value.trim()) {
        ui.addressInput.value = point.address;
      }
      if (ui.map) {
        var c = ui.map.getCenter();
        if (Math.abs(c[0] - point.lat) > 1e-7 || Math.abs(c[1] - point.lon) > 1e-7) {
          ui.map.setView(point.lat, point.lon, settings.defaultZoom);
        }
      }
    } else {
      // 选点被清掉时，输入框也要跟着清空，不能留着旧坐标误导用户
      ui.latInput.value = '';
      ui.lonInput.value = '';
    }
    if (ui.datumSelect) ui.datumSelect.value = settings.datum;
    if (ui.activeIdInput && !ui.activeIdInput.value && runtime.activeId) ui.activeIdInput.value = runtime.activeId;
    if (ui.fidInput && !ui.fidInput.value && runtime.fid) ui.fidInput.value = runtime.fid;
    updateCoordLabel();
    renderPresets();
  }

  function updateCoordLabel() {
    if (!ui.coordLabel) return;
    if (!point) { ui.coordLabel.textContent = '--'; return; }
    ui.coordLabel.textContent =
      point.lat.toFixed(6) + ', ' + point.lon.toFixed(6) +
      '  ·  ' + (point.datum || 'gcj02').toUpperCase() +
      '  ·  z' + (ui.map ? ui.map.getZoom().toFixed(1) : '-');
  }

  // ---------- 常用点 ----------

  function renderPresets() {
    if (!ui.chips) return;
    ui.chips.textContent = '';
    if (!presets.length) {
      ui.chips.appendChild(el('span', { class: 'meta', text: '常用点：暂无（选好点后点「存为常用点」）' }));
      return;
    }
    presets.forEach(function (p, idx) {
      var isCur = point && Math.abs(p.lat - point.lat) < 1e-6 && Math.abs(p.lon - point.lon) < 1e-6;
      var label = (p.name || p.address || (p.lat.toFixed(4) + ',' + p.lon.toFixed(4)));
      var chip = el('button', { class: 'chip' + (isCur ? ' cur' : ''), text: label, title: label + '\n' + p.lat + ', ' + p.lon + '\n连点两下可删除' });
      var timer = null;
      chip.addEventListener('click', function () {
        if (timer) { clearTimeout(timer); timer = null; removePreset(idx); return; }
        timer = setTimeout(function () {
          timer = null;
          setPoint(p.lat, p.lon, p.address, 'preset');
          if (ui.map) ui.map.setView(p.lat, p.lon, settings.defaultZoom);
        }, 220);
      });
      ui.chips.appendChild(chip);
    });
  }

  /**
   * 影子 DOM 里的输入/确认弹窗。
   * 不用 window.prompt / window.confirm：它们在被嵌入的 iframe 里可能被拦截，
   * 而且样式和页面风格不统一。
   */
  function askText(title, defaultValue, onOk) {
    if (!overlay) return;
    var input = el('input', { type: 'text', value: defaultValue || '' });
    var mask = el('div', { class: 'mask' });
    var dlg = el('div', { class: 'dlg' }, [
      el('h3', { text: title }),
      input,
      el('div', { class: 'acts' }, [
        el('button', { class: 'btn', text: '取消', onclick: function () { mask.remove(); } }),
        el('button', { class: 'btn primary', text: '确定', onclick: function () {
          var v = input.value.trim();
          mask.remove();
          onOk(v);
        } })
      ])
    ]);
    mask.appendChild(dlg);
    mask.addEventListener('click', function (e) { if (e.target === mask) mask.remove(); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { var v = input.value.trim(); mask.remove(); onOk(v); }
      if (e.key === 'Escape') mask.remove();
    });
    overlay.root.appendChild(mask);
    setTimeout(function () { input.focus(); input.select(); }, 30);
  }

  function askConfirm(title, message, onOk) {
    if (!overlay) return;
    var mask = el('div', { class: 'mask' });
    mask.appendChild(el('div', { class: 'dlg' }, [
      el('h3', { text: title }),
      el('p', { text: message }),
      el('div', { class: 'acts' }, [
        el('button', { class: 'btn', text: '取消', onclick: function () { mask.remove(); } }),
        el('button', { class: 'btn primary', text: '确定', onclick: function () { mask.remove(); onOk(); } })
      ])
    ]));
    mask.addEventListener('click', function (e) { if (e.target === mask) mask.remove(); });
    overlay.root.appendChild(mask);
  }

  function savePreset() {
    if (!point) { flash('请先在地图上选点', 'err'); return; }
    askText('给这个常用点起个名字', point.address || '我的位置', function (name) {
      if (name === null) return;
      presets.push({
        name: name || '未命名',
        lat: point.lat,
        lon: point.lon,
        datum: point.datum,
        address: point.address || name
      });
      CXL.setPresets(presets).then(function () { renderPresets(); flash('已保存常用点'); });
    });
  }

  function removePreset(idx) {
    var p = presets[idx];
    if (!p) return;
    askConfirm('删除常用点', '确定删除「' + (p.name || p.address || '未命名') + '」吗？', function () {
      presets.splice(idx, 1);
      CXL.setPresets(presets).then(function () { renderPresets(); flash('已删除'); });
    });
  }

  // ---------- 地址解析 ----------

  function doGeocode() {
    var text = ui.addressInput.value.trim();
    if (!text) { flash('请先填写地址', 'err'); return; }
    var direct = CXL.parseLatLon(text);
    if (direct) { setPoint(direct[0], direct[1], text, 'manual'); flash('已按坐标解析'); return; }
    setStatusBusy('正在搜索地址…');
    chrome.runtime.sendMessage({ type: 'geocode', address: text, city: '' }, function (res) {
      if (!res || !res.ok) {
        setStatus((res && res.error) || '地址搜索失败（可在高级设置里填写高德 key）', 'err');
        return;
      }
      setPoint(res.lat, res.lon, res.formatted || text, 'search');
      if (ui.map) ui.map.setView(res.lat, res.lon, settings.defaultZoom);
      setStatus('已定位到：' + (res.formatted || text), 'ok');
    });
  }

  function reverseGeocode(lat, lon) {
    if (!settings.amapKey) return;
    chrome.runtime.sendMessage({ type: 'regeo', lat: lat, lon: lon }, function (res) {
      if (res && res.ok && res.address) updatePoint({ address: res.address });
    });
  }

  function useRealLocation() {
    if (!navigator.geolocation) { flash('浏览器不支持定位', 'err'); return; }
    setStatusBusy('正在获取本机真实位置…');
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        // 注意：页面主世界的定位已被我们劫持，这里用的是扩展隔离世界的原生实现
        setPoint(pos.coords.latitude, pos.coords.longitude, ui.addressInput.value, 'gps');
        if (ui.map) ui.map.setView(pos.coords.latitude, pos.coords.longitude, settings.defaultZoom);
        setStatus('已使用本机真实位置（WGS-84 原始值，如用于国内地图请切换坐标系）', 'ok');
      },
      function (err) {
        setStatus('获取本机位置失败：' + (err && err.message ? err.message : err), 'err');
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }

  // ---------- 页面识别 ----------

  function readCookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  }

  /**
   * 记住当前课程 / 班级 / 学校编号。
   * 这三个是"让扩展自己去问活动列表"的前提，所以除了本框架地址，
   * 也从被钩子捕获的请求地址里补（签到页常被套在 iframe 里，那些参数在子框架地址上）。
   * 地址栏里没有时（点进章节后 courseid 就没了），退一步从页面 HTML 里挖。
   */
  function rememberCourseContext(src) {
    var ctx = CXL.parseCourseContext([src || '', currentUrl()]);
    if (ctx.courseId && !runtime.courseId) runtime.courseId = ctx.courseId;
    if (ctx.classId && !runtime.classId) runtime.classId = ctx.classId;
    if (ctx.fid && !runtime.fid) {
      runtime.fid = ctx.fid;
      if (ui.fidInput && !ui.fidInput.value) ui.fidInput.value = ctx.fid;
    }

    var want = [];
    if (!runtime.courseId) want.push('courseId');
    if (!runtime.classId) want.push('classId');
    if (!runtime.fid) want.push('fid');
    if (!want.length) return;

    var htmlCtx = CXL.parseCourseContextFromHtml(document.documentElement.innerHTML, want);
    if (htmlCtx.courseId && !runtime.courseId) runtime.courseId = htmlCtx.courseId;
    if (htmlCtx.classId && !runtime.classId) runtime.classId = htmlCtx.classId;
    if (htmlCtx.fid && !runtime.fid) {
      runtime.fid = htmlCtx.fid;
      if (ui.fidInput && !ui.fidInput.value) ui.fidInput.value = htmlCtx.fid;
    }
  }

  /** 采纳一个 activeId（页面请求 / 网络响应 / 活动列表查询都能走这里） */
  function adoptActiveId(id, from, name) {
    if (!CXL.isActiveId(id)) return false;
    if (runtime.activeId === String(id)) return false;
    runtime.activeId = String(id);
    if (name) runtime.activeName = name;
    if (ui.activeIdInput) ui.activeIdInput.value = runtime.activeId;
    setStatus('已自动识别到 activeId：' + runtime.activeId +
      (runtime.activeName ? '（' + runtime.activeName + '）' : '') +
      (from ? ' · 来源：' + from : ''), 'ok');
    renderRuntime();
    return true;
  }
  /**
   * 自动获取 activeId：直接问服务端"这个课程现在有哪些签到活动"。
   * 这是识别不到编号时最靠谱的一条路——不依赖页面上有没有签到入口，
   * 也不用用户去翻老师发的签到消息（那是之前唯一的手动兜底）。
   * 只会拿「进行中」的活动，查不到就保持原状，不打扰用户。
   */
  function lookupActiveId(opts) {
    opts = opts || {};
    var cb = typeof opts.done === 'function' ? opts.done : null;
    var quiet = !!opts.quiet;

    if (runtime.lookupBusy) {
      if (cb) cb({ ok: false, busy: true, error: '正在查询中…' });
      return;
    }
    rememberCourseContext('');
    if (!runtime.courseId || !runtime.classId) {
      if (cb) cb({ ok: false, error: '当前页面地址里没有课程/班级编号，请在课程页面里重试' });
      return;
    }

    runtime.lookupBusy = true;
    runtime.activeLookupAt = Date.now();
    if (!quiet) setStatusBusy('正在向课程活动列表查询签到编号…');

    chrome.runtime.sendMessage({
      type: 'lookupActiveId',
      url: currentUrl(),
      courseId: runtime.courseId,
      classId: runtime.classId,
      fid: runtime.fid,
      uid: runtime.uid
    }, function (res) {
      runtime.lookupBusy = false;
      runtime.activeLookupAt = Date.now();
      var err = chrome.runtime.lastError;

      if (err) {
        if (cb) cb({ ok: false, error: '后台没有响应：' + err.message });
        else if (!quiet) setStatus('查询活动列表失败：' + err.message, 'err');
        return;
      }
      if (!res) {
        if (cb) cb({ ok: false, error: '后台没有响应' });
        else if (!quiet) setStatus('查询活动列表失败：后台没有响应', 'err');
        return;
      }

      if (!res.ok) {
        var why = res.error || '未知原因';
        if (cb) cb(res);
        else if (!quiet) setStatus('没能自动取到 activeId：' + why +
          '\n仍可展开「识别不到签到编号？」把老师发的签到消息粘进来解析。', 'err');
        return;
      }

      // 服务端给的 uid / fid 比页面上猜的准，顺手补上
      if (res.uid && !runtime.uid) runtime.uid = String(res.uid);
      if (res.fid && !runtime.fid) { runtime.fid = String(res.fid); if (ui.fidInput && !ui.fidInput.value) ui.fidInput.value = runtime.fid; }

      var changed = adoptActiveId(res.activeId, '课程活动列表', res.name);
      // 活动类型（位置/拍照）由活动列表判定，面板据此自动切到对应的区
      if (res.kind) applyDetectedKind(res.kind);
      if (changed) {
        var k = res.kind;
        var kindMsg = k ? '，类型：' + k.label + '（' + CXL.describeNeeds(k) + '）' : '';
        var hint;
        if (k && !k.canSubmitPlain && !k.needsLocation) {
          hint = '。⚠ 这类签到（' + k.label + '）网页端通常签不了：' +
            (k.needsQr ? '二维码里的 enc 只在老师屏幕上，拿不到' : '需要网页端没有的凭证') +
            '，请用学习通 APP。';
        } else if (k && k.needsLocation) {
          hint = '。这是位置签到：选好点后点「直接签到」。';
        } else if (k && k.needsPhoto) {
          hint = '。老师要求拍照：交图会被服务端校验（网页端多半过不了）；' +
            '可先不交图直接提交试试，不行就用 APP 现场拍。';
        } else {
          hint = '。直接点「直接签到」即可。';
        }
        setStatus('已自动获取到签到编号 activeId = ' + res.activeId +
          (res.name ? '（' + res.name + '）' : '') + kindMsg +
          '，状态：' + (res.label || '进行中') + hint, 'ok');
      }
      refreshBadge();
      if (cb) cb(res);
    });
  }

  /** 「刷新识别」：先扫页面，页面上没有再问一次课程活动列表 */
  function rescanAll() {
    scanPage();
    renderRuntime();
    if (runtime.activeId) {
      if (ui.activeIdInput && !ui.activeIdInput.value) ui.activeIdInput.value = runtime.activeId;
      flash('页面上已识别到 activeId：' + runtime.activeId, 'ok');
      return;
    }
    lookupActiveId({
      done: function (r) {
        if (r && r.ok) flash('已自动获取 activeId：' + r.activeId, 'ok');
        else flash('没能自动取到：' + ((r && r.error) || '未知原因'), 'err');
      }
    });
  }

  /**
   * 把「粘贴进来的签到消息 / 链接」解析成签到参数。
   * 这是识别不到 activeId 时的正经兜底：老师发的签到消息里一定含有它。
   */
  function applyPasted() {
    var text = (ui.pasteInput && ui.pasteInput.value || '').trim();
    if (!text) { flash('请先把签到消息或链接粘进来', 'err'); return; }
    var ctx = CXL.parseSignContext(text);
    if (!ctx.activeId && !ctx.fid && !ctx.courseId) {
      flash('没能从这段文本里识别出签到编号，请确认粘的是签到消息/链接', 'err');
      return;
    }
    if (ctx.activeId) adoptActiveId(ctx.activeId, '粘贴解析');
    if (ctx.fid) {
      runtime.fid = ctx.fid;
      ui.fidInput.value = ctx.fid;
    }
    if (ctx.uid && !runtime.uid) runtime.uid = ctx.uid;
    if (ctx.name && !ui.nameInput.value) ui.nameInput.value = ctx.name;
    if (ctx.courseId) runtime.courseId = ctx.courseId;
    if (ctx.classId) runtime.classId = ctx.classId;
    renderRuntime();
    flash('已识别：' + [
      ctx.activeId ? 'activeId=' + ctx.activeId : '',
      ctx.fid ? 'fid=' + ctx.fid : '',
      ctx.courseId ? 'courseId=' + ctx.courseId : '',
      ctx.classId ? 'classId=' + ctx.classId : ''
    ].filter(Boolean).join('  '), 'ok');
  }

  /** 从页面里尽量挖出 activeId / fid / 姓名 / uid / 课程编号 */
  function scanPage() {
    try {
      if (!runtime.uid) runtime.uid = readCookie('_uid') || readCookie('UID') || '';
      rememberCourseContext('');
      if (!runtime.fid) {
        var fm = location.href.match(/[?&]fid=(\d+)/) || document.documentElement.innerHTML.match(/[?&]fid=(\d+)/);
        if (fm) runtime.fid = fm[1];
      }
      if (!runtime.activeId) {
        var html = document.documentElement.innerHTML;
        var am =
          html.match(/activePrimaryId["'\s:=]+(\d{5,})/i) ||
          html.match(/activeId["'\s:=]+(\d{5,})/i) ||
          html.match(/[?&]activeId=(\d{5,})/i);
        if (am) runtime.activeId = am[1];
      }
      if (!runtime.userName) {
        var nm = document.documentElement.innerHTML.match(/"(?:userName|name|realName)"\s*:\s*"([^"]{1,20})"/);
        if (nm) runtime.userName = nm[1];
      }
      // 找出页面上所有可能是签到入口的链接（只取一次，避免重复累积）
      if (!runtime.linksScanned) {
        runtime.linksScanned = true;
        var links = Array.prototype.slice.call(document.querySelectorAll('a[href]'))
          .map(function (a) { return a.href; })
          .filter(function (h) { return /sign|active|kaoqin|checkin/i.test(h); })
          .slice(0, 5);
        if (links.length) {
          runtime.requests = runtime.requests.concat(links.map(function (u) { return { url: u, at: Date.now() }; }));
        }
      }
    } catch (e) { /* ignore */ }
  }

  function renderRuntime() {
    if (!ui.meta) return;
    var lines = [];
    lines.push('activeId：' + (runtime.activeId
      ? runtime.activeId + (runtime.activeName ? '（' + runtime.activeName + '）' : '') + ' · 自动识别'
      : '未识别到（点上面的「自动获取」或手填）'));
    lines.push('签到方式：' + (runtime.mode === 'photo' ? '拍照签到' : '位置签到') +
      (runtime.activeKind && runtime.activeKind.key !== 'unknown' ? '（活动类型：' + runtime.activeKind.label + '）' : '') +
      (runtime.modePickedByUser ? ' · 手动指定' : ''));
    if (runtime.mode === 'photo') {
      lines.push('图片：' + (runtime.photo
        ? runtime.photo.name + '（' + (runtime.photo.size / 1024).toFixed(0) + ' KB）' +
          (runtime.photo.objectId ? ' · objectId=' + runtime.photo.objectId : ' · 尚未上传')
        : '未选择'));
    }
    lines.push('fid：' + (runtime.fid || '未识别') + ' · 课程：' + (runtime.courseId || '未识别') + ' · 班级：' + (runtime.classId || '未识别'));
    lines.push('uid：' + (runtime.uid || '未识别'));
    lines.push('姓名：' + (runtime.userName || '未识别（留空时服务端会用自己的账号名）'));
    lines.push('页面定位调用：' + runtime.geoHits + ' 次 · 参数改写：' + runtime.rewrites + ' 次');
    lines.push('网络记录：' + runtime.net.length + ' 条' + (runtime.net.length ? '（见下方「网络活动记录」）' : ''));
    if (runtime.lastSignUrl) lines.push('捕获到最后一次签到请求：' + runtime.lastSignUrl.slice(0, 120));
    ui.meta.textContent = lines.join('\n');
  }

  function setStatus(text, kind) {
    runtime.status = text;
    if (!ui.status) {
      // 面板还没建好或已销毁：只记录，等面板挂载时再渲染
      if (ui.meta) renderRuntime();
      return;
    }
    ui.status.textContent = text;
    ui.status.className = 'status' + (kind ? ' ' + kind : '');
  }

  function setStatusBusy(text) { setStatus(text, 'busy'); }

  function flash(text, kind) {
    setStatus(text, kind);
    if (!overlay) return;
    var t = el('div', { class: 'toast', text: text });
    overlay.root.appendChild(t);
    setTimeout(function () { t.remove(); }, 2600);
  }

  // ---------- 两种签到方式 ----------

  /** 方式 A：把选点写入页面定位钩子，然后让网页自己去点签到 */
  function armForPage() {
    if (!point) { flash('请先在地图上选点', 'err'); return; }
    settings.enabled = true;
    pushConfig();
    CXL.saveSettings({ enabled: true }).then(refreshBadge);
    setStatus(
      '已把选点写入页面定位：现在去点网页上的「签到」按钮即可。\n' +
      '如果网页不弹定位、或签到后仍显示位置不符，请改用「直接签到」。',
      'ok'
    );
    // 尝试自动点击页面上的签到按钮（最佳努力，失败不影响）
    var btn = findSignButton();
    if (btn) {
      btn.click();
      setStatus('已把选点写入页面，并自动点击了页面上疑似「签到」的按钮。', 'ok');
    }
  }

  function findSignButton() {
    var nodes = document.querySelectorAll('a,button,div[onclick],span[onclick],li');
    for (var i = 0; i < nodes.length; i++) {
      var t = (nodes[i].textContent || '').trim();
      if (t.length <= 6 && /^(签到|马上签到|立即签到|点击签到|去签到)$/.test(t)) {
        var r = nodes[i].getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return nodes[i];
      }
    }
    return null;
  }

  /** 方式 B：直接用账号 Cookie 调签到接口 */
  // ---------- 拍照签到（本地图片） ----------

  /**
   * 选完图先本地校验 + 读成 dataURL。
   * 校验放在这里是为了让用户在"选图那一刻"就知道图片行不行，
   * 而不是点了签到、转了半天才报错。
   */
  function pickPhotoFile(file, from) {
    if (!file) return;
    var check = CXL.validatePhoto({ size: file.size, type: file.type, name: file.name });
    if (!check.ok) {
      flash(check.error, 'err');
      renderPhoto();
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      runtime.photo = {
        name: CXL.photoFileName(file.name, file.type),
        type: file.type || 'image/jpeg',
        size: file.size,
        dataUrl: String(reader.result || ''),
        objectId: ''
      };
      renderPhoto();
      setStatus('已选好图片：' + runtime.photo.name + '（' + (file.size / 1024).toFixed(0) + ' KB，来自' + (from || '本地') +
        '）。点下面的「' + (runtime.mode === 'photo' ? '上传并签到' : '直接签到') + '」会自动先上传再提交。', 'ok');
    };
    reader.onerror = function () { flash('读取图片失败，换一张试试', 'err'); };
    reader.readAsDataURL(file);
  }

  function clearPhoto() {
    runtime.photo = null;
    if (ui.photoFile && 'value' in ui.photoFile) ui.photoFile.value = '';
    renderPhoto();
    setStatus('已清除图片。');
  }

  function renderPhoto() {
    if (!ui.photoDrop) return;
    var p = runtime.photo;
    if (ui.photoDrop.classList) {
      if (p) ui.photoDrop.classList.add('has');
      else ui.photoDrop.classList.remove('has');
    }
    if (ui.photoImg) {
      if (p && p.dataUrl) { ui.photoImg.src = p.dataUrl; ui.photoImg.hidden = false; }
      else { ui.photoImg.removeAttribute('src'); ui.photoImg.hidden = true; }
    }
    if (ui.photoTitle) {
      ui.photoTitle.textContent = dragDepth
        ? '松手就用这张图'
        : (p ? '已选：' + p.name : '点这里选图片（或把图片拖进来 / Ctrl+V 粘贴）');
    }
    if (ui.photoStatus) {
      var size = p ? (p.size / 1024).toFixed(0) + ' KB' : '';
      var state = !p ? '还没选图片'
        : (runtime.photoUploading ? '正在上传…'
          : (p.objectId ? '已上传，objectId = ' + p.objectId : '已选好，尚未上传'));
      ui.photoStatus.textContent = p ? (state + ' · ' + p.name + ' · ' + size) : state;
      ui.photoStatus.className = 'hint' + (p && p.objectId ? '' : ' warn');
    }
  }

  /**
   * 把选好的图片传到学习通网盘，拿回 objectId（拍照签到真正要提交的东西）。
   * 上传成功后的 objectId 会缓存住：重复点签到不用重复上传。
   */
  function uploadPickedPhoto(opts) {
    opts = opts || {};
    var p = runtime.photo;
    if (!p) {
      if (opts.manual) flash('先选一张图片', 'err');
      if (opts.done) opts.done({ ok: false, error: '还没选图片' });
      return;
    }
    if (p.objectId && !opts.force) {
      if (opts.done) opts.done({ ok: true, objectId: p.objectId, cached: true });
      return;
    }
    if (runtime.photoUploading) {
      if (opts.done) opts.done({ ok: false, error: '正在上传中…' });
      return;
    }
    runtime.photoUploading = true;
    renderPhoto();
    if (opts.manual) setStatusBusy('正在上传图片（换 objectId）…');

    chrome.runtime.sendMessage({
      type: 'uploadPhoto',        // 注意别用 type 传图片 MIME：会被这个字段覆盖掉
      dataUrl: p.dataUrl,
      name: p.name,
      mime: p.type,
      uid: runtime.uid || ''
    }, function (res) {
      runtime.photoUploading = false;
      var err = chrome.runtime.lastError;
      if (err) {
        renderPhoto();
        if (opts.done) opts.done({ ok: false, error: '后台没有响应：' + err.message });
        else setStatus('上传失败：' + err.message, 'err');
        return;
      }
      if (!res || !res.ok) {
        renderPhoto();
        var why = (res && res.error) || '上传失败';
        if (opts.done) opts.done({ ok: false, error: why });
        else setStatus('上传失败：' + why, 'err');
        return;
      }
      if (runtime.photo) runtime.photo.objectId = res.objectId;
      if (res.uid && !runtime.uid) runtime.uid = String(res.uid);
      renderPhoto();
      setStatus('图片已上传，objectId = ' + res.objectId + '。现在点「' + signActionName() + '」提交即可。', 'ok');
      if (opts.done) opts.done({ ok: true, objectId: res.objectId });
    });
  }

  /** 从剪贴板里抓图片：Ctrl+V 直接贴进来 */
  document.addEventListener('paste', function (e) {
    if (!overlay || overlay.panel.hasAttribute('hidden')) return;
    if (runtime.mode !== 'photo') return;
    var items = (e.clipboardData && e.clipboardData.items) || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].type && items[i].type.indexOf('image/') === 0) {
        var f = items[i].getAsFile && items[i].getAsFile();
        if (f) {
          pickPhotoFile(f, '剪贴板');
          e.preventDefault();
        }
        return;
      }
    }
  });

  /**
   * 拖放的兜底接盘：把接收面从那个小方框扩大到"整个面板"。
   * 只在面板范围内生效（判断落点是否在面板里），拖到页面别处一概不管。
   * 用捕获阶段监听，避免被页面自己的 drag 处理抢先消费掉。
   */
  function isOverPanel(e) {
    if (!overlay || overlay.panel.hasAttribute('hidden')) return false;   // 面板没开：完全不插手
    var panel = overlay.panel;
    if (!panel.getBoundingClientRect) return false;
    var r = panel.getBoundingClientRect();
    if (!r || !r.width || !r.height) return false;   // 拿不到布局信息就当作不在面板里
    return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  }

  document.addEventListener('dragover', function (e) {
    if (!isOverPanel(e)) return;
    e.preventDefault();               // 不阻止默认行为，浏览器就不会派发 drop
    if (e.dataTransfer) { try { e.dataTransfer.dropEffect = 'copy'; } catch (err) { /* ignore */ } }
    setDragHint(true);
  }, true);

  document.addEventListener('dragleave', function (e) {
    if (isOverPanel(e)) return;
    setDragHint(false);
  }, true);

  document.addEventListener('drop', function (e) {
    if (!isOverPanel(e)) return;      // 面板外的拖放不插手，交回给页面
    e.preventDefault();
    setDragHint(false);
    var f = fileFromDrop(e);
    if (f) {
      if (runtime.mode !== 'photo') {
        setMode('photo', true);       // 用户把图拖进来了，说明就是要交照片
      }
      pickPhotoFile(f, '拖进来的图片');
    } else {
      flash('没读到拖进来的文件：请拖图片文件（jpg/png/webp），或用「点这里选图片」', 'err');
    }
  }, true);

  // ---------- 模式切换（位置 / 拍照合并成一个面板） ----------

  /** 底部主按钮在两种模式下的叫法 */
  function signActionName() {
    return runtime.mode === 'photo' ? '上传并签到' : '直接签到';
  }

  function setMode(mode, byUser) {
    mode = (mode === 'photo') ? 'photo' : 'location';
    runtime.mode = mode;
    if (byUser) runtime.modePickedByUser = true;

    // 位置区：地图也要跟着藏/显示
    ui.locSections.forEach(function (n) { n.hidden = (mode !== 'location'); });
    ui.photoSections.forEach(function (n) { n.hidden = (mode !== 'photo'); });
    if (ui.mapwrap) ui.mapwrap.hidden = (mode !== 'location');

    if (ui.modeLocBtn) ui.modeLocBtn.className = (mode === 'location') ? 'cur' : '';
    if (ui.modePhotoBtn) ui.modePhotoBtn.className = (mode === 'photo') ? 'cur' : '';
    if (ui.signBtn && mode === 'photo') ui.signBtn.textContent = '上传并签到';
    else if (ui.signBtn) ui.signBtn.textContent = '直接签到';
    if (ui.modeHint) {
      var k = runtime.activeKind;
      var auto = k
        ? '当前活动：' + k.label + '签到 · ' + CXL.describeNeeds(k)
        : '还没识别出活动类型，可以先自己选';
      ui.modeHint.textContent = auto + (runtime.modePickedByUser ? '（你手动指定）' : '') +
        (mode === 'photo'
          ? ' · 选好图片后点「直接签到」会自动上传并提交'
          : ' · 地图选点后点「直接签到」');
    }
    if (mode === 'location' && ui.map) {
      ui.map.refresh();
      setTimeout(function () { if (ui.map) ui.map.refresh(); }, 60);
    }
    renderPhoto();
    renderRuntime();
  }

  /**
   * 按活动类型自动切模式（用户手动切过就不动，只提示）。
   * 注意：ifphoto 只是"可附照片"的附加标志，不是类型；基础类型由 otherId/activeSort/名字决定。
   */
  function applyDetectedKind(kind) {
    if (!kind) return;
    runtime.activeKind = kind;
    // 要定位 -> 位置模式；否则要照片 -> 拍照模式
    if (kind.needsLocation) {
      if (!runtime.modePickedByUser && runtime.mode !== 'location') setMode('location', false);
    } else if (kind.needsPhoto) {
      if (!runtime.modePickedByUser && runtime.mode !== 'photo') setMode('photo', false);
    }
    if (ui.modeHint) {
      var bits = ['当前活动：' + (kind.label || '未知') + '签到'];
      if (kind.fromName) bits.push('（类型是按活动名字猜的）');
      bits.push(CXL.describeNeeds(kind));
      if (!kind.canSubmitPlain) {
        bits.push('⚠ 这类签到网页端可能签不了' + (kind.needsQr ? '（二维码里的 enc 拿不到）' : ''));
      }
      ui.modeHint.textContent = bits.join(' · ') +
        (runtime.modePickedByUser ? '（你手动切换过，以你选的为准）' : '');
    }
  }

  /**
   * 方式 B：直接用账号 Cookie 调签到接口。
   * 位置和拍照共用这一条提交路径：位置带坐标，拍照带 objectId（没有就现场上传）。
   */
  function submit(isDry) {
    var activeId = (ui.activeIdInput.value || runtime.activeId || '').trim();
    if (!CXL.isActiveId(activeId)) {
      // 没编号时不要只说"请手填"：先替用户自动查一次
      lookupActiveId({
        done: function (r) {
          if (r && r.ok) {
            flash('已自动获取 activeId = ' + r.activeId + '，再点一次「' + (isDry ? '试运行' : '直接签到') + '」即可', 'ok');
          } else {
            flash('没识别到有效的 activeId：' + ((r && r.error) || '') +
              '\n可展开「高级设置」手动填写（就是签到活动的编号）', 'err');
          }
        }
      });
      return;
    }

    var mode = runtime.mode;
    if (mode === 'location' && !point) { flash('位置签到要先用地图选点（或点「用本机真实位置」）', 'err'); return; }
    if (mode === 'photo' && !runtime.photo) { flash('拍照签到要先选一张图片（点上面的虚线框）', 'err'); return; }
    if (isDry) { doSubmit(isDry, activeId, mode, ''); return; }

    if (mode === 'photo' && runtime.photo && !runtime.photo.objectId) {
      // 还没上传：先把图片传上去换 objectId，成功后再提交（用户只需要点一次）
      setStatusBusy('先上传图片换 objectId…');
      uploadPickedPhoto({
        done: function (r) {
          if (!r || !r.ok) {
            setStatus('上传图片失败：' + ((r && r.error) || '未知原因') + '\n签到未提交。', 'err');
            return;
          }
          doSubmit(false, activeId, mode, r.objectId);
        }
      });
      return;
    }
    doSubmit(isDry, activeId, mode, (runtime.photo && runtime.photo.objectId) || '');
  }

  /** 真正发提交请求 */
  function doSubmit(isDry, activeId, mode, objectId) {
    var payload = {
      activeId: activeId,
      kind: mode === 'photo' ? 'photo' : 'location',
      courseId: runtime.courseId || '',
      name: (ui.nameInput.value || runtime.userName || '').trim(),
      fid: (ui.fidInput.value || runtime.fid || '').trim(),
      uid: runtime.uid || '',
      appType: settings.appType,
      ifTiJiao: settings.ifTiJiao
    };
    if (objectId) payload.objectId = objectId;
    if (point) {
      payload.lat = point.lat;
      payload.lon = point.lon;
      payload.datum = point.datum;
      payload.hasPoint = true;
      payload.address = ui.addressInput.value.trim() || point.address || '';
    }
    var req = { type: 'sign', dryRun: !!isDry, payload: payload };

    setStatusBusy(isDry ? '正在试运行（不会真的签到）…' : (mode === 'photo' ? '正在提交拍照签到…' : '正在提交位置签到…'));
    chrome.runtime.sendMessage(req, function (res) {
      if (!res) { setStatus('没有收到后台响应，请重新加载页面后再试', 'err'); return; }
      var how = '（' + (res.method || 'GET') + ' ' + (mode === 'photo' ? '拍照签到' : '位置签到') + '）';
      if (res.ok) {
        setStatus((isDry ? '【试运行】\n' : '【签到成功】\n') + (res.message || '') + how +
          '\n' + (res.params ? '表单：' + res.params.slice(0, 400) + '\n' : '') +
          '\n请求：' + res.url, 'ok');
      } else {
        setStatus((isDry ? '【试运行】' : '【签到未成功】') + '\n' + (res.message || '未知错误') + how +
          (res.url ? '\n\n请求：' + res.url : ''), 'err');
      }
    });
  }

  // ---------- 启动 ----------

  /**
   * 把当前课程 / 班级编号报给后台。
   * 自动签到是"没人看着"也要跑的：后台必须知道该去哪些课程里找活动，
   * 而课程编号只有打开过这门课的页面时才知道（地址栏/正文里）。
   * 顺手带上课程名，日志里就能说清是哪门课。
   */
  function reportAutoTarget() {
    rememberCourseContext('');
    if (!runtime.courseId || !runtime.classId) return;
    var key = runtime.courseId + '/' + runtime.classId;
    if (runtime.autoTargetSent === key) return;    // 同一门课报一次就够
    runtime.autoTargetSent = key;
    var courseName = '';
    try {
      courseName = (document.title || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      if (!courseName) {
        var h1 = document.querySelector('h1, .courseName, .tit');
        courseName = (h1 && h1.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      }
    } catch (e) { courseName = ''; }
    try {
      chrome.runtime.sendMessage({
        type: 'autoTarget',
        target: {
          courseId: runtime.courseId,
          classId: runtime.classId,
          fid: runtime.fid || '',
          courseName: courseName,
          url: currentUrl()
        }
      }, function () { void chrome.runtime.lastError; });
    } catch (e) { /* 后台不在就算了，下次打开页面再报 */ }
  }

  async function boot() {
    settings = await CXL.getSettings();
    point = await CXL.getPoint();
    presets = await CXL.getPresets();

    injectMainWorld();

    var mounted = false;
    function mount() {
      if (mounted) return true;
      if (!document.body) return false;
      buildOverlay();            // 已存在时会直接返回，不会重复建面板
      if (!overlay) return false;
      mounted = true;
      scanPage();
      syncForm();
      refreshBadge();
      renderRuntime();
      refreshDuty();             // 决定本框架是否显示悬浮按钮
      setMode(runtime.mode, false);   // 先按默认（位置）铺好面板，等识别出类型再切
      renderPhoto();
      if (!runtime.activeId && settings.autoDetect) {
        // 页面上翻不到编号（很常见：网页版把签到入口藏了）就直接问课程活动列表，
        // 不等延迟——签到窗口通常很短，早一秒拿到编号就早一秒能签。
        if (runtime.courseId && runtime.classId) lookupActiveId({ quiet: true });
        // 再晚一点复查一次：页面可能在这期间才把签到请求发出来（那时就更准）
        setTimeout(function () {
          if (runtime.activeId) return;
          scanPage();
          renderRuntime();
          if (ui.activeIdInput && runtime.activeId) ui.activeIdInput.value = runtime.activeId;
          if (!runtime.activeId) lookupActiveId({ quiet: true });
        }, 2500);
      }
      // 把课程/班级编号交给后台：自动签到要在没人打开页面的情况下自己找活动
      reportAutoTarget();
      return true;
    }

    if (!mount()) {
      var timer = setInterval(function () { if (mount()) clearInterval(timer); }, 300);
      setTimeout(function () { clearInterval(timer); }, 20000);
    }

    /**
     * 自动获取 activeId：每 6 秒看一眼，只要还没拿到编号就重试（30 秒一次请求）。
     * 老师发布签到的时间不固定，用户开着课程页面等签到是常态，
     * 所以这里持续试探；拿到之后就彻底停下来，不再打扰服务端。
     */
    setInterval(function () {
      if (!settings || !settings.autoDetect || !overlay) return;
      if (runtime.activeId || runtime.lookupBusy) return;
      if (ui.activeIdInput && ui.activeIdInput.value.trim()) return;   // 用户手填了，尊重用户
      if (!runtime.courseId || !runtime.classId) return;
      if (Date.now() - (runtime.activeLookupAt || 0) < 30000) return;
      lookupActiveId({ quiet: true });
    }, 6000);

    // 定期续约，并在页面内容变化后重新判断谁是值班框架
    setInterval(function () {
      if (!overlay) return;
      refreshDuty();
      if (isSignFrame() && !runtime.isSignFrame) {
        runtime.isSignFrame = true;
        setStatus('本框架检测到签到界面。展开「网络活动记录」看接口，或用「复制诊断信息」导出。', 'ok');
      }
    }, 4000);

    CXL.onChange(function (payload) {
      if (payload.settings) {
        settings = payload.settings;
        if (ui.map) {
          ui.map.tileTemplate = settings.tileUrl;
          ui.map.tileSubdomains = settings.tileSubdomains;
          ui.map.refresh();
        }
        refreshBadge();
      }
      if (payload.point) { point = payload.point; syncForm(); refreshBadge(); }
      if (payload.presets) { presets = payload.presets; renderPresets(); }
    });

    // 页面是 SPA，路由变化时重新识别
    var lastHref = location.href;
    setInterval(function () {
      if (location.href !== lastHref) {
        lastHref = location.href;
        runtime.activeId = '';
        runtime.activeName = '';
        runtime.lastSignUrl = '';
        runtime.activeLookupAt = 0;
        if (ui.activeIdInput) ui.activeIdInput.value = '';
        setTimeout(function () {
          scanPage();
          renderRuntime();
          if (ui.activeIdInput && runtime.activeId) ui.activeIdInput.value = runtime.activeId;
          if (!runtime.activeId && settings.autoDetect) lookupActiveId({ quiet: true });
        }, 1200);
      }
    }, 1500);
  }

  boot();

  // 供 popup 调用
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return;
    if (msg.type === 'togglePanel') {
      togglePanel();
      sendResponse({ ok: true, open: overlay && !overlay.panel.hasAttribute('hidden') });
    } else if (msg.type === 'getState') {
      sendResponse({
        ok: true,
        point: point,
        settings: settings,
        runtime: {
          activeId: runtime.activeId,
          activeName: runtime.activeName,
          courseId: runtime.courseId,
          classId: runtime.classId,
          fid: runtime.fid,
          uid: runtime.uid,
          geoHits: runtime.geoHits,
          rewrites: runtime.rewrites,
          status: runtime.status
        }
      });
    } else if (msg.type === 'pickFromPopup' && msg.point) {
      setPoint(msg.point.lat, msg.point.lon, msg.point.address, 'popup');
      sendResponse({ ok: true });
    } else if (msg.type === 'clearPoint') {
      // popup 里点了「清除选点」：本地状态和输入框都要跟着清干净，
      // 否则面板还显示旧坐标，容易误签
      point = null;
      if (ui.latInput) ui.latInput.value = '';
      if (ui.lonInput) ui.lonInput.value = '';
      pushConfig();
      updateCoordLabel();
      refreshBadge();
      if (ui.status) setStatus('已清除选点，网页定位恢复为真实定位');
      sendResponse({ ok: true });
    } else if (msg.type === 'frameReport') {
      // 后台在跨框架点名：回一条本框架的状态过去
      sendResponse({
        ok: true,
        frame: {
          url: currentUrl().slice(0, 200),
          hookReady: !!window.__CXL_MAIN_READY,
          hasSignText: isSignFrame(),
          activeId: runtime.activeId || null
        }
      });
    }
    return true;
  });
})();
