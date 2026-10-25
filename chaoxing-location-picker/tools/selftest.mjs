/*
 * 开发用自测脚本（不随扩展打包使用，仅供本地验证核心逻辑）。
 * 运行：
 *   node tools/selftest.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'extension', 'src');

let pass = 0;
let fail = 0;

function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    console.log('  ✗ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : ''));
  }
}

function near(a, b, tol) {
  return Math.abs(a - b) <= tol;
}

function section(title) {
  console.log('\n' + title);
}

// ---------------------------------------------------------------------------
// 1. lib.js：坐标转换 / 解析 / 距离
// ---------------------------------------------------------------------------

section('1) lib.js 坐标与工具函数');

const libSource = fs.readFileSync(path.join(srcDir, 'lib.js'), 'utf8');
const mapSource = fs.readFileSync(path.join(srcDir, 'map.js'), 'utf8');
const libCtx = { globalThis: {}, chrome: { storage: { local: { get() {}, set() {} } }, storage_onChanged: null } };
libCtx.window = libCtx.globalThis;
vm.createContext(libCtx);
vm.runInContext(libSource, libCtx);
const CXL = libCtx.globalThis.CXL;

ok('CXL 已导出', !!CXL);

// 已知参考值：天安门 WGS-84 -> GCJ-02 偏移约 +0.0056 / +0.0061
const wgs = [39.908722, 116.397499];
const gcj = CXL.wgs84ToGcj02(wgs[0], wgs[1]);
ok('wgs84ToGcj02 纬度偏移合理', gcj[0] > wgs[0] && gcj[0] - wgs[0] < 0.01, gcj);
ok('wgs84ToGcj02 经度偏移合理', gcj[1] > wgs[1] && gcj[1] - wgs[1] < 0.01, gcj);

const back = CXL.gcj02ToWgs84(gcj[0], gcj[1]);
ok('gcj02ToWgs84 往返误差 < 1e-6', near(back[0], wgs[0], 1e-6) && near(back[1], wgs[1], 1e-6), back);

const bd = CXL.gcj02ToBd09(gcj[0], gcj[1]);
const bdBack = CXL.bd09ToGcj02(bd[0], bd[1]);
ok('BD-09 往返误差 < 1e-6', near(bdBack[0], gcj[0], 1e-6) && near(bdBack[1], gcj[1], 1e-6), [bd, bdBack]);

// 境外坐标不做偏移
const tokyo = CXL.wgs84ToGcj02(35.6762, 139.6503);
ok('境外坐标不偏移', tokyo[0] === 35.6762 && tokyo[1] === 139.6503, tokyo);

// 解析用户输入
ok('解析 "30.123456, 120.123456"', JSON.stringify(CXL.parseLatLon('30.123456, 120.123456')) === '[30.123456,120.123456]');
ok('解析中文逗号 "30.123456，120.123456"', JSON.stringify(CXL.parseLatLon('30.123456，120.123456')) === '[30.123456,120.123456]');
ok('解析经度在前 "120.123456 30.123456"（自动纠正）', JSON.stringify(CXL.parseLatLon('120.123456 30.123456')) === '[30.123456,120.123456]');
ok('解析带标签文本', JSON.stringify(CXL.parseLatLon('lat:30.123456 lng:120.123456')) === '[30.123456,120.123456]');
ok('解析 1 位小数 "31.5, 121.5"', JSON.stringify(CXL.parseLatLon('31.5, 121.5')) === '[31.5,121.5]');
ok('解析 2 位小数 "31.50, 121.50"', JSON.stringify(CXL.parseLatLon('31.50, 121.50')) === '[31.5,121.5]');
ok('解析空格分隔 "30.5 120.5"', JSON.stringify(CXL.parseLatLon('30.5 120.5')) === '[30.5,120.5]');
ok('解析中文标签 "纬度30.5 经度120.5"', JSON.stringify(CXL.parseLatLon('纬度30.5 经度120.5')) === '[30.5,120.5]');
ok('解析 "30.5°, 120.5°"', JSON.stringify(CXL.parseLatLon('30.5°, 120.5°')) === '[30.5,120.5]');
ok('无法解析时返回 null', CXL.parseLatLon('某某大学') === null);
ok('空值返回 null', CXL.parseLatLon('') === null);
ok('超出中国范围的数字返回 null', CXL.parseLatLon('1.5, 2.5') === null);

// 从粘贴的签到消息/链接里抽取参数
const pasted = CXL.parseSignContext(
  '【签到通知】老师发布了签到，请点击链接参与 https://mobilelearn.chaoxing.com/page/active/active?activeId=123456789&fid=1403&courseId=22222222&classId=3333333&uid=88888888 尽快完成'
);
ok('从消息里抽出 activeId', pasted.activeId === '123456789', pasted);
ok('从消息里抽出 fid', pasted.fid === '1403');
ok('从消息里抽出 courseId / classId', pasted.courseId === '22222222' && pasted.classId === '3333333');
ok('从消息里抽出 url', /^https:\/\/mobilelearn\.chaoxing\.com/.test(pasted.url || ''));
const pasted2 = CXL.parseSignContext('activePrimaryId=987654321');
ok('支持 activePrimaryId 写法', pasted2.activeId === '987654321', pasted2);
const pasted3 = CXL.parseSignContext('activeId=12345');
ok('过短的 activeId 不被误认', pasted3.activeId === undefined, pasted3);
ok('无关文本返回空对象', JSON.stringify(CXL.parseSignContext('今天天气不错')) === '{}');
ok('空输入返回空对象', JSON.stringify(CXL.parseSignContext('')) === '{}');

// ---- 地址名称相似度：必须挡住"河北师范大学 → 北京师范大学"这类误匹配 ----
const sim = CXL.nameSimilarity;
const HEBTU = '河北师范大学（裕华校区）, 南二环东路20号, 裕华区, 石家庄市, 河北省, 中国';
const BNU = '北京师范大学, 新街口外大街19号, 海淀区, 北京市, 中国';
ok('河师大 vs 河师大候选 → 高相似度（接受）', sim('河北师范大学', HEBTU) >= 0.45, sim('河北师范大学', HEBTU));
ok('河师大 vs 北京师范大学候选 → 低相似度（拒绝）', sim('河北师范大学', BNU) < 0.45, sim('河北师范大学', BNU));
ok('带校区的完整名称也能命中', sim('河北师范大学裕华校区', HEBTU) >= 0.45, sim('河北师范大学裕华校区', HEBTU));
ok('候选完整包含查询串时直接满分', sim('河北师范大学', '某某路河北师范大学东门') === 1);
ok('完全无关的名称 → 极低分', sim('河北师范大学', '上海虹桥火车站') < 0.3, sim('河北师范大学', '上海虹桥火车站'));
ok('空查询返回 0', sim('', HEBTU) === 0);
ok('空候选返回 0', sim('河北师范大学', '') === 0);

// 距离
const d = CXL.distance(39.908722, 116.397499, 39.908722, 116.407499);
ok('同纬度 0.01 经度 ≈ 850m', d > 800 && d < 900, Math.round(d));
ok('formatDistance 米/千米', CXL.formatDistance(320) === '320 m' && CXL.formatDistance(1500) === '1.50 km');

// ---------------------------------------------------------------------------
// 1.5 自动获取 activeId：活动列表接口 / 响应解析 / 目标挑选
// ---------------------------------------------------------------------------

section('1.5) 自动获取 activeId');

// --- 请求地址组装 ---
const listUrl = CXL.buildActiveListUrl({ fid: '135774', courseId: '268194985', classId: '157462133' }, undefined, 1792081573824);
ok('活动列表地址指向官方接口', /^https:\/\/mobilelearn\.chaoxing\.com\/v2\/apis\/active\/student\/activelist\?/.test(listUrl || ''), listUrl);
ok('带上 fid / courseId / classId / 时间戳',
  /fid=135774/.test(listUrl) && /courseId=268194985/.test(listUrl) && /classId=157462133/.test(listUrl) && /_=1792081573824/.test(listUrl), listUrl);
ok('默认只要进行中的活动（showNotStartedActive=0）', /showNotStartedActive=0/.test(listUrl), listUrl);
ok('缺 courseId 时不拼地址（避免打到不该打的接口）', CXL.buildActiveListUrl({ classId: '1' }) === null);
ok('缺 classId 时也不拼地址', CXL.buildActiveListUrl({ courseId: '1' }) === null);

// --- 响应解析 ---
const activeResp = {
  result: 1,
  data: {
    activeList: [
      { id: '4000175553141', activePrimaryId: '4000175553141', nameOne: '位置签到', status: 1, signType: 4, startTime: 1792081000000 },
      { id: '4000175553000', nameOne: '<p>手势签到</p>', status: 2, signType: 3, startTime: 1792000000000 },
      { id: '4000175552000', nameOne: '未开始的签到', startTime: 1792100000000 },
      { id: 'noise', nameOne: '脏数据', status: 1 },
      { activeId: '4000175553999', nameOne: '另一个进行中', status: 1, startTime: 1792081500000 }
    ]
  }
};
const acts = CXL.extractActivities(activeResp);
ok('解析出全部合法活动（丢掉脏数据）', acts.length === 4, acts.map((a) => a.id));
ok('活动编号优先取 activeId/activePrimaryId/id', acts[0].id === '4000175553141' && acts[0].status === 1, acts[0]);
ok('名称里的 HTML 标签被清掉', CXL.extractActivities(activeResp)[1].name === '手势签到', CXL.extractActivities(activeResp)[1].name);
ok('没有 status 的活动算「未开始」(0)', acts[2].status === 0, acts[2]);
ok('嵌套包裹也能解析（data.data.activeList）',
  CXL.extractActivities({ data: { data: { activeList: [{ id: '123456789', status: 1 }] } } }).length === 1);
ok('直接给数组也能解析', CXL.extractActivities([{ id: '123456789', status: 1 }]).length === 1);
ok('非对象/空值返回空数组', CXL.extractActivities(null).length === 0 && CXL.extractActivities('nope').length === 0);
ok('错误信息提取（用于解释失败原因）',
  CXL.lookupErrorMessage({ result: 0, errorMsg: '<b>未登录</b>' }, 200) === '未登录（HTTP 200）', CXL.lookupErrorMessage({ result: 0, errorMsg: '<b>未登录</b>' }, 200));

// --- 目标挑选：只认进行中，且取最新的那个 ---
const picked = CXL.pickActiveTarget(activeResp);
ok('只挑「进行中」的活动', !!picked && picked.label === '进行中', picked);
ok('多个进行中时取开始时间最新的', picked.id === '4000175553999', picked);
const onlyEnded = { result: 1, data: { activeList: [{ id: '4000175553000', status: 2, startTime: 1 }] } };
ok('只有已结束的活动时返回 null（不能拿老 activityId 去签到）', CXL.pickActiveTarget(onlyEnded) === null);
const onlyFuture = { result: 1, data: { activeList: [{ id: '4000175552000', startTime: 1 }] } };
ok('只有未开始的活动时返回 null', CXL.pickActiveTarget(onlyFuture) === null);
ok('显式允许时才退而取未开始的', CXL.pickActiveTarget(onlyFuture, { allowNotStarted: true }).label === '未开始');
ok('空列表返回 null', CXL.pickActiveTarget({ result: 1, data: { activeList: [] } }) === null);
ok('没有 data 字段也不抛异常', CXL.pickActiveTarget({ result: 1 }) === null);

// --- activeId 合法性 ---
ok('isActiveId 接受 6 位以上数字', CXL.isActiveId('123456') && CXL.isActiveId(' 4000175553141 '));
ok('isActiveId 拒绝短数字/时间戳以外的脏值', !CXL.isActiveId('12345') && !CXL.isActiveId('abc') && !CXL.isActiveId('') && !CXL.isActiveId(null));

// --- 课程 / 班级编号来源 ---
const courseUrl = 'https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?courseid=268194985&clazzid=157462133&cpi=493989176&enc=2db0bfc248deb1e0459f3469c0e5b0f9&t=1792081573824';
const ctxUrl = CXL.parseCourseContext([courseUrl]);
ok('从课程页地址里读出 courseId / classId（小写参数名）',
  ctxUrl.courseId === '268194985' && ctxUrl.classId === '157462133', ctxUrl);
const ctxSign = CXL.parseCourseContext(['https://mobilelearn.chaoxing.com/page/active/stuActiveList?fid=135774&courseId=268194985&classId=157462133']);
ok('从签到页地址里读出编号（驼峰参数名）',
  ctxSign.courseId === '268194985' && ctxSign.classId === '157462133' && ctxSign.fid === '135774', ctxSign);
const ctxMixed = CXL.parseCourseContext(['/page/sign/signIn?courseId=1&clazzid=2']);
ok('同一串里混用大小写也能认', ctxMixed.courseId === '1' && ctxMixed.classId === '2', ctxMixed);
ok('认不出时返回空串而不是 null', CXL.parseCourseContext(['https://i.chaoxing.com/base']).courseId === '');

const htmlPage = '<html><script>var courseId = "268194985"; var clazzid=157462133; var fid = 135774;</script></html>';
const ctxHtml = CXL.parseCourseContextFromHtml(htmlPage);
ok('地址里没有编号时能从页面正文里挖出来',
  ctxHtml.courseId === '268194985' && ctxHtml.classId === '157462133' && ctxHtml.fid === '135774', ctxHtml);
ok('只挖需要的字段（want 过滤）',
  CXL.parseCourseContextFromHtml(htmlPage, ['courseId']).classId === '');
ok('空 HTML 不抛异常', CXL.parseCourseContextFromHtml('').courseId === '');

// 端到端：用户给的课程页地址 -> 查询地址里的参数
const realCtx = CXL.parseCourseContext([courseUrl]);
const realUrl = CXL.buildActiveListUrl(realCtx, undefined, 1);
ok('由课程页地址直接得到可用的查询地址',
  /courseId=268194985/.test(realUrl) && /classId=157462133/.test(realUrl), realUrl);

// ---------------------------------------------------------------------------
// 1.6 签到类型判定 + 拍照上传（位置/拍照合并的基础）
// ---------------------------------------------------------------------------

section('1.6) 签到类型判定与拍照上传');

ok('otherId=4 -> 位置签到', CXL.detectSignKind({ otherId: 4 }).key === 'location');
ok('activeSort=4 -> 位置签到', CXL.detectSignKind({ activeSort: 4 }).key === 'location');
ok('otherId=1 -> 普通签到', CXL.detectSignKind({ otherId: 1 }).key === 'plain');
ok('otherId=3 -> 手势签到', CXL.detectSignKind({ otherId: 3 }).key === 'gesture');
ok('otherId=5 -> 签到码', CXL.detectSignKind({ otherId: 5 }).key === 'code');
ok('otherId=6 -> 二维码', CXL.detectSignKind({ otherId: 6 }).key === 'qr');
ok('activeSort=6/7/8 -> 二维码',
  CXL.detectSignKind({ activeSort: 6 }).key === 'qr' &&
  CXL.detectSignKind({ activeSort: 7 }).key === 'qr' &&
  CXL.detectSignKind({ activeSort: 8 }).key === 'qr');
ok('activeSort=9 -> 签到码', CXL.detectSignKind({ activeSort: 9 }).key === 'code');

// ifphoto 是"可附照片"的附加标志，不是签到类型（这是踩过的坑）
const plainPhoto = CXL.detectSignKind({ name: '普通签到', ifphoto: 1 });
ok('普通签到 + ifphoto=1 -> 类型仍是普通，只是可附照片',
  plainPhoto.key === 'plain' && plainPhoto.needsPhoto === true, plainPhoto);
ok('普通签到 + ifphoto=1 -> 允许不交图直接提交', plainPhoto.canSubmitPlain === true);
const qrPhoto = CXL.detectSignKind({ name: '二维码签到', ifphoto: 1 });
ok('二维码签到 + ifphoto=1 -> 类型是二维码（不是"拍照签到"）',
  qrPhoto.key === 'qr' && qrPhoto.needsPhoto === true, qrPhoto);
ok('二维码签到 -> 网页端签不了（CanSubmitPlain=false）', qrPhoto.canSubmitPlain === false);
ok('activeSort=3（普通+拍照）-> 类型是普通 + 要照片',
  CXL.detectSignKind({ activeSort: 3 }).key === 'plain' &&
  CXL.detectSignKind({ activeSort: 3, ifphoto: 1 }).needsPhoto === true);

// 服务端字段缺失时按活动名字兜底（老师起名通常很直白）
ok('名字含"二维码" -> 二维码', CXL.detectSignKind({ name: '二维码签到' }).key === 'qr');
ok('名字含"手势" -> 手势', CXL.detectSignKind({ name: '手势签到' }).key === 'gesture');
ok('名字含"位置" -> 位置', CXL.detectSignKind({ name: '位置签到' }).key === 'location');
ok('名字推断会标记 fromName', CXL.detectSignKind({ name: '二维码签到' }).fromName === true);
ok('服务端字段优先于名字',
  CXL.detectSignKind({ name: '二维码签到', otherId: 4 }).key === 'location' &&
  CXL.detectSignKind({ name: '二维码签到', otherId: 4 }).fromName === false);
ok('证据不足 -> unknown', CXL.detectSignKind({}).key === 'unknown');
ok('只有活动编号时不算证据', CXL.detectSignKind({ id: '4000175553141', status: 1 }).key === 'unknown');

// ---- 这次踩的坑：把"普通签到+要求拍照"误判成二维码 ----
// ifrefreshewm 只是"允许二维码自动刷新"的能力位（默认就可能 1），绝不能拿来判类型
const plainPhotoCase = CXL.detectSignKind({
  name: '普通签到', activeSort: 3, otherId: 1, ifphoto: 1, ifrefreshewm: 1
});
ok('普通签到 + 要求拍照 + ifrefreshewm=1 -> 仍然是普通（这次误判的回归）',
  plainPhotoCase.key === 'plain', plainPhotoCase.key);
ok('上面这个活动被正确标成"要照片"并可提交',
  plainPhotoCase.needsPhoto === true && plainPhotoCase.canSubmitPlain === true, plainPhotoCase);
ok('ifrefreshewm=1 不再单独决定类型',
  CXL.detectSignKind({ otherId: 1, ifrefreshewm: 1 }).key === 'plain',
  CXL.detectSignKind({ otherId: 1, ifrefreshewm: 1 }).key);
ok('判定依据能被读出来（面板要显示）',
  /activeSort=3/.test(CXL.describeEvidence(plainPhotoCase)) &&
  /ifphoto=1/.test(CXL.describeEvidence(plainPhotoCase)),
  CXL.describeEvidence(plainPhotoCase));
ok('名字与字段冲突时会标记 conflict（名字像二维码、字段说普通）',
  (function () {
    var k = CXL.detectSignKind({ name: '二维码签到', otherId: 1, activeSort: 1 });
    return k.key === 'plain' && k.evidence.conflict === true;
  })(), CXL.describeEvidence(CXL.detectSignKind({ name: '二维码签到', otherId: 1, activeSort: 1 })));

// 真的二维码签到仍然能判出来（服务端字段：activeSort 6~8）
ok('activeSort=6 仍然判成二维码', CXL.detectSignKind({ activeSort: 6 }).key === 'qr');
ok('只有名字是二维码时才按名字判',
  CXL.detectSignKind({ name: '二维码签到' }).key === 'qr' &&
  CXL.detectSignKind({ name: '二维码签到' }).fromName === true);
ok('activeSort=16 -> 手势（实测值）', CXL.detectSignKind({ activeSort: 16 }).key === 'gesture');

// ---- 活动详情接口 ----
ok('活动详情地址正确',
  CXL.buildActiveInfoUrl('4000175553141', undefined, 1) ===
  'https://mobilelearn.chaoxing.com/v2/apis/active/getPPTActiveInfo?activeId=4000175553141&_=1',
  CXL.buildActiveInfoUrl('4000175553141', undefined, 1));
ok('没有 activeId 时不拼详情地址', CXL.buildActiveInfoUrl('') === null);
const info = CXL.normalizeActiveInfo({
  result: 1,
  data: { activeId: 2000175731193, activeSort: '6', otherId: 1, ifphoto: 1, ifrefreshewm: 1, name: '<b>二维码签到</b>' }
});
ok('详情字段被正确归一化',
  info.activeSort === 6 && info.otherId === 1 && info.ifrefreshewm === 1, info);
ok('详情里的 name 会清掉 HTML', info.name === '二维码签到', info.name);
ok('详情为空时不抛异常', CXL.normalizeActiveInfo(null).activeSort === null);
ok('用详情判出来的类型就是二维码',
  CXL.detectSignKind(info).key === 'qr', CXL.detectSignKind(info).key);
ok('字符串 "1"/"0" 也当布尔用',
  CXL.detectSignKind({ otherId: 1, ifphoto: '1' }).needsPhoto === true &&
  CXL.detectSignKind({ otherId: 4, ifphoto: '0' }).needsPhoto === false);
ok('describeNeeds 说得清要什么',
  /二维码/.test(CXL.describeNeeds(CXL.detectSignKind({ otherId: 6 }))) &&
  /拍照/.test(CXL.describeNeeds(CXL.detectSignKind({ otherId: 1, ifphoto: 1 }))) &&
  /直接提交/.test(CXL.describeNeeds(CXL.detectSignKind({ otherId: 1 }))));
ok('ifphoto=1 会被说成"老师要求拍照"（不是"可选"）',
  /要求拍照/.test(CXL.describeNeeds(CXL.detectSignKind({ otherId: 1, ifphoto: 1 }))),
  CXL.describeNeeds(CXL.detectSignKind({ otherId: 1, ifphoto: 1 })));
ok('kindNeeds 兼容老接口',
  CXL.kindNeeds(CXL.detectSignKind({ otherId: 4 })).location === true);

const kindResp = {
  result: 1,
  data: {
    activeList: [
      { id: '4000175553141', nameOne: '普通签到', status: 1, activeSort: 3, ifphoto: 1, startTime: 2 },
      { id: '4000175553000', nameOne: '位置签到', status: 1, otherId: 4, activeSort: 4, startTime: 1 }
    ]
  }
};
const pickedKind = CXL.pickActiveTarget(kindResp);
ok('pickActiveTarget 会带回这次签到要什么（普通+可附照片）',
  pickedKind.kind.key === 'plain' && pickedKind.kind.needsPhoto === true, pickedKind.kind);
ok('解析活动时保留 otherId / activeSort / ifphoto',
  CXL.extractActivities(kindResp)[0].activeSort === 3 && CXL.extractActivities(kindResp)[0].ifphoto === 1);

ok('正常 jpg 通过校验', CXL.validatePhoto({ size: 200 * 1024, type: 'image/jpeg', name: 'a.jpg' }).ok);
ok('空文件被拒', !CXL.validatePhoto({ size: 0, type: 'image/jpeg' }).ok);
ok('超过 10MB 被拒', !CXL.validatePhoto({ size: 11 * 1024 * 1024, type: 'image/jpeg' }).ok);
ok('非图片类型被拒', !CXL.validatePhoto({ size: 1000, type: 'application/pdf', name: 'a.pdf' }).ok);
ok('没有 MIME 时按扩展名兜底',
  CXL.validatePhoto({ size: 1000, type: '', name: 'photo.PNG' }).ok &&
  !CXL.validatePhoto({ size: 1000, type: '', name: 'notes.txt' }).ok);
ok('文件名补全扩展名',
  CXL.photoFileName('IMG_0001', 'image/png') === 'photo.png' &&
  CXL.photoFileName('IMG_0001.JPG', '') === 'IMG_0001.JPG');

ok('取令牌地址正确', CXL.buildPanTokenUrl() === 'https://pan-yz.chaoxing.com/api/token/uservalid');
ok('上传地址正确', CXL.buildPanUploadUrl() === 'https://pan-yz.chaoxing.com/upload');
ok('objectid 取值兼容大小写与嵌套',
  CXL.pickObjectId({ objectid: 'abc123' }) === 'abc123' &&
  CXL.pickObjectId({ objectId: 'x9' }) === 'x9' &&
  CXL.pickObjectId({ data: { objectid: 'n1' } }) === 'n1' &&
  CXL.pickObjectId({}) === '');

// ---------------------------------------------------------------------------
// 1.7 提交参数：位置 vs 拍照
// ---------------------------------------------------------------------------

section('1.7) 提交参数（位置 / 拍照）');

const locMap = Object.fromEntries(CXL.buildSignParams({
  activeId: '1', uid: '2', fid: '3', lat: 30.5, lon: 120.5, datum: 'gcj02', address: '某大学', kind: 'location'
}));
ok('位置签到带 address / ifTiJiao', locMap.address === '某大学' && locMap.ifTiJiao === '1');
ok('位置签到带经纬度', locMap.latitude === '30.500000' && locMap.longitude === '120.500000');
ok('位置签到走 POST（与页面一致）', CXL.signUsesPost({ kind: 'location' }) === true);
ok('POST 表单里没有 useragent（照官方页面）', locMap.useragent === undefined);
ok('GET（纯普通）才带 useragent',
  Object.fromEntries(CXL.buildSignParams({ activeId: '1', kind: 'plain' })).useragent === '');

const photoMap = Object.fromEntries(CXL.buildSignParams({ activeId: '1', uid: '2', fid: '3', objectId: 'OBJ9', kind: 'photo' }));
ok('拍照签到带 objectId', photoMap.objectId === 'OBJ9');ok('拍照签到没选点时不乱发坐标（-1 是有定义的默认值）',
  photoMap.latitude === '-1.000000' && photoMap.longitude === '-1.000000');
ok('拍照签到不夹带位置专用字段', photoMap.address === undefined && photoMap.ifTiJiao === undefined);
ok('objectId 为空时不发这个字段',
  Object.fromEntries(CXL.buildSignParams({ activeId: '1', kind: 'photo' })).objectId === undefined);
ok('两者共用同一个提交接口',
  CXL.buildSignUrl({ activeId: '1', kind: 'photo', objectId: 'OBJ9' }).indexOf('/pptSign/stuSignajax?') > 0);
ok('courseId 会被带上（服务端要用）',
  Object.fromEntries(CXL.buildSignParams({ activeId: '1', courseId: '268194985', kind: 'photo' })).courseId === '268194985');

// --- 拍照提交：按公开可用实现的"极简参数 + GET"（PCR007 那次的修法）---
const photoPairs2 = CXL.buildPhotoSignParams({
  activeId: '4000175553141', uid: '342160606', fid: '135774',
  objectId: 'OBJ9', name: '张三', courseId: '268194985', deviceCode: 'x', validate: 'y'
});
const photoMap2 = Object.fromEntries(photoPairs2);
ok('拍照提交只发 9 个参数（照公开可用实现）', photoPairs2.length === 9, photoPairs2.map((kv) => kv[0]));
ok('这 9 个就是参考实现那一组',
  ['activeId', 'uid', 'clientip', 'latitude', 'longitude', 'appType', 'fid', 'objectId', 'name']
    .every((k) => k in photoMap2), Object.keys(photoMap2));
ok('拍照不带 courseId / deviceCode / validate（多带会被判参数不符）',
  photoMap2.courseId === undefined && photoMap2.deviceCode === undefined && photoMap2.validate === undefined);
ok('拍照不带位置专用字段', photoMap2.address === undefined && photoMap2.ifTiJiao === undefined);
ok('拍照坐标按官方页面填 -1', photoMap2.latitude === '-1' && photoMap2.longitude === '-1');
ok('拍照带上 objectId 与姓名', photoMap2.objectId === 'OBJ9' && photoMap2.name === '张三');

// --- 普通签到：8 个参数、不带 objectId（"活动名叫普通签到"那种情况用这个）---
const plainPairs = CXL.buildPlainSignParams({
  activeId: '2000175731144', uid: '342160606', fid: '135774', name: '张三',
  objectId: 'SHOULD_BE_IGNORED', courseId: '268194985'
});
const plainMap = Object.fromEntries(plainPairs);
ok('普通签到只发 8 个参数', plainPairs.length === 8, plainPairs.map((kv) => kv[0]));
ok('普通签到的 8 个字段与参考实现 signNormal 一致',
  ['activeId', 'uid', 'clientip', 'latitude', 'longitude', 'appType', 'fid', 'name']
    .every((k) => k in plainMap), Object.keys(plainMap));
ok('普通签到不带 objectId（带了会被判拍照校验失败）', plainMap.objectId === undefined);
ok('普通签到带姓名', plainMap.name === '张三');
ok('普通签到地址不带 objectId',
  CXL.buildPlainSignUrl({ activeId: '1', objectId: 'X' }).indexOf('objectId') < 0);

// --- 附加参数：确认了某个字段形状后可以直接粘进来用 ---
ok('附加参数支持 key=value&key=value',
  JSON.stringify(CXL.parseExtraParams('photoResult=abc&foo=1')) === '[["photoResult","abc"],["foo","1"]]',
  CXL.parseExtraParams('photoResult=abc&foo=1'));
ok('附加参数支持 JSON 对象',
  JSON.stringify(CXL.parseExtraParams('{"photoResult":"abc"}')) === '[["photoResult","abc"]]',
  CXL.parseExtraParams('{"photoResult":"abc"}'));
ok('附加参数支持换行分隔',
  CXL.parseExtraParams('a=1\nb=2').length === 2, CXL.parseExtraParams('a=1\nb=2'));
ok('附加参数能保留带 = 的值',
  CXL.parseExtraParams('photoResult=a=b').length === 1 &&
  CXL.parseExtraParams('photoResult=a=b')[0][1] === 'a=b');
ok('空/无等号的附加参数返回空数组',
  CXL.parseExtraParams('').length === 0 && CXL.parseExtraParams('乱写').length === 0);
ok('附加参数编码后可用',
  CXL.encodeSignParams(CXL.parseExtraParams('photoResult=1')) === 'photoResult=1');

// ---------------------------------------------------------------------------
// 2. injected.js：定位劫持 + 请求参数改写
// ---------------------------------------------------------------------------

section('2) injected.js 定位劫持与参数改写');

const injectedSource = fs.readFileSync(path.join(srcDir, 'injected.js'), 'utf8');

function makePage(url) {
  const listeners = {};
  const ctx = {
    console: { log() {}, warn() {} },
    setTimeout,
    setInterval,
    clearInterval,
    Date,
    Math,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Error,
    RegExp,
    Map,
    Promise,
    parseFloat,
    parseInt,
    isNaN,
    Request: class Request {
      constructor(u, i) { this.url = u; Object.assign(this, i || {}); }
    },
    document: {
      currentScript: { dataset: { cxlConfig: JSON.stringify({ enabled: true, spoofGeo: true, spoofTiles: true, datum: 'gcj02', point: { lat: 30.5, lon: 120.5 } }) } },
      createElement: () => ({ dataset: {} })
    },
    performance: { now: () => Date.now() },
    navigator: {
      geolocation: {
        getCurrentPosition(success, error) { this.__orig = true; success && success({ coords: { latitude: 1, longitude: 2 } }); },
        watchPosition() { return 1; },
        clearWatch() {}
      }
    },
    XMLHttpRequest: function XMLHttpRequest() {},
    Image: class Image {},
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    postMessage(msg) { (ctx.__messages = ctx.__messages || []).push(msg); },
    fetch: function fetch(input) { ctx.__lastFetch = input; return Promise.resolve({}); },
    location: { href: url },
    __messages: [],
    __listeners: listeners
  };
  ctx.globalThis = ctx;
  ctx.window = ctx;
  ctx.__CXL_DEBUG_HOOKS = true;
  ctx.XMLHttpRequest.prototype = { open() {}, send() {} };
  vm.createContext(ctx);
  vm.runInContext(injectedSource, ctx);
  return ctx;
}

const page = makePage('https://mobilelearn.chaoxing.com/page/active/active?activeId=123456');
const proto = page.XMLHttpRequest.prototype;

// geolocation 劫持
let got = null;
page.navigator.geolocation.getCurrentPosition((pos) => { got = pos; });
await new Promise((r) => setTimeout(r, 120));
ok('getCurrentPosition 被劫持并返回选点', !!got && got.coords.latitude === 30.5 && got.coords.longitude === 120.5, got && got.coords);

/**
 * 模拟真实 XHR 调用：
 * 实例沿原型链拿到钩子 open / send，钩子改写 URL 后通过实例上的 __cxlRealOpen
 * 调底层实现；这里用假的底层实现捕捉最终参数，并可触发 load 事件模拟响应。
 */
