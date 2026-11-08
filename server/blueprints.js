/**
 * 蓝图库：把当前工作区另存为多个命名蓝图，支持列表、加载、覆盖、重命名与删除。
 * 存储位置：data/blueprints/<id>.json
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeGraph } from '../shared/graph-utils.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'data', 'blueprints');
const ID_RE = /^[A-Za-z0-9_-]{4,80}$/;

async function ensureDir() {
  await mkdir(DIR, { recursive: true });
}

function fileOf(id) {
  if (!ID_RE.test(id)) throw new Error('蓝图 ID 非法');
  return path.join(DIR, `${id}.json`);
}

function makeId() {
  return `bp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function safeName(name) {
  return String(name || '').trim().slice(0, 60) || '未命名蓝图';
}

async function writeRecord(record) {
  const target = fileOf(record.id);
  const temp = `${target}.tmp`;
  await writeFile(temp, JSON.stringify(record, null, 2), 'utf8');
  await rename(temp, target);
}

function recordOf(raw) {
  const graph = normalizeGraph(raw.graph);
  return {
    id: String(raw.id),
    name: safeName(raw.name),
    createdAt: raw.createdAt || null,
    updatedAt: raw.updatedAt || null,
    graph,
  };
}

export async function listBlueprints() {
  await ensureDir();
  const files = (await readdir(DIR)).filter((file) => file.endsWith('.json'));
  const items = [];

  for (const file of files) {
    try {
      const raw = JSON.parse(await readFile(path.join(DIR, file), 'utf8'));
      if (!raw || !raw.id || !raw.graph) continue;
      const record = recordOf(raw);
      items.push({
        id: record.id,
        name: record.name,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        nodeCount: record.graph.nodes.length,
        connectionCount: record.graph.connections.length,
        functionCount: (record.graph.functions || []).length,
        variableCount: record.graph.variables.length,
      });
    } catch {
      // 忽略损坏的蓝图文件
    }
  }

  items.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return items;
}

export async function getBlueprint(id) {
  await ensureDir();
  const raw = JSON.parse(await readFile(fileOf(id), 'utf8'));
  return recordOf(raw);
}

export async function createBlueprint({ name, graph }) {
  await ensureDir();
  const now = new Date().toISOString();
  const record = {
    id: makeId(),
    name: safeName(name),
    createdAt: now,
    updatedAt: now,
    graph: normalizeGraph(graph),
  };
  await writeRecord(record);
  return {
    id: record.id,
    name: record.name,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export async function updateBlueprint(id, { name, graph }) {
  const existing = await getBlueprint(id);
  const record = {
    ...existing,
    name: typeof name === 'string' && name.trim() ? safeName(name) : existing.name,
    updatedAt: new Date().toISOString(),
    graph: graph ? normalizeGraph(graph) : existing.graph,
  };
  await writeRecord(record);
  return { id: record.id, name: record.name, updatedAt: record.updatedAt };
}

export async function deleteBlueprint(id) {
  await rm(fileOf(id), { force: true });
  return { ok: true };
}
