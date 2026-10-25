/*
 * 把共享的协议代码段从 extension/src/lib.js 同步到 photo-sign-extension/src/lib.js。
 * 两份 lib.js 里的这些段必须逐字一致（validate 会校验），手抄容易漏。
 *
 * 同步范围：下面每一对 [起点, 终点) 之间的内容。
 */
import fs from 'node:fs';

const SECTIONS = [
  // 活动列表接口（含 activeInfo 地址与归一化）
  ['  /** 活动列表接口（与网页 stuActiveList 页面调的是同一个） */', '  /**\n   * 把 activelist 接口的响应归一化成活动数组。'],
  // 签到类型判定整段
  ['  // -------------------------------------------------------------------------\n  // 签到类型', '  /** 提交时用的 HTTP 方法'],
  // 拍照 / 普通 / 位置 的参数组装
  ['  /**\n   * 拍照签到的参数必须"干净"。', '  // ---------- 距离 / 格式化 ----------']
];

const a = fs.readFileSync('extension/src/lib.js', 'utf8');
const bPath = 'photo-sign-extension/src/lib.js';
let b = fs.readFileSync(bPath, 'utf8');

function slice(src, start, end, label) {
  const i = src.indexOf(start);
  if (i < 0) throw new Error(label + ': 找不到起点 ' + JSON.stringify(start.slice(0, 40)));
  const j = src.indexOf(end, i + start.length);
  if (j < 0) throw new Error(label + ': 找不到终点 ' + JSON.stringify(end.slice(0, 40)));
  return { i, j, block: src.slice(i, j) };
}

let changed = 0;
for (const [start, end] of SECTIONS) {
  const A = slice(a, start, end, 'extension');
  const B = slice(b, start, end, 'photo-sign-extension');
  if (A.block === B.block) continue;
  b = b.slice(0, B.i) + A.block + b.slice(B.j);
  changed++;
  console.log('已同步：' + start.trim().split('\n').pop().slice(0, 46));
}

if (changed) {
  fs.writeFileSync(bPath, b, 'utf8');
  console.log('写回 photo-sign-extension/src/lib.js（' + changed + ' 段）');
} else {
  console.log('两份 lib.js 的共享段已一致，无需搬运');
}
