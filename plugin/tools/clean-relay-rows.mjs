#!/usr/bin/env node
/**
 * clean-relay-rows.mjs — 清理 cordis.patch.yml 里 dsh-public-relay 的无效/重复条目
 *
 * ── 为什么需要它 ──
 *
 * dsh 的 applyEntryPatches 把 patch 分两类：
 *   · 带 `insert:`   → 追加新条目（唯一能新增插件的形态）
 *   · 不带 `insert:` → 按 id 找**已存在**的条目来改；找不到就 warn + continue 静默丢弃
 *
 * 所以裸写的 `- id: dsh-public-relay` 完全无效，却会让人以为「已经配好了」。
 * set-relay-row.mjs 的早期版本还可能在已有裸条目时又插一个 insert 块，
 * 造成同一插件在文件里出现两份。
 *
 * 本脚本把文件收敛到「恰好 1 个有效 insert 条目、0 个裸条目」。
 *
 * 模式：
 *   默认         收敛（保留 1 个 insert，删裸条目与重复 insert）
 *   --remove     彻底移除本插件的所有条目（回滚用）
 *
 * 两种模式都保证文件顶层仍是合法 YAML 数组。幂等。
 *
 * 用法：
 *   node clean-relay-rows.mjs <profileDir>
 *   node clean-relay-rows.mjs <profileDir> --remove
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const removeMode = args.includes('--remove');
const profileDir = args.find((a) => !a.startsWith('--'));

if (!profileDir) {
  console.error('usage: node clean-relay-rows.mjs <profileDir> [--remove]');
  process.exit(2);
}

const dir = path.resolve(profileDir);
const patchPath = path.join(dir, 'cordis.patch.yml');
if (!fs.existsSync(patchPath)) {
  console.error(`[clean-relay-rows] 找不到 ${patchPath}`);
  process.exit(1);
}

const ROW_ID = 'dsh-public-relay';
const TAG = 'clean-relay-rows';

function loadYaml() {
  for (const anchor of [path.join(dir, 'package.json'), path.join(process.cwd(), 'package.json')]) {
    try { return createRequire(anchor)('js-yaml'); } catch { /* 试下个锚点 */ }
  }
  try { return createRequire(import.meta.url)('js-yaml'); } catch { return null; }
}

const yaml = loadYaml();

/** 统计条目：insert 里本插件的数量、顶层裸条目数量、以及文件是否合法数组。 */
function survey(text) {
  if (!yaml) {
    return { insert: 0, bare: 0, isArray: true, note: '（无 js-yaml，仅文本判断）' };
  }
  const T = (k) => new yaml.Type('tag:yaml.org,2002:js', {
    kind: k, resolve: () => true, construct: (d) => ({ __js: d }),
  });
  try {
    const doc = yaml.load(text, { schema: yaml.DEFAULT_SCHEMA.extend([T('scalar'), T('sequence'), T('mapping')]) });
    if (!Array.isArray(doc)) {
      return { insert: 0, bare: 0, isArray: false, note: `顶层是 ${doc === null ? 'null' : typeof doc}` };
    }
    let insert = 0;
    let bare = 0;
    for (const e of doc) {
      if (!e) continue;
      if (Array.isArray(e.insert) && e.insert.some((r) => r && r.id === ROW_ID)) insert++;
      else if (e.id === ROW_ID) bare++;
    }
    return { insert, bare, isArray: true, entries: doc.length, note: '' };
  } catch (err) {
    return { insert: 0, bare: 0, isArray: false, note: `YAML 解析失败：${String(err.message).split('\n')[0]}` };
  }
}

const original = fs.readFileSync(patchPath, 'utf8');
const eol = original.includes('\r\n') ? '\r\n' : '\n';
const lines = original.split(/\r?\n/);

console.log(`[${TAG}] ${removeMode ? '移除模式' : '收敛模式'}；处理前 ${JSON.stringify(survey(original))}`);

/** 从顶层条目起点 i，返回其结束行号（下一个顶层 `- ` 之前）。 */
function endOfEntry(i) {
  let j = i + 1;
  while (j < lines.length && !/^- /.test(lines[j])) j++;
  return j;
}

