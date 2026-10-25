/*
 * 自动签到模块（纯逻辑，不碰 DOM / 不发请求）。
 *
 * 只服务一种签到：**位置签到**。
 *   1) 按用户设定的时段（周一到周日 + 起止时间）开门、关门；
 *   2) 开门后自动去找「进行中」的活动，只认位置签到，别的类型只报告、不碰；
 *   3) 提交后如果因为"离签到地点太远"被拒，从服务端返回的距离里反推签到点，
 *      一轮轮逼近，直到签到成功或判明它就不是位置问题。
 *
 * 它是这么工作的：
 *   - 失败提示里一定带着「距离签到地点还有 xxx 米」（学习通位置签到的固定话术），
 *     这句话就是一次**距离测量**：以刚提交的那个点为圆心，r = 该距离 的圆上一定有签到点；
 *   - 换一个方向再交一次，就得到第二个圆；再换一个方向，第三个圆。
 *     三个圆（三个距离）在平面上只交于一点 —— 这就是三点定位。
 *   - 每轮都按"最小二乘"重新算一遍，残差大就换新方向再测；
 *     残差已经很小但还差一点点（服务端半径比算出来的小），
 *     就在解附近撒"曼哈顿十字"细调，把误差压到几十米。
 *
 * 该文件同时被内容脚本、后台 service worker、popup、options 加载，
 * 一律通过显式传入的全局对象挂 CXL，与 lib.js 的风格保持一致。
 */