function makeFakeXhr(ctx) {
  const p = ctx.XMLHttpRequest.prototype;
  const fake = Object.create(p);
  fake.__captured = null;
  fake.__listeners = {};
  fake.__cxlRealOpen = function (m, u) { fake.__captured = u; };
  fake.__cxlRealSend = function (b) { fake.__capturedBody = b; };
  fake.addEventListener = function (type, fn) { fake.__listeners[type] = fn; };
  fake.fire = function (status, responseText) {
    fake.status = status;
    fake.responseText = responseText;
    if (fake.__listeners.load) fake.__listeners.load();
  };
  return fake;
}

function captureXhrOpen(ctx, url) {
  const fake = makeFakeXhr(ctx);
  fake.open('GET', url);
  return fake.__captured;
}

function captureXhrSend(ctx, body) {
  const fake = makeFakeXhr(ctx);
  fake.send(body);
  return fake.__capturedBody;
}

/** 走完 open → send → load，返回该上下文录到的网络活动 */
function recordXhr(ctx, method, url, body, status, responseText) {
  const fake = makeFakeXhr(ctx);
  fake.open(method, url);
  fake.send(body);
  fake.fire(status, responseText);
  return (ctx.__messages || []).filter((m) => m.type === 'net');
}

const signUrl =
  'https://mobilelearn.chaoxing.com/pptSign/stuSignajax?name=%E5%BC%A0%E4%B8%89&address=x&activeId=123456&uid=999&clientip=&latitude=39.908722&longitude=116.397499&fid=1403&appType=15&ifTiJiao=1';

