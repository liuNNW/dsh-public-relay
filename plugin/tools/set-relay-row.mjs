#!/usr/bin/env node
/**
 * set-relay-row.mjs — 在 profile 的 cordis.patch.yml 里写入/更新 dsh-public-relay 条目
 *
 * ── 为什么必须是 `- insert:` 包裹（关键，踩过坑）──
 *
 * dsh 的 applyEntryPatches 把 patch 分成两类：
 *   · 带 `insert:` 的  → **追加新条目**到树里（新增插件走这条）
 *   · 不带 `insert:` 的 → **修改已存在的条目**，按 id 去找；
 *                        找不到就 warn + continue，**静默丢弃**
 *
 * 所以写成裸 `- id: dsh-public-relay` 完全不会新增任何东西 —— 它被当成
 * 「找一条 id=dsh-public-relay 的已有条目来改」，而那条根本不存在。
 * 正确写法与 @deepseek-ai/dsh-mimo-vision 一致：
 *
 *   - insert:
 *       - id: dsh-public-relay
 *         name: dsh-public-relay
 *         config: { ... }
 *
 * ── 其它必须守住的约束（都踩过）──
 *
 * 1. 顶层必须是 YAML 数组。
 * 2. 文件里不能同时有 `[]` 占位和条目 —— 那是两个顶层文档，YAML 报
 *    "end of the stream or a document separator is expected"。
 *    所以有 `[]` 时要**替换**它，而不是在它后面追加。
 * 3. 写 UTF-8、保留原换行风格、不要 BOM。
 *
 * 用法：
 *   node set-relay-row.mjs <profileDir> [--remove]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const remove = args.includes('--remove');
const profileDir = args.find((a) => !a.startsWith('--'));

if (!profileDir) {
  console.error('usage: node set-relay-row.mjs <profileDir> [--remove]');
  process.exit(2);
}

const dir = path.resolve(profileDir);
const patchPath = path.join(dir, 'cordis.patch.yml');
if (!fs.existsSync(patchPath)) {
  console.error(`[set-relay-row] 找不到 ${patchPath}`);
  process.exit(1);
}

const ROW_ID = 'dsh-public-relay';
const MARKER = `# --- ${ROW_ID} (DSH 中转插件) ---`;

/** 条目文本。必须带 insert:，否则会被 dsh 静默丢弃。 */
const ROW_LINES = [
  MARKER,
  '- insert:',
  `    - id: ${ROW_ID}`,
  `      name: ${ROW_ID}`,
  '      config:',
  '        enabled: true',
  '        listenHost: "127.0.0.1"',
  '        listenPort: 3091',
  '        password: ""',
  '        forceLoopback: true',
];

const raw = fs.readFileSync(patchPath, 'utf8');
const hasBom = raw.charCodeAt(0) === 0xFEFF;
const text = hasBom ? raw.slice(1) : raw;
const eol = text.includes('\r\n') ? '\r\n' : '\n';
const lines = text.split(/\r?\n/);

/**
 * 定位本插件那一块。
 *
 * 用「顶层条目起点」判断边界：一个条目以 `- ` 开头（缩进 0）。
 * 注意 `- insert:` 自身也是顶层条目起点，所以从标记行往下时，
 * 第一行 `- insert:` 属于本块，要**继续**往下走到下一个顶层 `- ` 才算块尾。
 *
 * 块尾定义：从块起点之后，找到第一个「顶层 - 开头、且不是本块 insert 行」的行。
 * 简化而稳妥的做法：块 = 从起点marker/insert 起，直到遇到下一个顶层条目，
 * 而顶层条目判定为「以 '- ' 开头」——但必须把紧跟 marker 的那行 insert 算进来。
 */
function locateBlock() {
  const rowRe = new RegExp(`^-\\s+id:\\s*${ROW_ID}\\s*$`);

  /** 从某个顶层条目起点 i，返回该条目的结束行号（下一个顶层 '- ' 之前）。 */
  const endOfEntry = (i) => {
    let j = i + 1;
    while (j < lines.length) {
      if (/^- /.test(lines[j])) {
        // `- insert:` 是一层容器，它内部的条目是缩进的，不会以 '- ' 开头；
        // 因此这里的 '- ' 一定是**另一个**顶层条目。
        break;
      }
      j++;
    }
    return j;
  };

  // a) 按标记注释定位：marker 行之后紧跟的就是本块的 insert 条目
  const markerAt = lines.findIndex((l) => l.trim() === MARKER);
  if (markerAt >= 0) {
    // 找到 marker 之后第一个顶层条目
    let entryAt = markerAt + 1;
    while (entryAt < lines.length && !/^- /.test(lines[entryAt])) entryAt++;
    if (entryAt < lines.length) {
      return { start: markerAt, end: endOfEntry(entryAt) };
    }
    return { start: markerAt, end: markerAt + 1 };
  }

  // b) 无标记：找 `- insert:`，其下第一个缩进条目是 id=dsh-public-relay
  for (let i = 0; i < lines.length; i++) {
    if (!/^- insert:\s*$/.test(lines[i])) continue;
    let j = i + 1;
    while (j < lines.length && !/^- /.test(lines[j])) j++;
    if (j < lines.length && rowRe.test(lines[j])) {
      return { start: i, end: endOfEntry(i) };
    }
  }

  // c) 裸条目（会被 dsh 丢弃，但需识别出来以便修正）
  const bareAt = lines.findIndex((l) => rowRe.test(l));
  if (bareAt >= 0) {
    return { start: bareAt, end: endOfEntry(bareAt), bare: true };
  }

  return null;
}

