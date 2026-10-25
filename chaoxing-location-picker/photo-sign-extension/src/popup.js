/*
 * 工具栏弹窗：显示当前页面状态，并提供"在当前页面打开面板"。
 * 面板是内容脚本挂上去的；如果这个页面还没被注入（刚装好扩展就打开的老标签页），
 * 这里用 scripting 按需补一次注入。
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  function status(text, kind) {
    var box = $('status');
    box.textContent = text;
    box.className = 'status' + (kind ? ' ' + kind : '');
  }

  function currentTab() {
    return new Promise(function (resolve) {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        resolve((tabs && tabs[0]) || null);
      });
    });
  }

  function sendToTab(tabId, msg) {
    return new Promise(function (resolve) {
      chrome.tabs.sendMessage(tabId, msg, function (res) {
        void chrome.runtime.lastError;
        resolve(res || null);
      });
    });
  }

  /** 页面没被注入时按需补注入（需要 *.chaoxing.com，并且要有 host 权限） */
  function ensureInjected(tab) {
    if (!tab || !/^https?:\/\/([^/]*\.)?chaoxing\.com/i.test(tab.url || '')) {
      return Promise.resolve({ ok: false, error: '当前标签页不是学习通页面（扩展只作用于 *.chaoxing.com）。' });
    }
    return sendToTab(tab.id, { type: 'getState' }).then(function (res) {
      if (res && res.ok) return { ok: true };
      return new Promise(function (resolve) {
        chrome.scripting.executeScript(
          { target: { tabId: tab.id, allFrames: true }, files: ['src/lib.js', 'src/content.js'] },
          function () {
            void chrome.runtime.lastError;
            resolve({ ok: true, injected: true });
          }
        );
      });
    });
  }

  async function boot() {
    await CXL.getSettings();

    var tab = await currentTab();
    if (!tab) { status('读不到当前标签页', 'err'); return; }

    var res = await sendToTab(tab.id, { type: 'getState' });
    if (!res) {
      status('当前页面还没有面板。点下面的按钮补注入（或刷新页面）。');
    } else {
      var r = res.runtime || {};
      status('当前页面状态：\n' +
        'activeId：' + (r.activeId || '未识别') + '\n' +
        '图片：' + (r.photo ? (r.photo.name + (r.photo.objectId ? '（已上传）' : '（未上传）')) : '未选择') + '\n' +
        (r.status || ''), 'ok');
    }

    $('openPanel').addEventListener('click', async function () {
      status('正在打开面板…');
      var gate = await ensureInjected(tab);
      if (!gate.ok) { status(gate.error, 'err'); return; }
      var r = await sendToTab(tab.id, { type: 'togglePanel' });
      if (r && r.ok) { status('面板已打开（在页面右下角）', 'ok'); window.close(); }
      else status('没能在该页面打开面板，请刷新页面后重试', 'err');
    });

    $('openOptions').addEventListener('click', function () { chrome.runtime.openOptionsPage(); });
  }

  boot();
})();
