/* 设置页：读写配置、连通性自检、维护当前选点与常用点、自动签到（只做位置签到）。 */
(function () {
  'use strict';

  var CXL = globalThis.CXL;
  var $ = function (id) { return document.getElementById(id); };

  var settings = null;
  var point = null;
  var auto = null;

  function setTest(text, kind) {
    var s = $('testStatus');
    s.textContent = text;
    s.className = 'status' + (kind ? ' ' + kind : '');
  }

  function setSave(text, kind) {
    var s = $('saveStatus');
    s.textContent = text;
    s.className = 'status' + (kind ? ' ' + kind : '');
    if (text) setTimeout(function () { if (s.textContent === text) { s.textContent = ''; s.className = 'status'; } }, 3500);
  }

  // ---------- 自动签到 ----------

  function setAutoStatus(text, kind) {
    var s = $('autoStatus');
    s.textContent = text;
    s.className = 'status' + (kind ? ' ' + kind : '');
  }

  /** 把 auto 配置铺到表单上 */
  function fillAutoForm() {
    $('autoEnabled').checked = !!auto.enabled;
    $('autoStart').value = auto.startTime || '08:00';
    $('autoEnd').value = auto.endTime || '14:00';
    $('autoInterval').value = Math.round((Number(auto.intervalMs) || 20000) / 1000);
    $('autoRounds').value = Number(auto.maxRounds) || 10;
    $('autoStop').checked = auto.stopAfterSuccess !== false;
    var days = Array.isArray(auto.weekdays) ? auto.weekdays.map(Number) : [];
    [].forEach.call($('autoWeekdays').querySelectorAll('input[type=checkbox]'), function (box) {
      box.checked = days.indexOf(Number(box.value)) >= 0;
    });
    $('autoPointHint').textContent = point
      ? '当前选点 ' + point.lat.toFixed(6) + ', ' + point.lon.toFixed(6)
      : '未设置（自动签到需要一个起始点）';
    renderCourses();
  }

  /** 从表单读回 auto 配置；顺手做基本校验，别把 25:00 这种写进存储 */
  function collectAuto() {
    var start = CXL.parseClock($('autoStart').value);
    var end = CXL.parseClock($('autoEnd').value);
    if (start === null) start = CXL.parseClock('08:00');
    if (end === null) end = CXL.parseClock('14:00');
    var days = [];
    [].forEach.call($('autoWeekdays').querySelectorAll('input[type=checkbox]'), function (box) {
      if (box.checked) days.push(Number(box.value));
    });
    var interval = Math.max(10, Math.min(600, parseInt($('autoInterval').value, 10) || 20));
    var rounds = Math.max(1, Math.min(30, parseInt($('autoRounds').value, 10) || 10));
    return {
      enabled: $('autoEnabled').checked,
      startTime: CXL.formatClock(start),
      endTime: CXL.formatClock(end),
      weekdays: days,
      intervalMs: interval * 1000,
      maxRounds: rounds,
      stopAfterSuccess: $('autoStop').checked,
      locationOnly: true,          // 固定：只签位置签到
      autoSubmit: true,
      // 监控的课程由上面的勾选框单独维护，保存时段时不能把它冲掉
      courses: (auto && auto.courses) || []
    };
  }

  function renderAutoLog(log) {
    var box = $('autoLog');
    var items = (log && log.items) || [];
    if (!items.length) {
      box.textContent = '还没有日志。点「立刻跑一轮」可以先手测一次。';
      return;
    }
    box.textContent = items.slice(-40).reverse().map(CXL.describeLog).join('\n');
  }

  // ---------- 监控的课程 ----------

  /** 缓存一次课表，勾选时不用每次回后台 */
  var courseCache = [];

  function renderCourses() {
    var box = $('courseList');
    box.textContent = '';
    if (!courseCache.length) {
      var tip = document.createElement('div');
      tip.className = 'empty';
      tip.textContent = '点「从课表读取我的课程」把课列出来；不选就是自动监控全部课程。';
      box.appendChild(tip);
      return;
    }
    var picked = {};
    ((auto && auto.courses) || []).forEach(function (c) {
      picked[c.courseId + '/' + c.classId] = true;
    });
    courseCache.forEach(function (c) {
      var key = c.courseId + '/' + c.classId;
      var row = document.createElement('label');
      row.className = 'c';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!picked[key];
      cb.addEventListener('change', function () { toggleCourse(c, cb.checked); });
      var name = document.createElement('span');
      name.textContent = c.courseName || '(未命名课程)';
      var ids = document.createElement('code');
      ids.textContent = c.courseId + '/' + c.classId;
      row.appendChild(cb);
      row.appendChild(name);
      row.appendChild(ids);
      box.appendChild(row);
    });
  }

  /** 勾/取消一门课：立刻写进 auto.courses，引擎马上生效 */
  function toggleCourse(course, on) {
    var list = ((auto && auto.courses) || []).slice();
    var key = course.courseId + '/' + course.classId;
    var idx = -1;
    for (var i = 0; i < list.length; i++) {
      if ((list[i].courseId + '/' + list[i].classId) === key) { idx = i; break; }
    }
    if (on && idx < 0) list.push(course);
    if (!on && idx >= 0) list.splice(idx, 1);
    auto = Object.assign({}, auto, { courses: list });
    chrome.runtime.sendMessage({ type: 'autoConfig', auto: { courses: list } }, function () {
      setAutoStatus(list.length
        ? '已指定监控 ' + list.length + ' 门课：' + list.map(function (c) { return c.courseName; }).join('、')
        : '已改为自动模式：监控全部课程（后台自己从课表读取）', 'ok');
    });
  }

  function loadCourses() {
    var box = $('courseList');
    box.textContent = '正在读取课表…';
    chrome.runtime.sendMessage({ type: 'autoCourses' }, function (res) {
      if (!res || !res.ok) {
        box.textContent = '';
        var tip = document.createElement('div');
        tip.className = 'warn';
        tip.textContent = (res && res.error) || '读取失败，请先在浏览器里登录学习通再试';
        box.appendChild(tip);
        return;
      }
      courseCache = res.courses || [];
      if (!courseCache.length) {
        box.textContent = '';
        var empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = '课表里没有课程（这学期没选课？），或者接口结构变了。';
        box.appendChild(empty);
        return;
      }
      renderCourses();
      setAutoStatus('读到 ' + courseCache.length + ' 门课程，勾选要监控的课（不勾 = 全部）', 'ok');
    });
  }

  function renderAutoState(state, schedule) {
    var lines = [];
    lines.push(CXL.describeAutoState(state, auto));
    if (schedule) {
      lines.push('当前：' + schedule.phase +
        (schedule.inWindow ? '（正在时段内）' : schedule.awaiting ? '（收尾中）' : '') +
        ' · ' + (schedule.reason || ''));
    }
    if (state && state.current && state.current.activeName) {
      lines.push('正在处理：' + (state.current.courseName || '') + '「' + state.current.activeName +
        '」activeId=' + state.current.activeId);
    }
    if (state && state.progress) {
      var pr = state.progress;
      lines.push('进度：第 ' + (pr.round || 0) + ' 次提交' +
        (pr.meters !== null && pr.meters !== undefined ? ' · 还差 ' + CXL.formatDistance(pr.meters) : '') +
        (pr.solution ? ' · 算出的签到点 ' + pr.solution.lat.toFixed(6) + ', ' + pr.solution.lon.toFixed(6) +
          '（残差 ' + Math.round(pr.solution.residual) + ' m）' : ''));
    }
    if (state && state.stats) {
      lines.push('今天：查询 ' + (state.stats.polls || 0) + ' 次 · 提交 ' + (state.stats.submitted || 0) +
        ' 次 · 成功 ' + (state.stats.success || 0) + ' 次');
    }
    if (state && state.lastError) lines.push('上次的问题：' + state.lastError);
    lines.push('时段：' + CXL.describeSchedule(auto));
    setAutoStatus(lines.join('\n'), state && state.stats && state.stats.success ? 'ok'
      : (state && state.lastError ? 'err' : ''));
  }

  function refreshAuto() {
    chrome.runtime.sendMessage({ type: 'autoStatus' }, function (res) {
      if (!res || !res.ok) {
        setAutoStatus((res && res.error) || '后台无响应（点一下扩展图标再试）', 'err');
        return;
      }
      auto = Object.assign({}, CXL.AUTO_DEFAULTS, res.auto || {});
      fillAutoForm();
      renderAutoState(res.state, res.schedule);
      renderAutoLog(res.log);
    });
  }

  /** 保存自动签到配置（走后台，让引擎立刻重排定时器） */
  function saveAuto(quiet) {
    var next = collectAuto();
    chrome.runtime.sendMessage({ type: 'autoConfig', auto: next }, function (res) {
      if (!res || !res.ok) {
        setAutoStatus((res && res.error) || '保存失败：后台无响应', 'err');
        return;
      }
      auto = next;
      fillAutoForm();
      if (!quiet) setAutoStatus('已保存：' + CXL.describeSchedule(next) +
        (next.enabled ? '，到点会自动开始。' : '（自动签到未开启）'), 'ok');
      refreshAuto();
    });
  }

  function fillForm() {
    $('enabled').checked = !!settings.enabled;
    $('spoofGeo').checked = !!settings.spoofGeo;
    $('spoofTiles').checked = !!settings.spoofTiles;
    $('autoDetect').checked = !!settings.autoDetect;
    $('record').checked = !!settings.record;
    $('dryRun').checked = !!settings.dryRun;
    $('datum').value = settings.datum;
    $('defaultZoom').value = settings.defaultZoom;
    $('tileUrl').value = settings.tileUrl;
    $('tileSubdomains').value = (settings.tileSubdomains || []).join(',');
    $('appType').value = settings.appType;
    $('ifTiJiao').value = settings.ifTiJiao;
    $('amapKey').value = settings.amapKey || '';

    if (point) {
      $('curPoint').value = point.lat.toFixed(6) + ', ' + point.lon.toFixed(6);
      $('curAddr').value = point.address || '';
    } else {
      $('curPoint').value = '';
      $('curAddr').value = '';
    }
  }

  function collect() {
    return {
      enabled: $('enabled').checked,
      spoofGeo: $('spoofGeo').checked,
      spoofTiles: $('spoofTiles').checked,
      autoDetect: $('autoDetect').checked,
      record: $('record').checked,
      dryRun: $('dryRun').checked,
      datum: $('datum').value,
      defaultZoom: Math.max(3, Math.min(19, parseInt($('defaultZoom').value, 10) || 16)),
      tileUrl: $('tileUrl').value.trim() || CXL.DEFAULTS.tileUrl,
      tileSubdomains: $('tileSubdomains').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean),
      appType: $('appType').value.trim() || '15',
      ifTiJiao: $('ifTiJiao').value.trim() || '1',
      amapKey: $('amapKey').value.trim()
    };
  }

  async function boot() {
    settings = await CXL.getSettings();
    point = await CXL.getPoint();
    auto = Object.assign({}, CXL.AUTO_DEFAULTS, settings.auto || {});
    fillForm();
    fillAutoForm();
    refreshAuto();

    // ---- 自动签到 ----
    $('autoSave').addEventListener('click', function () { saveAuto(false); });
    $('autoEnabled').addEventListener('change', function () {
      // 勾上就顺手保存，省得用户忘了点按钮还以为已经开了
      saveAuto(true);
      setAutoStatus($('autoEnabled').checked
        ? '已开启，点「保存并启用」确认时段与星期（当前 ' + CXL.describeSchedule(collectAuto()) + '）'
        : '已关闭自动签到', $('autoEnabled').checked ? 'ok' : '');
    });
    $('autoRefresh').addEventListener('click', refreshAuto);
    $('fetchCourses').addEventListener('click', loadCourses);
    $('clearCourses').addEventListener('click', function () {
      auto = Object.assign({}, auto, { courses: [] });
      courseCache = [];
      renderCourses();
      chrome.runtime.sendMessage({ type: 'autoConfig', auto: { courses: [] } }, function () {
        setAutoStatus('已改为自动模式：监控全部课程（后台自己从课表读取，不用打开课程页面）', 'ok');
      });
    });
    $('autoRunNow').addEventListener('click', function () {
      setAutoStatus('正在跑一轮（只处理位置签到）…');
      chrome.runtime.sendMessage({ type: 'autoRunNow' }, function (res) {
        if (!res || !res.ok) { setAutoStatus((res && res.error) || '后台无响应', 'err'); return; }
        refreshAuto();
      });
    });
    $('autoReset').addEventListener('click', function () {
      chrome.runtime.sendMessage({ type: 'autoReset' }, function () {
        refreshAuto();
        setSave('已重置今天的自动签到记录', 'ok');
      });
    });
    $('useCurrentPoint').addEventListener('click', function () {
      var p = CXL.parseLatLon($('curPoint').value);
      if (!p) { setAutoStatus('上面「当前选点」还没有坐标：先在课程页面用地图选一个大概位置', 'err'); return; }
      point = {
        lat: CXL.round6(p[0]),
        lon: CXL.round6(p[1]),
        datum: $('datum').value || 'gcj02',
        address: $('curAddr').value.trim(),
        source: 'options-auto'
      };
      CXL.setPoint(point).then(function () {
        fillAutoForm();
        setAutoStatus('已把 ' + point.lat.toFixed(6) + ', ' + point.lon.toFixed(6) +
          ' 设为自动签到的起始点。差得远也没关系：会自动用服务端返回的距离做三点定位逼近。', 'ok');
      });
    });
    ['daysWork', 'daysAll', 'daysNone'].forEach(function (id) {
      $(id).addEventListener('click', function () {
        var preset = id === 'daysWork' ? [1, 2, 3, 4, 5] : id === 'daysAll' ? [0, 1, 2, 3, 4, 5, 6] : [];
        [].forEach.call($('autoWeekdays').querySelectorAll('input[type=checkbox]'), function (box) {
          box.checked = preset.indexOf(Number(box.value)) >= 0;
        });
      });
    });

    $('save').addEventListener('click', function () {
      CXL.saveSettings(collect()).then(function (s) {
        settings = s;
        setSave('已保存', 'ok');
      });
    });

    // 勾选框即时生效，避免用户忘记点保存
    ['enabled', 'spoofGeo', 'spoofTiles', 'autoDetect', 'record', 'dryRun'].forEach(function (id) {
      $(id).addEventListener('change', function () {
        CXL.saveSettings(collect()).then(function (s) { settings = s; setSave('已保存', 'ok'); });
      });
    });

    $('resetTiles').addEventListener('click', function () {
      $('tileUrl').value = CXL.DEFAULTS.tileUrl;
      $('tileSubdomains').value = CXL.DEFAULTS.tileSubdomains.join(',');
      setSave('已恢复默认瓦片，记得保存', 'ok');
    });

    $('osmTiles').addEventListener('click', function () {
      $('tileUrl').value = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
      $('tileSubdomains').value = '';
      setSave('已切换为 OpenStreetMap（国内加载可能较慢），记得保存', 'ok');
    });

    $('testLogin').addEventListener('click', function () {
      setTest('正在检查登录状态…');
      chrome.runtime.sendMessage({ type: 'testLogin' }, function (res) {
        if (!res) { setTest('后台无响应', 'err'); return; }
        setTest(res.message, res.ok ? 'ok' : 'err');
      });
    });

    $('testReach').addEventListener('click', function () {
      setTest('正在访问签到接口…');
      chrome.runtime.sendMessage({ type: 'testReach' }, function (res) {
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

    $('savePoint').addEventListener('click', function () {
      var p = CXL.parseLatLon($('curPoint').value);
      if (!p) { setSave('坐标格式无法识别', 'err'); return; }
      point = {
        lat: CXL.round6(p[0]),
        lon: CXL.round6(p[1]),
        datum: $('datum').value,
        address: (point && point.address) || $('curAddr').value.trim(),
        source: 'options'
      };
      CXL.setPoint(point).then(function () { fillForm(); setSave('已保存选点', 'ok'); });
    });

    $('saveAddr').addEventListener('click', function () {
      if (!point) { setSave('请先设置坐标', 'err'); return; }
      point = Object.assign({}, point, { address: $('curAddr').value.trim() });
      CXL.setPoint(point).then(function () { setSave('已保存地址文本', 'ok'); });
    });

    $('clearPoint').addEventListener('click', function () {
      point = null;
      CXL.setPoint(null).then(function () { fillForm(); setSave('已清除选点', 'ok'); });
    });

    $('clearPresets').addEventListener('click', function () {
      CXL.setPresets([]).then(function () { setSave('已清空常用点', 'ok'); });
    });
  }

  boot();
})();