const openedUrl = captureXhrOpen(page, signUrl);
ok('XHR 钩子确实安装到原型上', page.XMLHttpRequest.prototype.__cxlPatched === true);
ok('XHR 请求里的 latitude 被改写', /latitude=30\.5/.test(openedUrl || ''), openedUrl && openedUrl.slice(0, 170));
ok('XHR 请求里的 longitude 被改写', /longitude=120\.5/.test(openedUrl || ''), openedUrl && openedUrl.slice(0, 170));
ok('XHR 改写保留其他参数（address/activeId/uid）', /address=x/.test(openedUrl) && /activeId=123456/.test(openedUrl) && /uid=999/.test(openedUrl));

// XHR body 改写（表单）
const sentBody = captureXhrSend(page, 'address=x&activeId=1&uid=9&latitude=39.9&longitude=116.4&ifTiJiao=1');
ok('XHR 表单 body 里的经纬度被改写', /latitude=30\.500000/.test(sentBody || '') && /longitude=120\.500000/.test(sentBody || ''), sentBody);

// 上报消息
const reports = page.__messages || [];
ok('回传了 request 事件（供 UI 抓 activeId）', reports.some((m) => m.type === 'request' && /stuSignajax/.test(m.payload.url)));
ok('回传了 rewrite 事件', reports.some((m) => m.type === 'rewrite'));
ok('回传了 geo 事件', reports.some((m) => m.type === 'geo'));

// 关闭开关后不应改写
const offPage = makePage('https://i.chaoxing.com/base');
offPage.__listeners['cxl:config'][0]({ detail: { enabled: false } });
const openedUrl3 = captureXhrOpen(offPage, signUrl);
ok('关闭开关后不再改写请求', /latitude=39\.908722/.test(openedUrl3 || ''), openedUrl3 && openedUrl3.slice(0, 140));
let got3 = null;
offPage.navigator.geolocation.getCurrentPosition((p) => { got3 = p; });
await new Promise((r) => setTimeout(r, 60));
ok('关闭开关后回退到原生定位', !!got3 && got3.coords.latitude === 1);

// WGS-84 输入应换算成 GCJ-02 再提交（与 lib.js 的实现交叉验证）
const wgsPage = makePage('https://i.chaoxing.com/base');
wgsPage.__listeners['cxl:config'][0]({ detail: { datum: 'wgs84', point: { lat: 39.908722, lon: 116.397499 }, enabled: true, spoofTiles: true } });
const openedUrl4 = captureXhrOpen(wgsPage, signUrl) || '';
const mLat = openedUrl4.match(/latitude=([\d.]+)/);
const mLon = openedUrl4.match(/longitude=([\d.]+)/);
const expectGcj = CXL.wgs84ToGcj02(39.908722, 116.397499);
ok('WGS-84 选点在请求中被换算为 GCJ-02', !!mLat && near(parseFloat(mLat[1]), expectGcj[0], 1e-6) && near(parseFloat(mLon[1]), expectGcj[1], 1e-6), [mLat && mLat[1], mLon && mLon[1], expectGcj]);

// ---- 网络录制：从页面响应里找 activeId（网页版不给签到入口时的关键路径）----
const recPage = makePage('https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?courseid=1');
recPage.__listeners['cxl:config'][0]({ detail: { token: 't1', enabled: true, record: true, spoofTiles: true, point: { lat: 30.5, lon: 120.5 } } });
const netMsgs = recordXhr(
  recPage, 'POST',
  'https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/active/list?courseid=268195115',
  'courseid=268195115&clazzid=157462462',
  200,
  '{"data":{"activeList":[{"activePrimaryId":987654321,"name":"位置签到","otherId":4}]}}'
);
ok('网络活动被录制下来', netMsgs.length === 1, netMsgs.length);
ok('录到了 URL 与状态码', netMsgs[0] && /active\/list/.test(netMsgs[0].payload.url) && netMsgs[0].payload.status === 200);
ok('录到了响应体（用于事后分析）', netMsgs[0] && /activePrimaryId/.test(netMsgs[0].payload.resp || ''));
const idMsg = (recPage.__messages || []).find((m) => m.type === 'activeId');
ok('从响应里识别出 activeId 并单独上报', !!idMsg && idMsg.payload.activeId === '987654321', idMsg && idMsg.payload);

// 时间戳 / enc 这类长数字不能被误当成 activeId
const recPage2 = makePage('https://mooc2-ans.chaoxing.com/x');
recPage2.__listeners['cxl:config'][0]({ detail: { token: 't2', record: true } });
recordXhr(recPage2, 'GET', 'https://mooc2-ans.chaoxing.com/a?t=1792076091993&enc=bbd5ad9bc17ad5b20a92ada8a97e8369', '', 200, '{"t":1792076091993}');
ok('时间戳/enc 不会被误认成 activeId', !(recPage2.__messages || []).some((m) => m.type === 'activeId'));

