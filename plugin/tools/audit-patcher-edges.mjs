#!/usr/bin/env node
/**
 * audit-patcher-edges.mjs — 检验 isLoopback 改写器的边界，重点看会不会产出**语法错误**的 JS
 *
 * 改写器要在任意第三方 bundle 上工作。一旦它把合法 JS 改坏，浏览器会整包
 * 加载失败 —— 那比「没改写成功」严重得多（设置页直接白屏）。
 * 所以每个样例都要做一次真正的语法检查（vm.Script 编译）。
 */
import vm from 'node:vm';
import { patchIsLoopback, findIsLoopbackSpans } from '../dsh-public-relay/lib/relay.js';

const cases = [
  ['普通对象', 'x = { isLoopback: pageLocation === void 0 }'],
  ['带尾随字段', 'x = { isLoopback: pageLocation === void 0, b: 2 }'],
  ['嵌套括号', 'x = { isLoopback: f(pageLocation(a, b), c) || d, z: 1 }'],
  ['三目表达式', 'x = { isLoopback: pageLocation === void 0 ? true : isLoopbackHostname(h), z: 1 }'],
  ['行注释里出现', '// isLoopback: pageLocation === void 0\nx = { isLoopback: pageLocation === void 0, z: 1 }'],
  ['块注释里出现', '/* isLoopback: pageLocation */\nx = { isLoopback: pageLocation === void 0, z: 1 }'],
  ['模板串里出现', 'const s = `isLoopback: pageLocation`;\nx = { isLoopback: pageLocation === void 0, z: 1 }'],
  ['正则字面量里出现', 'const re = /isLoopback: pageLocation/;\nx = { isLoopback: pageLocation === void 0, z: 1 }'],
  ['字符串里出现', 'const t = "isLoopback: pageLocation";\nx = { isLoopback: pageLocation === void 0, z: 1 }'],
  ['值本身是对象', 'x = { isLoopback: { a: 1 }, b: 2 }'],
  ['多行压缩形态', 'x={isLoopback:a||b,c:1}'],
  ['箭头函数值', 'x = { isLoopback: () => pageLocation === void 0, z: 1 }'],
  ['无该字段', 'function f(){ return 1 }'],
];

let bad = 0;
for (const [name, src] of cases) {
  const r = patchIsLoopback(src);
  let syntax = 'ok';
  try {
    new vm.Script(r.body);
  } catch (err) {
    syntax = `SYNTAX ERROR: ${err.message}`;
    bad += 1;
  }
  const changed = r.body !== src;
  console.log(`${name.padEnd(22)} hits=${r.hits} changed=${changed ? 'Y' : 'n'} ${syntax === 'ok' ? '' : '<<< ' + syntax}`);
  if (syntax !== 'ok') console.log('   结果：' + JSON.stringify(r.body));
}

console.log('');
// 直接调用内部扫描器，看它对未闭合输入的容错
const weird = [
  'isLoopback: ',
  'isLoopback: (((',
  'isLoopback: "unterminated',
  'isLoopback: `tpl ${x',
];
console.log('扫描器对畸形输入的容错：');
for (const w of weird) {
  let out;
  try { out = JSON.stringify(findIsLoopbackSpans(w)); } catch (e) { out = 'THREW: ' + e.message; }
  console.log(`  ${JSON.stringify(w).padEnd(28)} -> ${out}`);
}

console.log('');
console.log(bad === 0 ? '所有样例语法合法 ✅' : `有 ${bad} 个样例产出了非法 JS ❌`);
process.exitCode = bad === 0 ? 0 : 1;
