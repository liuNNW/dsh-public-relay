#!/usr/bin/env node
/**
 * repair-patch-array.mjs — 修「顶层出现多个文档」的 cordis.patch.yml
 *
 * 症状：文件里既有 `[]` 占位行、又有 `- id:` 条目（早期 set-relay-row.mjs 追加到
 * 末尾造成的）。YAML 会报：
 *   end of the stream or a document separator is expected
 * 因为顶层同时存在空数组与列表，等于两个文档。
 *
 * 修法：已有 `- ` 条目时删掉孤立的 `[]` 行；只有注释和无条目时才补 `[]`。
 * 用 YAML 解析器做前后校验，修不好就原样回滚。
 *
 * 用法：node repair-patch-array.mjs <cordis.patch.yml>
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const target = process.argv[2];
if (!target) {
  console.error('usage: node repair-patch-array.mjs <cordis.patch.yml>');
  process.exit(2);
}

const file = path.resolve(target);
if (!fs.existsSync(file)) {
  console.error(`not found: ${file}`);
  process.exit(2);
}

/** 容错 YAML 解析：profile 里可能有 !!js 自定义标签。 */
function loadYaml() {
  for (const anchor of [path.join(path.dirname(file), 'package.json'), path.join(process.cwd(), 'package.json')]) {
    try {
      return createRequire(anchor)('js-yaml');
    } catch { /* 试下一个 */ }
  }
  try {
    return createRequire(import.meta.url)('js-yaml');
  } catch {
    return null;
  }
}

function parseWith(yaml, text) {
  const jsType = (kind) => new yaml.Type('tag:yaml.org,2002:js', {
    kind,
    resolve: () => true,
    construct: (d) => ({ __js: d }),
  });
  const schema = yaml.DEFAULT_SCHEMA.extend([jsType('scalar'), jsType('sequence'), jsType('mapping')]);
  return yaml.load(text, { schema });
}

const original = fs.readFileSync(file, 'utf8');
const yaml = loadYaml();

// 先看当前状态
if (yaml) {
  try {
    const doc = parseWith(yaml, original);
    if (Array.isArray(doc)) {
      const hasRelay = doc.some((e) => e && e.id === 'dsh-relay');
      console.log(`[repair-patch-array] 文件已是合法数组（${doc.length} 项，含 dsh-relay=${hasRelay}），无需修复`);
      process.exit(0);
    }
  } catch {
    /* 需要修，往下走 */
  }
}

const eol = original.includes('\r\n') ? '\r\n' : '\n';
const lines = original.split(/\r?\n/);
const hasEntry = lines.some((l) => /^- /.test(l));
const placeholderCount = lines.filter((l) => /^\s*\[\s*\]\s*$/.test(l)).length;

console.log(`[repair-patch-array] 现状：条目行=${hasEntry}，[] 占位行=${placeholderCount}`);

let out;
if (hasEntry && placeholderCount > 0) {
  // 删掉所有孤立的 [] 行
  out = lines.filter((l) => !/^\s*\[\s*\]\s*$/.test(l)).join(eol);
  console.log('[repair-patch-array] 已删除孤立的 [] 占位行');
} else if (!hasEntry && placeholderCount === 0) {
  out = `${original.replace(/\s*$/, '')}${eol}${eol}[]${eol}`;
  console.log('[repair-patch-array] 无条目也无占位，已补 []');
} else {
  console.log('[repair-patch-array] 无需改动');
  process.exit(0);
}

// 收掉多余空行
out = out.replace(/(\r?\n){3,}/g, `${eol}${eol}`);

fs.writeFileSync(file, out, 'utf8');

// 回读校验
if (yaml) {
  try {
    const doc = parseWith(yaml, fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(doc)) throw new Error('顶层不是数组');
    const hasRelay = doc.some((e) => e && e.id === 'dsh-relay');
    console.log(`[repair-patch-array] 修复成功：数组 ${doc.length} 项，含 dsh-relay=${hasRelay}`);
    process.exit(0);
  } catch (err) {
    console.error(`[repair-patch-array] 修复后仍无法解析（${String(err.message).split('\n')[0]}），已回滚`);
    fs.writeFileSync(file, original, 'utf8');
    process.exit(1);
  }
}
console.log('[repair-patch-array] 已写入（无 js-yaml，跳过解析校验）');