// record 关闭时不录制
const recPage3 = makePage('https://mooc2-ans.chaoxing.com/x');
recPage3.__listeners['cxl:config'][0]({ detail: { token: 't3', record: false } });
const offMsgs = recordXhr(recPage3, 'GET', 'https://mooc2-ans.chaoxing.com/a?activeId=987654321', '', 200, '{}');
ok('关闭录制开关后不再记录', offMsgs.length === 0, offMsgs.length);

// GCJ-02 输入应原样提交
const gcjPage = makePage('https://i.chaoxing.com/base');
gcjPage.__listeners['cxl:config'][0]({ detail: { datum: 'gcj02', point: { lat: 30.123456, lon: 120.654321 }, enabled: true, spoofTiles: true } });
const openedUrl5 = captureXhrOpen(gcjPage, signUrl) || '';
ok('GCJ-02 选点原样提交（不做二次偏移）', /latitude=30\.123456/.test(openedUrl5) && /longitude=120\.654321/.test(openedUrl5), openedUrl5.slice(0, 150));

// BD-09 输入也要换算成 GCJ-02（与 lib.js 的 buildSignUrl 保持一致）
const bdPage = makePage('https://i.chaoxing.com/base');
bdPage.__listeners['cxl:config'][0]({ detail: { datum: 'bd09', point: { lat: 30.5, lon: 120.5 }, enabled: true, spoofTiles: true } });
const openedUrl6 = captureXhrOpen(bdPage, signUrl) || '';
const bdExpect = CXL.bd09ToGcj02(30.5, 120.5);
const bdLat = openedUrl6.match(/latitude=([\d.]+)/);
ok('BD-09 选点在请求中被换算为 GCJ-02（与直接签到一致）',
  !!bdLat && near(parseFloat(bdLat[1]), bdExpect[0], 1e-6), [bdLat && bdLat[1], bdExpect[0]]);

// 令牌校验：伪造的/过期的 token 必须被内容脚本拒绝
ok('主世界回传带上了令牌', reports.every((m) => typeof m.token === 'string'));
ok('未设置令牌时回传的 token 为空串（内容脚本会拒绝）',
  reports.filter((m) => m.type === 'ready').every((m) => m.token === ''));
const tokPage = makePage('https://i.chaoxing.com/base');
tokPage.__listeners['cxl:config'][0]({ detail: { token: 'abc123', enabled: true, spoofTiles: true, point: { lat: 30.5, lon: 120.5 } } });
captureXhrOpen(tokPage, signUrl);   // 触发一条 request 回传
const tokMsg = (tokPage.__messages || []).filter((m) => m.type === 'request').pop();
ok('设置令牌后回传里带上该令牌', !!tokMsg && tokMsg.token === 'abc123', tokMsg && tokMsg.token);

// ---------------------------------------------------------------------------
// 2.5 content.js：面板自己把 activeId 要回来的完整链路
// ---------------------------------------------------------------------------

section('2.5) content.js 自动获取 activeId 的链路');

const contentSource = fs.readFileSync(path.join(srcDir, 'content.js'), 'utf8');

/**
 * 用最小的 DOM / chrome 桩把 content.js 真的跑起来：
 * 只 stub 到"能建出面板、能发消息"为止，然后用假的后台响应驱动自动获取流程。
 * 目的是验证"地址 -> 消息参数 -> 采纳结果 -> 输入框/状态"这一整条线真的接上了，
 * 而不是只验证两个函数各自正确。
 */
function makeContentHarness(opts) {
  opts = opts || {};
  const sent = [];
  const replies = opts.replies || [];
  let replyIndex = 0;
  const FAKE_B64 = 'ZmFrZQ==';

  const elems = {};
  const created = [];            // 所有建出来的元素（含未挂进 ui 的）
  const readFiles = [];          // 通过 FileReader 读过的"文件"，用来断言真的走了选图→读图
  const elementValues = {};      // 输入框收到的所有赋值（历史），用来断言"自动填进面板了"
  let inputSeq = 0;
  const noop = () => {};
  const makeCtx2d = () => ({
    setTransform: noop, clearRect: noop, fillRect: noop, drawImage: noop,
    beginPath: noop, moveTo: noop, lineTo: noop, stroke: noop, fill: noop,
    fillText: noop, save: noop, restore: noop, translate: noop, scale: noop,
    getImageData: () => ({ data: [0, 0, 0, 0] }), putImageData: noop,
    createLinearGradient: () => ({ addColorStop: noop })
  });
  const makeEl = (tag) => {
    const node = {
      tagName: String(tag).toUpperCase(),
      __tag: String(tag).toLowerCase(),
      style: { cssText: '' },
      dataset: {},
      children: [],
      attributes: {},
      value: '',
      textContent: '',
      innerHTML: '',
      title: '',
      className: '',
      // 模拟 classList：content.js 用 add/remove 切换拖放高亮
      classList: (() => {
        const set = new Set();
        return {
          add: (c) => set.add(c),
          remove: (c) => set.delete(c),
          contains: (c) => set.has(c),
          toString: () => [...set].join(' ')
        };
      })(),
      width: 0,
      height: 0,
      clientWidth: 400,
      clientHeight: 268,
      setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'class') this.className = String(v); },
      getAttribute(k) { return this.attributes[k] === undefined ? null : this.attributes[k]; },
      hasAttribute(k) {
        if (k === 'class') return !!(this.className || (this.classList && String(this.classList)));
        return this.attributes[k] !== undefined;
      },
      removeAttribute(k) { delete this.attributes[k]; },
      appendChild(c) { this.children.push(c); return c; },
      // 真实 DOM 里 contains 会沿树往下找；dragleave 的判定依赖它，桩也要照做
      contains(n) {
        if (n === this) return true;
        return this.children.some((c) => c && typeof c.contains === 'function' && c.contains(n));
      },
      remove() {},
      addEventListener(type, fn) {
        this.__listeners = this.__listeners || {};
        (this.__listeners[type] = this.__listeners[type] || []).push(fn);
      },
      removeEventListener() {},
      attachShadow() { return harness.shadow; },
      getContext() { return makeCtx2d(); },
      setPointerCapture() {},
      releasePointerCapture() {},
      getBoundingClientRect() {
        // 面板没展开时真实浏览器给的是 0×0，这里的桩也照这个来（拖放兜底会据此判断落点）
        if (this.hasAttribute('hidden')) return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
        if (this.className && String(this.className).indexOf('panel') >= 0) {
          return { width: 400, height: 500, top: 100, left: 600, right: 1000, bottom: 600 };
        }
        return { width: 400, height: 268, top: 100, left: 600, right: 1000, bottom: 368 };
      },
      querySelectorAll() { return []; },
      focus() {},
      select() {},
      click() {}
    };
    // 记录输入框收到的每一次赋值（content.js 会把识别到的 activeId 写进 input.value），
    // 同一个输入框会被多次赋值，所以这里记历史而不是只记最后的值
    if (node.__tag === 'input' || node.__tag === 'textarea') {
      let v = '';
      Object.defineProperty(node, 'value', {
        get() { return v; },
        set(nv) { v = nv; elementValues['#' + (++inputSeq)] = String(nv); }
      });
    }
    if (node.__tag === 'input' && String(tag).toLowerCase() === 'input') created.push(node);
    return node;
  };

  const harness = {
    shadow: { appendChild() {}, removeChild() {} },
    __docListeners: {},
    document: {
      documentElement: {
        innerHTML: '<html><body>课程页面</body></html>',
        appendChild() {},
        // 打上测试标记：content.js 据此把内部把手（ui/runtime）暴露给 selftest
        hasAttribute: (n) => n === 'data-cxl-test',
        removeAttribute() {}
      },
      body: { innerText: '课程页面 签到', appendChild() {}, contains() { return true; } },
      head: { appendChild() {} },
      cookie: '_uid=342160606; fid=135774',
      createElement: makeEl,
      getElementById() { return null; },
      querySelectorAll() { return []; },
      // 记录 document 上注册的监听（拖放兜底就走这里，测试要能触发它们）
      addEventListener(type, fn) {
        (harness.__docListeners[type] = harness.__docListeners[type] || []).push(fn);
      },
      execCommand() { return true; }
    },
    location: { href: opts.url || 'https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?courseid=268194985&clazzid=157462133&cpi=493989176' },
    navigator: { clipboard: { writeText() { return Promise.resolve(); } } },
    chrome: {
      runtime: {
        lastError: undefined,
        getURL(p) { return 'chrome-extension://test/' + p; },
        getManifest() { return { version: '1.0.0' }; },
        sendMessage(msg, cb) {
          sent.push(msg);
          // 支持两种写法：数组（按顺序依次回，兼容老测试）或 { 消息类型: 回复 }
          let r;
          if (Array.isArray(replies)) r = replies[Math.min(replyIndex, replies.length - 1)];
          else r = replies[msg && msg.type];
          replyIndex++;
          if (cb) cb(typeof r === 'function' ? r(msg) : r);
        },
        onMessage: { addListener() {} }
      },
      storage: {
        local: { get(k, cb) { cb({}); }, set(o, cb) { if (cb) cb(); } },
        onChanged: { addListener() {} }
      }
    },
    CXL: null,            // 下面注入真的 lib.js / map.js 导出
    __sent: sent,
    setTimeout,
    clearTimeout,
    setInterval() { return 1; },        // 周期任务在测试里不跑，避免测试结束后还挂着定时器
    clearInterval() {},
    requestAnimationFrame() { return 1; },
    cancelAnimationFrame() {},
    devicePixelRatio: 1,
    Image: class Image {
      constructor() { this.onload = null; this.onerror = null; }
      set src(v) { this.__src = v; }
      get src() { return this.__src; }
    },
    // 选图流程要用：content.js 把 File 读成 dataURL 再交给后台
    FileReader: class FileReader {
      readAsDataURL(file) {
        readFiles.push({ name: file && file.name, size: file && file.size, type: file && file.type });
        this.result = 'data:' + ((file && file.type) || 'image/jpeg') + ';base64,' + FAKE_B64;
        if (this.onload) this.onload();
      }
    },
    Date, Math, JSON, Object, Array, String, Number, Boolean, Error, RegExp, Map, Promise, Set,
    parseFloat, parseInt, isNaN, Uint8Array,
    crypto: { getRandomValues(a) { for (let i = 0; i < a.length; i++) a[i] = i; return a; } }
  };
  harness.window = harness;
  harness.globalThis = harness;
  harness.top = harness;
  // 注意：这些 __ 开头的字段要往沙箱里再赋一次，
  // 因为 vm.createContext 之后外面手里的 harness 已经不是沙箱里那个全局对象了
  const expose = function () {
    harness.__created = created;
    harness.__readFiles = readFiles;
    harness.__replies = replies;
  };
  expose();
  harness.__custom = [];
  harness.__elements = elementValues;
  harness.addEventListener = function (type, fn) {
    harness.__listeners = harness.__listeners || {};
    (harness.__listeners[type] = harness.__listeners[type] || []).push(fn);
  };
  harness.dispatchEvent = function (ev) {
    harness.__custom.push(ev);
    const l = (harness.__listeners || {})[ev.type] || [];
    for (const fn of l) fn(ev);
    return true;
  };
  harness.CustomEvent = class CustomEvent {
    constructor(type, init) { this.type = type; this.detail = (init || {}).detail; }
  };

  // lib.js / map.js 跑在自己的一层全局里（map.js 建 canvas 用的是自己闭包里的 document），
  // content.js 跑在另一层，两者通过 CXL 这个对象互通——和浏览器里的真实关系一致。
  const libGlobals = {
    document: harness.document,
    window: null,
    Image: harness.Image,
    requestAnimationFrame: harness.requestAnimationFrame,
    cancelAnimationFrame: harness.cancelAnimationFrame,
    addEventListener() {},
    removeEventListener() {},
    devicePixelRatio: 1,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON, Object, Array, String, Number, Boolean, Error, RegExp, Map, Promise, Set,
    parseFloat, parseInt, isNaN,
    chrome: harness.chrome
  };
  libGlobals.globalThis = libGlobals;
  libGlobals.window = libGlobals;
  vm.createContext(libGlobals);
  vm.runInContext(libSource, libGlobals);
  vm.runInContext(mapSource, libGlobals);
  harness.CXL = libGlobals.CXL;

  vm.createContext(harness);
  vm.runInContext(contentSource, harness);
  // 面板是 boot() 里异步建起来的，所以这里给的是"取值函数"而不是当时的值；
  // runtime 在闭包里拿不到，内容脚本在测试模式下会把它一起挂到 __CXL_TEST_HANDLES__
  harness.__ui = vm.runInContext(`({
    handles: function () { return window.__CXL_TEST_HANDLES__; },
    signBtn: function () { var h = window.__CXL_TEST_HANDLES__; return h && h.ui.signBtn; },
    fileInput: function () { var h = window.__CXL_TEST_HANDLES__; return h && h.ui.photoFile; },
    drop: function () { var h = window.__CXL_TEST_HANDLES__; return h && h.ui.photoDrop; },
    panel: function () { var h = window.__CXL_TEST_HANDLES__; return h && h.ui.panel; },
    status: function () { var h = window.__CXL_TEST_HANDLES__; return h && h.ui.status; },
    mode: function () { var h = window.__CXL_TEST_HANDLES__; return h && h.runtime.mode; },
    photo: function () { var h = window.__CXL_TEST_HANDLES__; return h && h.runtime.photo; },
    openPanel: function () { window.__CXL_TEST_HANDLES__.openPanel(); }
  })`, harness);
  return harness;
}

