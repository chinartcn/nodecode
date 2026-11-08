/**
 * 模块（外部子图）工具：解析模块 JSON、识别触发节点、合并到当前工作区。
 *
 * 语义：
 * - 模块 JSON 就是一张图（可携带 functions / classes）。
 * - 含触发节点的模块合并进主图后，触发节点作为独立入口并发运行。
 * - 纯数据模块合并后不添加触发节点，仅保留节点/连线，由用户继续连线传值。
 * - 所有节点、连线、函数、类 id 都会重新分配，避免与现有工作区冲突。
 */

import { getNodeDef } from './node-defs.js';
import { generateId, getNodeLayout, normalizeGraph } from './graph-utils.js';

const FUNCTION_NODE_PREFIXES = ['fncall:', 'fnin:', 'fnout:', 'fnarg:', 'fnret:'];
const CLASS_NODE_PREFIXES = [
  'clsnew:',
  'clsget:',
  'clsset:',
  'clscall:',
  'clsselfget:',
  'clsselfset:',
  'clsarg:',
  'clsret:',
];

export function isTriggerNode(node) {
  return getNodeDef(node?.name)?.type === 'begin';
}

export function hasTriggerNodes(nodes) {
  return (nodes || []).some(isTriggerNode);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** 从多种导出格式中提取模块图与名称 */
export function extractModule(payload) {
  const data = payload && typeof payload === 'object' ? payload : {};
  let graph = null;
  if (data.graph && typeof data.graph === 'object' && Array.isArray(data.graph.nodes)) {
    graph = data.graph;
  } else if (data.main && typeof data.main === 'object' && Array.isArray(data.main.nodes)) {
    graph = {
      nodes: data.main.nodes,
      connections: data.main.connections,
      variables: data.main.variables,
      functions: data.functions || data.graph?.functions,
      classes: data.classes || data.graph?.classes,
    };
  } else if (Array.isArray(data.nodes)) {
    graph = data;
  }
  return {
    name: String(data.name || data.moduleName || '').trim() || '导入模块',
    graph,
  };
}

/** 把函数 id 变化同步到各种函数节点名上 */
function remapFunctionNodeName(name, fnIdMap) {
  if (typeof name !== 'string' || fnIdMap.size === 0) return name;
  for (const prefix of FUNCTION_NODE_PREFIXES) {
    if (!name.startsWith(prefix)) continue;
    const rest = name.slice(prefix.length);
    const separator = rest.indexOf(':');
    const oldId = separator === -1 ? rest : rest.slice(0, separator);
    const newId = fnIdMap.get(oldId);
    if (!newId) return name;
    return `${prefix}${newId}${separator === -1 ? '' : rest.slice(separator)}`;
  }
  return name;
}

/** 把类 id 变化同步到各种类节点名上 */
function remapClassNodeName(name, classIdMap) {
  if (typeof name !== 'string' || classIdMap.size === 0) return name;
  for (const prefix of CLASS_NODE_PREFIXES) {
    if (!name.startsWith(prefix)) continue;
    const rest = name.slice(prefix.length);
    const separator = rest.indexOf(':');
    const oldId = separator === -1 ? rest : rest.slice(0, separator);
    const newId = classIdMap.get(oldId);
    if (!newId) return name;
    return `${prefix}${newId}${separator === -1 ? '' : rest.slice(separator)}`;
  }
  return name;
}

function remapDynamicNodeName(name, fnIdMap, classIdMap) {
  return remapClassNodeName(remapFunctionNodeName(name, fnIdMap), classIdMap);
}

function boundsOf(nodes) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    const layout = getNodeLayout(node);
    const x = node.position?.x || 0;
    const y = node.position?.y || 0;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + (layout?.width || 180));
    maxY = Math.max(maxY, y + (layout?.height || 120));
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

