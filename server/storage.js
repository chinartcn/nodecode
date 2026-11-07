/**
 * 蓝图持久化：保存到 data/workspace.json
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeGraph } from '../shared/graph-utils.js';
import { examples } from './examples.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');
const FILE = path.join(DATA_DIR, 'workspace.json');

export async function loadState() {
  try {
    const raw = JSON.parse(await readFile(FILE, 'utf8'));
    return {
      name: typeof raw.name === 'string' ? raw.name : '我的蓝图',
      updatedAt: raw.updatedAt || null,
      graph: normalizeGraph(raw.graph),
    };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[storage] 读取工作区失败，使用示例重建：', error.message);
    }
    const seed = examples[0];
    const state = {
      name: seed.name,
      updatedAt: new Date().toISOString(),
      graph: normalizeGraph(seed.graph),
    };
    await saveState(state);
    return state;
  }
}

export async function saveState({ name, graph }) {
  await mkdir(DATA_DIR, { recursive: true });
  const payload = {
    name: String(name || '我的蓝图').slice(0, 60),
    updatedAt: new Date().toISOString(),
    graph: normalizeGraph(graph),
  };
  const tempFile = `${FILE}.tmp`;
  await writeFile(tempFile, JSON.stringify(payload, null, 2), 'utf8');
  await rename(tempFile, FILE);
  return payload;
}