/** 触发元素上注册的某个事件（测试里代替真实点击/选择） */
function fire(node, type, ev) {
  const ls = (node && node.__listeners && node.__listeners[type]) || [];
  ls.forEach((fn) => fn(ev || { preventDefault() {}, dataTransfer: null, clipboardData: null }));
  return ls.length;
}

/** 触发 document 上注册的事件（拖放兜底走的是 document 级监听） */
function fireDoc(h, type, ev) {
  const ls = (h.__docListeners && h.__docListeners[type]) || [];
  ls.forEach((fn) => fn(ev));
  return ls.length;
}

process.on('unhandledRejection', (e) => {
  fail++;
  console.log('  ✗ content.js 里出现未处理的异步异常：' + (e && e.message ? e.message : String(e)));
  if (e && e.stack) console.log(String(e.stack).split('\n').slice(1, 5).join('\n'));
});

const lookupReply = {
  ok: true, activeId: '4000175553141', name: '位置签到', label: '进行中',
  signType: 4, activityCount: 3, uid: '342160606', fid: '135774'
};
// boot() 里要等 storage 回调、建面板、注入脚本，所以放一小会儿再断言
const settle = () => new Promise((r) => setTimeout(r, 400));

const ch = makeContentHarness({ replies: [lookupReply] });
await settle();
const firstLookup = ch.__sent.find((m) => m.type === 'lookupActiveId');
ok('面板挂载后会自动发消息去取 activeId', !!firstLookup, ch.__sent.map((m) => m.type));
ok('消息里带上课程 / 班级编号（来自页面地址）',
  !!firstLookup && firstLookup.courseId === '268194985' && firstLookup.classId === '157462133',
  firstLookup && { courseId: firstLookup.courseId, classId: firstLookup.classId });
ok('消息里带上 uid（后台提交签到要用）', !!firstLookup && firstLookup.uid === '342160606', firstLookup && firstLookup.uid);
ok('消息里带上当前页面地址（后台用它做 Referer）',
  !!firstLookup && /courseid=268194985/.test(firstLookup.url || ''), firstLookup && firstLookup.url);
ok('自动查询期间不会误发签到请求（只有查编号 + 报课程给自动签到引擎）',
  ch.__sent.every((m) => m.type === 'lookupActiveId' || m.type === 'autoTarget'),
  ch.__sent.map((m) => m.type));
ok('把课程/班级报给后台（自动签到要在没人开页面时自己找活动）',
  ch.__sent.some((m) => m.type === 'autoTarget' && m.target &&
    m.target.courseId === '268194985' && m.target.classId === '157462133'),
  ch.__sent.filter((m) => m.type === 'autoTarget'));
ok('查询用的地址就是官方活动列表接口',
  !!firstLookup && CXL.buildActiveListUrl({ courseId: firstLookup.courseId, classId: firstLookup.classId, fid: firstLookup.fid })
    .startsWith('https://mobilelearn.chaoxing.com/v2/apis/active/student/activelist'));
ok('后台查到的 activeId 被填进面板（输入框里能看到）',
  Object.values(ch.__elements || {}).includes('4000175553141'),
  Object.values(ch.__elements || {}));

// 主世界回传的 activeId（页面自己的签到请求里抓到的）也要能填进面板
const ch5 = makeContentHarness({ replies: [lookupReply] });
await settle();                                    // 先让面板挂上（ui 建好），再模拟页面回传
const tokenEv = (ch5.__custom || []).find((e) => e.type === 'cxl:config' && e.detail && e.detail.token);
const msgListener = (ch5.__listeners.message || [])[0];
ok('内容脚本注册了主世界回传监听', typeof msgListener === 'function' && !!tokenEv);
msgListener({
  // 真实浏览器里 e.source 就是本窗口；沙箱外拿到的引用和沙箱里的 window 不是同一个对象，
  // 所以从沙箱内部取一次（vm.runInContext('window') 返回的是沙箱自己认得的那个）
  source: vm.runInContext('window', ch5),
  data: {
    __cxl: 'cxl:report',
    token: tokenEv && tokenEv.detail.token,
    type: 'request',
    payload: { url: 'https://mobilelearn.chaoxing.com/pptSign/stusignajax?activeId=4000175553999&uid=342160606' }
  }
});
ok('已经拿到活动列表里的编号后，页面里嗅到的编号不会把它冲掉',
  Object.values(ch5.__elements || {}).includes('4000175553141'),
  Object.values(ch5.__elements || {}));

// 干净场景：面板刚建好、页面自己发了签到请求 —— 这时应当采纳页面里的编号
const ch7 = makeContentHarness({ replies: [{ ok: false, error: '（测试桩）不返回活动' }] });
const tokenEv7 = (ch7.__custom || []).find((e) => e.type === 'cxl:config' && e.detail && e.detail.token);
const listener7 = (ch7.__listeners.message || [])[0];
listener7({
  source: null,                       // 不是本窗口 -> 必须被丢掉
  data: {
    __cxl: 'cxl:report', token: tokenEv7 && tokenEv7.detail.token, type: 'request',
    payload: { url: 'https://mobilelearn.chaoxing.com/pptSign/stusignajax?activeId=4000175553998' }
  }
});
listener7({
  source: vm.runInContext('window', ch7),
  data: {
    __cxl: 'cxl:report', token: tokenEv7 && tokenEv7.detail.token, type: 'request',
    payload: { url: 'https://mobilelearn.chaoxing.com/pptSign/stusignajax?activeId=4000175553999' }
  }
});
await settle();
ok('页面自己发过签到请求时，编号会被自动采纳（页面实测优先）',
  Object.values(ch7.__elements || {}).includes('4000175553999'), Object.values(ch7.__elements || {}));
ok('来源不是本窗口的回传被丢掉（别的窗口/页面脚本塞不进来）',
  !Object.values(ch7.__elements || {}).includes('4000175553998'), Object.values(ch7.__elements || {}));

// 伪造令牌的回传必须被丢掉（面板状态不能被页面脚本污染）
const ch6 = makeContentHarness({ replies: [lookupReply] });
await settle();
const before6 = Object.keys(ch6.__elements || {}).length;
const listener6 = (ch6.__listeners.message || [])[0];
listener6({
  source: vm.runInContext('window', ch6),
  data: {
    __cxl: 'cxl:report', token: 'forged', type: 'request',
    payload: { url: 'https://mobilelearn.chaoxing.com/pptSign/stusignajax?activeId=999999999' }
  }
});
ok('令牌不对的回传被忽略', !Object.values(ch6.__elements || {}).includes('999999999') &&
  Object.keys(ch6.__elements || {}).length === before6);

// 后台查不到（例如还没发布签到）时不能崩，也不能误报成功
const ch3 = makeContentHarness({ replies: [{ ok: false, error: '这个课程暂时没有任何活动记录' }] });
await settle();
ok('后台查询失败时链路不抛异常（面板照常工作）', ch3.__sent.some((m) => m.type === 'lookupActiveId'));

// 地址里没有课程编号时不该乱发请求
const ch4 = makeContentHarness({
  url: 'https://i.chaoxing.com/base',
  replies: [lookupReply]
});
await settle();
ok('地址里没有课程/班级编号时不会盲目请求活动列表',
  ch4.__sent.filter((m) => m.type === 'lookupActiveId').length === 0,
  ch4.__sent.map((m) => m.type));

// ---------------------------------------------------------------------------
// 2.6 content.js：拍照签到（选本地图片 -> 上传换 objectId -> 提交）
// ---------------------------------------------------------------------------

section('2.6) 拍照签到（本地图片提交 + 与位置签到合并）');

const photoReply = {
  ok: true, activeId: '4000175553141', name: '拍照签到', label: '进行中',
  kind: { key: 'photo', label: '拍照', needsPhoto: true, needsLocation: false },
  signType: 3, activityCount: 2, uid: '342160606', fid: '135774'
};
const uploadReply = { ok: true, objectId: 'OBJ-7788', size: 1024, name: 'photo.jpg', uid: '342160606' };

const chP = makeContentHarness({ replies: { lookupActiveId: photoReply, uploadPhoto: uploadReply, sign: { ok: true, message: 'success（测试桩）' } } });
await settle();

const signBtnP = chP.__ui.signBtn();
ok('面板建好了（能找到底部的提交按钮）', !!signBtnP);
ok('活动类型是拍照时，面板自动切到拍照模式', chP.__ui.mode() === 'photo', chP.__ui.mode());
ok('拍照活动也会自动获取 activeId', chP.__sent.some((m) => m.type === 'lookupActiveId'));

const fileInput = chP.__ui.fileInput();
ok('面板里有文件选择框（accept=image/*）',
  !!fileInput && /image/.test(fileInput.attributes.accept || ''), fileInput && fileInput.attributes);

// 模拟用户选了一张本地图片，然后点「直接签到」
fileInput.files = [{ name: 'IMG_0001.jpg', size: 2048, type: 'image/jpeg' }];
fire(fileInput, 'change');
fire(signBtnP, 'click');

ok('选图后真的把文件读成了 dataURL', (chP.__readFiles || []).length === 1, chP.__readFiles);
ok('读到的是用户选的那张图', (chP.__readFiles[0] || {}).name === 'IMG_0001.jpg');
ok('拍照模式下提交时会先自动上传图片',
  chP.__sent.some((m) => m.type === 'uploadPhoto'), chP.__sent.map((m) => m.type));
ok('上传消息里带上图片与 uid', (() => {
  const up = chP.__sent.find((m) => m.type === 'uploadPhoto');
  return !!up && /^data:image\/jpeg;base64,/.test(up.dataUrl || '') && up.uid === '342160606';
})(), chP.__sent.find((m) => m.type === 'uploadPhoto'));
ok('上传完成后同一个动作继续提交签到（用户只点一次）',
  chP.__sent.some((m) => m.type === 'sign'), chP.__sent.map((m) => m.type));
ok('提交的是拍照签到，并带上换来的 objectId', (() => {
  const s = chP.__sent.find((m) => m.type === 'sign');
  return !!s && s.payload.kind === 'photo' && s.payload.objectId === 'OBJ-7788';
})(), (chP.__sent.find((m) => m.type === 'sign') || {}).payload);
ok('拍照提交时不夹带位置签到的坐标', (() => {
  const s = chP.__sent.find((m) => m.type === 'sign');
  return !!s && s.payload.lat === undefined;
})());

// 再点一次签到：objectId 已缓存，不应该重复上传
const uploadsBefore = chP.__sent.filter((m) => m.type === 'uploadPhoto').length;
fire(signBtnP, 'click');
ok('objectId 已缓存，再点签到不会重复上传图片',
  chP.__sent.filter((m) => m.type === 'uploadPhoto').length === uploadsBefore,
  chP.__sent.filter((m) => m.type === 'uploadPhoto').length);

// 位置模式（默认）不应触发任何上传
const locReply = {
  ok: true, activeId: '4000175553000', name: '位置签到', label: '进行中',
  kind: { key: 'location', label: '位置', needsPhoto: false, needsLocation: true },
  signType: 4, uid: '342160606', fid: '135774'
};
const chL = makeContentHarness({ replies: [locReply] });
await settle();
ok('位置签到活动不会触发图片上传',
  chL.__sent.filter((m) => m.type === 'uploadPhoto').length === 0,
  chL.__sent.map((m) => m.type));
ok('位置活动仍然停在位置模式', chL.__ui.mode() === 'location', chL.__ui.mode());

// 位置签到没选点时必须拦住，并说明原因（不能发一个坐标为空的签到）
fire(chL.__ui.signBtn(), 'click');
ok('位置签到没选点时不发提交请求',
  chL.__sent.filter((m) => m.type === 'sign').length === 0,
  chL.__sent.map((m) => m.type));

// 用户手动切到拍照模式也该能走通（不依赖自动识别）
const chM = makeContentHarness({ replies: [locReply, uploadReply] });
await settle();
const dropEl = chM.__ui.drop();
fire(dropEl, 'drop', { preventDefault() {}, dataTransfer: { files: [{ name: 'x.png', size: 900, type: 'image/png' }] } });
ok('把图片拖到虚线框里能选上（框内拖放入口）', (chM.__readFiles || []).length === 1, chM.__readFiles);

// ---------------------------------------------------------------------------
// 2.7 拖放健壮性：整个面板都能接住 drop（之前"照片拖不进去"的回归测试）
// ---------------------------------------------------------------------------

section('2.7) 拖放健壮性（面板范围内都能接住）');

const chD = makeContentHarness({ replies: { lookupActiveId: photoReply, uploadPhoto: uploadReply } });
await settle();
chD.__ui.openPanel();                            // 面板打开（真实里用户点了悬浮按钮）
ok('面板打开后 __ui.panel 拿得到', !!chD.__ui.panel());

