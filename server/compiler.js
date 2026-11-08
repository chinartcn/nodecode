/**
 * 蓝图 -> JavaScript 代码编译器。
 * 核心流程与 codeck 的 CodeCompiler 一致：
 * 1. 生成变量声明
 * 2. 从 Begin 节点沿执行端点（exec）生成主流程
 * 3. 数据端点（port）通过连线递归解析为表达式
 */

import {
  EXEC_IN,
  EXEC_OUT,
  block,
  getNodeDef,
  indent,
  isValidIdentifier,
  setDynamicNodeDefs,
} from '../shared/node-defs.js';
import { buildFunctionNodeDefs, functionArgName, getFunctionJsName } from '../shared/function-defs.js';

/** 将节点内联输入值转换为 JS 字面量表达式 */
function emitLiteral(editor, value) {
  switch (editor) {
    case 'number': {
      const num = Number(value);
      return String(Number.isFinite(num) ? num : 0);
    }
    case 'boolean':
      return value === true || value === 'true' ? 'true' : 'false';
    case 'json': {
      if (value === undefined || value === null || value === '') return 'undefined';
      if (typeof value !== 'string') return JSON.stringify(value);
      const trimmed = value.trim();
      if (!trimmed) return 'undefined';
      try {
        return JSON.stringify(JSON.parse(trimmed));
      } catch {
        return JSON.stringify(value);
      }
    }
    case 'select':
    case 'text':
      return JSON.stringify(String(value ?? ''));
    default:
      return JSON.stringify(value ?? '');
  }
}

function emitVariable(variable) {
  const { type, value } = variable;
  if (type === 'number') {
    const num = Number(value);
    return String(Number.isFinite(num) ? num : 0);
  }
  if (type === 'boolean') return value === true || value === 'true' ? 'true' : 'false';
  if (type === 'object' || type === 'array') {
    if (value === undefined || value === null || value === '') return type === 'array' ? '[]' : '{}';
    try {
      return JSON.stringify(JSON.parse(value));
    } catch {
      return type === 'array' ? '[]' : '{}';
    }
  }
  return JSON.stringify(String(value ?? ''));
}

export class Compiler {
  constructor(graph, options = {}) {
    this.graph = graph;
    this.nodeMap = Object.fromEntries((graph.nodes || []).map((node) => [node.id, node]));
    this.connections = graph.connections || [];
    this.prepares = options.prepares || [];
    this.functionMap = options.functionMap || new Map();
    this._execActive = new Set();
    this._dataStack = [];
    this.printComment = true;
  }

  generate() {
    const body = this.generateBody();
    return Compiler.generatePrepareCode(this.prepares) + body;
  }

  /** 生成变量声明 + 执行流代码（不含 prepare 函数） */
  generateBody() {
    const begin = this.findBegin();
    this.collectPrepare(getNodeDef(begin.name));

    let body = this.generateVariables();
    body += this.generateCodeFromNode(this.getExecNext(begin.id));
    return body;
  }

  generateVariables() {
    const variables = Array.isArray(this.graph.variables) ? this.graph.variables : [];
    if (variables.length === 0) return '';
    const lines = variables.map((variable) => {
      if (!isValidIdentifier(variable.name)) {
        throw new Error(`变量名不合法：${variable.name}`);
      }
      if (variable.value === undefined || variable.value === '') {
        return `let ${variable.name};`;
      }
      return `let ${variable.name} = ${emitVariable(variable)};`;
    });
    return `${lines.join('\n')}\n\n`;
  }

  buildPinVarName(pinName, nodeId) {
    const safeNode = String(nodeId).replace(/[^A-Za-z0-9_$]/g, '_');
    const safePin = String(pinName).replace(/[^A-Za-z0-9_$]/g, '_');
    return `_${safeNode}_${safePin}`;
  }