const block = locateBlock();

if (remove) {
  if (!block) {
    console.log(`[set-relay-row] 本来就没有 ${ROW_ID} 条目`);
    process.exit(0);
  }
  const kept = [...lines.slice(0, block.start), ...lines.slice(block.end)];
  let joined = kept.join(eol).replace(/(\r?\n){3,}/g, `${eol}${eol}`);
  if (!joined.split(eol).some((l) => /^- /.test(l))) {
    joined = `${joined.replace(/\s*$/, '')}${eol}${eol}[]${eol}`;
  }
  fs.writeFileSync(patchPath, joined, 'utf8');
  console.log(`[set-relay-row] 已移除 ${ROW_ID} 条目（${block.end - block.start} 行）`);
  process.exit(0);
}

if (block) {
  const out = [...lines.slice(0, block.start), ...ROW_LINES, ...lines.slice(block.end)].join(eol);
  fs.writeFileSync(patchPath, out, 'utf8');
  console.log(`[set-relay-row] 已更新 ${ROW_ID}（${block.end - block.start} → ${ROW_LINES.length} 行）${block.bare ? '；原为无效裸条目，已改为 insert' : ''}`);
} else {
  const placeholderAt = lines.findIndex((l) => /^\s*\[\s*\]\s*$/.test(l));
  let out;
  if (placeholderAt >= 0) {
    out = [...lines.slice(0, placeholderAt), ...ROW_LINES, ...lines.slice(placeholderAt + 1)].join(eol);
    console.log(`[set-relay-row] 已用 insert 条目替换顶层 [] 占位（第 ${placeholderAt + 1} 行）`);
  } else if (lines.some((l) => /^- /.test(l))) {
    let insertAt = 0;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*$/.test(lines[i]) || /^\s*#/.test(lines[i])) { insertAt = i + 1; continue; }
      break;
    }
    out = [...lines.slice(0, insertAt), ...ROW_LINES, '', ...lines.slice(insertAt)].join(eol);
    console.log(`[set-relay-row] 已插入到第 ${insertAt + 1} 行`);
  } else {
    out = `${text.replace(/\s*$/, '')}${eol}${eol}${ROW_LINES.join(eol)}${eol}`;
    console.log('[set-relay-row] 已追加（原文件无条目）');
  }
  fs.writeFileSync(patchPath, out, 'utf8');
}

// ── 回读校验：合法数组 + 存在 insert→dsh-public-relay ──
let yaml = null;
try { yaml = createRequire(path.join(dir, 'package.json'))('js-yaml'); } catch { /* 试下个锚点 */ }
if (!yaml) { try { yaml = createRequire(import.meta.url)('js-yaml'); } catch { yaml = null; } }

const after = fs.readFileSync(patchPath, 'utf8');
let ok = false;
let detail = '';

if (yaml) {
  const T = (k) => new yaml.Type('tag:yaml.org,2002:js', {
    kind: k, resolve: () => true, construct: (d) => ({ __js: d }),
  });
  try {
    const doc = yaml.load(after, { schema: yaml.DEFAULT_SCHEMA.extend([T('scalar'), T('sequence'), T('mapping')]) });
    if (!Array.isArray(doc)) {
      detail = `顶层不是数组（${doc === null ? 'null' : typeof doc}）`;
    } else {
      const found = doc.some((e) => e && Array.isArray(e.insert) && e.insert.some((r) => r && r.id === ROW_ID));
      ok = found;
      detail = `数组 ${doc.length} 项，含 insert→${ROW_ID} = ${found}`;
      if (!found && doc.some((e) => e && e.id === ROW_ID)) {
        detail += '；存在裸条目（缺 insert:，会被 dsh 静默丢弃）';
      }
    }
  } catch (err) {
    detail = `YAML 解析失败：${String(err.message).split('\n')[0]}`;
  }
} else {
  ok = /- insert:/.test(after);
  detail = '（无 js-yaml，仅文本校验）';
}

console.log(`[set-relay-row] 回读校验：${ok ? 'OK' : 'FAIL'} ${detail}`);
process.exitCode = ok ? 0 : 1;
