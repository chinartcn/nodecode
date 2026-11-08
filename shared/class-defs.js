/**
 * 用户类（Class）对应的动态节点定义。
 *
 * 类包含：
 * - properties：实例属性（名称、类型、默认值）
 * - methods：方法（名称、输入/输出签名、方法体子图）
 *
 * 节点：
 * - clsnew:<classId>                 创建实例
 * - clsget:<classId>:<propId>        读取实例属性
 * - clsset:<classId>:<propId>        写入实例属性
 * - clscall:<classId>:<methodId>     调用实例方法
 * - clsselfget:<classId>:<propId>    方法内部读取 this.prop
 * - clsselfset:<classId>:<propId>    方法内部写入 this.prop
 * - clsarg:<classId>:<methodId>:<entryId>  方法输入参数
 * - clsret:<classId>:<methodId>:<entryId>  方法返回值
 */

import { EXEC_IN, EXEC_OUT } from './node-defs.js';
import { editorForType, functionArgName } from './function-defs.js';

const PROPERTY_TYPES = ['string', 'number', 'boolean', 'object', 'array'];

export function classNewDefName(classId) {
  return `clsnew:${classId}`;
}

export function classCallDefName(classId, methodId) {
  return `clscall:${classId}:${methodId}`;
}

export function classGetDefName(classId, propId) {
  return `clsget:${classId}:${propId}`;
}

export function classSetDefName(classId, propId) {
  return `clsset:${classId}:${propId}`;
}

export function classSelfGetDefName(classId, propId) {
  return `clsselfget:${classId}:${propId}`;
}

export function classSelfSetDefName(classId, propId) {
  return `clsselfset:${classId}:${propId}`;
}

export function classArgDefName(classId, methodId, entryId) {
  return `clsarg:${classId}:${methodId}:${entryId}`;
}

export function classRetDefName(classId, methodId, entryId) {
  return `clsret:${classId}:${methodId}:${entryId}`;
}

/** 方法子图的作用域 id，例如 cls:fn_1:m_2 */
export function methodScopeId(classId, methodId) {
  return `cls:${classId}:${methodId}`;
}

/** 解析方法作用域 id */
export function parseMethodScopeId(scopeId) {
  if (typeof scopeId !== 'string' || !scopeId.startsWith('cls:')) return null;
  const rest = scopeId.slice('cls:'.length);
  const index = rest.indexOf(':');
  if (index <= 0) return null;
  return { classId: rest.slice(0, index), methodId: rest.slice(index + 1) };
}

export function isMethodScopeId(scopeId) {
  return parseMethodScopeId(scopeId) !== null;
}

/** 生成合法且唯一的 JS 类名 */
export function getClassJsName(cls) {
  const base =
    String(cls?.name || 'cls')
      .replace(/[^A-Za-z0-9_$]/g, '_')
      .replace(/^(\d)/, '_$1')
      .slice(0, 32) || 'cls';
  const suffix = String(cls?.id || '').replace(/[^A-Za-z0-9_$]/g, '');
  return `_cls_${base}_${suffix}`;
}

/** 归一化属性默认值（与变量默认值规则一致） */
export function defaultPropertyValue(type, value) {
  if (!PROPERTY_TYPES.includes(type)) return String(value ?? '');
  if (type === 'number') {
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
  }
  if (type === 'boolean') return value === true || value === 'true';
  if (type === 'object' || type === 'array') {
    if (value === undefined || value === null || value === '') {
      return type === 'array' ? '[]' : '{}';
    }
    if (typeof value !== 'string') {
      try {
        return JSON.stringify(value);
      } catch {
        return type === 'array' ? '[]' : '{}';
      }
    }
    try {
      return JSON.stringify(JSON.parse(value));
    } catch {
      return type === 'array' ? '[]' : '{}';
    }
  }
  return String(value ?? '');
}

function execInPin(row = 0) {
  return { name: EXEC_IN, kind: 'exec', dir: 'in', row, label: '' };
}