/** 把模块放在现有图右侧，避免直接重叠 */
function computeOffset(targetNodes, sourceNodes) {
  if (!targetNodes.length || !sourceNodes.length) return { x: 0, y: 0 };
  const target = boundsOf(targetNodes);
  const source = boundsOf(sourceNodes);
  if (!target || !source) return { x: 0, y: 0 };
  return { x: target.maxX - source.minX + 80, y: target.minY - source.minY };
}

function remapScopeGraph(graph, fnIdMap, classIdMap) {
  const source = graph && typeof graph === 'object' ? graph : {};
  const idMap = new Map();
  const nodes = (source.nodes || []).map((node) => {
    const id = generateId('n');
    idMap.set(node.id, id);
    return {
      ...clone(node),
      id,
      name: remapDynamicNodeName(node.name, fnIdMap, classIdMap),
    };
  });
  const connections = (source.connections || [])
    .map((conn) => ({
      id: generateId('c'),
      fromNodeId: idMap.get(conn.fromNodeId),
      fromNodePinName: conn.fromNodePinName,
      toNodeId: idMap.get(conn.toNodeId),
      toNodePinName: conn.toNodePinName,
    }))
    .filter((conn) => conn.fromNodeId && conn.toNodeId);
  return {
    nodes,
    connections,
    variables: clone(source.variables || []),
  };
}

/**
 * 合并模块到目标图。
 * @param {{nodes:Array,connections:Array,variables:Array}} targetGraph 当前作用域的图
 * @param {object} payload 模块 JSON
 * @param {{targetScope?:string, takenFunctionNames?:string[], offset?:{x:number,y:number}}} options
 * @returns {{name:string, hasTrigger:boolean, graph:object, functions:Array, summary:object}}
 */
