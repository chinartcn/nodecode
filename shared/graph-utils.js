/**
 * 图数据工具：布局计算、连接校验、数据归一化。
 * 同时被浏览器端编辑器与服务端使用。
 */

import {
  EXEC_IN,
  EXEC_OUT,
  NODE_BODY_PADDING,
  NODE_HEADER_HEIGHT,
  NODE_ROW_HEIGHT,
  getNodeDef,
} from './node-defs.js';
import { PROPERTY_TYPES, defaultPropertyValue } from './class-defs.js';
import { applyDynamicNodeDefs } from './dynamic-defs.js';

export function generateId(prefix = 'n') {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;
}

export function pinKey(dir, name) {
  return `${dir}:${name}`;
}

/**
 * 节点布局只与节点类型有关，按类型缓存，避免每帧重复分配对象与数组。
 * 返回对象为共享只读数据，请勿修改。
 */
const LAYOUT_CACHE = new Map();

/** 动态节点定义变化后清空布局缓存 */
export function clearLayoutCache() {
  LAYOUT_CACHE.clear();
}

/** 计算节点尺寸与所有端点坐标（相对节点左上角） */
export function getNodeLayout(node) {
  const def = getNodeDef(node?.name);
  if (!def) return null;

  const cached = LAYOUT_CACHE.get(def.name);
  if (cached) return cached;

  const rows = Math.max(0, ...def.pins.map((pin) => pin.row)) + 1;
  const height = NODE_HEADER_HEIGHT + rows * NODE_ROW_HEIGHT + NODE_BODY_PADDING;

  const pins = def.pins.map((pin) => ({
    ...pin,
    x: pin.dir === 'in' ? 0 : def.width,
    y: NODE_HEADER_HEIGHT + pin.row * NODE_ROW_HEIGHT + NODE_ROW_HEIGHT / 2,
  }));
  const pinMap = new Map(pins.map((pin) => [pinKey(pin.dir, pin.name), pin]));

  const layout = { def, width: def.width, height, pins, pinMap };
  LAYOUT_CACHE.set(def.name, layout);
  return layout;
}

export function getPinLayout(node, dir, name) {
  const layout = getNodeLayout(node);
  if (!layout) return null;
  return layout.pinMap.get(pinKey(dir, name)) || null;
}

export function getPinAbs(node, dir, name) {
  const pin = getPinLayout(node, dir, name);
  if (!pin) return null;
  return { x: node.position.x + pin.x, y: node.position.y + pin.y };
}

export function nodeBounds(node) {
  const layout = getNodeLayout(node);
  if (!layout) return null;
  return {
    x: node.position.x,
    y: node.position.y,
    width: layout.width,
    height: layout.height,
  };
}

export function isPinConnected(graph, nodeId, pinName, dir) {
  return (graph.connections || []).some((conn) =>
    dir === 'in'
      ? conn.toNodeId === nodeId && conn.toNodePinName === pinName
      : conn.fromNodeId === nodeId && conn.fromNodePinName === pinName
  );
}

/**
 * 校验一条连接是否合法，返回 null 表示合法，否则返回错误文案。
 * from 必须是输出端点，to 必须是输入端点。
 */
export function validateConnection(graph, from, to) {
  const nodes = new Map((graph.nodes || []).map((node) => [node.id, node]));
  const fromNode = nodes.get(from.nodeId);
  const toNode = nodes.get(to.nodeId);
  if (!fromNode || !toNode) return '节点不存在';
  if (fromNode.id === toNode.id) return '不能连接同一个节点';

  const fromPin = getPinLayout(fromNode, 'out', from.pinName);
  const toPin = getPinLayout(toNode, 'in', to.pinName);
  if (!fromPin) return '起点端点不存在';
  if (!toPin) return '目标端点不存在';
  if (fromPin.kind !== toPin.kind) {
    return fromPin.kind === 'exec' ? '执行端点只能连接执行端点' : '数据端点只能连接数据端点';
  }
  return null;
}

/**
 * 生成新连接并移除冲突连线。
 * 规则（与 codeck 一致）：
 * - exec 端点一对一
 * - port 输入一对一，port 输出可一对多
 */
