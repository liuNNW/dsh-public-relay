/**
 * resolve-deps.mjs — 让测试能从工作区解析 dsh 的模块
 *
 * 背景：插件源码 import 的是 dsh 自带包（@deepseek-ai/schemastery 等），
 * 它们只存在于 dsh 的安装目录或 $DSH_HOME/profiles/node_modules 里，不在工作区。
 * 测试从工作区运行时，Node 的解析路径找不到它们。
 *
 * 做法：把 dsh 的模块目录登记进模块解析路径，运行期生效、不改任何配置文件。
 *   - `$DSH_HOME/profiles/node_modules`（dsh 自愈维护的扁平回退目录）
 *   - npm 全局 dsh 安装目录内的 node_modules
 *   - Electron 安装目录的 app.asar.unpacked（若有）
 *
 * 用法（在测试文件顶部、import 插件之前）：
 *   import { ensureDshModules } from './resolve-deps.mjs';
 *   ensureDshModules();
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import module from 'node:module';

/** 收集所有可能含有 dsh 模块的目录。 */
export function dshModulePaths() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const candidates = [
    path.join(home, 'profiles', 'node_modules'),
    path.join(home, 'profiles', 'desktop', 'node_modules'),
    path.join(home, 'profiles', 'web', 'node_modules'),
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'),
  ];
  return candidates.filter((p) => p && fs.existsSync(p));
}

/**
 * 把 dsh 的模块目录加入模块解析路径（幂等）。
 * @returns 实际加入的目录列表。
 */
export function ensureDshModules() {
  const paths = dshModulePaths();
  if (paths.length === 0) return [];

  // Module.globalPaths 与 _initPaths 都影响 CommonJS 解析；ESM 的裸说明符解析
  // 走 Node 自己的算法，对 ESM 依赖我们依赖「同目录 node_modules」或全局路径，
  // 因此这里主要保证 CJS interop（js-yaml 等）可用。
  const M = module.default ?? module;
  if (M && typeof M === 'object') {
    for (const p of paths) {
      if (Array.isArray(M.globalPaths) && !M.globalPaths.includes(p)) M.globalPaths.push(p);
    }
  }

  // 关键一步：把路径写进 NODE_PATH 式的解析链，供 createRequire 使用。
  const existing = (process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean);
  const merged = [...new Set([...existing, ...paths])];
  process.env.NODE_PATH = merged.join(path.delimiter);
  if (M && typeof M._initPaths === 'function') M._initPaths();

  return paths;
}

/**
 * 用 dsh 的解析锚点 require 一个模块（用于测试里需要 CommonJS 的依赖）。
 * @param specifier - 模块名。
 * @param fromProfile - 用作锚点的 profile 目录（默认 desktop）。
 * @returns 模块导出。
 */
export function requireFromDsh(specifier, fromProfile) {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const dir = fromProfile || path.join(home, 'profiles', 'desktop');
  const anchor = path.join(dir, 'package.json');
  const createRequire = (module.default ?? module).createRequire;
  const req = createRequire(fs.existsSync(anchor) ? anchor : path.join(home, 'profiles', 'web', 'package.json'));
  return req(specifier);
}