// 1) 在整个面板上 dragover（不是那个小方框）也要高亮 + 允许落点
const overPanel = {
  clientX: 800, clientY: 300, preventDefault() { overPanel.__prevented = true; },
  dataTransfer: { files: [], items: [], dropEffect: '' }
};
const handled = fireDoc(chD, 'dragover', overPanel);
ok('document 级接住了面板上的 dragover', handled > 0, handled);
ok('dragover 里调了 preventDefault（不调浏览器不会派发 drop）', overPanel.__prevented === true);
ok('拖到面板上时虚线框会高亮',
  chD.__ui.drop().classList.contains('over'), String(chD.__ui.drop().classList));

// 2) 鼠标滑过框内子元素触发的 dragleave 不能把高亮清掉（这是原来拖不进去的直接原因）
const innerChild = chD.__ui.drop().children[0];
ok('虚线框里确实有子元素（提示文字/缩略图）', !!innerChild);
fire(chD.__ui.drop(), 'dragleave', { relatedTarget: innerChild });
ok('鼠标划过框内子元素时高亮保持（原来的 bug 就在这）',
  chD.__ui.drop().classList.contains('over'), String(chD.__ui.drop().classList));

// 3) 在面板任意位置松手（不是那个小方框）也要收下图片
const dropOnPanel = {
  clientX: 700, clientY: 200, preventDefault() { dropOnPanel.__prevented = true; },
  dataTransfer: { files: [{ name: 'from-panel.png', size: 3000, type: 'image/png' }], items: [] }
};
fireDoc(chD, 'drop', dropOnPanel);
ok('在面板任意位置松手都会收下图片',
  (chD.__readFiles || []).length === 1 && chD.__readFiles[0].name === 'from-panel.png', chD.__readFiles);
ok('收下图片后高亮状态复位',
  !chD.__ui.drop().classList.contains('over'), String(chD.__ui.drop().classList));

// 4) 面板关着的时候不要插手页面的拖放
const chClosed = makeContentHarness({ replies: { lookupActiveId: photoReply } });
await settle();
const outsideEv = {
  clientX: 50, clientY: 50, preventDefault() { outsideEv.__prevented = true; },
  dataTransfer: { files: [{ name: 'z.png', size: 100, type: 'image/png' }], items: [] }
};
fireDoc(chClosed, 'drop', outsideEv);
ok('面板关闭时完全不接管 drop（不干扰页面自己的拖放）',
  outsideEv.__prevented !== true && (chClosed.__readFiles || []).length === 0,
  { prevented: outsideEv.__prevented, reads: chClosed.__readFiles });

// 5) 拖进来非图片文件时要给出明确提示，而不是静默失败
const chBad = makeContentHarness({ replies: { lookupActiveId: photoReply } });
await settle();
chBad.__ui.openPanel();
fireDoc(chBad, 'drop', {
  clientX: 800, clientY: 300, preventDefault() {},
  dataTransfer: { files: [{ name: 'a.pdf', size: 100, type: 'application/pdf' }], items: [] }
});
ok('拖进非图片文件时不会崩（给出提示）',
  (chBad.__readFiles || []).length === 0 && typeof chBad.__ui.status() === 'object');

// ---------------------------------------------------------------------------
// 2.8 background.js：服务端返回的翻译（不能把原始错误码直接甩给用户）
// ---------------------------------------------------------------------------

section('2.8) 服务端返回的翻译');

const bgSource = fs.readFileSync(path.join(srcDir, 'background.js'), 'utf8');
const bgSandbox = {
  console: { log() {}, warn() {}, error() {} },
  setTimeout, clearTimeout, setInterval, clearInterval,
  Date, Math, JSON, Object, Array, String, Number, Boolean, Error, RegExp, Map, Promise, Set,
  parseFloat, parseInt, isNaN, encodeURIComponent, decodeURIComponent,
  importScripts() {},                       // 已经手动喂了 lib.js
  chrome: {
    runtime: { onMessage: { addListener() {} }, lastError: undefined },
    cookies: { get: async () => null },
    tabs: { get(a, cb) { cb && cb(null); } },
    storage: { local: { get: (k, cb) => cb({}), set: (o, cb) => cb && cb() }, onChanged: { addListener() {} } },
    scripting: { executeScript() {} }
  }
};
bgSandbox.self = bgSandbox;
bgSandbox.globalThis = bgSandbox;
vm.createContext(bgSandbox);
vm.runInContext(libSource, bgSandbox);
vm.runInContext(bgSource, bgSandbox);
const explain = (text, status) => vm.runInContext('explainResponse', bgSandbox)(text, status || 200);

ok('success -> 成功', explain('success').ok === true);
ok('success2 -> 也算成功（但提示是补签）',
  explain('success2').ok === true && /截止/.test(explain('success2').message));
ok('"您已签到过了" -> 提示已签到', /已经签过/.test(explain('您已签到过了').message));
ok('空返回 -> 提示登录态/编号问题', /activeId/.test(explain('').message));
ok('未登录 -> 引导去登录', /i\.chaoxing\.com/.test(explain('请先登录再进行签到').message));
ok('超范围 -> 提示额外校验', /额外校验/.test(explain('validate').message));

// 这次实测遇到的那个错误码：必须翻译成人话，并给出两条可判断的可能
const pcr = explain('photoAuthError_PCR007');
ok('photoAuthError -> 翻译成人话（不再只甩错误码）',
  /服务端拒绝/.test(pcr.message) && /学习通 APP/.test(pcr.message), pcr.message);
ok('photoAuthError -> 抽出错误码并标记，方便面板另作处理',
  pcr.photoAuth === true && /PCR007/.test(pcr.message));
ok('photoAuthError -> 同时给出"参数不符"和"要现场拍照"两种可能',
  /参数不符合/.test(pcr.message) && /现场拍照/.test(pcr.message));

ok('[face] 类返回 -> 指向人脸活体，引导用 APP',
  explain('[face]活体协议验证不通过，请重新进入签到').needApp === true);
ok('二维码类返回 -> 说明 enc 拿不到',
  /enc/.test(explain('签到失败，请重新扫描').message));
ok('未知返回 -> 原样带出来，不吞掉', /某段没见过的返回/.test(explain('某段没见过的返回').message));

// ---------------------------------------------------------------------------
// 2.9 新插件「photo-sign-extension」：只做拍照签到的精简版
// ---------------------------------------------------------------------------

section('2.9) 精简版拍照签到插件（photo-sign-extension）');

const photoSrcDir = path.join(here, '..', 'photo-sign-extension', 'src');
const photoLibSource = fs.readFileSync(path.join(photoSrcDir, 'lib.js'), 'utf8');
const photoContentSource = fs.readFileSync(path.join(photoSrcDir, 'content.js'), 'utf8');

/**
 * 跑新插件的内容脚本：同样的 DOM/chrome 桩，但这次没有 map.js、没有坐标，
 * 面板只服务于"选图 -> 上传 -> 提交"这一条路。
 */
function makePhotoHarness(opts) {
  opts = opts || {};
  const sent = [];
  const created = [];
  const readFiles = [];
  const replies = opts.replies || {};
  const FAKE = 'ZmFrZQ==';
  const noop = () => {};

  // 假的 Blob（浏览器里是原生对象）
  class BlobDummy {
    constructor(parts, o) { this.size = 1234; this.type = (o && o.type) || 'image/jpeg'; }
  }

  // 假的视频流：getTracks().stop() 要能被观测到
  let streamStopped = false;
  const fakeStream = {
    getTracks() { return [{ stop() { streamStopped = true; } }]; }
  };

  const makeEl = (tag) => {
    const node = {
      tagName: String(tag).toUpperCase(),
      __tag: String(tag).toLowerCase(),
      style: { cssText: '' },
      dataset: {},
      children: [],
      attributes: {},
      textContent: '',
      innerHTML: '',
      title: '',
      className: '',
      hidden: false,
      width: 0, height: 0, clientWidth: 340, clientHeight: 400,
      classList: (() => {
        const set = new Set();
        return { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c), toString: () => [...set].join(' ') };
      })(),
      setAttribute(k, v) {
        this.attributes[k] = String(v);
        if (k === 'class') this.className = String(v);
        if (k === 'hidden') this.hidden = true;
      },
      getAttribute(k) { return this.attributes[k] === undefined ? null : this.attributes[k]; },
      hasAttribute(k) { return k === 'hidden' ? !!this.hidden : this.attributes[k] !== undefined; },
      removeAttribute(k) { delete this.attributes[k]; if (k === 'hidden') this.hidden = false; },
      appendChild(c) { this.children.push(c); return c; },
      contains(n) {
        if (n === this) return true;
        return this.children.some((c) => c && typeof c.contains === 'function' && c.contains(n));
      },
      remove() {},
      addEventListener(type, fn) {
        this.__listeners = this.__listeners || {};
        (this.__listeners[type] = this.__listeners[type] || []).push(fn);
      },
      removeEventListener() {},
      attachShadow() { return harness.shadow; },
      getBoundingClientRect() {
        if (this.hasAttribute('hidden')) return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
        if (this.className && String(this.className).indexOf('panel') >= 0) {
          return { width: 340, height: 500, top: 120, left: 640, right: 980, bottom: 620 };
        }
        return { width: 340, height: 200, top: 120, left: 640, right: 980, bottom: 320 };
      },
      // 摄像头路径要用的画布能力：抓一帧 -> toBlob
      getContext() { return { drawImage: () => {} }; },
      toBlob(cb) { cb(new BlobDummy()); },
      focus() {}, select() {}, click() {}
    };
    if (tag === 'input' || tag === 'textarea') {
      let v = '';
      Object.defineProperty(node, 'value', { get() { return v; }, set(nv) { v = nv; } });
    }
    // 真实 DOM 里给 textContent 赋值会清空子节点；桩也要照做，
    // 否则"重绘下拉列表"会累积出重复的 option
    let textVal = '';
    Object.defineProperty(node, 'textContent', {
      get() { return textVal; },
      set(nv) { textVal = String(nv); node.children.length = 0; }
    });
    if (tag === 'input') created.push(node);
    return node;
  };

  const harness = {
    shadow: { appendChild() {}, removeChild() {} },
    __docListeners: {},
    document: {
      documentElement: {
        innerHTML: '<html><body>课程页面</body></html>',
        appendChild() {},
        hasAttribute: (n) => n === 'data-cxl-test',
        removeAttribute() {}
      },
      body: { innerText: '课程页面 签到', appendChild() {}, contains: () => true },
      head: { appendChild() {} },
      cookie: '_uid=342160606; fid=135774',
      createElement: makeEl,
      getElementById: () => null,
      querySelectorAll: () => [],
      addEventListener(type, fn) { (harness.__docListeners[type] = harness.__docListeners[type] || []).push(fn); },
      execCommand: () => true
    },
    location: { href: opts.url || 'https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?courseid=268194985&clazzid=157462133&cpi=493989176' },
    // opts.camera=true 时装一个可用的 getUserMedia，否则不提供（测"不支持"分支）
    navigator: Object.assign(
      { clipboard: { writeText: () => Promise.resolve() } },
      opts.camera
        ? {
          mediaDevices: {
            getUserMedia() {
              harness.__cameraCalls = (harness.__cameraCalls || 0) + 1;
              return Promise.resolve(fakeStream);
            }
          }
        }
        : {}
    ),
    File: class File extends BlobDummy {
      constructor(parts, name, o) { super(parts, o); this.name = name; }
    },
    Blob: BlobDummy,
    chrome: {
      runtime: {
        lastError: undefined,
        getURL: (p) => p,
        getManifest: () => ({ version: '1.0.0' }),
        sendMessage(msg, cb) {
          sent.push(msg);
          const r = replies[msg && msg.type];
          if (cb) cb(typeof r === 'function' ? r(msg) : r);
        },
        onMessage: { addListener() {} }
      },
      storage: {
        local: { get: (k, cb) => cb({}), set: (o, cb) => cb && cb() },
        onChanged: { addListener() {} }
      }
    },
    setTimeout, clearTimeout,
    setInterval: () => 1, clearInterval: noop,
    requestAnimationFrame: () => 1, devicePixelRatio: 1,
    Image: class { },
    FileReader: class {
      readAsDataURL(file) {
        readFiles.push({ name: file && file.name, size: file && file.size, type: file && file.type });
        this.result = 'data:' + ((file && file.type) || 'image/jpeg') + ';base64,' + FAKE;
        if (this.onload) this.onload();
      }
    },
    Date, Math, JSON, Object, Array, String, Number, Boolean, Error, RegExp, Map, Promise, Set,
    parseFloat, parseInt, isNaN, Uint8Array, encodeURIComponent, decodeURIComponent,
    crypto: { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = i; return a; } }
  };
  harness.window = harness;
  harness.globalThis = harness;
  harness.top = harness;
  harness.__created = created;
  harness.__readFiles = readFiles;
  harness.__sent = sent;
  Object.defineProperty(harness, '__streamStopped', { get() { return streamStopped; } });
  Object.defineProperty(harness, '__cameraCalls', {
    get() { return harness.__cameraCallCount || 0; },
    set(v) { harness.__cameraCallCount = v; }
  });
  harness.addEventListener = noop;
  harness.dispatchEvent = () => true;
  harness.CustomEvent = class { constructor(t, i) { this.type = t; this.detail = (i || {}).detail; } };

  const libGlobals = {
    document: harness.document, Image: harness.Image, FileReader: harness.FileReader,
    addEventListener: noop, removeEventListener: noop,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON, Object, Array, String, Number, Boolean, Error, RegExp, Map, Promise, Set,
    parseFloat, parseInt, isNaN, chrome: harness.chrome
  };
  libGlobals.globalThis = libGlobals;
  libGlobals.window = libGlobals;
  vm.createContext(libGlobals);
  vm.runInContext(photoLibSource, libGlobals);
  harness.CXL = libGlobals.CXL;

  vm.createContext(harness);
  vm.runInContext(photoContentSource, harness);
  harness.__ui = vm.runInContext(`({
    h: function () { return window.__CXL_PHOTO_HANDLES__; },
    signBtn: function () { var x = window.__CXL_PHOTO_HANDLES__; return x && x.ui.signBtn; },
    plainBtn: function () { var x = window.__CXL_PHOTO_HANDLES__; return x && x.ui.plainBtn; },
    fileInput: function () { var x = window.__CXL_PHOTO_HANDLES__; return x && x.ui.file; },
    drop: function () { var x = window.__CXL_PHOTO_HANDLES__; return x && x.ui.drop; },
    status: function () { var x = window.__CXL_PHOTO_HANDLES__; return x && x.ui.status; },
    openPanel: function () { window.__CXL_PHOTO_HANDLES__.openPanel(); }
  })`, harness);
  return harness;
}