export function buildConnection(graph, from, to) {
  const error = validateConnection(graph, from, to);
  if (error) return { error };

  const fromNode = graph.nodes.find((node) => node.id === from.nodeId);
  const fromPin = getPinLayout(fromNode, 'out', from.pinName);
  const isExec = fromPin.kind === 'exec';

  const connections = (graph.connections || []).filter((conn) => {
    if (
      conn.fromNodeId === from.nodeId &&
      conn.fromNodePinName === from.pinName &&
      conn.toNodeId === to.nodeId &&
      conn.toNodePinName === to.pinName
    ) {
      return false; // 重复连线
    }
    // 目标数据输入只能有一条入线
    if (conn.toNodeId === to.nodeId && conn.toNodePinName === to.pinName) return false;
    // 执行端点两端都只能有一条线
    if (isExec) {
      const touchesFrom =
        (conn.fromNodeId === from.nodeId && conn.fromNodePinName === from.pinName) ||
        (conn.toNodeId === from.nodeId && conn.toNodePinName === from.pinName);
      const touchesTo =
        (conn.fromNodeId === to.nodeId && conn.fromNodePinName === to.pinName) ||
        (conn.toNodeId === to.nodeId && conn.toNodePinName === to.pinName);
      if (touchesFrom || touchesTo) return false;
    }
    return true;
  });

  const connection = {
    id: generateId('c'),
    fromNodeId: from.nodeId,
    fromNodePinName: from.pinName,
    toNodeId: to.nodeId,
    toNodePinName: to.pinName,
  };

  return { connections: [...connections, connection], connection };
}

/** 归一化任意来源的图数据，保证编辑器拿到的是安全结构 */
export function normalizeGraph(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};

  // 先归一化函数/类元信息，再注册动态节点定义，最后处理各子图连线
  const functions = normalizeFunctions(source.functions);
  const classes = normalizeClasses(source.classes);
  if (functions.length > 0 || classes.length > 0) {
    applyDynamicNodeDefs(functions, classes);
    clearLayoutCache();
  }
  for (const fn of functions) {
    fn.graph = normalizeScope(fn.graph, { singleTrigger: true });
  }
  for (const cls of classes) {
    for (const method of cls.methods) {
      method.graph = normalizeScope(method.graph, { singleTrigger: true });
    }
  }

  const scope = normalizeScope(source);
  return { ...scope, functions, classes };
}

function normalizeSignature(list, prefix) {
  if (!Array.isArray(list)) return [];
  const usedIds = new Set();
  return list
    .map((item, index) => {
      if (!item || typeof item !== 'object') return null;
      let id = String(item.id || '').trim();
      if (!id || usedIds.has(id)) id = generateId(prefix);
      usedIds.add(id);
      const name = String(item.name || '').trim();
      return {
        id,
        name: name || `${prefix === 'i' ? '输入' : '输出'}${index + 1}`,
        type: ['string', 'number', 'boolean', 'object', 'array'].includes(item.type)
          ? item.type
          : 'string',
      };
    })
    .filter(Boolean);
}

function normalizeFunctions(list) {
  if (!Array.isArray(list)) return [];
  const usedIds = new Set();
  return list
    .map((rawFn, index) => {
      if (!rawFn || typeof rawFn !== 'object') return null;
      let id = String(rawFn.id || '').trim();
      if (!id || usedIds.has(id)) id = generateId('fn');
      usedIds.add(id);
      return {
        id,
        name: String(rawFn.name || '').trim() || `函数${index + 1}`,
        inputs: normalizeSignature(rawFn.inputs, 'i'),
        outputs: normalizeSignature(rawFn.outputs, 'o'),
        graph: rawFn.graph && typeof rawFn.graph === 'object' ? rawFn.graph : {},
      };
    })
    .filter(Boolean);
}

function normalizeProperties(list) {
  if (!Array.isArray(list)) return [];
  const usedIds = new Set();
  const usedNames = new Set();
  return list
    .map((raw, index) => {
      if (!raw || typeof raw !== 'object') return null;
      let id = String(raw.id || '').trim();
      if (!id || usedIds.has(id)) id = generateId('p');
      usedIds.add(id);

      let name = String(raw.name || '').trim() || `属性${index + 1}`;
      if (usedNames.has(name)) {
        let suffix = 2;
        while (usedNames.has(`${name}_${suffix}`)) suffix += 1;
        name = `${name}_${suffix}`;
      }
      usedNames.add(name);

      const type = PROPERTY_TYPES.includes(raw.type) ? raw.type : 'string';
      return {
        id,
        name,
        type,
        value: defaultPropertyValue(type, raw.value),
      };
    })
    .filter(Boolean);
}

