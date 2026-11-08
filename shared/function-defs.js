/**
 * 用户函数（子图）对应的动态节点定义。
 * - fncall:<函数id>：函数调用节点（主图 / 其他函数内部）
 * - fnin:<函数id>：函数输入节点（仅在该函数子图内部使用）
 * - fnout:<函数id>：函数输出节点（仅在该函数子图内部使用）
 */

import { EXEC_IN, EXEC_OUT, setDynamicNodeDefs } from './node-defs.js';

const TYPE_TO_EDITOR = {
  string: 'text',
  number: 'number',
  boolean: 'boolean',
  object: 'json',
  array: 'json',
};

const EDITOR_TO_TYPE = {
  text: 'string',
  number: 'number',
  boolean: 'boolean',
  json: 'object',
  select: 'string',
  code: 'string',
};

export function editorForType(type) {
  return TYPE_TO_EDITOR[type] || 'text';
}

export function typeForEditor(editor) {
  return EDITOR_TO_TYPE[editor] || 'string';
}

export function functionCallDefName(id) {
  return `fncall:${id}`;
}

export function functionInputDefName(id) {
  return `fnin:${id}`;
}

export function functionOutputDefName(id) {
  return `fnout:${id}`;
}

/** 单个输入参数节点（节点标题即参数名） */
export function functionArgDefName(fnId, entryId) {
  return `fnarg:${fnId}:${entryId}`;
}

/** 单个输出参数节点（节点标题即输出名） */
export function functionRetDefName(fnId, entryId) {
  return `fnret:${fnId}:${entryId}`;
}

export function isFunctionNodeName(name) {
  return (
    typeof name === 'string' &&
    (name.startsWith('fncall:') || name.startsWith('fnin:') || name.startsWith('fnout:'))
  );
}

/** 生成合法且唯一的 JS 函数名 */
export function getFunctionJsName(fn) {
  const base =
    String(fn.name || 'fn')
      .replace(/[^A-Za-z0-9_$]/g, '_')
      .replace(/^(\d)/, '_$1')
      .slice(0, 32) || 'fn';
  const suffix = String(fn.id || '').replace(/[^A-Za-z0-9_$]/g, '');
  return `_fn_${base}_${suffix}`;
}

/** 函数参数变量名（由参数 id 派生，保证合法） */
export function functionArgName(id) {
  return `_arg_${String(id || '').replace(/[^A-Za-z0-9_$]/g, '_')}`;
}

function execInPin(row = 0) {
  return { name: EXEC_IN, kind: 'exec', dir: 'in', row, label: '' };
}

function execOutPin(row = 0) {
  return { name: EXEC_OUT, kind: 'exec', dir: 'out', row, label: '' };
}

/** 为所有函数构建动态节点定义 */
export function buildFunctionNodeDefs(functions) {
  const defs = [];

  for (const fn of functions || []) {
    const inputs = Array.isArray(fn.inputs) ? fn.inputs : [];
    const outputs = Array.isArray(fn.outputs) ? fn.outputs : [];

    // 调用节点：执行流 + 输入/输出数据端点
    defs.push({
      name: functionCallDefName(fn.id),
      label: fn.name,
      description: `调用函数「${fn.name}」`,
      type: 'function',
      category: 'function',
      width: 240,
      pins: [
        execInPin(0),
        execOutPin(0),
        ...inputs.map((entry, index) => ({
          name: `i_${entry.id}`,
          kind: 'port',
          dir: 'in',
          row: 1 + index,
          editor: editorForType(entry.type),
          label: entry.name || `输入${index + 1}`,
        })),
        ...outputs.map((entry, index) => ({
          name: `o_${entry.id}`,
          kind: 'port',
          dir: 'out',
          row: 1 + inputs.length + index,
          label: entry.name || `输出${index + 1}`,
        })),
      ],
    });

    // 每个输出参数一个独立节点：标题即输出名，接入值后作为函数返回值
    for (const entry of outputs) {
      defs.push({
        name: functionRetDefName(fn.id, entry.id),
        label: entry.name || '输出',
        description: `函数输出：${entry.name}`,
        type: 'function',
        category: 'io',
        width: 180,
        pins: [
          {
            name: 'value',
            kind: 'port',
            dir: 'in',
            row: 0,
            editor: editorForType(entry.type),
            label: '值',
          },
        ],
      });
    }

    // 每个输入参数一个独立节点：标题即输入名，输出端可直接连线
    for (const entry of inputs) {
      defs.push({
        name: functionArgDefName(fn.id, entry.id),
        label: entry.name || '输入',
        description: `函数输入：${entry.name}`,
        type: 'logic',
        category: 'io',
        width: 180,
        pins: [
          {
            name: 'value',
            kind: 'port',
            dir: 'out',
            row: 0,
            label: '值',
            code: () => functionArgName(entry.id),
          },
        ],
      });
    }

    // 函数输入节点：读取参数（旧版聚合节点，保留兼容）
    defs.push({
      name: functionInputDefName(fn.id),
      label: '函数输入',
      description: `读取「${fn.name}」的输入参数`,
      type: 'logic',
      category: 'io',
      width: 200,
      pins: inputs.map((entry, index) => ({
        name: `i_${entry.id}`,
        kind: 'port',
        dir: 'out',
        row: index,
        label: entry.name || `输入${index + 1}`,
        code: () => functionArgName(entry.id),
      })),
    });

    // 函数输出节点：写入返回值
    defs.push({
      name: functionOutputDefName(fn.id),
      label: '函数输出',
      description: `设置「${fn.name}」的返回值`,
      type: 'function',
      category: 'io',
      width: 220,
      pins: [
        execInPin(0),
        execOutPin(0),
        ...outputs.map((entry, index) => ({
          name: `o_${entry.id}`,
          kind: 'port',
          dir: 'in',
          row: 1 + index,
          editor: editorForType(entry.type),
          label: entry.name || `输出${index + 1}`,
        })),
      ],
      code: ({ input }) =>
        outputs
          .map(
            (entry) =>
              `__fnResult[${JSON.stringify(entry.id)}] = ${input(`o_${entry.id}`)};`
          )
          .join('\n') + '\n',
    });
  }

  return defs;
}

/** 重建全局动态节点注册表 */
export function applyFunctionNodeDefs(functions) {
  setDynamicNodeDefs(buildFunctionNodeDefs(functions));
}

/** 只获取某个函数的内部节点定义（输入/输出） */
export function getFunctionInternalDefs(fn) {
  return buildFunctionNodeDefs([fn]).filter(
    (def) => def.name.startsWith('fnin:') || def.name.startsWith('fnout:')
  );
}