const kept = [];
let removedBare = 0;
let removedInsert = 0;
let keptInsert = 0;

let i = 0;
while (i < lines.length) {
  const line = lines[i];

  // 1) 顶层裸条目 —— 永远是无效的，两种模式都删
  if (new RegExp(`^-\\s*id:\\s*${ROW_ID}\\s*$`).test(line)) {
    const j = endOfEntry(i);
    console.log(`[${TAG}] 删除裸条目（无效形态）：第 ${i + 1}-${j} 行`);
    removedBare++;
    i = j;
    continue;
  }

  // 2) 本插件的 insert 块
  if (/^- insert:\s*$/.test(line)) {
    const j = endOfEntry(i);
    const inner = lines.slice(i + 1, j);
    const isRelay = inner.some((l) => new RegExp(`^\\s+-\\s+id:\\s*${ROW_ID}\\s*$`).test(l));
    if (isRelay) {
      if (removeMode) {
        console.log(`[${TAG}] 删除 insert 条目：第 ${i + 1}-${j} 行`);
        removedInsert++;
        i = j;
        continue;
      }
      keptInsert++;
      if (keptInsert > 1) {
        console.log(`[${TAG}] 删除重复 insert 块：第 ${i + 1}-${j} 行`);
        removedInsert++;
        i = j;
        continue;
      }
    }
  }

  kept.push(line);
  i++;
}

let out = kept.join(eol).replace(/(\r?\n){3,}/g, `${eol}${eol}`);

const outLines = () => out.split(eol);
const hasTopEntry = () => outLines().some((l) => /^- /.test(l));

// 3) 收敛模式下若没有有效条目，补一个 insert（回滚模式不补）
if (!removeMode) {
  let after = survey(out);
  if (after.insert === 0) {
    const ROW = [
      `# --- ${ROW_ID} (DSH 中转插件) ---`,
      '- insert:',
      `    - id: ${ROW_ID}`,
      `      name: ${ROW_ID}`,
      '      config:',
      '        enabled: true',
      '        listenHost: "127.0.0.1"',
      '        listenPort: 3091',
      '        password: "20040915"',
      '        forceLoopback: true',
    ];
    const idx = outLines().findIndex((l) => /^\s*\[\s*\]\s*$/.test(l));
    if (idx >= 0) {
      out = [...outLines().slice(0, idx), ...ROW, ...outLines().slice(idx + 1)].join(eol);
      console.log(`[${TAG}] 已用 insert 条目替换顶层 [] 占位（第 ${idx + 1} 行）`);
    } else {
      out = `${out.replace(/\s*$/, '')}${eol}${eol}${ROW.join(eol)}${eol}`;
      console.log(`[${TAG}] 已追加 insert 条目`);
    }
  }
}

// 4) 无论哪种模式，顶层都必须保持合法数组：没有条目就补 []
if (!hasTopEntry() && !/^\s*\[\s*\]\s*$/m.test(out)) {
  out = `${out.replace(/\s*$/, '')}${eol}${eol}[]${eol}`;
  console.log(`[${TAG}] 已补顶层 [] 占位（保证数组合法）`);
}

if (out === original) {
  console.log(`[${TAG}] 无需改动`);
  const v = survey(original);
  const good = removeMode ? (v.insert === 0 && v.bare === 0) : (v.insert === 1 && v.bare === 0);
  process.exitCode = good ? 0 : 1;
  process.exit(process.exitCode);
}

fs.writeFileSync(patchPath, out, 'utf8');

const verify = survey(fs.readFileSync(patchPath, 'utf8'));
console.log(`[${TAG}] 处理后 ${JSON.stringify(verify)}`);

const pass = removeMode
  ? (verify.insert === 0 && verify.bare === 0 && verify.isArray)
  : (verify.insert === 1 && verify.bare === 0 && verify.isArray);

if (pass) {
  console.log(`[${TAG}] OK（删裸条目 ${removedBare}，删 insert ${removedInsert}）`);
  process.exit(0);
}
console.error(`[${TAG}] FAIL：结果不符合预期（insert=${verify.insert} bare=${verify.bare} isArray=${verify.isArray}）${verify.note ? ' ' + verify.note : ''}`);
process.exitCode = 1;
