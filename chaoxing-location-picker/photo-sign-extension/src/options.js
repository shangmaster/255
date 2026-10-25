/*
 * 设置页：读写配置 + 两个自检。
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  function setSaved(text) { $('saved').textContent = text || ''; }

  function setTest(text, kind) {
    var box = $('testStatus');
    box.textContent = text;
    box.className = 'status' + (kind ? ' ' + kind : '');
  }

  function fill(settings) {
    $('autoDetect').checked = !!settings.autoDetect;
    $('dryRun').checked = !!settings.dryRun;
    $('appType').value = settings.appType || '15';
  }

  async function boot() {
    var settings = await CXL.getSettings();
    fill(settings);

    $('save').addEventListener('click', function () {
      CXL.saveSettings({
        autoDetect: $('autoDetect').checked,
        dryRun: $('dryRun').checked,
        appType: $('appType').value.trim() || '15'
      }).then(function (s) {
        fill(s);
        setSaved('已保存（' + new Date().toLocaleTimeString() + '）');
      });
    });

    // 开关即时生效，不用非得点保存
    ['autoDetect', 'dryRun'].forEach(function (id) {
      $(id).addEventListener('change', function () {
        var patch = {};
        patch[id] = $(id).checked;
        CXL.saveSettings(patch).then(function () { setSaved('已保存'); });
      });
    });

    $('testLogin').addEventListener('click', function () {
      setTest('正在检查登录状态…');
      chrome.runtime.sendMessage({ type: 'testLogin' }, function (res) {
        if (!res) { setTest('后台无响应', 'err'); return; }
        setTest(res.message, res.ok ? 'ok' : 'err');
      });
    });

    $('testPan').addEventListener('click', function () {
      setTest('正在检查图片上传通道…');
      chrome.runtime.sendMessage({ type: 'testPan' }, function (res) {
        if (!res) { setTest('后台无响应', 'err'); return; }
        setTest(res.message, res.ok ? 'ok' : 'err');
      });
    });
  }

  boot();
})();
