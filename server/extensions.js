/**
 * 外部扩展节点加载器。
 * 支持：
 * - extensions/*.json：声明式节点（codeTemplate）
 * - extensions/*.js / *.mjs：ESM 模块，可直接提供 code(ctx) 函数
 * 文件内容可以是单个节点、数组，或 { nodes: [...] }。
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ABI_VERSION,
  buildExternalNodeDef,
  buildJsExternalNodeDef,
  renderTemplate,
} from '../shared/abi.js';
import { EXEC_IN, EXEC_OUT, setExternalNodeDefs } from '../shared/node-defs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSIONS_DIR = path.join(ROOT, 'extensions');

const JS_EXTENSIONS = new Set(['.js', '.mjs']);

/** 供 JS 扩展默认导出函数使用的小工具 */
const ABI_HELPERS = {
  version: ABI_VERSION,
  defineNode: buildExternalNodeDef,
  buildNode: buildExternalNodeDef,
  render: renderTemplate,
  EXEC_IN,
  EXEC_OUT,
};

function extractItems(exported) {
  if (Array.isArray(exported)) return exported;
  if (exported && Array.isArray(exported.nodes)) return exported.nodes;
  return [exported];
}

export async function loadExtensions() {
  const defs = [];
  const names = new Set();
  let files = [];

  try {
    files = (await readdir(EXTENSIONS_DIR))
      .filter((file) => /\.(json|js|mjs)$/i.test(file))
      .sort();
  } catch {
    files = [];
  }

  for (const file of files) {
    const filePath = path.join(EXTENSIONS_DIR, file);
    const ext = path.extname(file).toLowerCase();

    try {
      let items = [];

      if (JS_EXTENSIONS.has(ext)) {
        // 动态 import，保证扩展可以使用完整的 JS 代码生成函数
        const module = await import(pathToFileURL(filePath).href);
        let exported = module.default ?? module.nodes ?? module;
        if (typeof exported === 'function') {
          exported = await exported(ABI_HELPERS);
        }
        items = extractItems(exported);
        items = items.map((item) => buildJsExternalNodeDef(item));
      } else {
        const raw = JSON.parse(await readFile(filePath, 'utf8'));
        items = extractItems(raw).map((item) => buildExternalNodeDef(item));
      }

      for (const def of items) {
        if (!def || !def.name) continue;
        if (names.has(def.name)) {
          console.warn(`[extensions] 跳过重复节点：${def.name}`);
          continue;
        }
        names.add(def.name);
        defs.push(def);
      }
    } catch (error) {
      console.warn(`[extensions] ${file} 加载失败：${error.message}`);
    }
  }

  setExternalNodeDefs(defs);
  if (defs.length > 0) {
    console.log(`[extensions] 已加载 ${defs.length} 个外部节点`);
  }
  return defs;
}
