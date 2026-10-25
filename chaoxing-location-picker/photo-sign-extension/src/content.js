/*
 * 内容脚本（隔离世界）：在学习通页面右下角挂一个极简面板，只做拍照签到：
 *   1) 自动获取这次活动的 activeId（页面请求嗅探 + 课程活动列表接口）
 *   2) 选本地图片（点击 / 拖进面板 / Ctrl+V 粘贴）
 *   3) 上传换 objectId，然后用极简参数 + GET 提交
 *
 * 与「自由选点签到」插件的区别：这里没有地图、没有坐标、没有位置签到，
 * 面板只服务于"交一张图"这一件事。
 */
(function () {
  'use strict';

  var CXL = globalThis.CXL;
  if (!CXL) return;
  if (window.__cxlPhotoLoaded) return;
  window.__cxlPhotoLoaded = true;

  var HOST_ID = 'cxl-photo-host';
  /** 自动化测试开关：selftest 会先在 <html> 上打 data-cxl-test 标记 */
  var TEST_HOOK = (function () {
    try { return document.documentElement.hasAttribute('data-cxl-test'); } catch (e) { return false; }
  })();

  var settings = null;
  var overlay = null;
  var ui = {};
  var dragDepth = 0;
  /** 摄像头会话（openCamera / stopCamera / shootCamera 都要用，必须放模块作用域） */
  var camState = { stream: null };

  /**
   * 本面板的状态。
   * photo: { name, mime, size, dataUrl, objectId }
   * activeKind: 活动列表判定的类型（photo / location / unknown…），只用来提示
   */
  var st = {
    activeId: '',
    activeName: '',
    activeKind: null,
    courseId: '',
    classId: '',
    fid: '',
    uid: '',
    userName: '',
    photo: null,
    extra: '',
    candidates: [],
    uploading: false,
    lookupBusy: false,
    lastLookupAt: 0,
    net: [],
    status: '待命'
  };

  function currentUrl() {
    try { return location.href; } catch (e) { return ''; }
  }

  function isRelevantFrame() {
    var url = currentUrl();
    if (!url || url === 'about:blank') return true;
    // 只在学习通域名下挂面板（插件也只会注入到这些域名）
    return /chaoxing\.com/i.test(url);
  }

  // ---------- 跨框架协调：只在最外层挂一个面板 ----------
  // 学习通把页面套在多层 iframe 里，扩展是 all_frames 注入的，
  // 不做协调的话每层都会冒一个面板。

  var FRAME_KEY = 'photoFrameClaims';
  var FRAME_TTL = 15000;
  var myFrameKey = 'p' + Math.random().toString(36).slice(2, 10);
  var IS_TOP = (function () {
    try { return window.top === window; } catch (e) { return false; }
  })();

  function registerClaim() {
    return new Promise(function (resolve) {
      try { chrome.storage.local.get([FRAME_KEY], function (r) { resolve((r && r[FRAME_KEY]) || {}); }); }
      catch (e) { resolve({}); }
    }).then(function (all) {
      var now = Date.now();
      var fresh = {};
      Object.keys(all || {}).forEach(function (k) {
        if (all[k] && now - all[k].ts < FRAME_TTL) fresh[k] = all[k];
      });
      fresh[myFrameKey] = { ts: now, isTop: IS_TOP };
      var patch = {};
      patch[FRAME_KEY] = fresh;
      try { chrome.storage.local.set(patch); } catch (e) { /* ignore */ }
      return fresh;
    });
  }

  function isDutyFrame(claims) {
    var list = Object.keys(claims || {}).map(function (k) { return { key: k, c: claims[k] }; });
    if (!list.length) return true;
    // 顶层优先，其次是最新上报的那个（和「自由选点」插件保持同一套规则）
    list.sort(function (a, b) {
      if (a.c.isTop !== b.c.isTop) return a.c.isTop ? -1 : 1;
      return a.c.ts - b.c.ts;
    });
    return list[0].key === myFrameKey;
  }

  function refreshDuty() {
    if (!overlay) return;
    registerClaim().then(function (claims) {
      var duty = isDutyFrame(claims);
      overlay.fab.style.display = duty ? '' : 'none';
      if (!duty && !overlay.panel.hasAttribute('hidden')) overlay.panel.setAttribute('hidden', 'hidden');
    });
  }

  // ---------- 接收主世界（页面自己）的线索 ----------
  // 页面自己拉活动列表时带着 activeId，这里旁路听一下，能拿到就省一次请求。

  window.addEventListener('message', function (e) {
    if (e.source !== window) return;
    var d = e.data;
    if (!d || d.__cxl !== 'cxl:report-photo') return;
    var p = d.payload || {};
    if (d.type === 'request' && p.url) {
      st.net.push({ url: String(p.url), at: Date.now() });
      if (st.net.length > 30) st.net.shift();
      rememberContext(p.url);
      var m = String(p.url).match(/[?&#]activeId=(\d{6,})/i);
      if (m && !st.activeId) adoptActiveId(m[1], '页面请求');
      render();
    }
  });

  /** 从页面地址 / 被捕获的请求地址 / 页面正文里收集课程、班级、fid */
  function rememberContext(src) {
    var ctx = CXL.parseCourseContext([src || '', currentUrl()]);
    if (ctx.courseId && !st.courseId) st.courseId = ctx.courseId;
    if (ctx.classId && !st.classId) st.classId = ctx.classId;
    if (ctx.fid && !st.fid) st.fid = ctx.fid;

    var want = [];
    if (!st.courseId) want.push('courseId');
    if (!st.classId) want.push('classId');
    if (!st.fid) want.push('fid');
    if (!want.length) return;

    try {
      var more = CXL.parseCourseContextFromHtml(document.documentElement.innerHTML, want);
      if (more.courseId && !st.courseId) st.courseId = more.courseId;
      if (more.classId && !st.classId) st.classId = more.classId;
      if (more.fid && !st.fid) st.fid = more.fid;
    } catch (e) { /* ignore */ }
  }

  function adoptActiveId(id, from, name) {
    if (!CXL.isActiveId(id)) return false;
    var changed = st.activeId !== String(id);
    st.activeId = String(id);
    if (name) st.activeName = name;
    // 关键：输入框是提交时真正读的字段，任何来源切换都必须在同一处同步，
    // 否则会出现"面板显示选了新活动、实际发给旧活动"的问题（踩过）。
    if (ui.activeIdInput) ui.activeIdInput.value = st.activeId;
    if (changed) {
      setStatus('已识别到签到编号 activeId = ' + st.activeId + (from ? '（来源：' + from + '）' : '') +
        '。选好图片后点「提交拍照签到」即可。', 'ok');
    }
    render();
    return changed;
  }

  // ---------- 自动获取 activeId ----------

  function lookupActiveId(opts) {
    opts = opts || {};
    var cb = typeof opts.done === 'function' ? opts.done : null;
    if (st.lookupBusy) { if (cb) cb({ ok: false, error: '正在查询中…' }); return; }

    rememberContext('');
    if (!st.courseId || !st.classId) {
      if (cb) cb({ ok: false, error: '当前页面地址里没有课程/班级编号，请在学习通课程页面里重试' });
      return;
    }

    st.lookupBusy = true;
    st.lastLookupAt = Date.now();
    if (!opts.quiet) setStatus('正在查询这门课的活动列表…', 'busy');

    chrome.runtime.sendMessage({
      type: 'lookupActiveId',
      url: currentUrl(),
      courseId: st.courseId,
      classId: st.classId,
      fid: st.fid,
      uid: st.uid
    }, function (res) {
      st.lookupBusy = false;
      var err = chrome.runtime.lastError;
      if (err) { if (cb) cb({ ok: false, error: err.message }); return; }
      if (!res) { if (cb) cb({ ok: false, error: '后台没有响应' }); return; }

      if (!res.ok) {
        if (cb) cb(res);
        else setStatus('没能自动取到 activeId：' + (res.error || '未知原因') +
          '\n可以在面板里手动填写（就是签到链接里的 activeId= 后面那串数字）。', 'err');
        return;
      }

      if (res.uid && !st.uid) st.uid = String(res.uid);
      if (res.fid && !st.fid) st.fid = String(res.fid);
      if (res.candidates) st.candidates = res.candidates;

      var changed = adoptActiveId(res.activeId, '课程活动列表', res.name);
      if (res.name && !st.activeName) st.activeName = res.name;
      if (res.kind) applyKindToUi(res.kind);
      else if (changed) setStatus('已获取到 activeId = ' + res.activeId + '。选好图片后点「提交拍照签到」。', 'ok');
      render();
      if (cb) cb(res);
    });
  }

  /** 把"这次签到要什么"讲清楚（活动列表查到 / 手动切换活动都会调） */
  function applyKindToUi(k) {
    if (!k) return;
    st.activeKind = k;
    var head = '已选中活动 ' + (st.activeId || '') +
      (st.activeName ? '（' + st.activeName + '）' : '') + '：' + k.label + '签到 · ' +
      CXL.describeNeeds(k) + '\n';
    if (k.needsQr) {
      setStatus(head + '这是**二维码签到**：要扫老师屏幕上的二维码，提交需要二维码里的 enc，' +
        '网页端拿不到。请用学习通 APP 扫码签到（如果还要求拍照，APP 里一起完成）。\n' +
        '如果你刚发的是另一个普通签到，请在「签到活动」下拉里选中它。', 'err');
    } else if (k.needsGesture) {
      setStatus(head + '这是**手势签到**：要在 3×3 格子上画手势（例如 258），网页端没有入口。请用学习通 APP。', 'err');
    } else if (k.needsCode) {
      setStatus(head + '这是**签到码签到**：需要老师给的那串数字。本插件不做这个，请用学习通 APP 或网页上的签到入口。', 'err');
    } else if (k.needsLocation) {
      setStatus(head + '这是**位置签到**：要定位。请用带地图的那个插件（自由选点签到）。', 'err');
    } else if (k.needsPhoto) {
      setStatus(head + '这是**普通签到 + 老师要求拍照**。\n' +
        '网页端交照片会被服务端拒（photoAuthError：它要的是本机拍摄的凭证）。\n' +
        '三条路，按容易程度排：\n' +
        '  1) 直接点「按普通签到提交（不交图）」——有的场景服务端不强制照片；\n' +
        '  2) 如果你就是这个活动的发布者：在签发设置里把「要求参与人拍照」**关掉**重新发，\n' +
        '     网页端立刻就能签（那个开关只影响是否要求照片）；\n' +
        '  3) 保留拍照要求，那就用学习通 APP 现场拍（网页端没有相机入口，这是超星的限制）。', 'ok');
    } else {
      setStatus(head + '直接点「按普通签到提交（不交图）」即可。' +
        (k.evidence && k.evidence.conflict
          ? '\n注意：活动名字像「' + CXL.SIGN_KINDS[k.evidence.nameKind].label +
            '」，但服务端字段说是普通。如果提交后报"请重新扫描"，那它就真是二维码签到，得用 APP 扫。'
          : ''), 'ok');
    }
  }

  // ---------- 选图 ----------

  function pickPhotoFile(file, from) {
    if (!file) return;
    var check = CXL.validatePhoto({ size: file.size, type: file.type, name: file.name });
    if (!check.ok) { flash(check.error, 'err'); render(); return; }

    var reader = new FileReader();
    reader.onload = function () {
      st.photo = {
        name: CXL.photoFileName(file.name, file.type),
        mime: file.type || 'image/jpeg',
        size: file.size,
        dataUrl: String(reader.result || ''),
        objectId: ''
      };
      render();
      setStatus('已选好图片：' + st.photo.name + '（' + (file.size / 1024).toFixed(0) + ' KB，来自' +
        (from || '本地') + '）。点「提交拍照签到」会自动上传并提交。', 'ok');
    };
    reader.onerror = function () { flash('读取图片失败，换一张试试', 'err'); };
    reader.readAsDataURL(file);
  }

  function clearPhoto() {
    st.photo = null;
    if (ui.file && 'value' in ui.file) ui.file.value = '';
    render();
    setStatus('已清除图片。');
  }

  // ---------- 摄像头现场拍一张 ----------

  /**
   * 打开摄像头，把画面显示在面板里。
   * 注意：这是"浏览器现场拍"，拍出来的是一张真实的当下照片；
   * 但它过不过得了服务端的拍照校验，取决于服务端是否要求原生拍摄凭证（photoResult），
   * 这一点网页端无法伪造，也不打算伪造。
   */
  function openCamera() {
    var md = navigator.mediaDevices;
    if (!md || typeof md.getUserMedia !== 'function') {
      setStatus('这个浏览器/页面不支持调用摄像头（或者是被权限策略拦了）。\n' +
        '可以直接用「点这里选图片」选一张本地照片，效果一样是提交一张图。', 'err');
      return;
    }
    setStatus('正在请求摄像头权限…', 'busy');
    md.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false })
      .then(function (stream) {
        camState.stream = stream;
        if (ui.camVideo) {
          ui.camVideo.srcObject = stream;
          try { ui.camVideo.play(); } catch (e) { /* ignore */ }
        }
        if (ui.camWrap) ui.camWrap.hidden = false;
        if (ui.drop) ui.drop.style.display = 'none';
        setStatus('摄像头已打开。对准要拍的画面，点「拍下这张」。', 'ok');
      })
      .catch(function (e) {
        var name = (e && e.name) || '';
        var why = name === 'NotAllowedError' ? '你拒绝了摄像头权限'
          : name === 'NotFoundError' ? '这台电脑没有可用摄像头'
            : name === 'NotReadableError' ? '摄像头被别的程序占用了'
              : (e && e.message ? e.message : String(e));
        setStatus('打不开摄像头：' + why + '\n可以改用「点这里选图片」提交本地照片。', 'err');
      });
  }

  function stopCamera() {
    if (camState.stream) {
      try {
        camState.stream.getTracks().forEach(function (t) { t.stop(); });
      } catch (e) { /* ignore */ }
      camState.stream = null;
    }
    if (ui.camVideo) { try { ui.camVideo.srcObject = null; } catch (e) { /* ignore */ } }
    if (ui.camWrap) ui.camWrap.hidden = true;
    if (ui.drop) ui.drop.style.display = '';
  }

  /** 从视频画面抓一帧 -> 文件 -> 走和本地选图一样的流程 */
  function shootCamera() {
    var v = ui.camVideo;
    if (!v || !v.videoWidth) {
      flash('画面还没准备好，等一秒再点', 'err');
      return;
    }
    var w = v.videoWidth;
    var h = v.videoHeight;
    var maxSide = 1600;                       // 太大就等比缩一下，别把上传挤爆
    if (Math.max(w, h) > maxSide) {
      var scale = maxSide / Math.max(w, h);
      w = Math.max(1, Math.round(w * scale));
      h = Math.max(1, Math.round(h * scale));
    }
    var canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext('2d');
    if (!ctx) { flash('截图失败：拿不到画布上下文', 'err'); return; }
    ctx.drawImage && ctx.drawImage(v, 0, 0, w, h);

    var done = function (blob) {
      if (!blob) { flash('截图失败，再试一次', 'err'); return; }
      var f;
      try {
        f = new File([blob], 'camera_' + Date.now() + '.jpg', { type: 'image/jpeg' });
      } catch (e) {
        // 某些环境没有 File 构造器，退化成 Blob（pickPhotoFile 只用到 name/size/type）
        f = blob;
        f.name = 'camera_' + Date.now() + '.jpg';
      }
      stopCamera();
      pickPhotoFile(f, '摄像头');
    };

    if (canvas.toBlob) canvas.toBlob(done, 'image/jpeg', 0.92);
    else done(null);
  }

  /** 从拖放/粘贴事件里取出第一个图片文件 */
  function fileFromDataTransfer(dt) {
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

  function setDragHint(on) {
    dragDepth = on ? 1 : 0;
    if (overlay && overlay.drop && overlay.drop.classList) {
      if (on) overlay.drop.classList.add('over');
      else overlay.drop.classList.remove('over');
    }
    if (overlay && overlay.panel && overlay.panel.classList) {
      if (on) overlay.panel.classList.add('dragging');
      else overlay.panel.classList.remove('dragging');
    }
    if (ui.dropTitle) {
      ui.dropTitle.textContent = on ? '松手就用这张图'
        : (st.photo ? '已选：' + st.photo.name : '点这里选图片（或把图片拖进来 / Ctrl+V 粘贴）');
    }
  }

  /**
   * 面板范围内的 drag 事件都要接管：
   * dragover 不 preventDefault 浏览器就不会派发 drop；dragleave 在子元素之间移动也会触发，
   * 所以用计数式高亮，只有真的离开面板才取消。
   */
  function isOverPanel(e) {
    if (!overlay || overlay.panel.hasAttribute('hidden')) return false;
    var r = overlay.panel.getBoundingClientRect && overlay.panel.getBoundingClientRect();
    if (!r || !r.width || !r.height) return false;
    return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  }

  document.addEventListener('dragover', function (e) {
    if (!isOverPanel(e)) return;
    e.preventDefault();
    if (e.dataTransfer) { try { e.dataTransfer.dropEffect = 'copy'; } catch (err) { /* ignore */ } }
    setDragHint(true);
  }, true);

  document.addEventListener('dragleave', function (e) {
    if (isOverPanel(e)) return;
    setDragHint(false);
  }, true);

  document.addEventListener('drop', function (e) {
    if (!isOverPanel(e)) return;
    e.preventDefault();
    setDragHint(false);
    var f = fileFromDataTransfer(e.dataTransfer);
    if (f) pickPhotoFile(f, '拖进来的图片');
    else flash('没读到拖进来的文件：请拖图片文件（jpg/png/webp）', 'err');
  }, true);

  document.addEventListener('paste', function (e) {
    if (!overlay || overlay.panel.hasAttribute('hidden')) return;
    var items = (e.clipboardData && e.clipboardData.items) || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].type && items[i].type.indexOf('image/') === 0) {
        var f = items[i].getAsFile && items[i].getAsFile();
        if (f) { pickPhotoFile(f, '剪贴板'); e.preventDefault(); }
        return;
      }
    }
  });

  // ---------- 上传 + 提交 ----------

  function uploadPhoto(opts) {
    opts = opts || {};
    var p = st.photo;
    if (!p) { if (opts.done) opts.done({ ok: false, error: '还没选图片' }); return; }
    if (p.objectId && !opts.force) { if (opts.done) opts.done({ ok: true, objectId: p.objectId }); return; }
    if (st.uploading) { if (opts.done) opts.done({ ok: false, error: '正在上传中…' }); return; }

    st.uploading = true;
    render();
    if (opts.manual) setStatus('正在上传图片（换 objectId）…', 'busy');

    chrome.runtime.sendMessage({
      type: 'uploadPhoto',
      dataUrl: p.dataUrl,
      name: p.name,
      mime: p.mime,
      uid: st.uid || ''
    }, function (res) {
      st.uploading = false;
      var err = chrome.runtime.lastError;
      if (err) { render(); if (opts.done) opts.done({ ok: false, error: err.message }); return; }
      if (!res || !res.ok) {
        render();
        var why = (res && res.error) || '上传失败';
        if (opts.done) opts.done({ ok: false, error: why });
        else setStatus('上传失败：' + why, 'err');
        return;
      }
      if (st.photo) st.photo.objectId = res.objectId;
      if (res.uid && !st.uid) st.uid = String(res.uid);
      st.lastUpload = { raw: res.uploadRaw || '', fields: res.uploadFields || [] };
      render();
      setStatus('图片已上传，objectId = ' + res.objectId +
        (res.uploadFields && res.uploadFields.length
          ? '\n上传接口返回的字段：' + res.uploadFields.join(', ')
          : '') + '\n（如果里面出现像凭证/签名的字段，把它发我，可能是拍照校验缺的那一环）', 'ok');
      if (opts.done) opts.done({ ok: true, objectId: res.objectId });
    });
  }

  /**
   * 当前要提交的编号：输入框与内部状态以"输入框"为准（用户手改优先），
   * 但两边不一致时以刚选中的活动为准并回写输入框 —— 避免"选了 A、发了 B"。
   */
  function currentActiveId() {
    var typed = (ui.activeIdInput && ui.activeIdInput.value || '').trim();
    if (CXL.isActiveId(typed) && typed === st.activeId) return typed;
    if (CXL.isActiveId(st.activeId)) {
      if (ui.activeIdInput) ui.activeIdInput.value = st.activeId;   // 回写，保持一致
      return st.activeId;
    }
    return typed;
  }

  function submit(dry, forcedKind) {
    var kind = forcedKind || 'photo';
    var activeId = currentActiveId();
    if (!CXL.isActiveId(activeId)) {
      lookupActiveId({
        done: function (r) {
          if (r && r.ok) flash('已自动获取 activeId = ' + r.activeId + '，再点一次提交即可', 'ok');
          else flash('没有有效编号：' + ((r && r.error) || '') + '\n可在面板里手动填写。', 'err');
        }
      });
      return;
    }

    // 类型明确"网页端签不了"时直接拦住，别再发一个注定失败的请求
    // （canSubmitPlain 只有明确为 false 才拦，避免旧数据/未知类型被误挡）
    var k = st.activeKind;
    if (k && k.canSubmitPlain === false) {
      var why = k.needsQr
        ? '这是二维码签到：提交需要二维码里的 enc（只在老师屏幕上、几十秒换一次），网页端拿不到。'
        : k.needsGesture
          ? '这是手势签到：要在 3×3 格子上画手势，网页端没有入口。'
          : k.needsCode
            ? '这是签到码签到：需要老师给的那串数字，本插件不做这个。'
            : k.needsLocation
              ? '这是位置签到：要定位，请用带地图的那个插件。'
              : '这类签到网页端无法提交。';
      setStatus('没有发送请求。' + why + '\n请用学习通 APP 完成这次签到。', 'err');
      return;
    }

    if (kind === 'plain') {
      // 普通签到不需要图片，直接提交（这是"这次活动其实是普通签到"时的正确形状）
      sendSign(dry, activeId, '', 'plain');
      return;
    }

    if (!st.photo) { flash('先选一张图片（点虚线框 / 拖进来 / Ctrl+V）', 'err'); return; }
    if (dry) { sendSign(dry, activeId, '', 'photo'); return; }

    if (!st.photo.objectId) {
      // 没上传过就先上传，成功后自动继续提交：用户只需要点一次
      setStatus('先上传图片换 objectId…', 'busy');
      uploadPhoto({
        done: function (r) {
          if (!r || !r.ok) {
            setStatus('上传图片失败：' + ((r && r.error) || '未知原因') + '\n签到未提交。', 'err');
            return;
          }
          sendSign(false, activeId, r.objectId, 'photo');
        }
      });
      return;
    }
    sendSign(false, activeId, st.photo.objectId, 'photo');
  }

  function sendSign(dry, activeId, objectId, kind) {
    kind = kind || 'photo';
    var who = (ui.nameInput.value || st.userName || '').trim();
    setStatus(dry ? '正在试运行（不会真的提交）…'
      : (kind === 'plain' ? '正在按普通签到提交…' : '正在提交拍照签到…'), 'busy');
    chrome.runtime.sendMessage({
      type: 'photoSign',
      dryRun: !!dry,
      payload: {
        kind: kind,
        activeId: activeId,
        objectId: objectId || '',
        uid: st.uid || '',
        fid: st.fid || '',
        name: who,
        appType: settings.appType,
        extra: st.extra || ''
      }
    }, function (res) {
      if (!res) { setStatus('没有收到后台响应，请重新加载页面后再试', 'err'); return; }
      var head = dry ? '【试运行】\n' : (res.ok ? '【结果】\n' : '【未成功】\n');
      setStatus(head + (res.message || '') + (res.url ? '\n\n请求：' + res.url : ''), res.ok ? 'ok' : 'err');
      render();
    });
  }

  // ---------- 面板 ----------

  var CSS = [
    ':host { all: initial; }',
    '* { box-sizing: border-box; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; }',
    '.fab { position: fixed; right: 18px; bottom: 90px; z-index: 2147483000; width: 52px; height: 52px;',
    '  border-radius: 50%; border: none; cursor: pointer; background: #7a5af8; color: #fff;',
    '  box-shadow: 0 6px 18px rgba(0,0,0,.28); font-size: 11px; line-height: 1.15; font-weight: 600; }',
    '.fab:hover { background: #6a4ae0; }',
    '.panel { position: fixed; right: 18px; bottom: 152px; z-index: 2147483001; width: 340px; max-width: calc(100vw - 36px);',
    '  background: #fff; border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.32); overflow: hidden;',
    '  display: flex; flex-direction: column; color: #1b1f24; font-size: 13px; }',
    '.panel[hidden] { display: none; }',
    '.panel.dragging { outline: 2px dashed #7a5af8; outline-offset: -3px; }',
    '.hd { display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: #f7f5ff; border-bottom: 1px solid #e6e2f7; }',
    '.hd b { font-size: 14px; }',
    '.hd .sp { flex: 1; }',
    '.hd button { border: none; background: transparent; cursor: pointer; font-size: 15px; color: #5a6572; padding: 2px 6px; border-radius: 6px; }',
    '.hd button:hover { background: #ece7fb; }',
    '.bd { padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; max-height: 60vh; overflow: auto; }',
    '.row { display: flex; gap: 6px; align-items: center; }',
    '.row label { color: #4a5563; min-width: 56px; font-size: 12px; }',
    'input[type=text] { flex: 1; min-width: 0; padding: 5px 7px; border: 1px solid #cfd7e3; border-radius: 6px; font-size: 12px; }',
    'button.btn { border: none; border-radius: 7px; padding: 7px 10px; cursor: pointer; font-size: 12px; background: #ece7fb; color: #2c2350; }',
    'button.btn:hover { background: #ded5f8; }',
    'button.btn.primary { background: #7a5af8; color: #fff; font-weight: 600; }',
    'button.btn.primary:hover { background: #6a4ae0; }',
    'button.btn.ghost { background: transparent; border: 1px dashed #cfd7e3; }',
    '.drop { border: 1px dashed #b9c6d9; border-radius: 10px; padding: 14px 12px; text-align: center; background: #fafbfd; cursor: pointer; }',
    '.drop:hover { border-color: #7a5af8; background: #f7f5ff; }',
    '.drop.over { border-color: #7a5af8; background: #f0ecff; box-shadow: 0 0 0 2px rgba(122,90,248,.25) inset; }',
    '.drop.has { border-style: solid; border-color: #b7d5c2; background: #f6fbf8; }',
    '.drop b { display: block; font-size: 12px; color: #22303f; margin-bottom: 3px; }',
    '.drop .meta { font-size: 11px; color: #6b7787; }',
    '.thumb { display: block; max-width: 100%; max-height: 160px; margin: 8px auto 0; border-radius: 8px; }',
    // 注意：作者样式里的 display:block 会盖掉浏览器默认的 [hidden]{display:none}，
    // 所以必须显式再写一条，否则没选图时会出现一个"破图标 + alt 文字"
    '.thumb[hidden] { display: none; }',
    '.camwrap { margin-top: 8px; }',
    '.camwrap[hidden] { display: none; }',
    '.camvid { display: block; width: 100%; max-height: 200px; border-radius: 8px; background: #000; object-fit: cover; }',
    '.status { font-size: 12px; padding: 8px 9px; border-radius: 7px; background: #f2f5fa; color: #33415c; white-space: pre-wrap; word-break: break-all; }',
    '.status.ok { background: #e6f7ed; color: #12683c; }',
    '.status.err { background: #fdecec; color: #a3241f; }',
    '.status.busy { background: #fff6e5; color: #8a5a00; }',
    '.meta { font-size: 11px; color: #6b7787; line-height: 1.6; word-break: break-all; }',
    '.ft { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid #e6e2f7; background: #fafbfd; }',
    '.ft button { flex: 1; }',
    '.sec { border-top: 1px dashed #e3e8f0; padding-top: 8px; margin-top: 2px; }',
    '.sec > summary { cursor: pointer; font-size: 12px; color: #4a5563; outline: none; }',
    '.toast { position: fixed; right: 18px; bottom: 152px; z-index: 2147483002; background: #1b1f24; color: #fff; padding: 8px 12px; border-radius: 8px; font-size: 12px; opacity: .96; max-width: 340px; }'
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

  function buildOverlay() {
    if (document.getElementById(HOST_ID)) return false;
    if (!isRelevantFrame()) return false;

    var host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'all: initial;';
    var root = host.attachShadow({ mode: 'open' });
    var style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);

    var fab = el('button', { class: 'fab', title: '学习通拍照签到', text: '拍照\n签到' });
    fab.addEventListener('click', function () { togglePanel(); });

    // ---- 选图区 ----
    var file = el('input', { type: 'file', accept: 'image/*', style: 'display:none;' });
    var img = el('img', { class: 'thumb', alt: '待提交的图片' });
    img.hidden = true;
    var dropTitle = el('b', { text: '点这里选图片（或把图片拖进来 / Ctrl+V 粘贴）' });
    var dropMeta = el('div', { class: 'meta', text: '支持 jpg / png / webp，单张不超过 10 MB' });
    var drop = el('div', { class: 'drop', title: '点击选择本地图片，也可以直接拖拽或粘贴' }, [dropTitle, dropMeta, img]);
    drop.addEventListener('click', function () {
      if (file.__proxyClick) file.__proxyClick();
      else { try { file.click(); } catch (e) { /* ignore */ } }
    });
    drop.addEventListener('dragover', function (e) {
      e.preventDefault();
      if (e.dataTransfer) { try { e.dataTransfer.dropEffect = 'copy'; } catch (err) { /* ignore */ } }
      setDragHint(true);
    });
    drop.addEventListener('dragenter', function (e) { e.preventDefault(); setDragHint(true); });
    drop.addEventListener('dragleave', function (e) {
      var to = e.relatedTarget;
      if (to && drop.contains && drop.contains(to)) return;
      setDragHint(false);
    });
    drop.addEventListener('drop', function (e) {
      e.preventDefault();
      setDragHint(false);
      var f = fileFromDataTransfer(e.dataTransfer);
      if (f) pickPhotoFile(f, '拖进来的图片');
      else flash('没读到拖进来的文件：请拖图片文件（jpg/png/webp）', 'err');
    });
    file.addEventListener('change', function () {
      var f = file.files && file.files[0];
      if (f) pickPhotoFile(f, '本地文件');
    });

    var photoRow = el('div', { class: 'row' }, [
      el('button', { class: 'btn', text: '只上传图片', onclick: function () { uploadPhoto({ manual: true }); } }),
      el('button', { class: 'btn ghost', text: '清除图片', onclick: function () { clearPhoto(); } })
    ]);

    // ---- 摄像头：在网页里现场拍一张（真·当下拍摄）----
    var camWrap = el('div', { class: 'camwrap' }, []);
    camWrap.hidden = true;
    var camVideo = el('video', { class: 'camvid', autoplay: '', playsinline: '' });
    var camShoot = el('button', { class: 'btn primary', text: '拍下这张', onclick: function () { shootCamera(); } });
    var camCancel = el('button', { class: 'btn ghost', text: '取消', onclick: function () { stopCamera(); } });
    camWrap.appendChild(camVideo);
    camWrap.appendChild(el('div', { class: 'row', style: 'margin-top:6px;' }, [camShoot, camCancel]));

    var camBtn = el('button', {
      class: 'btn',
      text: '用摄像头拍一张',
      title: '调用本机摄像头现场拍一张（浏览器会请求摄像头权限）',
      onclick: function () { openCamera(); }
    });

    // ---- 编号 / 姓名 ----
    var activeIdInput = el('input', { type: 'text', placeholder: '签到编号（留空即自动获取）' });    var nameInput = el('input', { type: 'text', placeholder: '姓名（留空则由服务端推断）' });
    var extraInput = el('input', { type: 'text', placeholder: '附加参数，如 photoResult=xxx&foo=bar' });
    activeIdInput.addEventListener('change', function () {
      var v = activeIdInput.value.trim();
      st.activeId = v;
      if (v && !CXL.isActiveId(v)) flash('activeId 看起来不对：它是 6 位以上的数字', 'err');
      render();
    });
    nameInput.addEventListener('change', function () { st.userName = nameInput.value.trim(); });
    extraInput.addEventListener('change', function () { st.extra = extraInput.value.trim(); });

    var lookupBtn = el('button', { class: 'btn', text: '自动获取编号', onclick: function () { lookupActiveId({}); } });
    // 活动选择器：同一门课可能有多个签到在进行中，必须让用户自己挑
    var pickSelect = el('select', { title: '当前进行中的签到活动' });
    pickSelect.addEventListener('change', function () {
      var id = pickSelect.value;
      var c = (st.candidates || []).filter(function (x) { return String(x.id) === String(id); })[0];
      if (!c) return;
      st.activeName = c.name;
      st.activeKind = c.kind;
      adoptActiveId(c.id, '手动选择', c.name);
      applyKindToUi(c.kind);
      render();
    });
    var pickRow = el('div', { class: 'row' }, [el('label', { text: '签到活动' }), pickSelect]);
    var probeBtn = el('button', { class: 'btn', text: '探测拍照协议', title: '把可能的拍照签到页面拉一遍，找 photoResult 这类字段的出处', onclick: function () { probePhoto(); } });
    var adv = el('details', { class: 'sec' }, [
      el('summary', { text: '手动填写 / 排查' }),
      pickRow,
      el('div', { class: 'row', style: 'margin-top:8px;' }, [el('label', { text: 'activeId' }), activeIdInput]),
      el('div', { class: 'row' }, [el('label', { text: '姓名' }), nameInput]),
      el('div', { class: 'row' }, [el('label', { text: '附加参数' }), extraInput]),
      el('div', { class: 'row', style: 'margin-top:4px;' }, [lookupBtn, probeBtn,
        el('button', { class: 'btn', text: '检查上传通道', onclick: function () { testPan(); } }),
        el('button', { class: 'btn ghost', text: '复制诊断', onclick: function () { copyDiag(this); } })]),
      el('div', { class: 'meta', text: '编号会自动获取：先看页面自己的请求，再查这门课的活动列表和活动详情。查不到时才需要手填。\n「探测拍照协议」会用你的登录态拉几个页面，看 photoResult / signToken 出现在哪里。' })
    ]);

    var status = el('div', { class: 'status', text: '待命' });
    var meta = el('div', { class: 'meta' });

    var body = el('div', { class: 'bd' }, [drop, camWrap, photoRow, camBtn, status, meta, adv]);

    var dryBtn = el('button', { class: 'btn ghost', text: '试运行', onclick: function () { submit(true); } });
    var signBtn = el('button', { class: 'btn primary', text: '提交拍照签到', onclick: function () { submit(false, 'photo'); } });
    var plainBtn = el('button', { class: 'btn', text: '按普通签到提交', title: '这次活动没有拍照类型时用它：不带图片，直接提交', onclick: function () { submit(false, 'plain'); } });
    var foot = el('div', { class: 'ft', style: 'flex-wrap:wrap;' }, [dryBtn, plainBtn, signBtn]);
    signBtn.style.flex = '1 1 100%';

    var closeBtn = el('button', { text: '✕', title: '收起', onclick: function () { togglePanel(false); } });
    var optBtn = el('button', { text: '⚙', title: '设置', onclick: function () {
      try { chrome.runtime.sendMessage({ type: 'openOptions' }); } catch (e) { /* ignore */ }
    } });
    var head = el('div', { class: 'hd' }, [
      el('b', { text: '拍照签到（本地图片）' }), el('span', { class: 'sp' }), optBtn, closeBtn
    ]);

    var panel = el('div', { class: 'panel', hidden: 'hidden' }, [head, body, foot]);

    root.appendChild(fab);
    root.appendChild(panel);
    (document.body || document.documentElement).appendChild(host);

    overlay = { host: host, root: root, fab: fab, panel: panel, drop: drop };
    ui = { file: file, img: img, drop: drop, dropTitle: dropTitle, status: status, meta: meta,
      activeIdInput: activeIdInput, nameInput: nameInput, signBtn: signBtn, plainBtn: plainBtn,
      probeBtn: probeBtn, extraInput: extraInput, pickSelect: pickSelect,
      camBtn: camBtn, camWrap: camWrap, camVideo: camVideo };

    if (TEST_HOOK) {
      window.__CXL_PHOTO_HANDLES__ = {
        ui: ui,
        st: st,
        openPanel: function () { togglePanel(true); },
        lookup: function () { lookupActiveId({}); }
      };
    }
    return true;
  }

  function togglePanel(force) {    if (!overlay) return;
    var show = (typeof force === 'boolean') ? force : overlay.panel.hasAttribute('hidden');
    if (show) overlay.panel.removeAttribute('hidden');
    else overlay.panel.setAttribute('hidden', 'hidden');
  }

  function render() {
    if (!ui.drop) return;
    var p = st.photo;
    if (ui.drop.classList) {
      if (p) ui.drop.classList.add('has');
      else ui.drop.classList.remove('has');
    }
    if (ui.img) {
      if (p && p.dataUrl) { ui.img.src = p.dataUrl; ui.img.hidden = false; }
      else { ui.img.removeAttribute('src'); ui.img.hidden = true; }
    }
    if (ui.dropTitle && !dragDepth) {
      ui.dropTitle.textContent = p ? '已选：' + p.name : '点这里选图片（或把图片拖进来 / Ctrl+V 粘贴）';
    }
    if (ui.activeIdInput && !ui.activeIdInput.value && st.activeId) ui.activeIdInput.value = st.activeId;

    // 活动下拉：把"当前进行中的签到"都列出来，默认选中当前这个
    if (ui.pickSelect) {
      var list = st.candidates || [];
      var wantHtml = list.map(function (c) {
        return String(c.id);
      }).join(',');
      if (ui.pickSelect.__renderedFor !== wantHtml) {
        ui.pickSelect.__renderedFor = wantHtml;
        ui.pickSelect.textContent = '';
        if (!list.length) {
          var op0 = document.createElement('option');
          op0.value = '';
          op0.textContent = '（没有查到进行中的签到）';
          ui.pickSelect.appendChild(op0);
        }
        list.forEach(function (c) {
          var op = document.createElement('option');
          op.value = String(c.id);
          op.textContent = (c.name || '(未命名)') + ' · ' + (c.kind ? c.kind.label : '未知') +
            ' · ' + String(c.id).slice(-6);
          ui.pickSelect.appendChild(op);
        });
      }
      if (st.activeId) ui.pickSelect.value = String(st.activeId);
    }

    var lines = [];
    lines.push('activeId：' + (st.activeId ? st.activeId + (st.activeName ? '（' + st.activeName + '）' : '') : '未识别'));
    lines.push('课程：' + (st.courseId || '?') + ' · 班级：' + (st.classId || '?') + ' · fid：' + (st.fid || '?'));
    lines.push('uid：' + (st.uid || '未识别（会自动从 Cookie 读）'));
    lines.push('图片：' + (p ? p.name + '（' + (p.size / 1024).toFixed(0) + ' KB）' +
      (st.uploading ? ' · 上传中…' : (p.objectId ? ' · objectId=' + p.objectId : ' · 尚未上传')) : '未选择'));
    if (st.activeName) lines.push('活动名称：' + st.activeName);
    if (st.activeKind) {
      lines.push('签到类型：' + st.activeKind.label + ' · ' + CXL.describeNeeds(st.activeKind));
      // 把判定依据摊开：为什么判成这个类型，一眼能看到，不用猜
      lines.push('判定依据：' + CXL.describeEvidence(st.activeKind));
    }
    if (ui.meta) ui.meta.textContent = lines.join('\n');

    // 按签到类型调整按钮主次：
    //   · 普通签到（含"老师要求拍照"）/ 类型未知 → 「按普通签到提交」是主按钮
    //   · 明确签不了的类型（二维码/手势/签到码/位置）→ 两个都不做主按钮，
    //     因为点了也会被本地拦下，不该引导用户去点"多半失败"的那个
    var kNow = st.activeKind;
    var blocked = !!(kNow && kNow.canSubmitPlain === false);
    var plainFirst = !blocked;
    if (ui.signBtn && ui.plainBtn) {
      ui.plainBtn.className = 'btn' + (plainFirst ? ' primary' : '');
      ui.signBtn.className = 'btn' + (!plainFirst && !blocked ? ' primary' : '');
      ui.signBtn.style.flex = plainFirst ? '1' : '1 1 100%';
      ui.plainBtn.style.flex = plainFirst ? '1 1 60%' : '1';
      ui.signBtn.textContent = blocked
        ? '网页端无法提交（请用 APP）'
        : (plainFirst ? '提交拍照签到（交图）' : '仍要试交图');
      ui.plainBtn.textContent = plainFirst ? '按普通签到提交（不交图）' : '按普通签到提交';
    }
  }

  function setStatus(text, kind) {
    st.status = text;
    if (!ui.status) return;
    ui.status.textContent = text;
    ui.status.className = 'status' + (kind ? ' ' + kind : '');
  }

  function flash(text, kind) {
    setStatus(text, kind);
    if (!overlay) return;
    var t = el('div', { class: 'toast', text: text });
    overlay.root.appendChild(t);
    setTimeout(function () { t.remove(); }, 2600);
  }

  function testPan() {
    setStatus('正在检查图片上传通道…', 'busy');
    chrome.runtime.sendMessage({ type: 'testPan' }, function (res) {
      if (!res) { setStatus('后台没有响应', 'err'); return; }
      setStatus(res.message, res.ok ? 'ok' : 'err');
    });
  }

  /**
   * 协议探测：把可能的拍照签到页面拉一遍，看 photoResult / signToken 出现在哪里。
   * 结果直接显示在面板里（太长就截断），完整内容可以「复制诊断」带走。
   */
  function probePhoto() {
    if (!CXL.isActiveId(st.activeId)) {
      flash('先拿到 activeId 再探测（可以点「自动获取编号」）', 'err');
      return;
    }
    setStatus('正在探测拍照协议（会拉 6 个页面/接口，稍等）…', 'busy');
    chrome.runtime.sendMessage({
      type: 'probePhoto',
      activeId: st.activeId,
      courseId: st.courseId,
      classId: st.classId,
      fid: st.fid,
      uid: st.uid
    }, function (res) {
      if (!res || !res.ok) {
        setStatus('探测失败：' + ((res && (res.error || res.message)) || '后台没有响应'), 'err');
        return;
      }
      st.lastProbe = res;
      var lines = ['【协议探测结果】activeId=' + res.activeId, ''];
      (res.probes || []).forEach(function (p) {
        var hits = Object.keys(p.hits || {}).map(function (k) { return k + '×' + p.hits[k]; }).join(' ');
        lines.push('· ' + p.name + '  HTTP ' + p.status + '  ' + (p.len || 0) + 'B  ' +
          (hits || '无关键词'));
        if (p.error) lines.push('    ⚠ ' + p.error);
        (p.snippets || []).forEach(function (s) { lines.push('    ' + s.slice(0, 180)); });
      });
      var withHit = (res.probes || []).filter(function (p) {
        return p.hits && (p.hits.photoResult || p.hits.signToken);
      });
      lines.push('');
      lines.push(withHit.length
        ? '→ 有页面出现 photoResult/signToken，把这段（或「复制诊断」的内容）发我，我来对形状。'
        : '→ 6 个目标里都没有 photoResult/signToken。说明它在原生端，或页面需要 APP UA/桥才能拉到。');
      setStatus(lines.join('\n'), withHit.length ? 'ok' : 'err');
    });
  }

  function copyDiag(btn) {
    var snap = {
      时间: new Date().toISOString(),
      页面: currentUrl(),
      是否顶层: IS_TOP,
      activeId: st.activeId || null,
      活动类型: st.activeKind ? st.activeKind.label : null,
      课程: st.courseId || null,
      班级: st.classId || null,
      fid: st.fid || null,
      uid: st.uid || null,
      图片: st.photo ? { 文件名: st.photo.name, 类型: st.photo.mime, 字节: st.photo.size, objectId: st.photo.objectId || null } : null,
      上传接口返回字段: st.lastUpload ? st.lastUpload.fields : null,
      上传接口返回原文: st.lastUpload ? st.lastUpload.raw : null,
      状态: st.status,
      网络记录: st.net.slice(-10)
    };
    var text = JSON.stringify(snap, null, 2);
    var done = function (t) {
      if (btn) { var old = btn.textContent; btn.textContent = t; setTimeout(function () { btn.textContent = old; }, 1600); }
    };
    try {
      navigator.clipboard.writeText(text).then(function () { done('已复制 ✓'); }, function () { done('复制失败'); });
    } catch (e) { done('复制失败'); }
  }

  // ---------- 启动 ----------

  boot();

  async function boot() {
    settings = await CXL.getSettings();

    var mounted = false;
    function mount() {
      if (mounted) return true;
      if (!document.body) return false;
      buildOverlay();
      if (!overlay) return false;
      mounted = true;
      rememberContext('');
      st.uid = readCookie('_uid') || readCookie('UID') || '';
      render();
      refreshDuty();
      setStatus('待命。正在自动获取这次签到的编号…');
      // 挂载成功的标记：在页面控制台能看到，排查"没看到按钮"时很有用
      try {
        console.info('[拍照签到插件] 面板已挂载 · 当前页面：' + currentUrl() +
          ' · 是否顶层：' + IS_TOP + ' · 右下角应有紫色圆按钮');
      } catch (e) { /* ignore */ }
      if (settings.autoDetect && !st.activeId) lookupActiveId({ quiet: true });
      fetchUserName();
      return true;
    }

    if (!mount()) {
      var timer = setInterval(function () { if (mount()) clearInterval(timer); }, 300);
      setTimeout(function () { clearInterval(timer); }, 20000);
    }

    // 没拿到编号就持续试探（老师什么时候发签到不确定）；拿到就停
    setInterval(function () {
      if (!overlay || !settings || !settings.autoDetect) return;
      if (st.activeId || st.lookupBusy) return;
      if (ui.activeIdInput && ui.activeIdInput.value.trim()) return;
      if (!st.courseId || !st.classId) return;
      if (Date.now() - (st.lastLookupAt || 0) < 30000) return;
      lookupActiveId({ quiet: true });
    }, 6000);

    setInterval(function () { refreshDuty(); }, 4000);
  }

  function readCookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  }

  /**
   * 把登录账号的姓名读出来填进 name。
   * 实测：请求里 name 为空虽然是服务端允许的（由登录态推断），
   * 但普通签到带上真名更稳，而且面板里能看到"以谁的身份"提交。
   */
  function fetchUserName() {
    try {
      chrome.runtime.sendMessage({ type: 'whoAmI' }, function (res) {
        if (!res || !res.name) return;
        if (!st.userName) st.userName = res.name;
        if (ui.nameInput && !ui.nameInput.value) ui.nameInput.value = res.name;
        render();
      });
    } catch (e) { /* ignore */ }
  }

  // 供 popup 调用
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return;
    if (msg.type === 'togglePanel') {
      togglePanel();
      sendResponse({ ok: true, open: overlay && !overlay.panel.hasAttribute('hidden') });
    } else if (msg.type === 'getState') {
      sendResponse({
        ok: true,
        runtime: {
          activeId: st.activeId,
          activeName: st.activeName,
          courseId: st.courseId,
          classId: st.classId,
          status: st.status,
          photo: st.photo ? { name: st.photo.name, objectId: st.photo.objectId || null } : null
        }
      });
    } else if (msg.type === 'frameReport') {
      sendResponse({ ok: true, frame: { url: currentUrl(), hasPhoto: !!st.photo, activeId: st.activeId || null } });
    }
    return true;
  });
})();