// 用真实的类型判定结果当夹具（而不是手搓对象），这样测的就是面板实际拿到的形状
const photoReplyNew = {
  ok: true, activeId: '4000175553141', name: '普通签到', label: '进行中',
  kind: CXL.detectSignKind({ activeSort: 3, ifphoto: 1, name: '普通签到' }),
  uid: '342160606', fid: '135774'
};
const uploadReplyNew = { ok: true, objectId: 'OBJ-9001', size: 2048, name: 'IMG.jpg', uid: '342160606' };

const ph = makePhotoHarness({
  replies: {
    lookupActiveId: photoReplyNew,
    uploadPhoto: uploadReplyNew,
    photoSign: { ok: true, message: '服务端返回 success（测试桩）', method: 'GET', url: 'https://mobilelearn.chaoxing.com/pptSign/stuSignajax?activeId=4000175553141' }
  }
});
await settle();
ok('精简版：面板建起来了', !!ph.__ui.signBtn());
ok('精简版：自动发起 activeId 查询', ph.__sent.some((m) => m.type === 'lookupActiveId'));
ok('精简版：拿到的 activeId 写进了面板状态',
  ph.__ui.h().st.activeId === '4000175553141', ph.__ui.h().st.activeId);

// 选图 -> 提交（一次点击走完上传 + 提交）
const phFile = ph.__ui.fileInput();
ok('精简版：有文件选择框', !!phFile && /image/.test(phFile.attributes.accept || ''));
phFile.files = [{ name: 'IMG_0007.jpg', size: 2048, type: 'image/jpeg' }];
fire(phFile, 'change');
ok('精简版：选图后读成 dataURL', (ph.__readFiles || []).length === 1, ph.__readFiles);

fire(ph.__ui.signBtn(), 'click');
ok('精简版：提交时先上传图片', ph.__sent.some((m) => m.type === 'uploadPhoto'), ph.__sent.map((m) => m.type));
ok('精简版：上传后继续提交（用户只点一次）', ph.__sent.some((m) => m.type === 'photoSign'), ph.__sent.map((m) => m.type));

const signMsg = ph.__sent.find((m) => m.type === 'photoSign');
ok('精简版：提交带上换来的 objectId',
  !!signMsg && signMsg.payload.objectId === 'OBJ-9001', signMsg && signMsg.payload);
ok('精简版：提交只带 9 个参数要用的字段（不含坐标/课程号）',
  !!signMsg && signMsg.payload.lat === undefined && signMsg.payload.courseId === undefined,
  signMsg && Object.keys(signMsg.payload));

// 上传只做一次（objectId 缓存）
const uploadsA = ph.__sent.filter((m) => m.type === 'uploadPhoto').length;
fire(ph.__ui.signBtn(), 'click');
ok('精简版：objectId 已缓存，不会重复上传',
  ph.__sent.filter((m) => m.type === 'uploadPhoto').length === uploadsA,
  ph.__sent.filter((m) => m.type === 'uploadPhoto').length);

// 面板范围内拖放要能收图（上一轮踩过的坑，这里必须有）
const ph2 = makePhotoHarness({ replies: { lookupActiveId: photoReplyNew, uploadPhoto: uploadReplyNew } });await settle();
ph2.__ui.openPanel();
const overEv = { clientX: 800, clientY: 300, preventDefault() { overEv.__p = true; }, dataTransfer: { files: [], items: [], dropEffect: '' } };
fireDoc(ph2, 'dragover', overEv);
ok('精简版：面板上的 dragover 被接管且调了 preventDefault', overEv.__p === true);
ok('精简版：拖到面板上时虚线框高亮', ph2.__ui.drop().classList.contains('over'));
const dropEv = {
  clientX: 800, clientY: 300, preventDefault() {},
  dataTransfer: { files: [{ name: 'dropped.png', size: 4096, type: 'image/png' }], items: [] }
};
fireDoc(ph2, 'drop', dropEv);
ok('精简版：在面板任意位置松手都会收下图片',
  (ph2.__readFiles || []).length === 1 && ph2.__readFiles[0].name === 'dropped.png', ph2.__readFiles);

// 没选图就提交 -> 必须拦住
const ph3 = makePhotoHarness({ replies: { lookupActiveId: photoReplyNew, uploadPhoto: uploadReplyNew } });
await settle();
ph3.__ui.openPanel();
fire(ph3.__ui.signBtn(), 'click');
ok('精简版：没选图片时不发提交请求',
  !ph3.__sent.some((m) => m.type === 'photoSign'), ph3.__sent.map((m) => m.type));

// 没有课程编号的页面不要乱发查询
const ph4 = makePhotoHarness({ url: 'https://i.chaoxing.com/base', replies: { lookupActiveId: photoReplyNew } });
await settle();
ok('精简版：页面没有课程编号时不盲目查询',
  ph4.__sent.filter((m) => m.type === 'lookupActiveId').length === 0,
  ph4.__sent.map((m) => m.type));

// ---- 普通签到按钮：Activity 名叫「普通签到」、硬交照片会被 photoAuthError 时用它 ----
section('2.10) 普通签到兜底（photoAuthError 的正解）');

const plainReply = {
  ok: true, activeId: '2000175731144', name: '普通签到', label: '进行中',
  kind: CXL.detectSignKind({ otherId: 1, ifphoto: 1, name: '普通签到' }),
  uid: '342160606', fid: '135774'
};
const phP = makePhotoHarness({
  replies: {
    lookupActiveId: plainReply,
    whoAmI: { ok: true, name: '张三' },
    photoSign: { ok: true, message: '服务端返回 success（测试桩）', method: 'GET' }
  }
});
await settle();
ok('精简版：面板有「按普通签到提交」按钮', !!phP.__ui.plainBtn());
ok('精简版：活动识别为普通签到时，提示改用普通提交',
  /普通签到/.test(phP.__ui.status().textContent || '') &&
  /按普通签到提交/.test(phP.__ui.status().textContent || ''),
  phP.__ui.status().textContent);

fire(phP.__ui.plainBtn(), 'click');
const plainSign = phP.__sent.find((m) => m.type === 'photoSign');
ok('精简版：普通提交发出 kind=plain', !!plainSign && plainSign.payload.kind === 'plain', plainSign && plainSign.payload);
ok('精简版：普通提交不带 objectId',
  !!plainSign && !plainSign.payload.objectId, plainSign && plainSign.payload);
ok('精简版：普通提交不带图片（不上传）',
  !phP.__sent.some((m) => m.type === 'uploadPhoto'), phP.__sent.map((m) => m.type));
ok('精简版：普通提交也会带姓名（自动读到的）',
  !!plainSign && plainSign.payload.name === '张三', plainSign && plainSign.payload.name);

// 姓名自动读取：请求里不再永远是 name=
ok('精简版：启动时会读登录账号姓名', phP.__sent.some((m) => m.type === 'whoAmI'));

// ---- 类型明确签不了时，必须拦住、不发请求（这次"二维码签到被当成普通签"的回归）----
const qrReply = {
  ok: true, activeId: '2000175731193', name: '二维码签到', label: '进行中',
  // 真正的二维码签到：服务端字段给出 activeSort=6
  kind: CXL.detectSignKind({ activeSort: 6, otherId: 1, name: '二维码签到' }),
  uid: '342160606', fid: '135774'
};
const phQ = makePhotoHarness({ replies: { lookupActiveId: qrReply, whoAmI: { ok: true, name: '张三' } } });
await settle();
ok('精简版：二维码签到会被识别出来', phQ.__ui.h().st.activeKind.key === 'qr',
  phQ.__ui.h().st.activeKind && phQ.__ui.h().st.activeKind.key);
ok('精简版：提示里说明要扫码、让用 APP',
  /二维码/.test(phQ.__ui.status().textContent || '') && /APP/.test(phQ.__ui.status().textContent || ''),
  phQ.__ui.status().textContent);
phQ.__ui.openPanel();
const beforeQ = phQ.__sent.length;
fire(phQ.__ui.signBtn(), 'click');
fire(phQ.__ui.plainBtn(), 'click');
ok('精简版：二维码签到两个按钮都在本地拦下，一个请求都不发',
  phQ.__sent.slice(beforeQ).filter((m) => m.type === 'photoSign' || m.type === 'uploadPhoto').length === 0,
  phQ.__sent.slice(beforeQ).map((m) => m.type));
ok('精简版：拦住时给出原因（不是静默失败）',
  /没有发送请求/.test(phQ.__ui.status().textContent || ''), phQ.__ui.status().textContent);
ok('精简版：签不了的类型，按钮不再主推"多半失败"那个',
  !/多半失败/.test(phQ.__ui.h().ui.signBtn.textContent || '') &&
  /APP/.test(phQ.__ui.h().ui.signBtn.textContent || ''),
  phQ.__ui.h().ui.signBtn.textContent);