(function (global) {
  'use strict';

  var CXL = global.CXL || (global.CXL = {});

  // -------------------------------------------------------------------------
  // 1) 时段判断
  // -------------------------------------------------------------------------

  /** 七个星期几的名字，索引 = Date#getDay()（0 = 周日） */
  CXL.WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  /** 周一到周五 = 工作日，这是默认值（用户要的"周一至周五 8:00-14:00"） */
  CXL.DEFAULT_WEEKDAYS = [1, 2, 3, 4, 5];

  /**
   * "08:00" -> 480（分钟）。
   * 两段都必填；认不出来返回 null（不要悄悄当成 0 点，那会让时窗莫名其妙变长）。
   */
  CXL.parseClock = function (text) {
    var s = String(text === undefined || text === null ? '' : text).trim();
    if (!s) return null;
    var m = s.match(/^(\d{1,2})[:：.]?(\d{1,2})?$/);
    if (!m) return null;
    var h = parseInt(m[1], 10);
    var mi = m[2] === undefined ? 0 : parseInt(m[2], 10);
    if (!isFinite(h) || !isFinite(mi)) return null;
    if (h === 24 && mi === 0) return 24 * 60;      // 允许写成 24:00 表示当天结束
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi;
  };

  /** 分钟数 -> "08:00" */
  CXL.formatClock = function (minutes) {
    var n = Number(minutes);
    if (!isFinite(n)) return '--:--';
    n = ((Math.round(n) % 1440) + 1440) % 1440;
    return ('0' + Math.floor(n / 60)).slice(-2) + ':' + ('0' + (n % 60)).slice(-2);
  };

  /** 判断某一天是不是被勾上了（weekdays 为空 = 每天都算） */
  CXL.isActiveWeekday = function (date, weekdays) {
    var list = Array.isArray(weekdays) ? weekdays : CXL.DEFAULT_WEEKDAYS;
    if (!list.length) return true;
    var d = date.getDay();
    for (var i = 0; i < list.length; i++) {
      if (Number(list[i]) === d) return true;
    }
    return false;
  };

  var START_GRACE_MS = 20 * 60 * 1000;   // 开窗后 20 分钟内仍然允许开工
  var END_GRACE_MS = 12 * 60 * 1000;     // 关窗后又等了这么久还没结束 -> 收工

  /**
   * 当前该不该干活。
   * 返回：
   *   { active, inWindow, awaiting, phase, reason, weekday, nextAt }
   *   active   这一轮要不要去找签到
   *   awaiting 已经超出时段但还有一轮没跑完（今天"等到了签到"，要给机会签完）
   *   phase    'pre' 还没到点 / 'in' 正在时段里 / 'post' 时段已过 / 'off' 自动签到没开
   *   nextAt   下一次该醒来的时间戳（用来安排定时器）
   */
  CXL.checkSchedule = function (now, auto) {
    auto = auto || {};
    var at = (now instanceof Date) ? now : new Date(now === undefined ? Date.now() : now);
    var out = {
      active: false,
      inWindow: false,
      awaiting: false,
      phase: 'off',
      reason: '',
      weekday: at.getDay(),
      nextAt: null,
      startMin: CXL.parseClock(auto.startTime || '08:00'),
      endMin: CXL.parseClock(auto.endTime || '14:00')
    };
    var ms = at.getHours() * 3600000 + at.getMinutes() * 60000 + at.getSeconds() * 1000;
    var start = out.startMin === null ? 8 * 60 : out.startMin;
    var end = out.endMin === null ? 14 * 60 : out.endMin;

    if (auto.enabled === false) {
      out.phase = 'off';
      out.reason = '自动签到没打开';
      return out;
    }
    if (!CXL.isActiveWeekday(at, auto.weekdays)) {
      out.phase = 'pre';
      out.reason = '今天不在选定的星期里（' + CXL.describeWeekdays(auto.weekdays) + '）';
      return out;
    }
    if (start === end) {
      out.phase = 'pre';
      out.reason = '起止时间相同，等于没有时段';
      return out;
    }

    if (start < end) {
      // 普通时段，例如 08:00 - 14:00
      if (ms < start * 60000) {
        out.phase = 'pre';
        out.reason = '还没到 ' + CXL.formatClock(start);
      } else if (ms < end * 60000) {
        out.phase = 'in';
        out.inWindow = true;
        out.active = true;
        out.reason = '在时段内（' + CXL.formatClock(start) + ' - ' + CXL.formatClock(end) + '）';
      } else if (ms < end * 60000 + END_GRACE_MS) {
        out.phase = 'post';
        out.awaiting = true;
        out.active = true;
        out.reason = '时段刚结束，正在收尾';
      } else {
        out.phase = 'post';
        out.reason = '今天的时段已过（' + CXL.formatClock(end) + '）';
      }
    } else {
      // 跨夜时段，例如 22:00 - 02:00：起点之后、或次日终点之前都算在内
      var span = '在跨夜时段内（' + CXL.formatClock(start) + ' - 次日 ' + CXL.formatClock(end) + '）';
      if (ms >= start * 60000) {
        out.phase = 'in';
        out.inWindow = true;
        out.active = true;
        out.reason = span;
        // 刚开门（起点前后 20 分钟内）：面板上标一下"刚开始"
        if (ms < start * 60000 + START_GRACE_MS) out.justOpened = true;
      } else if (ms < end * 60000) {
        out.phase = 'in';
        out.inWindow = true;
        out.active = true;
        out.reason = span;
        // 次日收尾阶段：终点前最后 20 分钟等价于"刚开门"的一次收尾
        if (ms > end * 60000 - START_GRACE_MS) out.justOpened = true;
      } else if (ms < end * 60000 + END_GRACE_MS) {
        out.phase = 'post';
        out.awaiting = true;
        out.active = true;
        out.reason = '时段刚结束，正在收尾';
      } else {
        out.phase = 'pre';
        out.reason = '还没到 ' + CXL.formatClock(start);
      }
    }
    return out;
  };

  /** [1,2,3,4,5] -> "周一至周五"；不连续就逐个列出来 */
  CXL.describeWeekdays = function (weekdays) {
    var list = Array.isArray(weekdays) ? weekdays.slice().map(Number).sort(function (a, b) { return a - b; }) : [];
    if (!list.length) return '每天';
    if (list.length === 7) return '每天';
    // 周一~周五这种连续段优先用"至"表达（周日放最后，避免出现"周五至周日"这种含周日的歧义）
    var names = list.map(function (d) { return CXL.WEEKDAY_NAMES[d] || ('周' + d); });
    var consecutive = true;
    for (var i = 1; i < list.length; i++) {
      if (list[i] !== list[i - 1] + 1) { consecutive = false; break; }
    }
    if (consecutive && list.length >= 3 && list.indexOf(0) < 0) {
      return names[0] + '至' + names[names.length - 1];
    }
    return names.join('、');
  };

  /** 时段的一句话描述，面板/日志直接用 */
  CXL.describeSchedule = function (auto) {
    auto = auto || {};
    var start = CXL.parseClock(auto.startTime || '08:00');
    var end = CXL.parseClock(auto.endTime || '14:00');
    return CXL.describeWeekdays(auto.weekdays) + ' ' +
      CXL.formatClock(start === null ? 8 * 60 : start) + '-' +
      CXL.formatClock(end === null ? 14 * 60 : end);
  };

  // -------------------------------------------------------------------------
  // 2) 服务端返回的归类
  //
  //    这一步是"自动"能否安全的前提：只有明确是"距离不够"才去调坐标，
  //    别的失败（已签到、要人脸、要二维码、登录失效）一律停手并报出来。
  // -------------------------------------------------------------------------

  /** 距离文案：支持 "123米" "123.5m" "1.2km" "1公里" "0.5千米" */
  function pickMeters(text) {
    var s = String(text || '');
    var m = s.match(/(\d+(?:\.\d+)?)\s*(千米|公里|km|米|m)(?![a-z])/i);
    if (!m) return null;
    var n = parseFloat(m[1]);
    if (!isFinite(n)) return null;
    var unit = m[2].toLowerCase();
    if (unit === '千米' || unit === '公里' || unit === 'km') n *= 1000;
    return n;
  }

  /**
   * 归类服务端返回。
   * 返回：
   *   { ok, kind, meters, range, needApp, message }
   *   kind：success / already / tooFar / face / qr / login / expired / photoAuth /
   *         validate / empty / other
   */
  CXL.classifySignResponse = function (text, httpStatus) {
    var raw = String(text === undefined || text === null ? '' : text).trim();
    var out = { ok: false, kind: 'other', meters: null, range: null, needApp: false, message: raw };

    if (/^success2?$/i.test(raw) || /"success"\s*:\s*true/i.test(raw)) {
      out.ok = true;
      out.kind = 'success';
      return out;
    }
    if (!raw) {
      out.kind = 'empty';
      return out;
    }
    if (/请先登录|未登录|登录已过期|not\s*login/i.test(raw)) { out.kind = 'login'; return out; }
    if (/已签到|重复签到|请勿重复|签到过了/.test(raw)) { out.kind = 'already'; return out; }

    var meters = pickMeters(raw);
    var far = /范围|距离|太远|过远|不在.*(范围|区域)|超出/.test(raw);
    if (meters !== null && (far || /签到地点|签到范围/.test(raw))) {
      out.kind = 'tooFar';
      out.meters = meters;
      // 服务端文案里有时会写"签到范围 200 米"，有时只写"还需 xxx 米"
      var range = raw.match(/(?:范围|半径)[^0-9]{0,6}(\d+(?:\.\d+)?)\s*(千米|公里|km|米|m)/i);
      if (range) {
        var r = parseFloat(range[1]);
        var ru = range[2].toLowerCase();
        if (ru === '千米' || ru === '公里' || ru === 'km') r *= 1000;
        out.range = r;
      }
      return out;
    }
    if (/\[face\]|人脸|活体/.test(raw)) { out.kind = 'face'; out.needApp = true; return out; }
    if (/重新扫描|二维码/.test(raw)) { out.kind = 'qr'; return out; }
    if (/photoAuthError/i.test(raw)) { out.kind = 'photoAuth'; return out; }
    if (/已结束|过期|失效/.test(raw)) { out.kind = 'expired'; return out; }
    if (/validate|校验|参数/.test(raw)) { out.kind = 'validate'; return out; }
    return out;
  };

  /** 中文解释（后台/面板共用，避免两处说法不一致） */
  CXL.explainSignResult = function (cls) {
    cls = cls || {};
    var raw = cls.message ? '服务端返回：' + cls.message : '';
    switch (cls.kind) {
      case 'success':
        return '签到成功。';
      case 'already':
        return '这次签到之前已经签过了。' + raw;
      case 'tooFar':
        return '离签到地点太远（' + CXL.formatDistance(cls.meters) +
          (cls.range ? '，允许范围约 ' + CXL.formatDistance(cls.range) : '') + '）。' + raw;
      case 'face':
        return '这次要人脸活体，网页端拿不到凭证，只能用学习通 APP。' + raw;
      case 'qr':
        return '这次要扫老师屏幕上的二维码（enc 参数），网页端拿不到，只能用 APP。' + raw;
      case 'login':
        return '登录态失效了：先在浏览器里登录 i.chaoxing.com。' + raw;
      case 'expired':
        return '签到活动已结束或已过期。' + raw;
      case 'photoAuth':
        return '服务端拒绝了这个活动（拍照凭证校验）：' + cls.message;
      case 'validate':
        return '服务端要求额外校验（可能是参数不对或被判定异常）。' + raw;
      case 'empty':
        return '服务端返回空内容，通常说明登录态失效或活动编号无效。';
      default:
        return raw || '服务端返回了无法识别的内容。';
    }
  };

  // -------------------------------------------------------------------------
  // 3) 三点定位：由经验观测反推"签到地点"
  //
  //    观测格式（历史里存的就是这个）：
  //      { lat, lon, meters }   —— 在 (lat, lon) 提交，服务端说还差 meters 米
  //
  //    做法：先把地面近似成平面（局部切平面，几十公里内误差可忽略），
  //    每条形如  |P - A_i| = r_i  的圆方程相减消掉二次项，得到线性方程组
  //      2(P - A_j)·u = |A_j|² - |A_i|² + r_i² - r_j²
  //    再用正规方程 (AᵀA)x = Aᵀb 做最小二乘。观测不够/退化时回退到"单点 + 半径"。
  // -------------------------------------------------------------------------

  var M_PER_DEG_LAT = 111320;
  function metersPerDegLon(lat) {
    return 111320 * Math.cos((lat * Math.PI) / 180);
  }

  /** 局部切平面：经纬度 -> 米（原点取观测的均值，避免大数值相减的精度损失） */
  function projectLocal(points, origin) {
    var mLon = metersPerDegLon(origin.lat);
    return points.map(function (p) {
      return {
        x: (p.lon - origin.lon) * mLon,
        y: (p.lat - origin.lat) * M_PER_DEG_LAT,
        r: Number(p.meters)
      };
    });
  }

  function solveLeastSquares(rows, rhs) {
    // 2x2 正规方程：rows 是 N×2，rhs 是 N
    var a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
    for (var i = 0; i < rows.length; i++) {
      var x = rows[i][0], y = rows[i][1], b = rhs[i];
      a11 += x * x; a12 += x * y; a22 += y * y; b1 += x * b; b2 += y * b;
    }
    var det = a11 * a22 - a12 * a12;
    if (!isFinite(det) || Math.abs(det) < 1e-9) return null;
    return [
      (b1 * a22 - b2 * a12) / det,
      (b2 * a11 - b1 * a12) / det
    ];
  }

  /** 所有观测到同一点的平均绝对误差（米），用来判断这组解靠不靠谱 */
  function meanResidual(m, obs) {
    if (!obs.length) return Infinity;
    var sum = 0;
    for (var i = 0; i < obs.length; i++) {
      var d = Math.sqrt(Math.pow(m.x - obs[i].x, 2) + Math.pow(m.y - obs[i].y, 2));
      sum += Math.abs(d - obs[i].r);
    }
    return sum / obs.length;
  }

  /** 坐标是否落在一个可信的中国范围内（防止算飞出外太空的点被拿去提交） */
  function inChina(lat, lon) {
    return lat >= 3 && lat <= 54 && lon >= 73 && lon <= 136;
  }

  /**
   * 由历史观测算签到地点。
   * 返回 { lat, lon, residual, used, mode } 或 null（没有观测）。
   *   residual 平均绝对误差（米）；mode = 'trilateration' | 'exact' | 'midpoint' | 'circle'
   */
  CXL.solveTrilateration = function (obs, opts) {
    opts = opts || {};
    var list = (obs || []).filter(function (o) {
      return o && isFinite(Number(o.lat)) && isFinite(Number(o.lon)) &&
        isFinite(Number(o.meters)) && Number(o.meters) >= 0;
    }).map(function (o) {
      return { lat: Number(o.lat), lon: Number(o.lon), meters: Number(o.meters) };
    });
    if (!list.length) return null;

    var origin = { lat: 0, lon: 0 };
    list.forEach(function (o) { origin.lat += o.lat; origin.lon += o.lon; });
    origin.lat /= list.length;
    origin.lon /= list.length;

    var pts = projectLocal(list, origin);
    var mLon = metersPerDegLon(origin.lat);

    // 相同的点、相同半径重复测没意义，去重（保留最后一次读到的距离）
    var seen = {};
    var uniq = [];
    for (var i = 0; i < pts.length; i++) {
      var key = pts[i].x.toFixed(1) + ',' + pts[i].y.toFixed(1);
      if (seen[key] !== undefined) { uniq[seen[key]] = pts[i]; continue; }
      seen[key] = uniq.length;
      uniq.push(pts[i]);
    }

    var result = null;

    // ---- 两个及以上不同的位置：最小二乘 ----
    if (uniq.length >= 2) {
      var ref = uniq[0];
      var rows = [];
      var rhs = [];
      for (var j = 1; j < uniq.length; j++) {
        var o = uniq[j];
        rows.push([2 * (o.x - ref.x), 2 * (o.y - ref.y)]);
        rhs.push(
          (o.x * o.x + o.y * o.y) - (ref.x * ref.x + ref.y * ref.y) +
          (ref.r * ref.r - o.r * o.r)
        );
      }
      var sol = solveLeastSquares(rows, rhs);
      if (sol) {
        var cand = { x: sol[0], y: sol[1] };
        result = {
          lat: origin.lat + cand.y / M_PER_DEG_LAT,
          lon: origin.lon + cand.x / mLon,
          residual: meanResidual(cand, uniq),
          used: list.length,
          mode: 'trilateration'
        };
      }
    }

    // ---- 只有一条测量，或线性方程退化（两点靠得太近/几乎重合）----
    //      只有一个点：签到点就在它的圆上，方向未知，先停在测量点本身（最简单的近似）。
    //      两个点：圆相交会给出两个镜像解（上下各一个），平均误差完全一样、没法区分，
    //             这时宁可"保守"—— 停在两个测量点的中点，等第三条测量来定方向。
    //             这一步只用来决定"下一步往哪测"，不会当成最终结果提交。
    if (!result) {
      if (uniq.length <= 1) {
        result = {
          lat: origin.lat + uniq[0].y / M_PER_DEG_LAT,
          lon: origin.lon + uniq[0].x / mLon,
          residual: meanResidual(uniq[0], uniq),
          used: list.length,
          mode: 'circle'
        };
      } else {
        var mx = 0, my = 0;
        for (var m = 0; m < uniq.length; m++) { mx += uniq[m].x; my += uniq[m].y; }
        var midPoint = { x: mx / uniq.length, y: my / uniq.length };
        result = {
          lat: origin.lat + midPoint.y / M_PER_DEG_LAT,
          lon: origin.lon + midPoint.x / mLon,
          residual: meanResidual(midPoint, uniq),
          used: list.length,
          mode: 'midpoint'
        };
      }
    }

    if (!inChina(result.lat, result.lon)) return null;

    // ---- 严格圆相交解作为候选：只有它明显更准（对全部观测的平均误差更小）才采纳。
    //      最小二乘在测量少时会"缩"到几个点的中间、把方向磨平；
    //      严格解则天然把每个圆心放在自己的圆上，方向由几何决定。
    if (list.length >= 2) {
      try {
        var exact = CXL.solveTrilaterationExact(list);
        if (exact && isFinite(exact.residual)) {
          result.tried = {
            leastSquares: {
              lat: CXL.round6(result.lat), lon: CXL.round6(result.lon),
              residual: result.residual, mode: result.mode
            },
            exact: { lat: exact.lat, lon: exact.lon, residual: exact.residual }
          };
          // 两条测量时，圆相交必然给出两个镜像解，两个解的误差完全一样，
          // 单看"谁更准"分不出来 —— 这时不采纳，等下一轮第三条测量来定方向。
          var ambiguous = (list.length < 3) && (result.mode === 'midpoint' ||
            Math.abs(exact.residual - result.residual) < 5);
          // 留 1 米容差，避免噪声让两种解法来回抖
          if (!ambiguous && exact.residual + 1 < result.residual) {
            result.lat = exact.lat;
            result.lon = exact.lon;
            result.residual = exact.residual;
            result.mode = 'exact';
          }
        }
      } catch (e) { /* 严格解只是补充，出错就当没有 */ }
    }

    result.lat = CXL.round6(result.lat);
    result.lon = CXL.round6(result.lon);
    result.residual = Math.round(result.residual * 10) / 10;
    return result;
  };

  /**
   * 严格的圆相交解（"每个圆都落在自己的圆上"的推广版）。
   *
   * 圆方程 (x-x_i)² + (y-y_i)² = r_i²。做法很直白：
   *   - 每两条测量可以交出两个候选点；
   *   - 把所有这些候选点收集起来，取"对所有测量最不矛盾"的那个
   *     （|O-A_i| 与 r_i 的平均差最小）。
   *
   * 为什么需要它：最小二乘把圆方程相减时丢掉了"点在圆的哪一侧"这个符号信息，
   * 只有两条测量时连方向都定不出来（解只会落在两点连线的中垂线上）。
   * 圆相交天然保留了这一侧的信息。它对测量误差更敏感，
   * 所以只当**补充候选**，由调用方拿平均误差跟最小二乘的结果比一比再采纳。
   *
   * 两圆相离/内含（服务端把距离取整、或测量点本身有误差时很常见）没有交点，
   * 这时把两个半径往中间拉，使"大半径 - 小半径 == 圆心距"（或相切），
   * 仍然给出一个可用的候选点。
   */
  CXL.solveTrilaterationExact = function (obs) {
    var list = (obs || []).filter(function (o) {
      return o && isFinite(Number(o.lat)) && isFinite(Number(o.lon)) &&
        isFinite(Number(o.meters)) && Number(o.meters) >= 0;
    });
    if (list.length < 2) return null;

    var oLat = 0;
    list.forEach(function (o) { oLat += Number(o.lat); });
    oLat /= list.length;
    var mLon = metersPerDegLon(oLat);
    var mLat = M_PER_DEG_LAT;

    // 以观测均值为原点的局部平面（单位：米）
    var ox = 0, oy = 0;
    list.forEach(function (o) {
      ox += Number(o.lon) * mLon;
      oy += Number(o.lat) * mLat;
    });
    ox /= list.length; oy /= list.length;

    var n = list.length;
    var P = list.map(function (o) {
      return { x: Number(o.lon) * mLon - ox, y: Number(o.lat) * mLat - oy, r: Number(o.meters) };
    });

    /** 圆对 (a, b) 的交点；相离/内含时把半径拉到相切 */
    function circleIntersections(a, b) {
      var dx = b.x - a.x;
      var dy = b.y - a.y;
      var d = Math.sqrt(dx * dx + dy * dy);
      if (!(d > 1e-9)) return [];
      var r1 = a.r;
      var r2 = b.r;
      var sum = r1 + r2;
      if (d > sum) {
        // 相离：等比放大两个半径到刚好外切
        var kmul = d / sum;
        r1 *= kmul;
        r2 *= kmul;
      } else if (d < Math.abs(r1 - r2)) {
        // 内含：把两个半径往中间靠，让 |r1 - r2| == d
        var big = Math.max(r1, r2);
        var small = Math.min(r1, r2);
        var mid = (big + d + small) / 2;
        if (r1 >= r2) { r1 = mid; r2 = mid - d; }
        else { r2 = mid; r1 = mid - d; }
        if (r1 < 0 || r2 < 0) return [];
      }
      var aLen = (d * d + r1 * r1 - r2 * r2) / (2 * d);
      var h2 = r1 * r1 - aLen * aLen;
      var h = h2 > 0 ? Math.sqrt(h2) : 0;
      var mx = a.x + (dx * aLen) / d;
      var my = a.y + (dy * aLen) / d;
      var ux = -dy / d;
      var uy = dx / d;
      return [
        { x: mx + ux * h, y: my + uy * h },
        { x: mx - ux * h, y: my - uy * h }
      ];
    }

    /** 候选点对所有测量的平均误差 */
    function errAt(pt) {
      var sum = 0;
      for (var i = 0; i < n; i++) {
        var d = Math.sqrt(Math.pow(pt.x - P[i].x, 2) + Math.pow(pt.y - P[i].y, 2));
        sum += Math.abs(d - P[i].r);
      }
      return sum / n;
    }

    var best = null;
    for (var i = 0; i < n; i++) {
      for (var j = i + 1; j < n; j++) {
        var hits = circleIntersections(P[i], P[j]);
        for (var h = 0; h < hits.length; h++) {
          var e = errAt(hits[h]);
          if (!isFinite(e)) continue;
          if (!best || e < best.err) best = { x: hits[h].x, y: hits[h].y, err: e };
        }
      }
    }
    if (!best) return null;

    var lat = (oy + best.y) / mLat;
    var lon = (ox + best.x) / mLon;
    if (!inChina(lat, lon)) return null;
    return {
      lat: CXL.round6(lat),
      lon: CXL.round6(lon),
      residual: Math.round(best.err * 10) / 10,
      used: n,
      mode: 'exact'
    };
  };

  CXL.offsetPoint = function (lat, lon, north, east) {
    var dLat = (Number(north) || 0) / M_PER_DEG_LAT;
    var dLon = (Number(east) || 0) / metersPerDegLon(lat);
    return { lat: CXL.round6(lat + dLat), lon: CXL.round6(lon + dLon) };
  };

  /** 两个点之间还要走多少米（沿北、沿东分解），给"再挪一点"用 */
  CXL.deltaMeters = function (fromLat, fromLon, toLat, toLon) {
    return {
      north: (toLat - fromLat) * M_PER_DEG_LAT,
      east: (toLon - fromLon) * metersPerDegLon(fromLat)
    };
  };

  /** 八方位，按"覆盖角最好"的顺序取；用来在圆上换方向重测 */
  CXL.DIRECTIONS = [
    { name: '正北', deg: 0 },
    { name: '正东', deg: 90 },
    { name: '正南', deg: 180 },
    { name: '正西', deg: 270 },
    { name: '东北', deg: 45 },
    { name: '东南', deg: 135 },
    { name: '西南', deg: 225 },
    { name: '西北', deg: 315 }
  ];

  function bearingBetween(a, b) {
    var dy = (b.lat - a.lat) * M_PER_DEG_LAT;
    var dx = (b.lon - a.lon) * metersPerDegLon(a.lat);
    var deg = (Math.atan2(dx, dy) * 180) / Math.PI;
    return (deg + 360) % 360;
  }

  function angleGap(a, b) {
    var d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }

  /**
   * 挑下一个测量方向：离已有观测方向越远越好（三点定位最怕三个点挤在一条线上）。
   * usedDegs 是已经测过的方向角度列表。
   */
  CXL.pickDirection = function (usedDegs, round) {
    var used = (usedDegs || []).map(function (d) { return ((Number(d) % 360) + 360) % 360; });
    var best = null;
    var bestScore = -1;
    for (var i = 0; i < CXL.DIRECTIONS.length; i++) {
      var dir = CXL.DIRECTIONS[i];
      var score = 360;
      if (used.length) {
        var minGap = 360;
        for (var j = 0; j < used.length; j++) minGap = Math.min(minGap, angleGap(dir.deg, used[j]));
        score = minGap;                 // 与最近一次测量方向的夹角越大越好
      }
      // 很小的扰动：让同样的观测记录每次复现也算出同样的方向（便于排查）
      score -= i * 0.01;
      if (score > bestScore) { bestScore = score; best = dir; }
    }
    if (!best) best = CXL.DIRECTIONS[(round || 0) % CXL.DIRECTIONS.length];
    return best;
  };

  /** 用第 n 个方向、给定半径，算出一个探点 */
  CXL.probePoint = function (center, radiusMeters, deg) {
    var rad = (deg * Math.PI) / 180;
    return CXL.offsetPoint(center.lat, center.lon,
      Math.cos(rad) * radiusMeters, Math.sin(rad) * radiusMeters);
  };

  // -------------------------------------------------------------------------
  // 4) 一轮轮的推进策略（纯决策函数，方便单测）
  // -------------------------------------------------------------------------

  /** 自动签到的默认参数（新装即"周一至周五 8:00-14:00、只签位置签到"） */
  CXL.AUTO_DEFAULTS = {
    enabled: false,                 // 默认不自动，用户自己打开
    startTime: '08:00',
    endTime: '14:00',
    weekdays: [1, 2, 3, 4, 5],
    locationOnly: true,             // 只处理位置签到（其它类型只报告）
    intervalMs: 20000,              // 时段内的查询间隔
    maxRounds: 10,                  // 单次签到最多提交几次
    maxProbeMeters: 800,            // 单次探点的最远半径
    goodEnoughMeters: 25,           // 解算残差小于这个值就认为定位准了
    autoSubmit: true,               // 时段内拿到位置签到时自动提交
    stopAfterSuccess: true,         // 当天签成功后不再找
    // 监控哪些课：留空 = 自动（打开过页面登记的课程，或直接从课表接口拉）
    courses: [],
    pollEverySeconds: 20            // 时段内的查询间隔（面板/设置页展示用）
  };

  /**
   * 下一步该干什么（决策表）：
   *   输入：观测历史 obs、当前中心 center、已试方向、已用轮数
   *   输出：{ lat, lon, why } —— 下个要提交的点；或 null（该停手）
   */
  CXL.planProbe = function (obs, opts) {
    opts = opts || {};
    var list = obs || [];
    var maxProbe = Number(opts.maxProbeMeters) || CXL.AUTO_DEFAULTS.maxProbeMeters;
    var goodEnough = Number(opts.goodEnoughMeters) || CXL.AUTO_DEFAULTS.goodEnoughMeters;

    if (!list.length) {
      return { center: null, radius: null, why: '还没有测量数据，先用用户给的点试一次', first: true };
    }

    var last = list[list.length - 1];
    var solution = CXL.solveTrilateration(list, {});
    // 测过的方位：观测里若带着 deg（我们自己探点时记的，准）就用它，
    // 没有的话按相邻两点的连线反推（够用，因为探点本来就是按直线走的）。
    var usedDegs = [];
    for (var i = 0; i < list.length; i++) {
      if (isFinite(Number(list[i].deg))) usedDegs.push(Number(list[i].deg));
    }
    for (var j = 1; j < list.length; j++) {
      var prev = list[j - 1];
      if (Math.abs(prev.lat - list[j].lat) < 1e-7 && Math.abs(prev.lon - list[j].lon) < 1e-7) continue;
      var b = bearingBetween({ lat: prev.lat, lon: prev.lon }, { lat: list[j].lat, lon: list[j].lon });
      var dup = false;
      for (var k = 0; k < usedDegs.length; k++) if (angleGap(usedDegs[k], b) < 5) { dup = true; break; }
      if (!dup) usedDegs.push(b);
    }
    if (Array.isArray(opts.usedDegs) && opts.usedDegs.length) usedDegs = opts.usedDegs.slice();

    if (!solution) {
      return {
        center: { lat: last.lat, lon: last.lon },
        radius: Math.min(maxProbe, Math.max(30, last.meters * 2)),
        why: '观测数据不够，扩一倍半径再试'
      };
    }

    // 残差已经很小：说明算出来的点应该就在范围边上。
    // 这时不再撒大圈，改成"在解附近按十字方向一点点挪"，把最后几十米磨掉。
    if (solution.residual <= goodEnough) {
      var step = Math.max(12, Math.min(60, (last.meters || 0) * 0.6 + 12));
      var refineDir = CXL.pickDirection(usedDegs, list.length + 3);
      var refineDir2 = CXL.pickDirection(usedDegs.concat([refineDir.deg]), list.length + 4);
      var useDir = (list.length % 2 === 0) ? refineDir : refineDir2;
      var rp = CXL.probePoint({ lat: solution.lat, lon: solution.lon }, step, useDir.deg);
      return {
        center: rp,
        radius: step,
        refine: true,
        solution: solution,
        direction: useDir.name,
        why: '定位已收敛（残差 ' + Math.round(solution.residual) + ' m），把解往' + useDir.name +
          '挪 ' + Math.round(step) + ' m 细调'
      };
    }

    var dir = CXL.pickDirection(usedDegs, list.length);
    var radius = Math.max(20, Math.min(maxProbe, Math.max(solution.residual * 1.6, last.meters + 60)));
    var point = CXL.probePoint(solution, radius, dir.deg);
    return {
      center: point,
      radius: radius,
      solution: solution,
      direction: dir.name,
      why: '按三点定位解算（残差 ' + Math.round(solution.residual) + ' m），往' + dir.name + ' ' +
        Math.round(radius) + ' m 处再测一次'
    };
  };

  // -------------------------------------------------------------------------
  // 5) 运行状态（后台写、面板读）
  // -------------------------------------------------------------------------

  CXL.AUTO_KEYS = {
    auto: 'auto',                 // 自动签到的配置（CXL.AUTO_DEFAULTS 的超集）
    autoState: 'autoState',       // 运行状态
    autoLog: 'autoLog',           // 最近若干条日志
    autoTargets: 'autoTargets'    // 记录到的课程/班级（供后台补查询）
  };

  CXL.emptyAutoState = function () {
    return {
      enabled: false,
      phase: 'off',
      status: '未启用',
      today: '',                 // yyyy-MM-dd：下面 stats 属于哪一天
      looking: false,
      lastLookupAt: 0,
      lastError: '',
      current: null,             // { courseName, activeId, activeName, kind, mode }
      progress: null,            // { round, meters, solution, note }
      stats: { polls: 0, submitted: 0, success: 0 }
    };
  };

  CXL.emptyAutoLog = function () {
    return { items: [] };
  };

  /** 追加一条日志（最多保留几十条，够面板翻） */
  CXL.appendLog = function (log, entry, max) {
    var next = { items: ((log && log.items) || []).slice() };
    next.items.push(Object.assign({ at: Date.now() }, entry || {}));
    var cap = max || 60;
    if (next.items.length > cap) next.items = next.items.slice(-cap);
    return next;
  };

  /** 日志一行文字 */
  CXL.describeLog = function (entry) {
    if (!entry) return '';
    var d = new Date(entry.at || Date.now());
    var hh = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    return hh + '  ' + (entry.text || '');
  };

  /** 状态摘要（popup / options 都显示这一行） */
  CXL.describeAutoState = function (state, auto) {
    state = state || CXL.emptyAutoState();
    if (!state.enabled) return '自动签到未启用（时段 ' + CXL.describeSchedule(auto) + '）';
    return '自动签到：' + (state.status || state.phase || '待命') +
      ' · 时段 ' + CXL.describeSchedule(auto) +
      ' · 今天查询 ' + (state.stats ? state.stats.polls : 0) + ' 次、成功 ' + (state.stats ? state.stats.success : 0) + ' 次';
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