  buildContext(node) {
    return {
      node,
      input: (pinName, nodeId) => this.getInputCode(pinName, nodeId ?? node.id),
      raw: (pinName) => node.data?.[pinName],
      isConnected: (pinName, nodeId) =>
        this.connections.some(
          (conn) => conn.toNodeId === (nodeId ?? node.id) && conn.toNodePinName === pinName
        ),
      execOut: (pinName, nodeId) => this.getConnectionExecOutput(pinName, nodeId ?? node.id),
      buildPinVarName: (pinName, nodeId) => this.buildPinVarName(pinName, nodeId ?? node.id),
      indent,
      block,
    };
  }

  /** 解析某个输入端点：已连接则递归解析上游，否则使用节点内联值 */
  getInputCode(pinName, nodeId) {
    const node = this.nodeMap[nodeId];
    if (!node) return 'undefined';
    const def = getNodeDef(node.name);
    if (!def) return 'undefined';

    const pin = def.pins.find((item) => item.dir === 'in' && item.name === pinName);
    const connection = this.connections.find(
      (conn) => conn.toNodeId === nodeId && conn.toNodePinName === pinName
    );

    if (!connection) {
      return emitLiteral(pin?.editor, node.data?.[pinName]);
    }

    return this.resolveOutputCode(connection.fromNodeId, connection.fromNodePinName);
  }

  /** 解析某个输出端点对应的表达式 / 变量名 */
  resolveOutputCode(nodeId, pinName) {
    const key = `${nodeId}:${pinName}`;
    if (this._dataStack.includes(key)) {
      throw new Error('检测到数据流循环依赖，请检查连线');
    }

    const node = this.nodeMap[nodeId];
    if (!node) return 'undefined';
    const def = getNodeDef(node.name);
    if (!def) return 'undefined';
    const output = def.pins.find((pin) => pin.dir === 'out' && pin.name === pinName);
    if (!output) return 'undefined';

    this.collectPrepare(def);
    this._dataStack.push(key);
    try {
      if (typeof output.code === 'function') {
        return output.code(this.buildContext(node));
      }
      return this.buildPinVarName(pinName, nodeId);
    } finally {
      this._dataStack.pop();
    }
  }

  /** 生成从指定节点开始的执行链代码 */
  generateCodeFromNode(startNode) {
    let code = '';
    let current = startNode;
    const chain = [];

    try {
      while (current) {
        if (this._execActive.has(current.id)) {
          throw new Error('执行流出现循环，请检查是否把连线接到了上游节点');
        }
        this._execActive.add(current.id);
        chain.push(current.id);

        const def = getNodeDef(current.name);
        if (!def) break;
        this.collectPrepare(def);

        if (current.name.startsWith('fncall:')) {
          if (this.printComment) {
            code += `// 调用函数 ${def.label} · ${current.id}\n`;
          }
          code += this.generateFunctionCall(current);
        } else if (typeof def.code === 'function') {
          if (this.printComment) {
            code += `// ${def.label} · ${current.id}\n`;
          }
          code += def.code(this.buildContext(current));
        }

        current = this.getExecNext(current.id);
      }
    } finally {
      for (const id of chain) this._execActive.delete(id);
    }

    return code;
  }

  /** 生成函数调用代码（函数内部支持 await / 嵌套调用） */
  generateFunctionCall(node) {
    const fnId = node.name.slice('fncall:'.length);
    const fn = this.functionMap.get(fnId);
    if (!fn) throw new Error('调用了不存在的函数，请删除该调用节点');

    const args = (fn.inputs || []).map((entry) =>
      this.getInputCode(`i_${entry.id}`, node.id)
    );
    const jsName = getFunctionJsName(fn);

    if (!(fn.outputs || []).length) {
      return `await ${jsName}(${args.join(', ')});\n`;
    }

    const resultVar = this.buildPinVarName('result', node.id);
    let code = `var ${resultVar} = await ${jsName}(${args.join(', ')});\n`;
    for (const entry of fn.outputs) {
      code += `var ${this.buildPinVarName(`o_${entry.id}`, node.id)} = ${resultVar} == null ? undefined : ${resultVar}[${JSON.stringify(entry.id)}];\n`;
    }
    return code;
  }

  getConnectionExecOutput(pinName, nodeId) {
    const next = this.getExecNext(nodeId, pinName);
    if (!next) return null;
    return this.generateCodeFromNode(next);
  }