function normalizeMethods(list) {
  if (!Array.isArray(list)) return [];
  const usedIds = new Set();
  const usedNames = new Set();
  return list
    .map((raw, index) => {
      if (!raw || typeof raw !== 'object') return null;
      let id = String(raw.id || '').trim();
      if (!id || usedIds.has(id)) id = generateId('m');
      usedIds.add(id);

      let name = String(raw.name || '').trim();
      if (!name || name === 'constructor') name = `方法${index + 1}`;
      if (usedNames.has(name)) {
        let suffix = 2;
        while (usedNames.has(`${name}_${suffix}`)) suffix += 1;
        name = `${name}_${suffix}`;
      }
      usedNames.add(name);

      return {
        id,
        name,
        inputs: normalizeSignature(raw.inputs, 'i'),
        outputs: normalizeSignature(raw.outputs, 'o'),
        graph: raw.graph && typeof raw.graph === 'object' ? raw.graph : {},
      };
    })
    .filter(Boolean);
}

function normalizeClasses(list) {
  if (!Array.isArray(list)) return [];
  const usedIds = new Set();
  const usedNames = new Set();
  return list
    .map((raw, index) => {
      if (!raw || typeof raw !== 'object') return null;
      let id = String(raw.id || '').trim();
      if (!id || usedIds.has(id)) id = generateId('cls');
      usedIds.add(id);

      let name = String(raw.name || '').trim() || `类${index + 1}`;
      if (usedNames.has(name)) {
        let suffix = 2;
        while (usedNames.has(`${name}_${suffix}`)) suffix += 1;
        name = `${name}_${suffix}`;
      }
      usedNames.add(name);

      return {
        id,
        name,
        properties: normalizeProperties(raw.properties),
        methods: normalizeMethods(raw.methods),
      };
    })
    .filter(Boolean);
}

/** 归一化单张图（主图或某个函数内部图） */
function normalizeScope(raw, options = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const nodes = [];

  if (Array.isArray(source.nodes)) {
    for (const item of source.nodes) {
      if (!item || typeof item !== 'object') continue;
      const def = getNodeDef(item.name);
      if (!def) continue;
      const position = item.position && typeof item.position === 'object' ? item.position : {};
      nodes.push({
        id: String(item.id || generateId('n')),
        name: def.name,
        position: {
          x: Number.isFinite(Number(position.x)) ? Number(position.x) : 0,
          y: Number.isFinite(Number(position.y)) ? Number(position.y) : 0,
        },
        data: item.data && typeof item.data === 'object' ? JSON.parse(JSON.stringify(item.data)) : {},
      });
    }
  }

  // 触发节点：主图可多个，函数内部只保留一个
  const triggerIndexes = [];
  nodes.forEach((node, index) => {
    if (getNodeDef(node.name)?.type === 'begin') triggerIndexes.push(index);
  });
  if (triggerIndexes.length === 0) {
    nodes.unshift({ id: generateId('n'), name: 'begin', position: { x: 40, y: 60 }, data: {} });
  } else if (options.singleTrigger) {
    for (let i = triggerIndexes.length - 1; i >= 1; i -= 1) nodes.splice(triggerIndexes[i], 1);
  }

  const ids = new Set();
  const uniqueNodes = nodes.filter((node) => {
    if (ids.has(node.id)) return false;
    ids.add(node.id);
    return true;
  });

  const nodeMap = new Map(uniqueNodes.map((node) => [node.id, node]));
  const connections = [];
  const connectionKeys = new Set();
  if (Array.isArray(source.connections)) {
    for (const conn of source.connections) {
      if (!conn || typeof conn !== 'object') continue;
      const fromNode = nodeMap.get(conn.fromNodeId);
      const toNode = nodeMap.get(conn.toNodeId);
      if (!fromNode || !toNode) continue;
      if (!getPinLayout(fromNode, 'out', conn.fromNodePinName)) continue;
      if (!getPinLayout(toNode, 'in', conn.toNodePinName)) continue;
      const key = [conn.fromNodeId, conn.fromNodePinName, conn.toNodeId, conn.toNodePinName].join('|');
      if (connectionKeys.has(key)) continue;
      connectionKeys.add(key);
      connections.push({
        id: String(conn.id || generateId('c')),
        fromNodeId: conn.fromNodeId,
        fromNodePinName: conn.fromNodePinName,
        toNodeId: conn.toNodeId,
        toNodePinName: conn.toNodePinName,
      });
    }
  }

  const variables = [];
  if (Array.isArray(source.variables)) {
    const names = new Set();
    for (const variable of source.variables) {
      if (!variable || typeof variable !== 'object') continue;
      const name = String(variable.name || '').trim();
      if (!name || names.has(name)) continue;
      names.add(name);
      variables.push({
        name,
        type: ['string', 'number', 'boolean', 'object', 'array'].includes(variable.type)
          ? variable.type
          : 'string',
        value: variable.value ?? '',
      });
    }
  }

  return { nodes: uniqueNodes, connections, variables };
}

export { EXEC_IN, EXEC_OUT };