export function mergeModuleGraph(targetGraph, payload, options = {}) {
  const parsed = extractModule(payload);
  const raw = parsed.graph;
  if (!raw || !Array.isArray(raw.nodes) || !Array.isArray(raw.connections)) {
    throw new Error('文件内容不是有效的模块 JSON');
  }

  const target = {
    nodes: clone(targetGraph?.nodes || []),
    connections: clone(targetGraph?.connections || []),
    variables: clone(targetGraph?.variables || []),
  };
  const originalVariableCount = target.variables.length;

  // 判断模块自身是否带触发节点（归一化会自动补 begin，所以必须看原始数据）
  const sourceHasTrigger = hasTriggerNodes(raw.nodes);
  const normalized = normalizeGraph(raw);

  // 函数：统一分配新 id；名称冲突时追加序号
  const takenNames = new Set(options.takenFunctionNames || []);
  const fnIdMap = new Map();
  const importedFunctions = [];
  for (const fn of normalized.functions || []) {
    const newId = generateId('fn');
    fnIdMap.set(fn.id, newId);
    let name = String(fn.name || '函数').trim() || '函数';
    if (takenNames.has(name)) {
      let index = 2;
      while (takenNames.has(`${name}_${index}`)) index += 1;
      name = `${name}_${index}`;
    }
    takenNames.add(name);
    importedFunctions.push({
      id: newId,
      name,
      inputs: clone(fn.inputs || []),
      outputs: clone(fn.outputs || []),
      graph: null,
    });
  }
  // 类：统一分配新 id；名称冲突时追加序号
  const takenClassNames = new Set(options.takenClassNames || []);
  const classIdMap = new Map();
  const importedClasses = [];
  for (const cls of normalized.classes || []) {
    const newId = generateId('cls');
    classIdMap.set(cls.id, newId);
    let name = String(cls.name || '类').trim() || '类';
    if (takenClassNames.has(name)) {
      let index = 2;
      while (takenClassNames.has(`${name}_${index}`)) index += 1;
      name = `${name}_${index}`;
    }
    takenClassNames.add(name);
    importedClasses.push({
      id: newId,
      name,
      properties: clone(cls.properties || []),
      methods: (cls.methods || []).map((method) => ({
        id: method.id,
        name: method.name,
        inputs: clone(method.inputs || []),
        outputs: clone(method.outputs || []),
        graph: null,
      })),
    });
  }

  // 函数与类都分配完 id 后，再重写各子图（函数可调用类，方法也可调用函数/类）
  for (let index = 0; index < (normalized.functions || []).length; index += 1) {
    importedFunctions[index].graph = remapScopeGraph(
      normalized.functions[index].graph,
      fnIdMap,
      classIdMap
    );
  }
  for (let classIndex = 0; classIndex < (normalized.classes || []).length; classIndex += 1) {
    const sourceClass = normalized.classes[classIndex];
    const targetClass = importedClasses[classIndex];
    for (let methodIndex = 0; methodIndex < (sourceClass.methods || []).length; methodIndex += 1) {
      targetClass.methods[methodIndex].graph = remapScopeGraph(
        sourceClass.methods[methodIndex].graph,
        fnIdMap,
        classIdMap
      );
    }
  }

  // 变量：同名同类型复用，同名不同类型则重命名
  const variableNameMap = new Map();
  for (const variable of normalized.variables || []) {
    const existing = target.variables.find((item) => item.name === variable.name);
    if (!existing) {
      target.variables.push(clone(variable));
      variableNameMap.set(variable.name, variable.name);
      continue;
    }
    if (existing.type === variable.type) {
      variableNameMap.set(variable.name, existing.name);
      continue;
    }
    let name = variable.name;
    let index = 2;
    while (target.variables.some((item) => item.name === name)) {
      name = `${variable.name}_${index}`;
      index += 1;
    }
    target.variables.push({ ...clone(variable), name });
    variableNameMap.set(variable.name, name);
  }

  // 触发节点仅在「模块自带触发」且「目标是主图」时保留
  const scope = options.targetScope || 'main';
  const keepTriggers = sourceHasTrigger && scope === 'main';
  const sourceNodes = normalized.nodes.filter(
    (node) => !isTriggerNode(node) || keepTriggers
  );

  const offset = options.offset || computeOffset(target.nodes, sourceNodes);
  const nodeIdMap = new Map();
  const addedNodes = sourceNodes.map((node) => {
    const id = generateId('n');
    nodeIdMap.set(node.id, id);
    const data = clone(node.data || {});
    if ((node.name === 'varget' || node.name === 'varset') && variableNameMap.has(data.name)) {
      data.name = variableNameMap.get(data.name);
    }
    return {
      id,
      name: remapDynamicNodeName(node.name, fnIdMap, classIdMap),
      position: {
        x: (node.position?.x || 0) + offset.x,
        y: (node.position?.y || 0) + offset.y,
      },
      data,
    };
  });

  const addedConnections = [];
  for (const conn of normalized.connections || []) {
    const fromNodeId = nodeIdMap.get(conn.fromNodeId);
    const toNodeId = nodeIdMap.get(conn.toNodeId);
    if (!fromNodeId || !toNodeId) continue;
    addedConnections.push({
      id: generateId('c'),
      fromNodeId,
      fromNodePinName: conn.fromNodePinName,
      toNodeId,
      toNodePinName: conn.toNodePinName,
    });
  }

  return {
    name: parsed.name,
    hasTrigger: sourceHasTrigger,
    graph: {
      nodes: [...target.nodes, ...addedNodes],
      connections: [...target.connections, ...addedConnections],
      variables: target.variables,
    },
    functions: importedFunctions,
    classes: importedClasses,
    summary: {
      nodes: addedNodes.length,
      connections: addedConnections.length,
      variables: target.variables.length - originalVariableCount,
      functions: importedFunctions.length,
      classes: importedClasses.length,
      triggers: addedNodes.filter(isTriggerNode).length,
      hasTrigger: sourceHasTrigger,
      name: parsed.name,
    },
  };
}