// 没选图时不该露出"破图标 + alt 文字"（CSS 里 display:block 会盖掉 [hidden]）
const cssText = fs.readFileSync(path.join(photoSrcDir, 'content.js'), 'utf8');
ok('精简版：缩略图 hidden 时有显式 display:none 规则（防破图标）',
  /\.thumb\[hidden\]\s*\{\s*display:\s*none/.test(cssText));
ok('精简版：没选图时缩略图处于 hidden 状态',
  phQ.__ui.h().ui.img.hidden === true, phQ.__ui.h().ui.img.hidden);


// ---- 多活动选择器：同一门课有多个进行中签到时必须能选 ----
const twoActsReply = {
  ok: true,
  activeId: '2000175731193',
  name: '二维码签到',
  label: '进行中',
  kind: CXL.detectSignKind({ activeSort: 7, otherId: 2, name: '二维码签到' }),
  candidates: [
    {
      id: '2000175731193', name: '二维码签到', startTime: 2,
      kind: CXL.detectSignKind({ activeSort: 7, otherId: 2, name: '二维码签到' })
    },
    {
      id: '2000175731200', name: '普通签到', startTime: 1,
      kind: CXL.detectSignKind({ activeSort: 3, otherId: 1, ifphoto: 1, ifrefreshewm: 1, name: '普通签到' })
    }
  ],
  uid: '342160606', fid: '135774'
};
const phPick = makePhotoHarness({ replies: { lookupActiveId: twoActsReply, whoAmI: { ok: true, name: '张三' } } });
await settle();
const hPick = phPick.__ui.h();
ok('精简版：进行中的多个签到都会列进下拉',
  (hPick.ui.pickSelect.children || []).length === 2, (hPick.ui.pickSelect.children || []).length);
ok('精简版：下拉里带活动名和类型',
  (hPick.ui.pickSelect.children || []).some((o) => /普通签到/.test(o.textContent || '')),
  (hPick.ui.pickSelect.children || []).map((o) => o.textContent));
ok('精简版：默认选中的是当前活动',
  hPick.ui.pickSelect.value === '2000175731193', hPick.ui.pickSelect.value);

// 手动切到那个"普通签到 + 要求拍照"的活动
hPick.ui.pickSelect.value = '2000175731200';
fire(hPick.ui.pickSelect, 'change');
ok('精简版：切换活动会改 activeId', hPick.st.activeId === '2000175731200', hPick.st.activeId);
ok('精简版：切换活动会重判类型（变成普通+要求拍照）',
  hPick.st.activeKind.key === 'plain' && hPick.st.activeKind.needsPhoto === true,
  hPick.st.activeKind && hPick.st.activeKind.key);
ok('精简版：切换后提示随之更新、不再是二维码那套',
  !/二维码/.test(hPick.ui.status.textContent || '') &&
  /普通/.test(hPick.ui.status.textContent || ''),
  hPick.ui.status.textContent);
ok('精简版：切换后两个提交按钮恢复可用（不再被二维码拦住）',
  hPick.ui.plainBtn.className.indexOf('primary') >= 0, hPick.ui.plainBtn.className);
ok('精简版：切换活动后输入框也跟着换成新编号（否则会提交旧活动）',
  hPick.ui.activeIdInput.value === '2000175731200', hPick.ui.activeIdInput.value);

// 真提交一次：必须发给刚选中的那个活动，而不是输入框里的旧值
const phPick2 = makePhotoHarness({
  replies: {
    lookupActiveId: twoActsReply,
    whoAmI: { ok: true, name: '张三' },
    uploadPhoto: { ok: true, objectId: 'OBJ-1', size: 100, name: 'a.jpg', uid: '342160606' },
    photoSign: { ok: true, message: 'ok' }
  }
});
await settle();
const hP2 = phPick2.__ui.h();
// 故意把输入框弄脏成旧活动编号，再点下拉里的普通签到
hP2.ui.activeIdInput.value = '2000175731193';
hP2.st.activeId = '2000175731193';
hP2.ui.pickSelect.value = '2000175731200';
fire(hP2.ui.pickSelect, 'change');
const f2 = hP2.ui.file;
f2.files = [{ name: 'a.jpg', size: 1000, type: 'image/jpeg' }];
fire(f2, 'change');
fire(hP2.ui.signBtn, 'click');
const sentPick = phPick2.__sent.filter((m) => m.type === 'photoSign').pop();
ok('精简版：提交用的是"选中的活动"，不是输入框里的旧编号',
  !!sentPick && sentPick.payload.activeId === '2000175731200',
  sentPick && sentPick.payload.activeId);

// otherId=0 是新建普通签到的真实取值（缺失 activeSort 时也能判对）
const plainZero = CXL.detectSignKind({ otherId: 0, name: '普通签到' });
ok('otherId=0 -> 普通签到（不靠名字也判得对）',
  plainZero.key === 'plain' && plainZero.fromName === false, plainZero);

// ---- 摄像头现场拍一张（网页端拍照功能）----
section('2.11) 网页端摄像头拍照');

const phCam = makePhotoHarness({
  replies: { lookupActiveId: photoReplyNew, whoAmI: { ok: true, name: '张三' } },
  camera: true
});
await settle();
const hCam = phCam.__ui.h();
ok('精简版：面板有「用摄像头拍一张」按钮', !!hCam.ui.camBtn);
fire(hCam.ui.camBtn, 'click');
await new Promise((r) => setTimeout(r, 20));      // getUserMedia 是异步的
ok('精简版：点摄像头会请求 getUserMedia', phCam.__cameraCalls === 1, phCam.__cameraCalls);
ok('精简版：摄像头打开后显示视频区', hCam.ui.camWrap.hidden === false, hCam.ui.camWrap.hidden);

hCam.ui.camVideo.videoWidth = 640;
hCam.ui.camVideo.videoHeight = 480;
const shootRow = (hCam.ui.camWrap.children || [])[1] || {};
const shootBtn = (shootRow.children || [])[0];
ok('精简版：视频区里有「拍下这张」按钮', !!shootBtn);
fire(shootBtn, 'click');
ok('精简版：拍照后得到一张待提交的图片',
  !!hCam.st.photo && /^camera_/.test(hCam.st.photo.name || ''),
  hCam.st.photo && hCam.st.photo.name);
ok('精简版：拍照后关掉摄像头并释放视频流',
  hCam.ui.camWrap.hidden === true && phCam.__streamStopped === true,
  { hidden: hCam.ui.camWrap.hidden, stopped: phCam.__streamStopped });

const phNoCam = makePhotoHarness({ replies: { lookupActiveId: photoReplyNew }, camera: false });
await settle();
const hNoCam = phNoCam.__ui.h();
fire(hNoCam.ui.camBtn, 'click');
ok('精简版：不支持摄像头时给出可操作提示',
  /不支持调用摄像头/.test(hNoCam.ui.status.textContent || '') &&
  /选图片/.test(hNoCam.ui.status.textContent || ''),
  hNoCam.ui.status.textContent);



const phE = makePhotoHarness({ replies: { lookupActiveId: photoReplyNew, uploadPhoto: uploadReplyNew, photoSign: { ok: true, message: 'ok' } } });
await settle();
const hE = phE.__ui.h();
hE.st.extra = 'photoResult=SOMETHING';
const fileE = hE.ui.file;
fileE.files = [{ name: 'a.jpg', size: 1000, type: 'image/jpeg' }];
fire(fileE, 'change');
fire(hE.ui.signBtn, 'click');
const signE = phE.__sent.find((m) => m.type === 'photoSign');
ok('精简版：附加参数会跟着提交一起发出去',
  !!signE && signE.payload.extra === 'photoResult=SOMETHING', signE && signE.payload.extra);

const phProbe = makePhotoHarness({
  replies: {
    lookupActiveId: photoReplyNew,
    probePhoto: {
      ok: true, activeId: '4000175553141',
      probes: [{ name: '签到页', status: 200, len: 100, hits: { photoResult: 1 }, snippets: ['...photoResult...'] }]
    }
  }
});
await settle();
const hProbe = phProbe.__ui.h();
ok('精简版：面板有「探测拍照协议」按钮', !!hProbe.ui.probeBtn);
fire(hProbe.ui.probeBtn, 'click');
ok('精简版：点探测会请求后台拉页面',
  phProbe.__sent.some((m) => m.type === 'probePhoto'), phProbe.__sent.map((m) => m.type));
ok('精简版：探测结果会显示在面板里（含命中关键词）',
  /photoResult/.test(hProbe.ui.status.textContent || ''), hProbe.ui.status.textContent);



// ---------------------------------------------------------------------------
// 3. 各脚本语法检查（popup / options / content / background）
// ---------------------------------------------------------------------------

section('3) 脚本语法检查');

for (const f of ['content.js', 'background.js', 'popup.js', 'options.js', 'map.js', 'injected.js', 'lib.js']) {
  const code = fs.readFileSync(path.join(srcDir, f), 'utf8');
  try {
    new vm.Script(code, { filename: f });
    ok(f + ' 语法正确', true);
  } catch (e) {
    ok(f + ' 语法错误：' + e.message, false);
  }
}

// 精简版插件的脚本同样过一遍语法（它的 content/background 是另一份实现）
for (const f of ['content.js', 'background.js', 'popup.js', 'options.js', 'lib.js']) {
  const code = fs.readFileSync(path.join(photoSrcDir, f), 'utf8');
  try {
    new vm.Script(code, { filename: 'photo-sign-extension/' + f });
    ok('photo-sign-extension/' + f + ' 语法正确', true);
  } catch (e) {
    ok('photo-sign-extension/' + f + ' 语法错误：' + e.message, false);
  }
}

// ---------------------------------------------------------------------------
// 4. manifest.json 检查
// ---------------------------------------------------------------------------

section('4) manifest.json 检查');

const manifest = JSON.parse(fs.readFileSync(path.join(here, '..', 'extension', 'manifest.json'), 'utf8'));
ok('manifest_version = 3', manifest.manifest_version === 3);
ok('声明了 storage / activeTab / scripting 权限', ['storage', 'activeTab', 'scripting'].every((p) => manifest.permissions.includes(p)));
ok('injected.js 在 web_accessible_resources 中', JSON.stringify(manifest.web_accessible_resources).includes('src/injected.js'));

const referenced = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  manifest.options_ui.page,
  'src/injected.js',
  'src/lib.js',
  'src/map.js'
];
for (const rel of referenced) {
  ok('文件存在：' + rel, fs.existsSync(path.join(here, '..', 'extension', rel)));
}

// popup/options 里引用的脚本
for (const html of ['popup.html', 'options.html']) {
  const text = fs.readFileSync(path.join(srcDir, html), 'utf8');
  const refs = [...text.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  for (const r of refs) {
    ok(html + ' 引用的 ' + r + ' 存在', fs.existsSync(path.join(srcDir, r)));
  }
}

// ---------------------------------------------------------------------------
// 5. 签到 URL 组装（直接测扩展里真正使用的实现）
// ---------------------------------------------------------------------------

section('5) 签到 URL 参数格式（CXL.buildSignUrl）');

const url = CXL.buildSignUrl({
  name: '张三',
  address: 'XX大学 图书馆',
  activeId: '123456789',
  uid: '88888888',
  lat: 30.1234567,
  lon: 120.7654321,
  fid: '1403'
});
ok('URL 指向 stuSignajax 接口', url.startsWith('https://mobilelearn.chaoxing.com/pptSign/stuSignajax?'));
ok('含 latitude/longitude 六位小数', /latitude=30\.123457/.test(url) && /longitude=120\.765432/.test(url), url);
ok('含 activeId/uid/fid/appType/ifTiJiao', /activeId=123456789/.test(url) && /uid=88888888/.test(url) && /fid=1403/.test(url) && /appType=15/.test(url) && /ifTiJiao=1/.test(url));
ok('中文做了 URL 编码', /name=%E5%BC%A0%E4%B8%89/.test(url) && !/name=张三/.test(url));
ok('clientip 参数存在且为空', /[?&]clientip=&/.test(url));
ok('WGS-84 输入的 URL 与手工换算一致', (() => {
  const u = CXL.buildSignUrl({ lat: 39.908722, lon: 116.397499, datum: 'wgs84', activeId: '1' });
  const g = CXL.wgs84ToGcj02(39.908722, 116.397499);
  return u.includes('latitude=' + g[0].toFixed(6)) && u.includes('longitude=' + g[1].toFixed(6));
})());
ok('BD-09 输入被换算为 GCJ-02', (() => {
  const u = CXL.buildSignUrl({ lat: 30.5, lon: 120.5, datum: 'bd09', activeId: '1' });
  const g = CXL.bd09ToGcj02(30.5, 120.5);
  return u.includes('latitude=' + g[0].toFixed(6)) && u.includes('longitude=' + g[1].toFixed(6));
})());

// ---------------------------------------------------------------------------
// 6. map.js：投影与平移（在假 DOM 里跑一遍）
// ---------------------------------------------------------------------------

section('6) map.js 投影正确性');

function makeMapCtx() {
  const canvas = {
    clientWidth: 400, clientHeight: 300, width: 400, height: 300,
    style: {},
    getContext: () => ({
      setTransform() {}, clearRect() {}, fillRect() {}, drawImage() {}, save() {}, restore() {},
      beginPath() {}, arc() {}, fill() {}, ellipse() {}, moveTo() {}, lineTo() {}, closePath() {},
      stroke() {}, fillText() {}, bezierCurveTo() {}
    }),
    addEventListener() {}, removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 }),
    appendChild() {}, remove() {}, setPointerCapture() {}
  };
  const host = { appendChild() {}, clientWidth: 400, clientHeight: 300 };
  const ctx = {
    console, Math, Object, Array, String, Number, Boolean, Error, RegExp, Map, Set, Promise,
    parseInt, parseFloat, isNaN, setTimeout, setInterval, clearInterval, Date,
    document: { createElement: () => canvas, currentScript: { dataset: {} } },
    requestAnimationFrame: () => 0,
    ResizeObserver: undefined
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.addEventListener = function () {};
  ctx.devicePixelRatio = 1;
  vm.createContext(ctx);
  vm.runInContext(libSource, ctx);   // map.js 依赖 CXL
  vm.runInContext(mapSource, ctx);
  return { ctx, host };
}

const { ctx: mapCtx, host: mapHost } = makeMapCtx();
const map = mapCtx.globalThis.CXL.createMap(mapHost, {});
ok('createMap 返回地图实例', !!map && typeof map.setView === 'function');

map.setView(39.908722, 116.397499, 16);
const c0 = map.getCenter();
ok('setView 后中心点正确', near(c0[0], 39.908722, 1e-9) && near(c0[1], 116.397499, 1e-9), c0);

const backCenter = map.screenToLatLon(200, 150);
ok('屏幕中心反投影 = 视图中心', near(backCenter[0], 39.908722, 1e-6) && near(backCenter[1], 116.397499, 1e-6), backCenter);

map.panByPixels(-100, 0);
const afterPan = map.getCenter();
ok('向右拖动地图后中心经度向东移动', afterPan[1] > 116.397499, afterPan);

map.setView(30, 120, 10);
const zoomLow = map.screenToLatLon(0, 0);
map.setView(30, 120, 14);
const zoomHigh = map.screenToLatLon(0, 0);
ok('缩放级别越高，同样像素跨越的经纬度越小', Math.abs(zoomHigh[1] - 120) < Math.abs(zoomLow[1] - 120), [zoomLow[1], zoomHigh[1]]);

// ---------------------------------------------------------------------------

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
