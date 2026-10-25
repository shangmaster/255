/*
 * 注入到页面主世界（MAIN world）的钩子脚本。
 * 作用：
 *   1) 接管 navigator.geolocation（以及腾讯/百度地图 SDK 的定位接口），
 *      让网页定位拿到我们选定的坐标；
 *   2) 兜底改写定位类网络请求（XHR / fetch）里的 latitude/longitude；
 *   3) 旁路监听签到请求，把 activeId 等线索回传给扩展 UI。
 *
 * 配置有两条来源，互为补充：
 *   - 页面里的 `cxl:config` CustomEvent（content.js 派发，含一次性令牌）；
 *   - 由 content.js 兜底注入时，脚本标签上的 data-cxl-config。
 * 本文件刻意自包含：不引用 chrome.* API，也不依赖 lib.js。
 */
(function () {
  'use strict';

  var TAG = '[CXL]';
  var script = document.currentScript;
  var cfg = {
    token: '',
    enabled: true,
    spoofGeo: true,
    spoofTiles: true,
    point: null,
    datum: 'gcj02'
  };
  try {
    if (script && script.dataset && script.dataset.cxlConfig) {
      cfg = Object.assign(cfg, JSON.parse(script.dataset.cxlConfig));
    }
  } catch (e) { /* 配置解析失败则用默认值 */ }

  var CFG_EVENT = 'cxl:config';
  var REPORT_EVENT = 'cxl:report';

  // ---------- 与扩展通信 ----------

  function report(type, payload) {
    try {
      window.postMessage({ __cxl: REPORT_EVENT, token: cfg.token, type: type, payload: payload || {} }, '*');
    } catch (e) { /* ignore */ }
  }

  window.addEventListener(CFG_EVENT, function (e) {
    try {
      var detail = e && e.detail;
      if (detail) cfg = Object.assign(cfg, detail);
    } catch (err) { /* ignore */ }
  });

  function log() {
    var args = Array.prototype.slice.call(arguments);
    args.unshift(TAG);
    try { console.log.apply(console, args); } catch (e) { /* ignore */ }
  }

  // ---------- 坐标工具 ----------

  var PI = Math.PI;
  var A = 6378245.0;
  var EE = 0.00669342162296594323;

  function outOfChina(lat, lon) {
    return !(lon > 73.66 && lon < 135.05 && lat > 3.86 && lat < 53.55);
  }

  function transformLat(x, y) {
    var ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
    ret += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0;
    ret += ((160.0 * Math.sin((y / 12.0) * PI) + 320 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0;
    return ret;
  }

  function transformLon(x, y) {
    var ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
    ret += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0;
    ret += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0;
    return ret;
  }

  function wgs84ToGcj02(lat, lon) {
    if (outOfChina(lat, lon)) return [lat, lon];
    var dLat = transformLat(lon - 105.0, lat - 35.0);
    var dLon = transformLon(lon - 105.0, lat - 35.0);
    var radLat = (lat / 180.0) * PI;
    var magic = Math.sin(radLat);
    magic = 1 - EE * magic * magic;
    var sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI);
    dLon = (dLon * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * PI);
    return [lat + dLat, lon + dLon];
  }

  function gcj02ToWgs84(lat, lon) {
    if (outOfChina(lat, lon)) return [lat, lon];
    var g = wgs84ToGcj02(lat, lon);
    return [lat * 2 - g[0], lon * 2 - g[1]];
  }

  /** BD-09（百度）-> GCJ-02。本文件刻意自包含，不依赖 lib.js。 */
  function bd09ToGcj02(lat, lon) {
    var x = lon - 0.0065;
    var y = lat - 0.006;
    var z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * (Math.PI * 3000.0) / 180.0);
    var theta = Math.atan2(y, x) - 0.000003 * Math.cos(x * (Math.PI * 3000.0) / 180.0);
    return [z * Math.sin(theta), z * Math.cos(theta)];
  }

  /**
   * 返回要伪装给页面的 [lat, lon]。
   * 约定：配置里的 point 使用 datum 指定的坐标系；
   * - datum = gcj02：国内地图/学习通直接按 GCJ-02 处理，原样返回；
   * - datum = wgs84：navigator.geolocation 按 WGS-84 语义返回，原样返回，
   *   而网络请求里的经纬度通常是地图坐标，需要转成 GCJ-02。
   */
  function spoofForGeo() {
    if (!cfg.point) return null;
    return [Number(cfg.point.lat), Number(cfg.point.lon)];
  }

  function spoofForNetwork() {
    if (!cfg.point) return null;
    var lat = Number(cfg.point.lat);
    var lon = Number(cfg.point.lon);
    // 网络请求里的经纬度一律按 GCJ-02 提交，与 lib.js 的 buildSignUrl 保持一致
    if (cfg.datum === 'wgs84') return wgs84ToGcj02(lat, lon);
    if (cfg.datum === 'bd09') return bd09ToGcj02(lat, lon);
    return [lat, lon];
  }

  // ---------- 1) navigator.geolocation ----------

  function installGeoHook() {
    var geo = navigator.geolocation;
    if (!geo) return;
    var watchers = new Map();

    function fakePosition(coords) {
      return {
        coords: {
          latitude: coords[0],
          longitude: coords[1],
          accuracy: 25,
          altitude: null,
          altitudeAccuracy: null,
          heading: null,
          speed: null,
          toJSON: function () { return this; }
        },
        timestamp: Date.now(),
        toJSON: function () { return this; }
      };
    }

    var fakeError = {
      code: 2,
      message: 'Position unavailable',
      PERMISSION_DENIED: 1,
      POSITION_UNAVAILABLE: 2,
      TIMEOUT: 3
    };

    // 优先打原型：Chrome 把 getCurrentPosition 定义在 Geolocation.prototype 上，
    // 直接给实例赋值在严格模式下可能抛错（自有只读属性），那样钩子会静默失效。
    var proto = null;
    try {
      proto = Object.getPrototypeOf(geo);
      if (proto && typeof proto.getCurrentPosition !== 'function') proto = null;
    } catch (e) { proto = null; }
    if (!proto && geo.constructor && geo.constructor.prototype) {
      var cp = geo.constructor.prototype;
      if (typeof cp.getCurrentPosition === 'function') proto = cp;
    }
    var target = proto || geo;

    var nativeGet = target.getCurrentPosition;
    var nativeWatch = target.watchPosition;
    var nativeClear = target.clearWatch;

    try {
      target.getCurrentPosition = function (success, error, options) {
        var p = cfg.enabled && cfg.spoofGeo ? spoofForGeo() : null;
        if (!p) return nativeGet.apply(geo, arguments);
        log('劫持 getCurrentPosition ->', p[0], p[1]);
        report('geo', { api: 'getCurrentPosition', lat: p[0], lon: p[1] });
        setTimeout(function () {
          try {
            if (typeof success === 'function') success(fakePosition(p));
          } catch (e) {
            if (typeof error === 'function') error(fakeError);
          }
        }, 30);
        return undefined;
      };

      if (typeof nativeWatch === 'function') {
        target.watchPosition = function (success, error, options) {
          var p = cfg.enabled && cfg.spoofGeo ? spoofForGeo() : null;
          if (!p) return nativeWatch.apply(geo, arguments);
          log('劫持 watchPosition ->', p[0], p[1]);
          report('geo', { api: 'watchPosition', lat: p[0], lon: p[1] });
          var id = Math.floor(Math.random() * 1e6) + 1 + 1e6; // 避开原生 id 区间
          var timer = setInterval(function () {
            try {
              if (typeof success === 'function') success(fakePosition(p));
            } catch (e) { /* ignore */ }
          }, 3000);
          watchers.set(id, timer);
          setTimeout(function () {
            try {
              if (typeof success === 'function') success(fakePosition(p));
            } catch (e) { /* ignore */ }
          }, 30);
          return id;
        };
      }

      if (typeof nativeClear === 'function') {
        target.clearWatch = function (id) {
          if (watchers.has(id)) {
            clearInterval(watchers.get(id));
            watchers.delete(id);
            return;
          }
          return nativeClear.apply(geo, arguments);
        };
      }

      // 回读校验：确认补丁真的生效了（否则早点在日志里暴露，别静默失败）
      if (typeof geo.getCurrentPosition === 'function' &&
          geo.getCurrentPosition === nativeGet &&
          typeof nativeGet === 'function') {
        log('警告：geolocation 钩子未生效，页面仍会拿到真实定位');
      } else {
        log('geolocation 钩子已安装（原型：' + (proto ? 'Geolocation.prototype' : '实例') + '）');
      }
    } catch (e) {
      log('geolocation 钩子安装失败', e);
    }
  }

  // ---------- 2) 网络请求兜底改写 + 旁路录制 ----------

  var SIGN_HINT = /(stusignajax|presign|signajax|\/sign\/|pptSign|activeId=|activePrimaryId|activelist|active\/list)/i;
  var COORD_KEYS = /^(latitude|longitude|lat|lng|lon|location|geo|gps|coords?)$/i;
  var REC_URL_HINT = /chaoxing\.com/i;
  var REC_MAX = 40;

  /**
   * 旁路记录网络活动（不改写、不阻断）。
   * 作用有两个：
   *   1) 在页面的请求/响应里找出 activeId —— 网页版虽然不让签到，
   *      但它自己拉取签到列表的接口里带着这个编号；
   *   2) 出问题时可以把这份记录导出来排查。
   */
  function NetworkRecorder() {
    this.list = [];
    this.byUrl = new Map();
  }

  NetworkRecorder.prototype.push = function (entry) {
    entry.id = this.list.length + 1;
    entry.at = new Date().toTimeString().slice(0, 8);
    this.list.push(entry);
    if (this.list.length > REC_MAX) this.list.shift();
    this.scanForActiveId(entry);
    report('net', entry);
  };

  /**
   * 从文本里挖 activeId。必须带键名才算数：
   * 早期版本用裸的 /\d{6,}/ 兜底，会把时间戳(1792076091993)、enc 等全打成命中，
   * 那种"什么都匹配"的规则等于没有，所以这里删掉了。
   */
  NetworkRecorder.prototype.scanForActiveId = function (entry) {
    var text = (entry.url || '') + ' ' + (entry.body || '') + ' ' + (entry.resp || '');
    var m = text.match(/activePrimaryId["'\s:=]+(\d{6,})/i) ||
            text.match(/activeId["'\s:=]+(\d{6,})/i) ||
            text.match(/[?&#]activeId=(\d{6,})/i);
    if (m && !this.foundActiveId) {
      this.foundActiveId = m[1];
      log('从网络响应里发现 activeId =', m[1]);
      report('activeId', { activeId: m[1], from: entry.url });
    }
  };

  NetworkRecorder.prototype.find = function (url) {
    return this.byUrl.get(url);
  };

  NetworkRecorder.prototype.forget = function (url) {
    this.byUrl.delete(url);
  };

  NetworkRecorder.prototype.forgetAll = function () {
    this.byUrl.clear();
  };

  var recorder = new NetworkRecorder();

  function installNetworkHook() {
    // ---- XMLHttpRequest ----
    var XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype && !XHR.prototype.__cxlPatched) {
      // 记录原始实现，方便调试、测试与恢复
      XHR.prototype.__cxlRealOpen = XHR.prototype.open;
      XHR.prototype.__cxlRealSend = XHR.prototype.send;

      XHR.prototype.open = function (method, url) {
        var finalUrl = url;
        try {
          if (typeof url === 'string' && SIGN_HINT.test(url)) {
            report('request', { kind: 'xhr', method: method, url: url });
          }
          if (cfg.spoofTiles && typeof url === 'string' && /latitude|longitude|lat=|lng=|lon=/.test(url)) {
            finalUrl = rewriteQuery(url);
          }
          if (cfg.record && typeof finalUrl === 'string' && REC_URL_HINT.test(finalUrl)) {
            this.__cxlRec = { kind: 'xhr', method: String(method || 'GET').toUpperCase(), url: finalUrl, body: '' };
            this.__cxlRecPost = null;
          } else {
            this.__cxlRec = null;
          }
        } catch (e) { /* ignore */ }
        var args = Array.prototype.slice.call(arguments);
        args[1] = finalUrl;
        // 通过 __cxlRealOpen 间接调用原始实现：既不污染闭包，也便于测试与卸载
        return this.__cxlRealOpen.apply(this, args);
      };

      XHR.prototype.send = function (body) {
        var finalBody = body;
        try {
          var r = rewriteBody(body);
          if (r.changed) finalBody = r.body;
          if (this.__cxlRec) {
            if (typeof finalBody === 'string') this.__cxlRec.body = finalBody.slice(0, 500);
            var rec = this.__cxlRec;
            var self = this;
            this.addEventListener('load', function () {
              rec.status = self.status;
              var t = '';
              try { t = String(self.responseText || ''); } catch (e) { t = ''; }
              rec.respLen = t.length;
              rec.resp = t.slice(0, 4000);
              recorder.push(rec);
            });
          }
        } catch (e) { /* ignore */ }
        var args = Array.prototype.slice.call(arguments);
        args[0] = finalBody;
        return this.__cxlRealSend.apply(this, args);
      };

      XHR.prototype.__cxlPatched = true;
      log('XHR 钩子已安装');
    }

    // ---- fetch ----
    if (typeof window.fetch === 'function' && !window.fetch.__cxlPatched) {
      var rawFetch = window.fetch;
      var patchedFetch = function (input, init) {
        var rec = null;
        try {
          init = init || {};
          var url = typeof input === 'string' ? input : input && input.url;
          if (url && SIGN_HINT.test(url)) {
            report('request', { kind: 'fetch', method: (init.method || (input && input.method) || 'GET'), url: url });
          }
          if (cfg.spoofTiles && typeof url === 'string' && /latitude|longitude|lat=|lng=|lon=/.test(url)) {
            var fixed = rewriteQuery(url);
            if (fixed !== url) {
              input = typeof input === 'string' ? fixed : new Request(fixed, input);
            }
          }
          if (init.body) {
            var r = rewriteBody(init.body);
            if (r.changed) init.body = r.body;
          }
          if (cfg.record && typeof url === 'string' && REC_URL_HINT.test(url)) {
            rec = {
              kind: 'fetch',
              method: String(init.method || (input && input.method) || 'GET').toUpperCase(),
              url: url,
              body: typeof init.body === 'string' ? init.body.slice(0, 500) : ''
            };
          }
        } catch (e) { /* ignore */ }
        var p = rawFetch.call(this, input, init);
        if (rec && p && typeof p.then === 'function') {
          p.then(function (res) {
            try {
              res.clone().text().then(function (t) {
                rec.status = res.status;
                rec.respLen = (t || '').length;
                rec.resp = (t || '').slice(0, 4000);
                recorder.push(rec);
              }).catch(function () { recorder.push(rec); });
            } catch (e) { recorder.push(rec); }
          }).catch(function () { recorder.push(rec); });
        }
        return p;
      };
      patchedFetch.__cxlPatched = true;
      window.fetch = patchedFetch;
      log('fetch 钩子已安装');
    }

    // 后续挂载腾讯/百度地图 SDK 的定位钩子
    installSdkHooks();
  }

  /** 改写 URL 查询串里的经纬度；返回改写后的 URL */
  function rewriteQuery(url) {
    if (!cfg.enabled) return url;
    var out = url;
    var found = [];
    out = out.replace(/([?&])(latitude|longitude|lat|lng|lon)=(-?\d+(?:\.\d+)?)/gi, function (m, sep, key, val) {
      var p = spoofForNetwork();
      if (!p) return m;
      var isLat = /^(latitude|lat)$/i.test(key);
      found.push(key);
      // 先解析已有数值，尽量保留原精度位数
      var current = parseFloat(val);
      var dec = (String(val).split('.')[1] || '').length;
      var next = isLat ? p[0] : p[1];
      // 如果页面原本传的是 WGS-84（与我们要写入的 GCJ-02 差异明显），保持我们的值
      void current;
      return sep + key + '=' + next.toFixed(Math.max(6, dec));
    });
    if (found.length) {
      report('rewrite', { kind: 'query', keys: found, url: out });
      log('改写请求参数 ->', out);
    }
    return out;
  }

  function rewriteBody(body) {
    if (!cfg.enabled || typeof body !== 'string') return { body: body, changed: false };
    var changed = false;
    var p = spoofForNetwork();
    if (!p) return { body: body, changed: false };
    var next = body.replace(/(^|&)(latitude|longitude|lat|lng|lon)=(-?\d+(?:\.\d+)?)/gi, function (m, sep, key, val) {
      var isLat = /^(latitude|lat)$/i.test(key);
      changed = true;
      return sep + key + '=' + (isLat ? p[0] : p[1]).toFixed(6);
    });
    // JSON 体
    if (!changed && /^\s*[{[]/.test(body)) {
      try {
        var obj = JSON.parse(body);
        var hit = false;
        (function walk(node) {
          if (!node || typeof node !== 'object') return;
          for (var k in node) {
            if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
            var v = node[k];
            if (COORD_KEYS.test(k) && (typeof v === 'number' || typeof v === 'string')) {
              var isLat = /^(latitude|lat)$/i.test(k);
              if (/^(latitude|longitude|lat|lng|lon)$/i.test(k)) {
                node[k] = Number((isLat ? p[0] : p[1]).toFixed(6));
                hit = true;
              }
            } else if (v && typeof v === 'object') {
              walk(v);
            }
          }
        })(obj);
        if (hit) {
          changed = true;
          next = JSON.stringify(obj);
        }
      } catch (e) { /* 非 JSON */ }
    }
    if (changed) {
      report('rewrite', { kind: 'body' });
      log('改写请求体经纬度完成');
    }
    return { body: next, changed: changed };
  }

  /**
   * 挂载腾讯/百度地图 SDK 的定位钩子。
   * 这两个 SDK 可能晚于本脚本加载，所以按退避策略重试：
   * 前 20 次每 500ms（SDK 一般很快就到），之后放慢到 4s，避免长时间空转。
   */
  function installSdkHooks() {
    function sdkReadyState() {
      return {
        qq: !!(window.qq && window.qq.maps && window.qq.maps.Geolocation),
        bmap: !!(window.BMap && window.BMap.Geolocation)
      };
    }

    function trySdkHooks() {
      var want = sdkReadyState();
      // 页面上没出现的 SDK 视为"已完成"，出现的必须打上补丁
      var done =
        (!want.qq || hookQqMaps()) &&
        (!want.bmap || hookBMap());
      return done ? 2 : 0;
    }

    if (trySdkHooks() >= 2) return;

    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      if (trySdkHooks() >= 2 || tries > 20) {
        clearInterval(timer);
        if (tries > 20) return; // 前 20 次都没等到，转入慢速轮询
        var slow = setInterval(function () {
          tries++;
          if (trySdkHooks() >= 2 || tries > 60) clearInterval(slow);
        }, 4000);
      }
    }, 500);
  }

  /** 给 qq.maps.Geolocation 打补丁；成功返回 1，未就绪返回 0 */
  function hookQqMaps() {
    try {
      var qq = window.qq;
      if (!qq || !qq.maps || !qq.maps.Geolocation || !qq.maps.Geolocation.prototype) return 0;
      var proto = qq.maps.Geolocation.prototype;
      if (proto.__cxlPatched) return 1;
      ['getLocation', 'getIpLocation'].forEach(function (name) {
        if (typeof proto[name] !== 'function') return;
        var orig = proto[name];
        proto[name] = function (success, error, options) {
          var p = cfg.enabled && cfg.spoofGeo ? spoofForGeo() : null;
          if (!p) return orig.apply(this, arguments);
          log('劫持 qq.maps.Geolocation.' + name, p[0], p[1]);
          report('geo', { api: 'qq.maps.' + name, lat: p[0], lon: p[1] });
          var res = { lat: p[0], lng: p[1], accuracy: 25, type: 'gcj02' };
          setTimeout(function () {
            try { if (typeof success === 'function') success(res); } catch (e) { /* ignore */ }
          }, 30);
          return undefined;
        };
      });
      proto.__cxlPatched = true;
      log('qq.maps 钩子已安装');
      return 1;
    } catch (e) {
      return 0;
    }
  }

  /** 给 BMap.Geolocation 打补丁；成功返回 1，未就绪返回 0 */
  function hookBMap() {
    try {
      var BMap = window.BMap;
      if (!BMap || !BMap.Geolocation || !BMap.Geolocation.prototype) return 0;
      var bproto = BMap.Geolocation.prototype;
      if (bproto.__cxlPatched) return 1;
      var bget = bproto.getCurrentPosition;
      bproto.getCurrentPosition = function (success, options) {
        var p = cfg.enabled && cfg.spoofGeo ? spoofForGeo() : null;
        if (!p) return bget.apply(this, arguments);
        log('劫持 BMap.Geolocation.getCurrentPosition', p[0], p[1]);
        report('geo', { api: 'BMap.Geolocation', lat: p[0], lon: p[1] });
        var res = {
          point: { lng: p[1], lat: p[0] },
          accuracy: 25,
          status: 0,
          address: null
        };
        setTimeout(function () {
          try { if (typeof success === 'function') success(res); } catch (e) { /* ignore */ }
        }, 30);
        return undefined;
      };
      bproto.__cxlPatched = true;
      log('BMap 钩子已安装');
      return 1;
    } catch (e) {
      return 0;
    }
  }

  installGeoHook();
  installNetworkHook();

  // 标记：告诉内容脚本"主世界钩子已经在跑了"，避免它再插一次脚本
  try {
    Object.defineProperty(window, '__CXL_MAIN_READY', {
      value: true,
      configurable: true,
      enumerable: false,
      writable: false
    });
  } catch (e) {
    window.__CXL_MAIN_READY = true;
  }

  report('ready', { cfg: cfg });
})();