function execOutPin(row = 0) {
  return { name: EXEC_OUT, kind: 'exec', dir: 'out', row, label: '' };
}

function portIn(pinName, row, editor, label) {
  return { name: pinName, kind: 'port', dir: 'in', row, editor, label: label ?? pinName };
}

function portOut(pinName, row, label) {
  return { name: pinName, kind: 'port', dir: 'out', row, label: label ?? pinName };
}

function typeEditor(type) {
  return editorForType(PROPERTY_TYPES.includes(type) ? type : 'string');
}

/** 为所有类构建动态节点定义 */
export function buildClassNodeDefs(classes) {
  const defs = [];

  for (const cls of classes || []) {
    const className = getClassJsName(cls);
    const properties = Array.isArray(cls.properties) ? cls.properties : [];
    const methods = Array.isArray(cls.methods) ? cls.methods : [];

    /* ---------------- 创建实例 ---------------- */
    const newDefaults = {};
    for (const property of properties) {
      newDefaults[`p_${property.id}`] = property.value;
    }
    defs.push({
      name: classNewDefName(cls.id),
      label: `new ${cls.name}`,
      description: `创建「${cls.name}」实例`,
      type: 'function',
      category: 'class',
      width: 240,
      defaults: newDefaults,
      pins: [
        execInPin(0),
        execOutPin(0),
        ...properties.map((property, index) =>
          portIn(
            `p_${property.id}`,
            1 + index,
            typeEditor(property.type),
            property.name
          )
        ),
        portOut('instance', 1, '实例'),
      ],
      code: ({ node, input, isConnected, buildPinVarName }) => {
        const instance = buildPinVarName('instance');
        const entries = properties
          .filter(
            (property) =>
              isConnected(`p_${property.id}`) ||
              Object.prototype.hasOwnProperty.call(node.data || {}, `p_${property.id}`)
          )
          .map(
            (property) =>
              `${JSON.stringify(property.id)}: ${input(`p_${property.id}`)}`
          );
        if (!entries.length) {
          return `var ${instance} = new ${className}();\n`;
        }
        return `var ${instance} = new ${className}({ ${entries.join(', ')} });\n`;
      },
    });

    /* ---------------- 属性读取 / 写入 ---------------- */
    for (const property of properties) {
      defs.push({
        name: classGetDefName(cls.id, property.id),
        label: `读取 ${property.name}`,
        description: `读取「${cls.name}.${property.name}」`,
        type: 'logic',
        category: 'class',
        width: 200,
        pins: [
          { name: 'instance', kind: 'port', dir: 'in', row: 0, label: '实例' },
          {
            name: 'value',
            kind: 'port',
            dir: 'out',
            row: 1,
            label: property.name,
            code: ({ input, isConnected }) => {
              if (!isConnected('instance')) {
                throw new Error(`请为「读取 ${property.name}」连接类实例`);
              }
              return `((${input('instance')})[${JSON.stringify(property.name)}])`;
            },
          },
        ],
      });

      defs.push({
        name: classSetDefName(cls.id, property.id),
        label: `写入 ${property.name}`,
        description: `写入「${cls.name}.${property.name}」`,
        type: 'function',
        category: 'class',
        width: 220,
        pins: [
          execInPin(0),
          execOutPin(0),
          { name: 'instance', kind: 'port', dir: 'in', row: 1, label: '实例' },
          portIn('value', 2, typeEditor(property.type), property.name),
        ],
        code: ({ input, isConnected }) => {
          if (!isConnected('instance')) {
            throw new Error(`请为「写入 ${property.name}」连接类实例`);
          }
          return `(${input('instance')})[${JSON.stringify(property.name)}] = ${input('value')};\n`;
        },
      });

      defs.push({
        name: classSelfGetDefName(cls.id, property.id),
        label: `this.${property.name}`,
        description: `在方法内读取 this.${property.name}`,
        type: 'logic',
        category: 'class',
        width: 190,
        pins: [
          {
            name: 'value',
            kind: 'port',
            dir: 'out',
            row: 0,
            label: property.name,
            code: () => `this[${JSON.stringify(property.name)}]`,
          },
        ],
      });

      defs.push({
        name: classSelfSetDefName(cls.id, property.id),
        label: `this.${property.name} =`,
        description: `在方法内写入 this.${property.name}`,
        type: 'function',
        category: 'class',
        width: 210,
        pins: [
          execInPin(0),
          execOutPin(0),
          portIn('value', 1, typeEditor(property.type), property.name),
        ],
        code: ({ input }) => `this[${JSON.stringify(property.name)}] = ${input('value')};\n`,
      });
    }

    /* ---------------- 方法调用 ---------------- */
    for (const method of methods) {
      const inputs = Array.isArray(method.inputs) ? method.inputs : [];
      const outputs = Array.isArray(method.outputs) ? method.outputs : [];
      defs.push({
        name: classCallDefName(cls.id, method.id),
        label: `${cls.name}.${method.name}`,
        description: `调用「${cls.name}.${method.name}」`,
        type: 'function',
        category: 'class',
        width: 260,
        pins: [
          execInPin(0),
          execOutPin(0),
          { name: 'instance', kind: 'port', dir: 'in', row: 1, label: '实例' },
          ...inputs.map((entry, index) =>
            portIn(`i_${entry.id}`, 2 + index, typeEditor(entry.type), entry.name)
          ),
          ...outputs.map((entry, index) =>
            portOut(
              `o_${entry.id}`,
              2 + inputs.length + index,
              entry.name
            )
          ),
        ],
        code: ({ input, isConnected, buildPinVarName }) => {
          if (!isConnected('instance')) {
            throw new Error(`请为「${cls.name}.${method.name}」连接类实例`);
          }
          const target = `(${input('instance')})[${JSON.stringify(method.name)}]`;
          const args = inputs.map((entry) => input(`i_${entry.id}`)).join(', ');
          if (!outputs.length) {
            return `await ${target}(${args});\n`;
          }
          const result = buildPinVarName('result');
          let code = `var ${result} = await ${target}(${args});\n`;
          for (const entry of outputs) {
            code += `var ${buildPinVarName(`o_${entry.id}`)} = ${result} == null ? undefined : ${result}[${JSON.stringify(entry.id)}];\n`;
          }
          return code;
        },
      });

      /* ---------------- 方法内部节点 ---------------- */
      for (const entry of inputs) {
        defs.push({
          name: classArgDefName(cls.id, method.id, entry.id),
          label: entry.name || '参数',
          description: `方法「${method.name}」的输入参数`,
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
      for (const entry of outputs) {
        defs.push({
          name: classRetDefName(cls.id, method.id, entry.id),
          label: entry.name || '返回',
          description: `方法「${method.name}」的返回值`,
          type: 'logic',
          category: 'io',
          width: 180,
          pins: [
            {
              name: 'value',
              kind: 'port',
              dir: 'in',
              row: 0,
              editor: typeEditor(entry.type),
              label: '值',
            },
          ],
        });
      }
    }
  }

  return defs;
}

/** 类的外部节点（用于添加面板），不含方法内部节点 */
export function listClassPaletteNodeNames(cls) {
  const names = [classNewDefName(cls.id)];
  for (const property of cls.properties || []) {
    names.push(classGetDefName(cls.id, property.id));
    names.push(classSetDefName(cls.id, property.id));
  }
  for (const method of cls.methods || []) {
    names.push(classCallDefName(cls.id, method.id));
  }
  return names;
}

/** 方法内部可用的 this 属性节点 */
export function listClassSelfNodeNames(cls) {
  const names = [];
  for (const property of cls.properties || []) {
    names.push(classSelfGetDefName(cls.id, property.id));
    names.push(classSelfSetDefName(cls.id, property.id));
  }
  return names;
}

export { PROPERTY_TYPES };