  getExecNext(nodeId, pinName = EXEC_OUT) {
    if (!this.nodeMap[nodeId]) return null;
    const matches = this.connections.filter(
      (conn) => conn.fromNodeId === nodeId && conn.fromNodePinName === pinName
    );
    if (matches.length === 0) return null;
    if (matches.length > 1) {
      throw new Error(`节点 ${nodeId} 的执行端点存在多条连线`);
    }
    return this.nodeMap[matches[0].toNodeId] || null;
  }

  collectPrepare(def) {
    if (!def || !Array.isArray(def.prepare)) return;
    for (const item of def.prepare) {
      if (item.type === 'function' && !this.prepares.some((p) => p.type === 'function' && p.name === item.name)) {
        this.prepares.push(item);
      }
    }
  }

  static generatePrepareCode(prepares) {
    const functions = (prepares || []).filter((item) => item.type === 'function');
    if (functions.length === 0) return '';
    return (
      functions
        .map(
          (fn) =>
            `function ${fn.name}(${fn.parameters.join(', ')}) {\n${indent(fn.body, 2)}\n}`
        )
        .join('\n\n') + '\n\n'
    );
  }

  findBegin() {
    const begins = Object.values(this.nodeMap).filter(
      (node) => getNodeDef(node.name)?.type === 'begin'
    );
    if (begins.length === 0) throw new Error('缺少开始节点');
    if (begins.length > 1) throw new Error('开始节点只能有一个');
    return begins[0];
  }
}

/** 检测函数之间的循环调用 */
function assertNoFunctionCycles(functions) {
  const edges = new Map();
  for (const fn of functions) {
    const targets = new Set();
    for (const node of fn.graph?.nodes || []) {
      if (typeof node.name === 'string' && node.name.startsWith('fncall:')) {
        targets.add(node.name.slice('fncall:'.length));
      }
    }
    edges.set(fn.id, targets);
  }

  const state = new Map();
  const visit = (id) => {
    const current = state.get(id) || 0;
    if (current === 1) throw new Error('函数存在循环调用，请检查嵌套关系');
    if (current === 2) return;
    state.set(id, 1);
    for (const next of edges.get(id) || []) {
      if (edges.has(next)) visit(next);
    }
    state.set(id, 2);
  };
  for (const fn of functions) visit(fn.id);
}

export function compileGraph(graph) {
  const functions = Array.isArray(graph.functions) ? graph.functions : [];
  setDynamicNodeDefs(buildFunctionNodeDefs(functions));
  assertNoFunctionCycles(functions);

  const functionMap = new Map(functions.map((fn) => [fn.id, fn]));
  const prepares = [];
  const declarations = [];

  for (const fn of functions) {
    const compiler = new Compiler(fn.graph || {}, { prepares, functionMap });
    let body = compiler.generateBody();

    // 每个输出参数节点在函数结束时写入返回值
    const outputPrefix = `fnret:${fn.id}:`;
    for (const node of fn.graph?.nodes || []) {
      if (typeof node.name !== 'string' || !node.name.startsWith(outputPrefix)) continue;
      const entryId = node.name.slice(outputPrefix.length);
      const entry = (fn.outputs || []).find((item) => item.id === entryId);
      if (!entry) continue;
      const value = compiler.getInputCode('value', node.id);
      body += `__fnResult[${JSON.stringify(entry.id)}] = ${value};\n`;
    }

    const parameters = (fn.inputs || []).map((entry) => functionArgName(entry.id)).join(', ');
    declarations.push(
      `async function ${getFunctionJsName(fn)}(${parameters}) {\n  let __fnResult = {};\n${indent(body, 2)}\n  return __fnResult;\n}`
    );
  }

  const mainCompiler = new Compiler(
    { nodes: graph.nodes, connections: graph.connections, variables: graph.variables },
    { prepares, functionMap }
  );
  const mainBody = mainCompiler.generateBody();

  return (
    Compiler.generatePrepareCode(prepares) +
    declarations.join('\n\n') +
    (declarations.length ? '\n\n' : '') +
    mainBody
  );
}

export { EXEC_IN, EXEC_OUT };
