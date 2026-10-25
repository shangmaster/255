/* 工具栏弹窗：快速查看/修改选点、开关伪装、跳转到设置。 */
(function () {
  'use strict';

  var CXL = globalThis.CXL;
  var $ = function (id) { return document.getElementById(id); };

  var settings = null;
  var point = null;

  function status(text, kind) {
    var s = $('status');
    s.textContent = text;
    s.className = 'status' + (kind ? ' ' + kind : '');
  }

  function render() {
    var dot = $('dot');
    var on = settings.enabled && !!point;
    dot.className = 'dot' + (on ? ' on' : '');
    $('enabled').checked = !!settings.enabled;
    $('datum').value = settings.datum || 'gcj02';

    if (point) {
      $('coord').textContent = point.lat.toFixed(6) + ', ' + point.lon.toFixed(6) + '  (' + String(point.datum || 'gcj02').toUpperCase() + ')';
      $('addr').textContent = point.address || '未填写地址（可在地图面板里填）';
      $('manual').value = point.lat.toFixed(6) + ', ' + point.lon.toFixed(6);
    } else {
      $('coord').textContent = '尚未选点';
      $('addr').textContent = '在目标页面点右下角圆形按钮，用地图选点';
    }
  }

  /** 把选点推给当前标签页的面板（如果已注入） */
  function pushToTab(message, done) {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      var tab = tabs && tabs[0];
      if (!tab || !tab.id) { done && done(null); return; }
      chrome.tabs.sendMessage(tab.id, message, function (res) {
        void chrome.runtime.lastError;
        done && done(res || null);
      });
    });
  }

  function isChaoxingUrl(url) {
    return /^https?:\/\/([^/]*\.)?chaoxing\.com(\.cn)?\//i.test(url || '');
  }

  /**
   * 保证当前标签页已经注入内容脚本（含 lib.js / map.js / content.js）。
   * 用户第一次点「在当前页面选点」时按需注入，避免每开一个网页就跑一遍脚本。
   */
  async function ensureInjected() {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    var tab = tabs && tabs[0];
    if (!tab || !tab.id) return { ok: false, error: '找不到当前标签页' };
    if (!isChaoxingUrl(tab.url)) {
      return { ok: false, error: '当前页面不是超星/学习通页面：\n' + (tab.url || '') };
    }

    // 先 ping 一下，已经注入过就不重复注入
    var alive = await new Promise(function (resolve) {
      chrome.tabs.sendMessage(tab.id, { type: 'getState' }, function (res) {
        void chrome.runtime.lastError;
        resolve(!!res);
      });
    });
    if (alive) return { ok: true, tabId: tab.id };

    try {
      // 钩子必须跑在页面主世界（MAIN）才能真正接管页面的 navigator.geolocation；
      // 用 scripting 的 world 选项比"插 script 标签"更可靠，也不会被页面 CSP 拦掉。
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        files: ['src/injected.js']
      });
      // UI 与工具函数跑在扩展隔离世界（ISOLATED），才能用 chrome.storage / runtime
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['src/lib.js', 'src/map.js', 'src/content.js']
      });
    } catch (e) {
      return { ok: false, error: '注入失败：' + (e && e.message ? e.message : String(e)) };
    }

    // 等内容脚本挂载完面板
    for (var i = 0; i < 12; i++) {
      await new Promise(function (r) { setTimeout(r, 120); });
      var ready = await new Promise(function (resolve) {
        chrome.tabs.sendMessage(tab.id, { type: 'getState' }, function (res) {
          void chrome.runtime.lastError;
          resolve(!!res);
        });
      });
      if (ready) return { ok: true, tabId: tab.id };
    }
    return { ok: false, error: '脚本已注入但没有响应，请刷新页面后重试' };
  }

  async function boot() {
    settings = await CXL.getSettings();
    point = await CXL.getPoint();
    $('ver').textContent = 'v' + chrome.runtime.getManifest().version;
    render();

    pushToTab({ type: 'getState' }, function (res) {
      if (!res) {
        status('当前标签页没有注入面板（请在超星/学习通页面上使用，或先刷新页面）');
        return;
      }
      var r = res.runtime || {};
      status(
        '当前页面状态：\n' +
        'activeId：' + (r.activeId || '未识别') + '\n' +
        '定位调用：' + (r.geoHits || 0) + ' 次 · 参数改写：' + (r.rewrites || 0) + ' 次\n' +
        (r.status || '')
      , 'ok');
    });

    $('enabled').addEventListener('change', function () {
      CXL.saveSettings({ enabled: $('enabled').checked }).then(function (s) {
        settings = s;
        render();
        status(s.enabled ? '已启用坐标伪装' : '已关闭坐标伪装，网页将使用真实定位', s.enabled ? 'ok' : '');
      });
    });

    $('datum').addEventListener('change', function () {
      CXL.saveSettings({ datum: $('datum').value }).then(function (s) { settings = s; render(); });
    });

    $('openPicker').addEventListener('click', async function () {
      status('正在检查页面…');
      var gate = await ensureInjected();
      if (!gate.ok) {
        status(gate.error + '\n\n扩展只能作用于 *.chaoxing.com 域名下的页面。', 'err');
        return;
      }
      chrome.tabs.sendMessage(gate.tabId, { type: 'togglePanel' }, function (res) {
        void chrome.runtime.lastError;
        if (!res) { status('面板没有响应，请刷新页面后重试', 'err'); return; }
        window.close();
      });
    });

    $('applyManual').addEventListener('click', function () {
      var p = CXL.parseLatLon($('manual').value);
      if (!p) { status('坐标格式无法识别，请写成「纬度, 经度」，例如 30.123456, 120.123456', 'err'); return; }
      point = {
        lat: CXL.round6(p[0]),
        lon: CXL.round6(p[1]),
        datum: $('datum').value,
        address: (point && point.address) || '',
        source: 'manual'
      };
      CXL.setPoint(point).then(function () {
        render();
        pushToTab({ type: 'pickFromPopup', point: point });
        status('已应用坐标：' + point.lat + ', ' + point.lon, 'ok');
      });
    });

    $('clearPoint').addEventListener('click', function () {
      point = null;
      CXL.setPoint(null).then(function () {
        render();
        pushToTab({ type: 'clearPoint' });
        status('已清除选点，网页定位将恢复为真实定位');
      });
    });

    $('openOptions').addEventListener('click', function () {
      chrome.runtime.openOptionsPage();
    });

    // ---- 自动签到（只做位置签到）：这里只给"开关 + 一行状态 + 手测一次" ----
    chrome.runtime.sendMessage({ type: 'autoStatus' }, function (res) {
      if (!res || !res.ok) {
        $('autoSub').textContent = '自动签到状态读取失败：' + ((res && res.error) || '后台无响应');
        return;
      }
      var auto = Object.assign({}, CXL.AUTO_DEFAULTS, res.auto || {});
      $('autoEnabled').checked = !!auto.enabled;
      $('autoSub').textContent = CXL.describeAutoState(res.state, auto) +
        (res.schedule ? '\n当前：' + (res.schedule.reason || res.schedule.phase) : '');
    });

    $('autoEnabled').addEventListener('change', function () {
      var on = $('autoEnabled').checked;
      chrome.runtime.sendMessage({ type: 'autoConfig', auto: { enabled: on } }, function (res) {
        if (!res || !res.ok) {
          $('autoSub').textContent = '保存失败：' + ((res && res.error) || '后台无响应');
          return;
        }
        $('autoSub').textContent = on
          ? '已开启，时段与星期去设置页调整（默认 周一至周五 08:00-14:00）'
          : '已关闭自动签到';
      });
    });

    $('autoRunNow').addEventListener('click', function () {
      $('autoSub').textContent = '正在跑一轮（只处理位置签到）…';
      chrome.runtime.sendMessage({ type: 'autoRunNow' }, function (res) {
        if (!res || !res.ok) { $('autoSub').textContent = '出错：' + ((res && res.error) || '后台无响应'); return; }
        setTimeout(function () {
          chrome.runtime.sendMessage({ type: 'autoStatus' }, function (r2) {
            if (!r2 || !r2.ok) return;
            $('autoSub').textContent = CXL.describeAutoState(r2.state, r2.auto);
          });
        }, 1200);
      });
    });
  }

  boot();
})();
