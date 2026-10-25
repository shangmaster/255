/*
 * 共用工具：配置读写、坐标系转换、距离计算、选点存储、签到 URL 组装。
 * 该文件同时在扩展页面（popup/options）和内容脚本（隔离世界）里加载，
 * 通过显式传入的全局对象挂载 CXL，避免依赖隐式的 this 绑定。
 */
(function (global) {
  'use strict';

  var CXL = global.CXL || (global.CXL = {});

  // ---------- 默认配置 ----------

  CXL.DEFAULTS = {
    enabled: true,          // 总开关：是否劫持网页定位
    spoofGeo: true,         // 是否劫持 navigator.geolocation
    spoofTiles: true,       // 是否同时改写"瓦片请求"里的坐标（备用兜底）
    datum: 'gcj02',         // 选点使用的坐标系：gcj02（高德/腾讯/国内地图）| wgs84（GPS 原始）
    appType: '15',          // 学习通签到请求的 appType 参数
    ifTiJiao: '1',          // 学习通签到请求的 ifTiJiao 参数
    autoDetect: true,       // 自动获取 activeId（页面 + 网络请求 + 课程活动列表接口）
    record: true,           // 旁路记录页面网络活动，用于找出 activeId / 排查问题
    dryRun: false,          // 试运行：只打印将要发送的请求，不真正提交
    tileUrl: 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
    tileSubdomains: ['1', '2', '3', '4'],
    amapKey: '',            // 可选：高德 Web 服务 key，用于地址搜索 / 逆地理编码
    defaultZoom: 16
  };

  var KEY_SETTINGS = 'settings';
  var KEY_POINT = 'point';
  var KEY_PRESETS = 'presets';

  // ---------- 存储 ----------

  function storageGet(keys) {
    return new Promise(function (resolve) {
      chrome.storage.local.get(keys, function (res) { resolve(res || {}); });
    });
  }

  function storageSet(obj) {
    return new Promise(function (resolve) {
      chrome.storage.local.set(obj, function () { resolve(); });
    });
  }

  CXL.getSettings = async function () {
    var res = await storageGet(KEY_SETTINGS);
    return Object.assign({}, CXL.DEFAULTS, res[KEY_SETTINGS] || {});
  };

  CXL.saveSettings = function (patch) {
    return CXL.getSettings().then(function (s) {
      var next = Object.assign({}, s, patch);
      return storageSet({ settings: next }).then(function () { return next; });
    });
  };

  /** 当前选中的签到点：{lat, lon, datum, address, source} */
  CXL.getPoint = async function () {
    var res = await storageGet(KEY_POINT);
    return res[KEY_POINT] || null;
  };

  CXL.setPoint = function (point) {
    return storageSet({ point: point });
  };

  CXL.getPresets = async function () {
    var res = await storageGet(KEY_PRESETS);
    return res[KEY_PRESETS] || [];
  };

  CXL.setPresets = function (list) {
    return storageSet({ presets: list });
  };

  // ---------- 订阅变更（popup / overlay 同步） ----------

  CXL.onChange = function (handler) {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local') return;
      var payload = {};
      var hit = false;
      if (changes[KEY_SETTINGS]) { payload.settings = Object.assign({}, CXL.DEFAULTS, changes[KEY_SETTINGS].newValue || {}); hit = true; }
      if (changes[KEY_POINT]) { payload.point = changes[KEY_POINT].newValue || null; hit = true; }
      if (changes[KEY_PRESETS]) { payload.presets = changes[KEY_PRESETS].newValue || []; hit = true; }
      if (hit) handler(payload);
    });
  };

  // ---------- 坐标系转换（GCJ-02 / WGS-84 / BD-09） ----------

  var PI = Math.PI;
  var A = 6378245.0;
  var EE = 0.00669342162296594323;
  var X_PI = (PI * 3000.0) / 180.0;

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

  CXL.wgs84ToGcj02 = function (lat, lon) {
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
  };

  CXL.gcj02ToWgs84 = function (lat, lon) {
    if (outOfChina(lat, lon)) return [lat, lon];
    var g = CXL.wgs84ToGcj02(lat, lon);
    return [lat * 2 - g[0], lon * 2 - g[1]];
  };

  CXL.gcj02ToBd09 = function (lat, lon) {
    var z = Math.sqrt(lon * lon + lat * lat) + 0.00002 * Math.sin(lat * X_PI);
    var theta = Math.atan2(lat, lon) + 0.000003 * Math.cos(lon * X_PI);
    return [z * Math.sin(theta) + 0.006, z * Math.cos(theta) + 0.0065];
  };

  CXL.bd09ToGcj02 = function (lat, lon) {
    var x = lon - 0.0065;
    var y = lat - 0.006;
    var z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * X_PI);
    var theta = Math.atan2(y, x) - 0.000003 * Math.cos(x * X_PI);
    return [z * Math.sin(theta), z * Math.cos(theta)];
  };

  /** 把任意坐标系下的点转成 GCJ-02 */
  CXL.toGcj02 = function (lat, lon, datum) {
    if (datum === 'wgs84') return CXL.wgs84ToGcj02(lat, lon);
    if (datum === 'bd09') return CXL.bd09ToGcj02(lat, lon);
    return [lat, lon];
  };

  /** 把 GCJ-02 的点转成目标坐标系 */
  CXL.fromGcj02 = function (lat, lon, datum) {
    if (datum === 'wgs84') return CXL.gcj02ToWgs84(lat, lon);
    if (datum === 'bd09') return CXL.gcj02ToBd09(lat, lon);
    return [lat, lon];
  };

  // -------------------------------------------------------------------------
  // 自动获取签到活动的 activeId
  //
  // 网页版学习通把签到入口藏起来了，但页面自己拉「活动列表」的接口是公开协议：
  //   GET https://mobilelearn.chaoxing.com/v2/apis/active/student/activelist
  //       ?fid=学校id&courseId=课程id&classId=班级id&showNotStartedActive=0
  // 返回 { result: 1, data: { activeList: [{ id, status, signType, nameOne, ... }] } }，
  // 其中 status==1 表示"进行中"（页面用它填 activeList1 那个"进行中"分组），
  // status==2 是"已结束"，没有 status 是"未开始"。
  // 只要拿到当前课程 + 班级，就能让扩展自己把这个编号取回来，不必让用户去翻签到消息。
  // -------------------------------------------------------------------------

  /** 活动列表接口（与网页 stuActiveList 页面调的是同一个） */
  CXL.ACTIVE_LIST_HOST = 'https://mobilelearn.chaoxing.com';
  CXL.ACTIVE_LIST_PATH = '/v2/apis/active/student/activelist';
  /** 活动详情接口：activeSort（唯一可靠的签到类型判别字段）就在这里面 */
  CXL.ACTIVE_INFO_PATH = '/v2/apis/active/getPPTActiveInfo';

  /**
   * 课表接口：拿到"我有哪些课 / 班级"。
   * 自动签到不该要求用户先去课程页登记 —— 只要浏览器登录着，
   * 后台用这份课表就能自己拼出 activelist 请求。
   */
  CXL.COURSE_LIST_HOST = 'https://mooc1-api.chaoxing.com';
  CXL.COURSE_LIST_PATH = '/mycourse/backclazzdata';

  /** 课表地址（view=json 让它返回 JSON 而不是 HTML） */
  CXL.buildCourseListUrl = function (host, now) {
    var t = (typeof now === 'number' && isFinite(now)) ? now : Date.now();
    return (host || CXL.COURSE_LIST_HOST) + CXL.COURSE_LIST_PATH +
      '?view=json&_=' + String(t);
  };

  /**
   * 把课表返回归一化成 [{ courseId, classId, fid, name }]。
   *
   * 返回结构在不同版本里有三种常见形状（都实测见过）：
   *   { channelList: [ { content: { course: { data: [{id,name}] } }, id, name } ] }
   *   { data: [ { course: { data: [...] }, id, name } ] }
   *   直接就是一个数组
   * 所以这里用递归遍历，凡是"同一个节点里既有 id 又有 course.data[0].id"的，
   * 就当作"一个班"（classId = 节点的 id，courseId = course.data[0].id）。
   */
  CXL.extractCourses = function (json) {
    var out = [];
    var seen = {};
    var push = function (courseId, classId, fid, name, courseName) {
      courseId = String(courseId === undefined || courseId === null ? '' : courseId).trim();
      classId = String(classId === undefined || classId === null ? '' : classId).trim();
      // 实测：courseId 通常 6~12 位，classId 也可能只有 5~6 位，两者都只要求"是长数字"
      if (!/^\d{5,}$/.test(courseId) || !/^\d{3,}$/.test(classId)) return;
      var key = courseId + '/' + classId;
      if (seen[key]) return;
      seen[key] = true;
      out.push({
        courseId: courseId,
        classId: classId,
        fid: String(fid || ''),
        name: [courseName, name].filter(Boolean).join(' / ').slice(0, 60)
      });
    };

    var walk = function (node, depth, parentId, fidHint, nameHint) {
      if (!node || depth > 8) return;
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++) walk(node[i], depth + 1, parentId, fidHint, nameHint);
        return;
      }
      if (typeof node !== 'object') return;

      // 这一层自己的班级编号：优先级 node.id > 父节点传下来的 id
      var classId = node.id !== undefined && node.id !== null ? node.id : parentId;
      var fid = node.fid !== undefined ? node.fid
        : (node.content && node.content.fid) !== undefined ? node.content.fid : fidHint;
      // 班级名同理：本层的 > 父节点传下来的（channelList 里名字在外层，course 在内层）
      var className = node.name || node.className || nameHint;

      var course = node.course;
      if (course && typeof course === 'object') {
        var data = Array.isArray(course.data) ? course.data : null;
        var first = data && data[0];
        if (first && (first.id || first.courseId)) {
          push(first.id || first.courseId, classId, fid,
            (node.content && (node.content.name || node.content.className)) || className,
            first.name || first.courseName);
        }
      }

      for (var k in node) {
        if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
        var v = node[k];
        if (v && typeof v === 'object') {
          walk(v, depth + 1, classId, fid, className);
        }
      }
    };
    walk(json, 0, undefined, undefined, undefined);
    return out;
  };

  /**
   * 组装活动列表请求地址。参数名大小写与官方页面一致（courseId / classId）。
   * 认不出来的字段为 undefined；courseId 与 classId 缺一不可。
   */
  CXL.buildActiveListUrl = function (p, host, now) {
    p = p || {};
    if (p.courseId === undefined || p.courseId === null || p.courseId === '' ||
        p.classId === undefined || p.classId === null || p.classId === '') {
      return null;
    }
    var t = (typeof now === 'number' && isFinite(now)) ? now : Date.now();
    var qs = [
      ['fid', p.fid || ''],
      ['courseId', p.courseId],
      ['classId', p.classId],
      ['showNotStartedActive', p.showNotStartedActive === undefined ? '0' : p.showNotStartedActive],
      ['_', String(t)]
    ]
      .map(function (kv) { return kv[0] + '=' + encodeURIComponent(kv[1]); })
      .join('&');
    return (host || CXL.ACTIVE_LIST_HOST) + CXL.ACTIVE_LIST_PATH + '?' + qs;
  };

  /**
   * 活动详情地址。签到类型（activeSort）只有这个接口给得准：
   * 活动列表里的 otherId/activeType 不足以区分二维码、手势等（官方客户端实测如此）。
   * 返回 null 表示没有 activeId 可用。
   */
  CXL.buildActiveInfoUrl = function (activeId, host, now) {
    if (!activeId) return null;
    var t = (typeof now === 'number' && isFinite(now)) ? now : Date.now();
    var qs = [['activeId', activeId], ['_', String(t)]]
      .map(function (kv) { return kv[0] + '=' + encodeURIComponent(kv[1]); })
      .join('&');
    return (host || CXL.ACTIVE_LIST_HOST) + CXL.ACTIVE_INFO_PATH + '?' + qs;
  };

  /**
   * 把活动详情的返回归一化。
   * 关心的字段（都来自官方客户端的判定逻辑）：
   *   activeSort        1 普通 / 2 普通+防作弊 / 3 普通+拍照 / 4 位置 / 5 位置+人脸
   *                     6~8 二维码 / 9 签到码 / 手势=16（实测值）
   *   otherId           另一套类型码
   *   ifphoto           老师"要求参与人拍照"的开关
   *   ifNeedVCode       要防作弊验证码
   *   openCheckFaceFlag 要人脸
   *   ifrefreshewm      二维码自动更新（这一位能直接把类型钉成二维码）
   *   ifopenAddress     需要地址
   */
  CXL.normalizeActiveInfo = function (json) {
    var d = (json && json.data) || json || {};
    if (typeof d !== 'object') d = {};
    var num = function (v) {
      if (v === undefined || v === null || v === '') return null;
      var n = Number(v);
      return isFinite(n) ? n : null;
    };
    return {
      activeId: d.activeId !== undefined ? String(d.activeId) : '',
      activeSort: num(d.activeSort),
      otherId: num(d.otherId),
      ifphoto: d.ifphoto !== undefined ? d.ifphoto : null,
      ifNeedVCode: d.ifNeedVCode !== undefined ? d.ifNeedVCode : null,
      openCheckFaceFlag: num(d.openCheckFaceFlag),
      ifrefreshewm: num(d.ifrefreshewm),
      ifopenAddress: num(d.ifopenAddress),
      numberCount: num(d.numberCount),
      name: plainText(d.name || d.nameOne || d.title || '')
    };
  };

  /** 活动编号：实测是 6 位以上数字（activePrimaryId 与 id 都是这个编号） */
  function pickDigits(v) {
    if (v === undefined || v === null) return '';
    var s = String(v).trim();
    return /^\d{6,}$/.test(s) ? s : '';
  }

  /** 服务端文案里可能带 HTML（如 <p>xx</p>），显示前清掉标签 */
  function plainText(v) {
    if (v === undefined || v === null) return '';
    return String(v).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /** 活动状态：1=进行中 2=已结束 其他/缺省=未开始（与官方页面的分组一致） */
  function normalizeStatus(v) {
    if (v === undefined || v === null || v === '') return 0;
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }

  /**
   * 把 activelist 接口的响应归一化成活动数组。
   * 返回 [{ id, status, signType, otherId, activeSort, ifphoto, type, name }]，
   * 认不出编号的条目直接丢掉。兼容 data.activeList / data.data.activeList / 直接数组。
   */
  CXL.extractActivities = function (json) {
    var out = [];
    if (!json || typeof json !== 'object') return out;
    var data = json.data;
    var list = null;
    if (Array.isArray(json.activeList)) list = json.activeList;
    else if (Array.isArray(json)) list = json;
    else if (data && Array.isArray(data.activeList)) list = data.activeList;
    else if (data && data.data && Array.isArray(data.data.activeList)) list = data.data.activeList;
    else if (Array.isArray(data)) list = data;
    if (!list) return out;

    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (!item || typeof item !== 'object') continue;
      var id = pickDigits(item.activeId) || pickDigits(item.activePrimaryId) || pickDigits(item.id);
      if (!id) continue;
      out.push({
        id: id,
        // 用户签到状态与活动状态都可能叫 status，这里要的是「活动是否进行中」
        status: normalizeStatus(
          item.activeStatus !== undefined ? item.activeStatus : item.status
        ),
        signType: item.signType !== undefined ? item.signType : null,
        // otherId 是稳定的签到类型码，activeSort 是它的细分，ifphoto 表示"要拍照"
        otherId: item.otherId !== undefined ? item.otherId : null,
        activeSort: item.activeSort !== undefined ? item.activeSort : null,
        ifphoto: item.ifphoto !== undefined ? item.ifphoto : null,
        type: item.type !== undefined ? item.type : null,
        startTime: item.startTime || item.start_time || '',
        name: plainText(item.nameOne || item.name || item.title || '')
      });
    }
    return out;
  };

  // -------------------------------------------------------------------------
  // 签到类型判定
  //
  // 这里踩过一个坑，值得写清楚：
  //   `ifphoto` 不是"签到类型"，它只是"要不要**附带**一张照片"的附加标志。
  //   一个「普通签到」可以选拍照、也可以不拍；一个「二维码签到」同样可能要求拍照。
  //   把 ifphoto=1 当成"这是拍照签到"会导致：给普通签到塞照片 →
  //   photoAuthError_PCR007；给二维码签到塞照片 → 签到失败，请重新扫描。
  //
  // 所以这里分两层：
  //   1) 基础类型（决定"要什么才能签上"）：普通 / 位置 / 二维码 / 签到码 / 手势
  //      —— 来自 otherId / activeSort，其次看活动名字（老师常直接起名"二维码签到"）
  //   2) 附加要求：needsPhoto（要附带照片）、needsFace（要人脸活体）
  // -------------------------------------------------------------------------

  CXL.SIGN_KINDS = {
    plain: { key: 'plain', label: '普通', needsLocation: false, needsQr: false, needsCode: false, needsGesture: false },
    location: { key: 'location', label: '位置', needsLocation: true, needsQr: false, needsCode: false, needsGesture: false },
    qr: { key: 'qr', label: '二维码', needsLocation: false, needsQr: true, needsCode: false, needsGesture: false },
    code: { key: 'code', label: '签到码', needsLocation: false, needsQr: false, needsCode: true, needsGesture: false },
    gesture: { key: 'gesture', label: '手势', needsLocation: false, needsQr: false, needsCode: false, needsGesture: true },
    unknown: { key: 'unknown', label: '未知', needsLocation: false, needsQr: false, needsCode: false, needsGesture: false }
  };

  /** otherId（稳定的类型码）-> 基础类型 */
  CXL.OTHER_ID_KINDS = {
    0: 'plain',       // 实测：新建的普通签到 otherId=0（且没有 activeSort）
    1: 'plain',
    2: 'plain',       // 部分版本的"普通"
    3: 'gesture',
    4: 'location',
    5: 'code',
    6: 'qr',
    7: 'qr',
    8: 'qr'
  };

  /** activeSort（细分）-> 基础类型。flutter_chaoxing 实测：3=普通+拍照、4=位置、6~8=二维码、9=签到码、16=手势 */
  CXL.ACTIVE_SORT_KINDS = {
    1: 'plain',
    2: 'plain',
    3: 'plain',       // 普通 + 拍照（拍照是附加要求，不是类型）
    4: 'location',
    5: 'location',
    6: 'qr',
    7: 'qr',
    8: 'qr',
    9: 'code',
    16: 'gesture'     // 实测：activeSort=16 是手势签到
  };

  /**
   * 从活动名字里猜基础类型（最后的兜底证据）。
   * 老师起名很直白："普通签到"、"二维码签到"、"手势签到"、"签到码"，实测有效。
   */
  CXL.kindFromName = function (name) {
    var s = String(name || '');
    if (!s) return '';
    if (/二维码|扫码|扫一扫/.test(s)) return 'qr';
    if (/手势/.test(s)) return 'gesture';
    if (/签到码|数字码|验证码签到/.test(s)) return 'code';
    if (/位置|定位|签到地点/.test(s)) return 'location';
    if (/普通|常规/.test(s)) return 'plain';
    return '';
  };

  /**
   * 判断这次签到需要什么。
   * 入参可以是活动列表里的一条（extractActivities 的产物），也可以是活动详情接口的返回。
   * 返回：
   *   { key, label,              // 基础类型
   *     needsPhoto, needsFace,   // 附加要求
   *     needsLocation, needsQr, needsCode, needsGesture,
   *     fromName,                // 类型是从名字猜的（不是服务端字段）
   *     canSubmitPlain }         // 本扩展能不能直接提交（不需要二维码/手势/坐标）
   */
  CXL.detectSignKind = function (info) {
    info = info || {};
    var num = function (v) {
      if (v === undefined || v === null || v === '') return null;
      var n = Number(v);
      return isFinite(n) ? n : null;
    };
    var flag = function (v) {
      if (v === undefined || v === null || v === '') return null;
      var s = String(v).toLowerCase();
      if (s === 'true' || s === '1') return true;
      if (s === 'false' || s === '0') return false;
      return null;
    };

    var otherId = num(info.otherId);       // 注意：不要把 item.id（活动编号）当 otherId
    var sort = num(info.activeSort);
    var ifphoto = flag(info.ifphoto);
    var ifface = flag(info.openCheckFaceFlag || info.ifOpenCheckFace || info.ifface);
    // ifrefreshewm 只是"允许二维码自动刷新"这类能力开关（默认就可能是 1），
    // 不能拿它判类型 —— 曾经用它把"普通签到+要求拍照"全判成二维码，撤掉。
    var refreshEwm = flag(info.ifrefreshewm);

    // ---- 1) 基础类型：只认服务端类型字段（activeSort 最准，其次 otherId）----
    var key = '';
    if (sort !== null && CXL.ACTIVE_SORT_KINDS[sort]) key = CXL.ACTIVE_SORT_KINDS[sort];
    if (!key && otherId !== null && CXL.OTHER_ID_KINDS[otherId]) key = CXL.OTHER_ID_KINDS[otherId];

    // ---- 2) 两个字段都没有时才看活动名字（并在面板里标明是猜的）----
    var nameKind = CXL.kindFromName(info.name);
    var fromName = false;
    if (!key && nameKind) { key = nameKind; fromName = true; }
    if (!key) key = 'unknown';

    var base = CXL.SIGN_KINDS[key] || CXL.SIGN_KINDS.unknown;
    return {
      key: base.key,
      label: base.label,
      needsPhoto: ifphoto === true,
      needsFace: ifface === true,
      needsLocation: !!base.needsLocation,
      needsQr: !!base.needsQr,
      needsCode: !!base.needsCode,
      needsGesture: !!base.needsGesture,
      fromName: fromName,
      // 普通签到（不需要二维码/手势/坐标）才可能直接用 stuSignajax 签上
      canSubmitPlain: base.key === 'plain' || base.key === 'unknown',
      // 判定依据：面板直接显示，避免"为什么判成这个类型"变成黑盒
      evidence: {
        activeSort: sort,
        otherId: otherId,
        ifphoto: ifphoto,
        ifrefreshewm: refreshEwm,
        nameKind: nameKind || '',
        // 名字和服务端字段不一致时提示一句（例如名字叫"二维码签到"但字段说普通）
        conflict: !!(nameKind && !fromName && nameKind !== key)
      }
    };
  };

  /** 把判定依据写成一行，给面板显示 */
  CXL.describeEvidence = function (kind) {
    var e = (kind && kind.evidence) || {};
    var parts = [];
    if (e.activeSort !== null && e.activeSort !== undefined) parts.push('activeSort=' + e.activeSort);
    if (e.otherId !== null && e.otherId !== undefined) parts.push('otherId=' + e.otherId);
    if (e.ifphoto === true) parts.push('ifphoto=1（要求拍照）');
    if (e.ifrefreshewm === true) parts.push('ifrefreshewm=1（二维码刷新能力）');
    if (!parts.length) parts.push('服务端没给类型字段');
    if (kind && kind.fromName) parts.push('类型按活动名字推断');
    if (e.conflict) parts.push('⚠ 名字像「' + CXL.SIGN_KINDS[e.nameKind].label + '」但字段说是「' + (kind.label || '') + '」');
    return parts.join(' · ');
  };

  /** 这个类型要不要坐标 / 照片（兼容老调用方） */
  CXL.kindNeeds = function (kind) {
    if (typeof kind === 'string') kind = CXL.SIGN_KINDS[kind];
    kind = kind || CXL.SIGN_KINDS.unknown;
    return { photo: !!kind.needsPhoto, location: !!kind.needsLocation };
  };

  /** 用一句话说清"这次签到要什么"，给面板直接显示 */
  CXL.describeNeeds = function (kind) {
    kind = kind || CXL.detectSignKind({});
    var parts = [];
    if (kind.needsQr) parts.push('要扫老师的二维码');
    if (kind.needsGesture) parts.push('要画手势');
    if (kind.needsCode) parts.push('要老师的签到码');
    if (kind.needsLocation) parts.push('要定位');
    if (kind.needsFace) parts.push('要人脸');
    // 老师发签到时的"要求参与人拍照"开关 —— 开着就代表这次要交照片
    if (kind.needsPhoto) parts.push('老师要求拍照');
    if (!parts.length) parts.push('直接提交即可');
    return parts.join(' · ');
  };

  /** 提交时用的 HTTP 方法：只有"纯普通/防作弊"走 GET，其余（拍照/位置等）走 POST */
  CXL.kindUsesPost = function (kind) {
    var k = (typeof kind === 'string') ? kind : (kind && kind.key);
    return !(k === 'plain');
  };

  /**
   * 拍照签到的参数必须"干净"。
   *
   * 实测：带上 location/deviceCode/vp* 这些字段提交拍照签到，服务端会回
   * `photoAuthError_PCR007`；而公开可用的第三方实现（kuizuo/chaoxing-sign）提交的
   * 是极简参数、而且用 GET：
   *   activeId / uid / clientip / latitude(-1) / longitude(-1) / appType / fid / objectId / name
   * 多传字段会被判成"参数不符合这次签到的规则"，所以这里按那个形状来。
   * 只有真需要坐标时才额外带 address / ifTiJiao（那时是位置类签到）。
   */
  CXL.buildPhotoSignParams = function (p) {
    p = p || {};
    return [
      ['activeId', p.activeId || ''],
      ['uid', p.uid || ''],
      ['clientip', ''],
      ['latitude', '-1'],
      ['longitude', '-1'],
      ['appType', p.appType || '15'],
      ['fid', p.fid || ''],
      ['objectId', p.objectId || ''],
      ['name', p.name || '']
    ];
  };

  /** 拍照签到的完整请求地址（GET，参数就上面那 9 个） */
  CXL.buildPhotoSignUrl = function (p, host) {
    return (host || 'https://mobilelearn.chaoxing.com') + '/pptSign/stuSignajax?' +
      CXL.encodeSignParams(CXL.buildPhotoSignParams(p));
  };

  /** 回复里携带的提示（失败时用来解释原因，如"未登录"） */
  CXL.lookupErrorMessage = function (json, httpStatus) {
    if (!json || typeof json !== 'object') return '';
    var msg = plainText(json.errorMsg || json.msg || json.message || '');
    if (!msg) return '';
    return msg + (httpStatus ? '（HTTP ' + httpStatus + '）' : '');
  };

  /**
   * 从活动列表里挑出"这次要签到"的活动编号。
   * 只认 status==1（进行中）的活动——已结束的老活动一旦被拿来提交，服务端会直接报错；
   * 未开始的也不能签，所以除非调用方显式 allowNotStarted，否则一律忽略。
   * 同一个 activeId 只会有一个；返回 { id, name, signType, label } 或 null。
   */
  CXL.pickActiveTarget = function (json, opts) {
    opts = opts || {};
    var acts = CXL.extractActivities(json);
    if (!acts.length) return null;

    function newest(list) {
      if (!list.length) return null;
      var sorted = list.slice().sort(function (a, b) {
        var ta = Number(a.startTime) || 0;
        var tb = Number(b.startTime) || 0;
        if (ta !== tb) return tb - ta;                    // 开始时间晚的优先
        return Number(b.id) - Number(a.id);               // 时间一样就按编号大的（编号随时间递增）
      });
      return sorted[0];
    }

    var target = newest(acts.filter(function (a) { return a.status === 1; }));
    var label = '进行中';
    if (!target && opts.allowNotStarted) {
      target = newest(acts.filter(function (a) { return a.status !== 2; }));
      label = '未开始';
    }
    if (!target) return null;
    return {
      id: target.id,
      name: target.name,
      signType: target.signType,
      // 这次签到是"位置"还是"拍照"，由面板据此自动切换
      kind: CXL.detectSignKind(target),
      otherId: target.otherId,
      activeSort: target.activeSort,
      ifphoto: target.ifphoto,
      label: label
    };
  };

  // -------------------------------------------------------------------------
  // 拍照签到：先上传图片换 objectId，再用 stuSignajax 提交
  //
  // 上传协议（与学习通网盘同一套，实测自 7.0.2 客户端）：
  //   1) GET  https://pan-yz.chaoxing.com/api/token/uservalid   -> { result: true, _token }
  //   2) POST https://pan-yz.chaoxing.com/upload  (multipart)
  //        puid=账号id  _token=上一步的token  file=图片
  //      -> { objectid: "xxxx" }
  //   3) stuSignajax 带上 objectId（+ 可选 photoResult）提交
  // -------------------------------------------------------------------------

  CXL.PAN_HOST = 'https://pan-yz.chaoxing.com';
  CXL.PAN_TOKEN_PATH = '/api/token/uservalid';
  CXL.PAN_UPLOAD_PATH = '/upload';

  /** 取上传用的 _token 的地址（puid 由调用方作为参数带上） */
  CXL.buildPanTokenUrl = function (host) {
    return (host || CXL.PAN_HOST) + CXL.PAN_TOKEN_PATH;
  };

  /** 图片上传地址 */
  CXL.buildPanUploadUrl = function (host) {
    return (host || CXL.PAN_HOST) + CXL.PAN_UPLOAD_PATH;
  };

  /** 单张图片的大小上限（学习通网盘对小图不友好，但对超大图也会拒；10MB 足够手机原图） */
  CXL.PHOTO_MAX_BYTES = 10 * 1024 * 1024;
  /** 允许的图片类型 */
  CXL.PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/bmp', 'image/gif'];

  /**
   * 校验要上传的图片。返回 { ok:true } 或 { ok:false, error }。
   * 这一步在"选完图"就做，避免用户点了签到才发现图片不能传。
   */
  CXL.validatePhoto = function (info) {
    info = info || {};
    var size = Number(info.size);
    var type = String(info.type || '').toLowerCase();
    if (!size) return { ok: false, error: '图片是空的，换一张试试' };
    if (size > CXL.PHOTO_MAX_BYTES) {
      return {
        ok: false,
        error: '图片太大了（' + (size / 1024 / 1024).toFixed(1) + ' MB），上限 ' +
          (CXL.PHOTO_MAX_BYTES / 1024 / 1024) + ' MB，可以先压缩或截屏再选'
      };
    }
    // 有些系统给不出 MIME（拖拽/粘贴时常见），这时靠扩展名兜底
    if (type && CXL.PHOTO_TYPES.indexOf(type) < 0) {
      var byName = /\.(jpe?g|png|webp|bmp|gif)$/i.test(String(info.name || ''));
      if (!byName) {
        return { ok: false, error: '这个文件不是常见图片格式（jpg/png/webp），换一张试试' };
      }
    } else if (!type && !/\.(jpe?g|png|webp|bmp|gif)$/i.test(String(info.name || ''))) {
      return { ok: false, error: '认不出这个文件是不是图片，换一张试试' };
    }
    return { ok: true };
  };

  /** 上传时的文件名（服务端按扩展名认类型） */
  CXL.photoFileName = function (name, type) {
    var n = String(name || '').trim();
    if (/\.(jpe?g|png|webp|bmp|gif)$/i.test(n)) return n;
    var t = String(type || '').toLowerCase();
    if (t === 'image/png') return 'photo.png';
    if (t === 'image/webp') return 'photo.webp';
    if (t === 'image/gif') return 'photo.gif';
    if (t === 'image/bmp') return 'photo.bmp';
    return 'photo.jpg';
  };

  /** 从上传接口的返回里取 objectid（官方读的是小写 objectid，也兼容驼峰） */
  CXL.pickObjectId = function (json) {
    if (!json || typeof json !== 'object') return '';
    var cand = [json.objectid, json.objectId, json.objectID, json.data && json.data.objectid,
      json.data && json.data.objectId];
    for (var i = 0; i < cand.length; i++) {
      var v = cand[i];
      if (v !== undefined && v !== null && String(v).trim()) return String(v).trim();
    }
    return '';
  };

  /** 活动编号是否看起来合法（提交前的最后一道校验） */
  CXL.isActiveId = function (v) {
    return /^\d{6,}$/.test(String(v === undefined || v === null ? '' : v).trim());
  };

  /**
   * 从页面地址里读课程 / 班级 / 学校编号。
   * 注意参数名大小写混用：课程页是 courseid / clazzid，签到页是 courseId / classId。
   * 返回 { courseId, classId, fid }，认不出来的为 ''。
   */
  CXL.parseCourseContext = function (candidates) {
    var list = Array.isArray(candidates) ? candidates : [candidates];
    var out = { courseId: '', classId: '', fid: '' };
    var names = {
      courseId: [/[?&#]courseid=(\d+)/i, /[?&#]courseId=(\d+)/],
      classId: [/[?&#]clazzid=(\d+)/i, /[?&#]classid=(\d+)/i, /[?&#]classId=(\d+)/],
      fid: [/[?&#]fid=(\d+)/i]
    };
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (!s) continue;
      s = String(s);
      for (var key in names) {
        if (out[key]) continue;
        var res = names[key];
        for (var j = 0; j < res.length; j++) {
          var m = s.match(res[j]);
          if (m) { out[key] = m[1]; break; }
        }
      }
    }
    return out;
  };

  /**
   * 页面正文里的课程 / 班级编号。
   * 不是所有学习通页面都把编号放在地址栏上（课程首页点进章节后地址里就没有 courseid 了），
   * 但页面自己会带着它去调接口，所以正文里通常有 courseId=xxx / "courseId":"xxx" 这类写法。
   *
   * 注意：这里的键名与缩进会被 tools/validate-extension.mjs 当成"默认配置项"来扫，
   * 所以刻意写成 6 空格缩进的对象字面量（配置项在 CXL.DEFAULTS 里是 4 空格）。
   */
  CXL.courseHtmlPatterns = function (key) {
    var P = {
      courseId: [
        /[?&#]courseid=(\d+)/i,
        /courseId["'\s:=]+(\d+)/,
        /\bcourseid\b["'\s:=]+(\d+)/i
      ],
      classId: [
        /[?&#]clazzid=(\d+)/i,
        /[?&#]classid=(\d+)/i,
        /classId["'\s:=]+(\d+)/,
        /\bclazzid\b["'\s:=]+(\d+)/i
      ],
      fid: [
        /[?&#]fid=(\d+)/i,
        /\bfid\b["'\s:=]+(\d+)/i
      ]
    };
    if (!key) return P;
    return P[key] || [];
  };

  /** 按上面这组规则从任意文本（一般是页面 HTML）里挖编号 */
  CXL.parseCourseContextFromHtml = function (html, want) {
    var out = { courseId: '', classId: '', fid: '' };
    if (!html) return out;
    var text = String(html);
    var keys = want && want.length ? want : ['courseId', 'classId', 'fid'];
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var pats = CXL.courseHtmlPatterns(key);
      for (var j = 0; j < pats.length; j++) {
        var m = text.match(pats[j]);
        if (m) { out[key] = m[1]; break; }
      }
    }
    return out;
  };


  /**
   * 从任意文本里抽取签到活动的关键参数。
   * 适用场景：把老师发在群里/网页聊天里的签到消息、或浏览器地址栏里的签到链接整段粘进来。
   * 返回 { activeId, fid, courseId, classId, uid, name, url } —— 认不出来的字段为 undefined。
   */
  CXL.parseSignContext = function (text) {
    var out = {};
    if (!text) return out;
    var s = String(text);

    function grab(re) {
      var m = s.match(re);
      return m ? m[1] : undefined;
    }

    // activeId / activePrimaryId 是签到活动编号，实测至少 6 位，用 {6,} 过滤掉噪音数字
    out.activeId =
      grab(/activePrimaryId["'\s:=]+(\d{6,})/i) ||
      grab(/activeId["'\s:=]+(\d{6,})/i) ||
      grab(/[?&#]activeId=(\d{6,})/i);

    out.fid = grab(/[?&#]fid=(\d+)/i) || grab(/\bfid["'\s:=]+(\d+)/i);
    out.courseId = grab(/[?&#]courseId=(\d+)/i) || grab(/\bcourseId["'\s:=]+(\d+)/i);
    out.classId = grab(/[?&#]classId=(\d+)/i) || grab(/\bclassId["'\s:=]+(\d+)/i);
    out.uid = grab(/[?&#]uid=(\d+)/i) || grab(/\b_?uid["'\s:=]+(\d+)/i);
    out.name = grab(/[?&#]name=([^&\s"']{1,30})/i);

    // 找出文本里的链接，方便日志里显示
    var u = s.match(/https?:\/\/[^\s"'<>]+/);
    if (u) out.url = u[0];

    // 把 undefined 去掉
    Object.keys(out).forEach(function (k) {
      if (out[k] === undefined || out[k] === '') delete out[k];
    });
    if (out.name) {
      try { out.name = decodeURIComponent(out.name); } catch (e) { /* 保持原样 */ }
    }
    return out;
  };

  /** 根据当前选点生成一行便于分享/核对的描述 */
  CXL.describePoint = function (point) {
    if (!point) return '未选点';
    return point.lat.toFixed(6) + ', ' + point.lon.toFixed(6) +
      ' (' + String(point.datum || 'gcj02').toUpperCase() + ')' +
      (point.address ? ' · ' + point.address : '');
  };

  /**
   * 很轻量的名称相似度：字符 bigram（二元组）重合率 + 首字校验。
   * 目的是挡住「河北师范大学 → 北京师范大学」这类错误匹配
   * （实测免费地理编码接口真的会这么返回），而不是做到语义级准确。
   *
   * 为什么不能用单字命中率：河北师范大学 / 北京师范大学 的"师范大学"四个字全中，
   * 单字法会给出 0.77 的高分，根本挡不住。中文地名/机构名起区分作用的是开头，
   * 所以这里用 bigram 重合率，并对首字不同的情况重罚。返回 0~1。
   */
  CXL.nameSimilarity = function (query, candidate) {
    var strip = function (s) {
      return String(s || '').replace(/[（）()【】\[\]、,，.。·\-—\s]/g, '');
    };
    var q = strip(query);
    var c = strip(candidate);
    if (!q || !c) return 0;

    // 候选里完整包含查询串 → 直接满分
    if (c.indexOf(q) >= 0) return 1;
    if (q.length < 2 || c.length < 2) return q === c ? 1 : 0;

    var bigrams = function (s) {
      var set = [];
      for (var i = 0; i < s.length - 1; i++) set.push(s.slice(i, i + 2));
      return set;
    };
    var bq = bigrams(q);
    var bc = bigrams(c);
    var hit = 0;
    for (var i = 0; i < bq.length; i++) {
      if (bc.indexOf(bq[i]) >= 0) hit++;
    }
    // Dice 系数：2|交集| / (|A| + |B|)
    var score = (2 * hit) / (bq.length + bc.length);

    // 首字不同基本就是两个不同的地方（河北/北京、东/西校区…），重罚
    if (q[0] !== c[0]) score *= 0.4;

    return score;
  };

  /**
   * 组装签到提交的参数（mobilelearn.chaoxing.com/pptSign/stuSignajax）。
   * 位置签到和拍照签到用的是同一个接口，区别只在于带不带坐标、带不带 objectId：
   *   - 位置：address + latitude/longitude
   *   - 拍照：objectId（上传图片换来的编号）(+ 可选 photoResult)
   *
   * 几个字段的取舍是照着官方 H5 页面抄的，不是猜的：
   *   - 坐标默认 -1（页面拿不到定位时就发 -1，非位置签到服务端接受这个值）
   *   - useragent 只在 GET（纯普通/防作弊）时带，POST 的表单里没有这个字段
   *   - ifTiJiao/vp* 这些是位置签到才出现的字段，拍照时不发，避免被判定成参数不符
   */
  CXL.buildSignParams = function (p) {
    p = p || {};
    var kind = (typeof p.kind === 'string') ? p.kind : (p.kind && p.kind.key) || 'location';
    var needs = CXL.kindNeeds(kind);
    var objectId = p.objectId ? String(p.objectId).trim() : '';

    var usePost = (p.usePost === undefined) ? (kind !== 'plain') : !!p.usePost;
    // 拍照签到也可以顺带带上位置（有些老师会同时要求），有坐标就发，没有就 -1
    var wantCoords = needs.location || (kind === 'photo' && p.hasPoint);
    var lat = -1;
    var lon = -1;
    if (wantCoords && isFinite(Number(p.lat)) && isFinite(Number(p.lon))) {
      lat = Number(p.lat);
      lon = Number(p.lon);
      if (p.datum === 'wgs84') {
        var g = CXL.wgs84ToGcj02(lat, lon);
        lat = g[0];
        lon = g[1];
      } else if (p.datum === 'bd09') {
        var c = CXL.bd09ToGcj02(lat, lon);
        lat = c[0];
        lon = c[1];
      }
    }

    var pairs = [
      ['activeId', p.activeId || ''],
      ['courseId', p.courseId || ''],
      ['uid', p.uid || ''],
      ['clientip', '']
    ];
    if (!usePost) pairs.push(['useragent', '']);
    pairs.push(['latitude', lat.toFixed(6)]);
    pairs.push(['longitude', lon.toFixed(6)]);
    pairs.push(['fid', p.fid || '']);
    pairs.push(['appType', p.appType || '15']);
    pairs.push(['name', p.name || '']);

    if (p.deviceCode) pairs.push(['deviceCode', p.deviceCode]);
    if (p.validate) pairs.push(['validate', p.validate]);
    if (objectId) pairs.push(['objectId', objectId]);
    if (p.photoResult) pairs.push(['photoResult', p.photoResult]);
    if (p.signCode) pairs.push(['signCode', p.signCode]);

    if (needs.location || kind === 'both') {
      pairs.push(['address', p.address || '']);
      pairs.push(['ifTiJiao', p.ifTiJiao || CXL.DEFAULTS.ifTiJiao]);
      // 这几个是位置签到页面固定带的采集状态位
      pairs.push(['vpProbability', '']);
      pairs.push(['vpStrategy', '']);
      pairs.push(['currentFaceId', '']);
      pairs.push(['ifCFP', '0']);
      pairs.push(['faceEnc', '']);
      pairs.push(['faceCode', '']);
    }

    // 去掉没有值的可选参数：服务端能区分"没传"和"传了空"
    var out = [];
    for (var i = 0; i < pairs.length; i++) {
      var k = pairs[i][0];
      var v = pairs[i][1];
      if (v === undefined || v === null) continue;
      // deviceCode / validate / objectId / photoResult / signCode 为空时干脆不发
      if ((k === 'deviceCode' || k === 'validate' || k === 'objectId' ||
           k === 'photoResult' || k === 'signCode') && String(v) === '') continue;
      out.push([k, String(v)]);
    }
    return out;
  };

  /** 参数数组 -> 查询串 / 表单体（同一个编码，两种用法） */
  CXL.encodeSignParams = function (pairs) {
    return (pairs || [])
      .map(function (kv) { return kv[0] + '=' + encodeURIComponent(kv[1]); })
      .join('&');
  };

  /**
   * 解析"附加参数"文本，支持三种写法（面板里直接粘就行）：
   *   `photoResult=xxx&foo=bar`、`{"photoResult":"xxx"}`、`photoResult=xxx` 单行
   * 返回 [[k,v], ...]；解析不出来返回空数组。
   */
  CXL.parseExtraParams = function (text) {
    var s = String(text === undefined || text === null ? '' : text).trim();
    if (!s) return [];
    var out = [];

    // JSON 对象形式
    if (s.charAt(0) === '{') {
      try {
        var obj = JSON.parse(s);
        Object.keys(obj || {}).forEach(function (k) {
          var v = obj[k];
          if (v === undefined || v === null) return;
          out.push([k, typeof v === 'object' ? JSON.stringify(v) : String(v)]);
        });
        return out;
      } catch (e) { /* 落到下面的 key=value 形式 */ }
    }

    // key=value&key=value 形式（允许换行分隔）
    s.split(/[&\n]+/).forEach(function (part) {
      var i = part.indexOf('=');
      if (i <= 0) return;
      var k = part.slice(0, i).trim();
      var v = part.slice(i + 1).trim();
      if (!k) return;
      out.push([k, v]);
    });
    return out;
  };

  /** 这次提交该用 GET 还是 POST（拍照/位置等页面都用 POST） */
  CXL.signUsesPost = function (p) {
    p = p || {};
    var kind = (typeof p.kind === 'string') ? p.kind : (p.kind && p.kind.key) || 'location';
    if (p.usePost !== undefined) return !!p.usePost;
    return kind !== 'plain';
  };

  /**
   * 组装签到请求 URL（保留原有函数签名，位置签到的老调用方不用改）。
   * 需要更多参数的场景（拍照）请用 buildSignParams + encodeSignParams。
   */
  CXL.buildSignUrl = function (p, host) {
    var pairs = CXL.buildSignParams(p);
    return (host || 'https://mobilelearn.chaoxing.com') + '/pptSign/stuSignajax?' +
      CXL.encodeSignParams(pairs);
  };

  /**
   * 普通签到的参数（没有坐标、没有照片，就 8 个字段）。
   *
   * 实测教训：活动名叫「普通签到」的那种活动，如果硬塞一个 objectId 进去，
   * 服务端会走进"拍照校验"分支然后回 `photoAuthError_PCR007` —— 因为那个活动
   * 压根没有拍照上下文。所以"先判断类型、再决定发什么"很重要。
   * 这 8 个字段与公开可用实现的 signNormal 一致。
   */
  CXL.buildPlainSignParams = function (p) {
    p = p || {};
    return [
      ['activeId', p.activeId || ''],
      ['uid', p.uid || ''],
      ['clientip', ''],
      ['latitude', '-1'],
      ['longitude', '-1'],
      ['appType', p.appType || '15'],
      ['fid', p.fid || ''],
      ['name', p.name || '']
    ];
  };

  /** 普通签到的完整请求地址（GET） */
  CXL.buildPlainSignUrl = function (p, host) {
    return (host || 'https://mobilelearn.chaoxing.com') + '/pptSign/stuSignajax?' +
      CXL.encodeSignParams(CXL.buildPlainSignParams(p));
  };


  // ---------- 距离 / 格式化 ----------

  CXL.distance = function (lat1, lon1, lat2, lon2) {
    var R = 6371008.8;
    var dLat = ((lat2 - lat1) * PI) / 180;
    var dLon = ((lon2 - lon1) * PI) / 180;
    var a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * PI) / 180) * Math.cos((lat2 * PI) / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  };

  CXL.formatDistance = function (meters) {
    if (!isFinite(meters)) return '--';
    if (meters < 1000) return Math.round(meters) + ' m';
    return (meters / 1000).toFixed(2) + ' km';
  };

  CXL.round6 = function (n) {
    return Math.round(Number(n) * 1e6) / 1e6;
  };

  /**
   * 解析用户输入的坐标文本，支持：
   *   "30.123456,120.123456"、"31.5, 121.5"、"30.5 120.5"、
   *   "lat:30.1 lng:120.2"、"纬度 30.1 经度 120.2"、
   *   以及高德/百度常见的 "120.1,30.1"（经度在前，会被自动纠正）。
   * 返回 [lat, lon] 或 null。
   */
  CXL.parseLatLon = function (text) {
    if (!text) return null;

    // 先干掉已知的标签词，再按分隔符切分：只剩数字的分片才好配对
    var cleaned = String(text)
      .replace(/latitude|longitude|经度|纬度|坐标|经纬度/gi, ' ')
      .replace(/[a-zA-Z_]{1,}\s*[:=]?/g, ' ')
      .replace(/[，、；;：:()\[\]{}]/g, ' ')
      .replace(/°/g, ' ')
      .trim();

    var parts = cleaned.split(/[\s,]+/).filter(function (s) {
      var n = parseFloat(s);
      return isFinite(n) && /^-?\d+(\.\d+)?$/.test(s);
    }).map(parseFloat);

    if (parts.length < 2) return null;

    // 中国境内：纬度 3~54，经度 73~136。先按原顺序试，再试反序。
    var candidates = [[parts[0], parts[1]], [parts[1], parts[0]]];
    for (var i = 0; i < candidates.length; i++) {
      var lat = candidates[i][0];
      var lon = candidates[i][1];
      if (lat >= 3 && lat <= 54 && lon >= 73 && lon <= 136) return [lat, lon];
    }
    return null;
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
