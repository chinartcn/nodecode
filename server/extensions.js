/**
 * 外部扩展节点加载器。
 * 支持：
 * - extensions/*.json：声明式节点（codeTemplate）
 * - extensions/*.js / *.mjs：ESM 模块，可直接提供 code(ctx) 函数
 * 文件内容可以是单个节点、数组，或 { nodes: [...] }。
 *
 * 另外支持导入 .zip 扩展包：解压其中的 .json / .js / .mjs 到 extensions/ 后热重载。
 */

import { access, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ABI_VERSION,
  buildExternalNodeDef,
  buildJsExternalNodeDef,
  renderTemplate,
} from '../shared/abi.js';
import { EXEC_IN, EXEC_OUT, setExternalNodeDefs } from '../shared/node-defs.js';
import { readZipEntries } from './zip.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSIONS_DIR = path.join(ROOT, 'extensions');

const JS_EXTENSIONS = new Set(['.js', '.mjs']);
const PACKAGE_FILE_RE = /\.(json|js|mjs)$/i;
const SAFE_FILE_RE = /^[\p{L}\p{N}._-]+$/u;

// 带查询参数 import，避免热重载时命中 ESM 模块缓存
let importNonce = 0;

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

/**
 * 加载 extensions/ 下的全部扩展。
 * @returns {{defs:Array, errors:{file:string,message:string}[], files:string[]}}
 */
export async function loadExtensions() {
  const defs = [];
  const errors = [];
  const loadedFiles = [];
  const names = new Set();
  let files = [];

  // 先清空旧的外部节点，避免热重载时把上一版节点当成同名冲突
  setExternalNodeDefs([]);

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
        importNonce += 1;
        const moduleUrl = `${pathToFileURL(filePath).href}?v=${Date.now()}_${importNonce}`;
        const module = await import(moduleUrl);
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
      loadedFiles.push(file);
    } catch (error) {
      errors.push({ file, message: error.message });
      console.warn(`[extensions] ${file} 加载失败：${error.message}`);
    }
  }

  setExternalNodeDefs(defs);
  if (defs.length > 0) {
    console.log(`[extensions] 已加载 ${defs.length} 个外部节点`);
  }
  return { defs, errors, files: loadedFiles };
}

/** 把 ZIP 内条目扁平化为安全的扩展文件名 */
function safePackageFileName(rawName) {
  const normalized = String(rawName || '').replace(/\\/g, '/');
  if (normalized.split('/').includes('..')) return null;
  const base = normalized.split('/').pop()?.trim() || '';
  if (!base || base.startsWith('.') || base.includes('\0')) return null;
  if (!PACKAGE_FILE_RE.test(base)) return null;
  if (!SAFE_FILE_RE.test(base)) return null;
  return base;
}

/**
 * 安装 .zip 扩展包：解压合法扩展文件到 extensions/，然后热重载。
 * 同名文件会被覆盖。
 * @param {Buffer} buffer ZIP 二进制
 * @returns {Promise<{files:string[], overwritten:string[], skipped:string[], nodes:string[], errors:Array}>}
 */
export async function installExtensionZip(buffer) {
  const entries = readZipEntries(buffer);
  await mkdir(EXTENSIONS_DIR, { recursive: true });

  const files = [];
  const overwritten = [];
  const skipped = [];
  const seen = new Set();

  for (const entry of entries) {
    const fileName = safePackageFileName(entry.name);
    if (!fileName) {
      if (!entry.name.endsWith('/') && !entry.name.startsWith('__MACOSX/')) {
        skipped.push(entry.name);
      }
      continue;
    }
    if (seen.has(fileName)) {
      skipped.push(entry.name);
      continue;
    }
    seen.add(fileName);

    const target = path.join(EXTENSIONS_DIR, fileName);
    let existed = false;
    try {
      await access(target);
      existed = true;
    } catch {
      existed = false;
    }

    const temp = `${target}.tmp`;
    await writeFile(temp, entry.data);
    await rename(temp, target);

    files.push(fileName);
    if (existed) overwritten.push(fileName);
  }

  if (files.length === 0) {
    throw new Error('压缩包中没有可导入的扩展文件（.json / .js / .mjs）');
  }

  const result = await loadExtensions();
  return {
    files,
    overwritten,
    skipped,
    nodes: result.defs.map((def) => def.name),
    errors: result.errors,
  };
}
