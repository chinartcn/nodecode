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

export function generateId(prefix = 'n') {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;
}

export function pinKey(dir, name) {
  return `${dir}:${name}`;
}

/** 计算节点尺寸与所有端点坐标（相对节点左上角） */
export function getNodeLayout(node) {
  const def = getNodeDef(node?.name);
  if (!def) return null;

  const rows = Math.max(0, ...def.pins.map((pin) => pin.row)) + 1;
  const height = NODE_HEADER_HEIGHT + rows * NODE_ROW_HEIGHT + NODE_BODY_PADDING;

  const pins = def.pins.map((pin) => ({
    ...pin,
    x: pin.dir === 'in' ? 0 : def.width,
    y: NODE_HEADER_HEIGHT + pin.row * NODE_ROW_HEIGHT + NODE_ROW_HEIGHT / 2,
  }));

  return { def, width: def.width, height, pins };
}

export function getPinLayout(node, dir, name) {
  const layout = getNodeLayout(node);
  if (!layout) return null;
  return layout.pins.find((pin) => pin.dir === dir && pin.name === name) || null;
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

  // 保证有且有且仅有一个开始节点
  const beginIndexes = [];
  nodes.forEach((node, index) => {
    if (getNodeDef(node.name)?.type === 'begin') beginIndexes.push(index);
  });
  if (beginIndexes.length === 0) {
    nodes.unshift({ id: generateId('n'), name: 'begin', position: { x: 40, y: 60 }, data: {} });
  } else {
    for (let i = beginIndexes.length - 1; i >= 1; i -= 1) nodes.splice(beginIndexes[i], 1);
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
