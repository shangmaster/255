/*
 * 零依赖的滑瓦片地图（Web Mercator + canvas），用于在页面里自由选点。
 * 不依赖任何外部 JS 库：只按需加载瓦片图片，图片不上的话也有网格兜底。
 */
(function (global) {
  'use strict';

  var CXL = global.CXL || (global.CXL = {});

  var TILE = 256;
  var MAX_LAT = 85.05112878;

  function clamp(v, a, b) {
    return Math.min(b, Math.max(a, v));
  }

  function now() {
    if (typeof performance !== 'undefined' && performance.now) return performance.now();
    return Date.now();
  }

  /** 内置兜底底图生成器：蓝色水面 + 绿色陆地 + 经纬网格，用于瓦片不可用时。 */
  function fallbackTile() {
    var c = document.createElement('canvas');
    c.width = c.height = TILE;
    var g = c.getContext('2d');
    g.fillStyle = '#eef4f3';
    g.fillRect(0, 0, TILE, TILE);
    g.fillStyle = '#dbe9df';
    g.beginPath();
    g.moveTo(0, 66);
    g.bezierCurveTo(60, 40, 120, 96, 190, 70);
    g.bezierCurveTo(220, 58, 240, 76, 256, 68);
    g.lineTo(256, 256);
    g.lineTo(0, 256);
    g.closePath();
    g.fill();
    g.strokeStyle = 'rgba(120, 150, 140, 0.35)';
    g.lineWidth = 1;
    for (var i = 0; i <= 4; i++) {
      var p = (i * TILE) / 4 + 0.5;
      g.beginPath(); g.moveTo(p, 0); g.lineTo(p, TILE); g.stroke();
      g.beginPath(); g.moveTo(0, p); g.lineTo(TILE, p); g.stroke();
    }
    return c;
  }

  var fallbackCanvas = null;
  function getFallback() {
    if (!fallbackCanvas) fallbackCanvas = fallbackTile();
    return fallbackCanvas;
  }

  /**
   * @param {HTMLElement} host 容器（必须有确定的宽高）
   * @param {{onPick?:Function, onViewChange?:Function}} opts
   */
  CXL.createMap = function (host, opts) {
    opts = opts || {};
    var canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:100%;height:100%;cursor:grab;touch-action:none;';
    host.appendChild(canvas);
    var ctx = canvas.getContext('2d');

    var zoom = 16;
    var center = [39.908722, 116.397499]; // 坐标中心：[lat, lon]
    var dpr = 1;
    var tiles = new Map();      // key -> {state:'loading'|'ok'|'fail', img}
    var s2 = Math.pow(2, zoom);
    var dragging = false;
    var dragMoved = 0;
    var lastPointer = null;
    var dirty = true;
    var running = true;
    var gcTimer = null;

    var state = {
      tiles: 0,   // 已成功绘制的瓦片数
      failed: 0,  // 失败的瓦片数
      zoom: zoom
    };

    function scale() {
      return Math.pow(2, zoom - 18);
    }

    function project(lat, lon) {
      var x = (lon + 180) / 360;
      var s = Math.sin((clamp(lat, -MAX_LAT, MAX_LAT) * Math.PI) / 180);
      var y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
      return [x, y];
    }

    function unproject(x, y) {
      var lon = x * 360 - 180;
      var n = Math.PI - 2 * Math.PI * y;
      var lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
      return [lat, lon];
    }

    /** 世界像素坐标（以当前 zoom 的瓦片像素为单位，1 瓦片 = 256px） */
    function worldPixel(lat, lon) {
      var p = project(lat, lon);
      var s = TILE * Math.pow(2, zoom);
      return [p[0] * s, p[1] * s];
    }

    function screenToLatLon(x, y) {
      var wp = api.centerWorld();
      var s = TILE * Math.pow(2, zoom);
      var wx = wp[0] + (x - canvas.clientWidth / 2);
      var wy = wp[1] + (y - canvas.clientHeight / 2);
      return unproject(wx / s, clamp(wy / s, 0, 1));
    }

    function tileUrl(z, x, y) {
      var tpl = api.tileTemplate || '';
      var subs = api.tileSubdomains && api.tileSubdomains.length ? api.tileSubdomains : [''];
      var s = subs[Math.abs(x + y) % subs.length];
      return tpl
        .replace('{s}', s)
        .replace('{x}', String(x))
        .replace('{y}', String(y))
        .replace('{z}', String(z));
    }

    var api = {
      tileTemplate: '',
      tileSubdomains: [''],

      getZoom: function () { return zoom; },
      setZoom: function (z, anchor) {
        var nz = clamp(z, 3, 19);
        if (nz === zoom) return;
        var before = null;
        if (anchor) before = screenToLatLon(anchor[0], anchor[1]);
        zoom = nz;
        state.zoom = zoom;
        api.centerWorld.cache = null;
        if (before && anchor) {
          // 保持锚点下的地理位置不变
          var wp = api.centerWorld();
          var s = TILE * Math.pow(2, zoom);
          var target = worldPixel(before[0], before[1]);
          var cx = target[0] - (anchor[0] - canvas.clientWidth / 2);
          var cy = target[1] - (anchor[1] - canvas.clientHeight / 2);
          var ll = unproject(cx / s, clamp(cy / s, 0, 1));
          center = ll;
          api.centerWorld.cache = null;
        }
        dirty = true;
        if (opts.onViewChange) opts.onViewChange(zoom);
      },
      zoomIn: function () { api.setZoom(zoom + 1, [canvas.clientWidth / 2, canvas.clientHeight / 2]); },
      zoomOut: function () { api.setZoom(zoom - 1, [canvas.clientWidth / 2, canvas.clientHeight / 2]); },

      getCenter: function () { return center.slice(); },
      setView: function (lat, lon, z) {
        center = [clamp(lat, -MAX_LAT, MAX_LAT), lon];
        if (typeof z === 'number') { zoom = clamp(z, 3, 19); state.zoom = zoom; }
        api.centerWorld.cache = null;
        dirty = true;
        if (opts.onViewChange) opts.onViewChange(zoom);
      },
      panByPixels: function (dx, dy) {
        var s = TILE * Math.pow(2, zoom);
        var wp = api.centerWorld();
        var ll = unproject(
          (wp[0] - dx) / s,
          clamp((wp[1] - dy) / s, 0, 1)
        );
        center = ll;
        api.centerWorld.cache = null;
        dirty = true;
      },

      screenToLatLon: screenToLatLon,
      refresh: function () { dirty = true; },
      stats: function () { return { drawn: state.tiles, failed: state.failed, zoom: zoom, cached: tiles.size }; },
      destroy: function () {
        running = false;
        if (resizeObserver) resizeObserver.disconnect();
        window.removeEventListener('resize', resize);
        if (gcTimer) clearInterval(gcTimer);
        tiles.clear();
        canvas.remove();
      }
    };

    // 当前中心点的世界像素（带缓存）
    api.centerWorld = function () {
      if (!api.centerWorld.cache) api.centerWorld.cache = worldPixel(center[0], center[1]);
      return api.centerWorld.cache;
    };
    api.centerWorld.cache = null;

    // ---------- 渲染 ----------

    function ensureTile(z, x, y) {
      // 缓存键带上瓦片模板：换底图后旧瓦片自然失效，不会被"加载失败"卡住
      var key = api.tileTemplate + '|' + z + '/' + x + '/' + y;
      var entry = tiles.get(key);
      if (entry) return entry;
      entry = { state: 'loading', img: null, stamp: now() };
      tiles.set(key, entry);
      var img = new Image();
      img.decoding = 'async';
      img.onload = function () {
        entry.state = img.naturalWidth ? 'ok' : 'fail';
        entry.img = img;
        dirty = true;
      };
      img.onerror = function () {
        entry.state = 'fail';
        dirty = true;
      };
      if (api.tileTemplate) img.src = tileUrl(z, x, y);
      else entry.state = 'fail';
      return entry;
    }

    function draw() {
      var w = canvas.clientWidth;
      var h = canvas.clientHeight;
      if (!w || !h) return;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#f2f5f4';
      ctx.fillRect(0, 0, w, h);

      var s = scale();
      var tileSize = TILE * s;
      var baseZoom = Math.round(zoom);
      var baseTileSize = TILE;
      // 以整数级绘制瓦片，再用 scale 放大到当前 zoom 的小数级
      var wp = api.centerWorld();
      var firstX = Math.floor((wp[0] - w / 2) / tileSize);
      var firstY = Math.floor((wp[1] - h / 2) / tileSize);
      var lastX = Math.floor((wp[0] + w / 2) / tileSize);
      var lastY = Math.floor((wp[1] + h / 2) / tileSize);
      var n = Math.pow(2, baseZoom);
      var drawn = 0;
      var failed = 0;

      for (var ty = firstY; ty <= lastY; ty++) {
        if (ty < 0 || ty >= n) continue;
        for (var tx = firstX; tx <= lastX; tx++) {
          var wrapX = ((tx % n) + n) % n;
          var sx = Math.round((tx * tileSize) - (wp[0] - w / 2));
          var sy = Math.round((ty * tileSize) - (wp[1] - h / 2));
          var entry = ensureTile(baseZoom, wrapX, ty);
          var tw = Math.ceil(tileSize) + 1;
          if (entry.state === 'ok' && entry.img) {
            ctx.drawImage(entry.img, sx, sy, tw, tw);
            drawn++;
          } else {
            ctx.drawImage(getFallback(), sx, sy, tw, tw);
            failed++;
          }
        }
      }
      state.tiles = drawn;
      state.failed = failed;

      // 中心点固定标记（选中的签到位置）
      var cx = w / 2;
      var cy = h / 2;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.35)';
      ctx.shadowBlur = 6;
      ctx.shadowOffsetY = 2;
      ctx.fillStyle = '#e64545';
      ctx.beginPath();
      ctx.arc(cx, cy - 22, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx - 6, cy - 18);
      ctx.lineTo(cx + 6, cy - 18);
      ctx.closePath();
      ctx.fillStyle = '#e64545';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy - 22, 3.4, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(cx, cy + 1, 5, 2, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fill();

      // 比例尺
      var metersPerPixel = (156543.03392 * Math.cos((center[0] * Math.PI) / 180)) / Math.pow(2, zoom);
      var barMeters = niceNumber(metersPerPixel * 90);
      var barPx = barMeters / metersPerPixel;
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillRect(w - barPx - 22, h - 26, barPx + 12, 18);
      ctx.strokeStyle = '#334';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(w - barPx - 16, h - 12);
      ctx.lineTo(w - 16, h - 12);
      ctx.stroke();
      ctx.fillStyle = '#223';
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(barMeters >= 1000 ? barMeters / 1000 + ' km' : barMeters + ' m', w - barPx - 16, h - 16);
    }

    function niceNumber(v) {
      var exp = Math.floor(Math.log(v) / Math.LN10);
      var base = Math.pow(10, exp);
      var f = v / base;
      var nice = f >= 5 ? 5 : f >= 2 ? 2 : 1;
      return nice * base;
    }

    function loop() {
      if (!running) return;
      if (dirty) {
        dirty = false;
        try { draw(); } catch (e) { /* 渲染失败不影响交互 */ }
      }
      requestAnimationFrame(loop);
    }

    // ---------- 尺寸 ----------

    function resize() {
      dpr = window.devicePixelRatio || 1;
      var w = canvas.clientWidth;
      var h = canvas.clientHeight;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      dirty = true;
    }

    var resizeObserver = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(host);
    }
    window.addEventListener('resize', resize);

    // ---------- 交互 ----------

    canvas.addEventListener('pointerdown', function (e) {
      dragging = true;
      dragMoved = 0;
      lastPointer = [e.clientX, e.clientY];
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = 'grabbing';
    });

    canvas.addEventListener('pointermove', function (e) {
      if (!dragging || !lastPointer) return;
      var dx = e.clientX - lastPointer[0];
      var dy = e.clientY - lastPointer[1];
      lastPointer = [e.clientX, e.clientY];
      dragMoved += Math.abs(dx) + Math.abs(dy);
      api.panByPixels(-dx, -dy);
    });

    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      canvas.style.cursor = 'grab';
      if (dragMoved < 5 && opts.onPick) {
        var rect = canvas.getBoundingClientRect();
        var ll = screenToLatLon(e.clientX - rect.left, e.clientY - rect.top);
        opts.onPick(ll[0], ll[1]);
      }
      lastPointer = null;
    }

    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', function () {
      dragging = false;
      canvas.style.cursor = 'grab';
      lastPointer = null;
    });

    canvas.addEventListener(
      'wheel',
      function (e) {
        e.preventDefault();
        var rect = canvas.getBoundingClientRect();
        var anchor = [e.clientX - rect.left, e.clientY - rect.top];
        if (e.deltaY < 0) api.setZoom(zoom + 1, anchor);
        else api.setZoom(zoom - 1, anchor);
      },
      { passive: false }
    );

    // 双击放大
    canvas.addEventListener('dblclick', function (e) {
      var rect = canvas.getBoundingClientRect();
      api.setZoom(zoom + 1, [e.clientX - rect.left, e.clientY - rect.top]);
    });

    /** 移动端/触摸：双指缩放 */
    var pinch = null;
    canvas.addEventListener('touchstart', function (e) {
      if (e.touches.length === 2) {
        dragging = false;
        var d = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        pinch = { d: d, zoom: zoom };
      }
    }, { passive: true });

    canvas.addEventListener('touchmove', function (e) {
      if (pinch && e.touches.length === 2) {
        e.preventDefault();
        var d = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        var ratio = d / (pinch.d || 1);
        api.setZoom(pinch.zoom + Math.log2(ratio), [canvas.clientWidth / 2, canvas.clientHeight / 2]);
      }
    }, { passive: false });

    canvas.addEventListener('touchend', function () { pinch = null; }, { passive: true });

    // 清理过期瓦片缓存，避免长时间运行内存膨胀
    gcTimer = setInterval(function () {
      if (tiles.size <= 600) return;
      var cutoff = now() - 10 * 60000;
      var keys = Array.from(tiles.keys());
      for (var i = 0; i < keys.length && tiles.size > 400; i++) {
        var t = tiles.get(keys[i]);
        if (t && t.stamp < cutoff) tiles.delete(keys[i]);
      }
    }, 60000);

    resize();
    loop();
    return api;
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
