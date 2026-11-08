/**
 * 把当前图中的一组节点封装为函数（子图）。
 * 自动处理与外部之间的边界连线，生成函数输入/输出签名。
 */

import { EXEC_IN, EXEC_OUT, getNodeDef } from './node-defs.js';
import { generateId, getNodeLayout, getPinLayout } from './graph-utils.js';
import {
  functionArgDefName,
  functionCallDefName,
  functionRetDefName,
  typeForEditor,
} from './function-defs.js';

function cloneData(data) {
  try {
    return JSON.parse(JSON.stringify(data || {}));
  } catch {
    return {};
  }
}

function uniqueName(base, used) {
  const prefix = String(base || '端口').trim() || '端口';
  let name = prefix;
  let index = 2;
  while (used.has(name)) {
    name = `${prefix}${index}`;
    index += 1;
  }
  used.add(name);
  return name;
}

export function wrapSelectionAsFunction(graph, selectedIds, name) {
  const nodes = graph.nodes || [];
  const selectedSet = new Set(selectedIds || []);
  const selected = nodes.filter(
    (node) => selectedSet.has(node.id) && getNodeDef(node.name)?.type !== 'begin'
  );
  if (!selected.length) return { error: '请先选择要封装的节点' };

  const selectedNodeIds = new Set(selected.map((node) => node.id));
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const warnings = [];
  const fnId = generateId('fn');
  const fnName = String(name || '').trim() || '函数';

  const internal = [];
  const incoming = [];
  const outgoing = [];
  const outerKept = [];

  for (const conn of graph.connections || []) {
    const fromInside = selectedNodeIds.has(conn.fromNodeId);
    const toInside = selectedNodeIds.has(conn.toNodeId);
    if (fromInside && toInside) internal.push(conn);
    else if (!fromInside && toInside) incoming.push(conn);
    else if (fromInside && !toInside) outgoing.push(conn);
    else outerKept.push(conn);
  }

  const pinOf = (nodeId, dir, pinName) => {
    const node = nodeMap.get(nodeId);
    return node ? getPinLayout(node, dir, pinName) : null;
  };

  const inputs = [];
  const outputs = [];
  const fnConnections = internal.map((conn) => ({ ...conn, id: generateId('c') }));
  const outerConnections = outerKept.map((conn) => ({ ...conn, id: generateId('c') }));

  const usedInputNames = new Set();
  const usedOutputNames = new Set();
  const inputNodes = [];
  const outputNodes = [];
  const callNodeId = generateId('n');

  // 边界数据输入：每个输入参数一个独立节点
  for (const conn of incoming) {
    const pin = pinOf(conn.toNodeId, 'in', conn.toNodePinName);
    if (!pin || pin.kind !== 'port') continue;
    const entry = {
      id: generateId('p'),
      name: uniqueName(pin.label || pin.name, usedInputNames),
      type: typeForEditor(pin.editor),
    };
    inputs.push(entry);
    const inputNodeId = generateId('n');
    inputNodes.push({ entry, nodeId: inputNodeId });
    fnConnections.push({
      id: generateId('c'),
      fromNodeId: inputNodeId,
      fromNodePinName: 'value',
      toNodeId: conn.toNodeId,
      toNodePinName: conn.toNodePinName,
    });
    outerConnections.push({
      id: generateId('c'),
      fromNodeId: conn.fromNodeId,
      fromNodePinName: conn.fromNodePinName,
      toNodeId: callNodeId,
      toNodePinName: `i_${entry.id}`,
    });
  }

  // 边界数据输出（同一个源端点只生成一个输出）
  const outputBySource = new Map();
  for (const conn of outgoing) {
    const pin = pinOf(conn.fromNodeId, 'out', conn.fromNodePinName);
    if (!pin || pin.kind !== 'port') continue;
    const key = `${conn.fromNodeId}|${conn.fromNodePinName}`;
    let entry = outputBySource.get(key);
    if (!entry) {
      entry = {
        id: generateId('p'),
        name: uniqueName(pin.label || pin.name, usedOutputNames),
        type: typeForEditor(pin.editor),
      };
      outputs.push(entry);
      outputBySource.set(key, entry);

      const outputNodeId = generateId('n');
      outputNodes.push({ entry, nodeId: outputNodeId });
      fnConnections.push({
        id: generateId('c'),
        fromNodeId: conn.fromNodeId,
        fromNodePinName: conn.fromNodePinName,
        toNodeId: outputNodeId,
        toNodePinName: 'value',
      });
    }
    outerConnections.push({
      id: generateId('c'),
      fromNodeId: callNodeId,
      fromNodePinName: `o_${entry.id}`,
      toNodeId: conn.toNodeId,
      toNodePinName: conn.toNodePinName,
    });
  }

  const incomingExec = incoming.filter(
    (conn) => pinOf(conn.toNodeId, 'in', conn.toNodePinName)?.kind === 'exec'
  );
  const outgoingExec = outgoing.filter(
    (conn) => pinOf(conn.fromNodeId, 'out', conn.fromNodePinName)?.kind === 'exec'
  );
  if (incomingExec.length > 1) warnings.push('存在多个执行输入，仅保留第一条');
  if (outgoingExec.length > 1) warnings.push('存在多个执行输出，仅保留第一条');

  const beginNodeId = generateId('n');
  let entryTarget = null;

  if (incomingExec.length) {
    const conn = incomingExec[0];
    entryTarget = { nodeId: conn.toNodeId, pinName: conn.toNodePinName };
    outerConnections.push({
      id: generateId('c'),
      fromNodeId: conn.fromNodeId,
      fromNodePinName: conn.fromNodePinName,
      toNodeId: callNodeId,
      toNodePinName: EXEC_IN,
    });
  } else {
    for (const node of selected) {
      const layout = getNodeLayout(node);
      const execIn = layout?.pins.find((pin) => pin.dir === 'in' && pin.kind === 'exec');
      if (!execIn) continue;
      const hasInternalIn = internal.some(
        (conn) => conn.toNodeId === node.id && conn.toNodePinName === execIn.name
      );
      if (!hasInternalIn) {
        entryTarget = { nodeId: node.id, pinName: execIn.name };
        break;
      }
    }
  }

  if (entryTarget) {
    fnConnections.push({
      id: generateId('c'),
      fromNodeId: beginNodeId,
      fromNodePinName: EXEC_OUT,
      toNodeId: entryTarget.nodeId,
      toNodePinName: entryTarget.pinName,
    });
  } else {
    warnings.push('未找到函数入口执行流，请在函数内部手动连接开始节点');
  }

  // 输出参数使用独立节点，不需要执行流终点
  if (outgoingExec.length) {
    const conn = outgoingExec[0];
    outerConnections.push({
      id: generateId('c'),
      fromNodeId: callNodeId,
      fromNodePinName: EXEC_OUT,
      toNodeId: conn.toNodeId,
      toNodePinName: conn.toNodePinName,
    });
  }

  // 复制内部用到的变量
  const usedVariableNames = new Set();
  for (const node of selected) {
    if ((node.name === 'varget' || node.name === 'varset') && node.data?.name) {
      usedVariableNames.add(node.data.name);
    }
  }
  const variables = (graph.variables || [])
    .filter((variable) => usedVariableNames.has(variable.name))
    .map((variable) => ({ ...variable }));

  const bounds = selected.reduce(
    (acc, node) => {
      const layout = getNodeLayout(node);
      acc.minX = Math.min(acc.minX, node.position.x);
      acc.minY = Math.min(acc.minY, node.position.y);
      acc.maxX = Math.max(acc.maxX, node.position.x + (layout?.width || 0));
      acc.maxY = Math.max(acc.maxY, node.position.y + (layout?.height || 0));
      return acc;
    },
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  );

  const innerNodes = selected.map((node) => ({
    id: node.id,
    name: node.name,
    position: { x: node.position.x, y: node.position.y },
    data: cloneData(node.data),
  }));

  const fnNodes = [
    {
      id: beginNodeId,
      name: 'begin',
      position: { x: bounds.minX - 250, y: bounds.minY - 120 },
      data: {},
    },
    ...innerNodes,
  ];
  inputNodes.forEach((item, index) => {
    fnNodes.push({
      id: item.nodeId,
      name: functionArgDefName(fnId, item.entry.id),
      position: { x: bounds.minX - 250, y: bounds.minY + 40 + index * 110 },
      data: {},
    });
  });
  outputNodes.forEach((item, index) => {
    fnNodes.push({
      id: item.nodeId,
      name: functionRetDefName(fnId, item.entry.id),
      position: { x: bounds.maxX + 70, y: bounds.minY + 40 + index * 110 },
      data: {},
    });
  });

  const functionDef = {
    id: fnId,
    name: fnName,
    inputs,
    outputs,
    graph: { nodes: fnNodes, connections: fnConnections, variables },
  };

  const callNode = {
    id: callNodeId,
    name: functionCallDefName(fnId),
    position: {
      x: bounds.minX + (bounds.maxX - bounds.minX) / 2 - 120,
      y: Math.max(40, bounds.minY - 160),
    },
    data: {},
  };

  const outerGraph = {
    nodes: [...nodes.filter((node) => !selectedNodeIds.has(node.id)), callNode],
    connections: outerConnections,
    variables: graph.variables || [],
  };

  return { functionDef, outerGraph, callNodeId, warnings };
}
