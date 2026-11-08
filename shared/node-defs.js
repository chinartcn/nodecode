/**
 * 节点定义：前端（渲染）与后端（代码生成）共享。
 * 设计参考 codeck（https://github.com/moonrailgun/codeck）的节点体系。
 */

export const EXEC_IN = '$exec_in';
export const EXEC_OUT = '$exec_out';

// 节点画布布局常量（世界坐标 = 缩放为 1 时的 CSS 像素）
export const NODE_HEADER_HEIGHT = 34;
export const NODE_ROW_HEIGHT = 30;
export const NODE_BODY_PADDING = 10;

export const NODE_TYPE_COLORS = {
  begin: '#e17055',
  function: '#0984e3',
  logic: '#6c5ce7',
};

export const CATEGORY_LABELS = {
  core: '核心',
  logic: '逻辑',
  data: '数据',
  function: '函数',
  io: '输入输出',
};

export const CATEGORY_COLORS = {
  core: '#4da3ff',
  logic: '#a29bfe',
  data: '#4dd0c1',
  function: '#e84393',
  io: '#fdcb6e',
};

/** 缩进一段代码 */
export function indent(text, size = 2) {
  if (!text) return '';
  const pad = ' '.repeat(size);
  return String(text)
    .split('\n')
    .map((line) => (line.trim() === '' ? line : pad + line))
    .join('\n');
}

/** 缩进代码块，空内容返回空字符串 */
export function block(text, size = 2) {
  if (!text || !String(text).trim()) return '';
  return indent(text, size);
}

const RESERVED_WORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'else', 'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof',
  'let', 'new', 'return', 'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void',
  'while', 'with', 'yield', 'enum', 'await', 'implements', 'package', 'protected', 'static',
  'interface', 'private', 'public', 'null', 'true', 'false', 'undefined',
]);

export function isValidIdentifier(name) {
  const text = String(name || '');
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(text)) return false;
  return !RESERVED_WORDS.has(text);
}

/* ---------------- 端点构造器 ---------------- */

const execIn = (row = 0) => ({ name: EXEC_IN, kind: 'exec', dir: 'in', row, label: '' });
const execOut = (row = 0, label = '') => ({ name: EXEC_OUT, kind: 'exec', dir: 'out', row, label });
const execPin = (name, dir, row, label = '') => ({ name, kind: 'exec', dir, row, label });
const portIn = (name, row, editor, extra = {}) => ({
  name,
  kind: 'port',
  dir: 'in',
  row,
  editor,
  label: extra.label ?? name,
  ...extra,
});
const portOut = (name, row, extra = {}) => ({
  name,
  kind: 'port',
  dir: 'out',
  row,
  label: extra.label ?? name,
  ...extra,
});

/** 二元逻辑/运算节点构造器 */
function buildBinaryLogic(name, label, description, operator, editor = 'number') {
  return {
    name,
    label,
    description,
    type: 'logic',
    category: 'logic',
    width: 170,
    defaults: { input1: editor === 'boolean' ? true : 0, input2: editor === 'boolean' ? true : 0 },
    pins: [
      portIn('input1', 0, editor, { label: 'A' }),
      portIn('input2', 1, editor, { label: 'B' }),
      portOut('output', 2, {
        label: '结果',
        code: ({ input }) => `(${input('input1')} ${operator} ${input('input2')})`,
      }),
    ],
  };
}

export const nodeDefs = [
  /* ---------------- 核心 ---------------- */
  {
    name: 'begin',
    label: '开始',
    description: '独立触发起点，可添加多个，运行时并发执行',
    type: 'begin',
    category: 'core',
    width: 170,
    trigger: 'always',
    pins: [execOut(0)],
  },
  {
    name: 'if-trigger',
    label: '条件触发',
    description: '条件为真时才触发独立运行',
    type: 'begin',
    category: 'core',
    width: 200,
    trigger: 'condition',
    defaults: { condition: true },
    pins: [execOut(0), portIn('condition', 0, 'boolean', { label: 'condition' })],
  },
  {
    name: 'log',
    label: 'Log',
    description: '在运行面板输出一条日志',
    type: 'function',
    category: 'core',
    width: 230,
    defaults: { message: 'Hello Codeck Mobile' },
    pins: [execIn(0), execOut(0), portIn('message', 1, 'text', { label: 'message' })],
    code: ({ input }) => `console.log(${input('message')});\n`,
  },
  {
    name: 'if',
    label: 'If',
    description: '条件为真 / 假时执行不同分支',
    type: 'logic',
    category: 'core',
    width: 230,
    defaults: { condition: true },
    pins: [
      execIn(0),
      execOut(0),
      portIn('condition', 1, 'boolean', { label: 'condition' }),
      execPin('true', 'out', 1, 'true'),
      execPin('false', 'out', 2, 'false'),
    ],
    code: ({ input, execOut: branch }) =>
      `if (${input('condition')}) {\n${block(branch('true'), 2)}\n} else {\n${block(branch('false'), 2)}\n}\n`,
  },
  {
    name: 'loop',
    label: 'Loop',
    description: '按次数循环执行 body 分支',
    type: 'function',
    category: 'core',
    width: 230,
    defaults: { times: 3 },
    pins: [
      execIn(0),
      execOut(0),
      portIn('times', 1, 'number', { label: 'times' }),
      execPin('body', 'out', 1, 'body'),
      portOut('inc', 2, { label: 'inc' }),
    ],
    code: ({ input, execOut: branch, buildPinVarName }) => {
      const inc = buildPinVarName('inc');
      return `for (var ${inc} = 0; ${inc} < ${input('times')}; ${inc}++) {\n${block(branch('body'), 2)}\n}\n`;
    },
  },
  {
    name: 'foreach',
    label: 'ForEach',
    description: '遍历数组，body 中可读取 item',
    type: 'function',
    category: 'core',
    width: 230,
    defaults: { array: '[]' },
    pins: [
      execIn(0),
      execOut(0),
      portIn('array', 1, 'json', { label: 'array' }),
      execPin('iteration', 'out', 1, 'body'),
      portOut('item', 2, { label: 'item' }),
    ],
    code: ({ input, execOut: branch, buildPinVarName }) => {
      const item = buildPinVarName('item');
      return `for (var ${item} of (${input('array')} ?? [])) {\n${block(branch('iteration'), 2)}\n}\n`;
    },
  },
  {
    name: 'sleep',
    label: 'Sleep',
    description: '等待若干毫秒后继续',
    type: 'function',
    category: 'core',
    width: 210,
    defaults: { ms: 1000 },
    pins: [execIn(0), portIn('ms', 1, 'number', { label: 'ms' }), execPin('cb', 'out', 0, '')],
    code: ({ input, execOut: branch }) =>
      `await new Promise((__resolve) => {\n  setTimeout(() => {\n${block(branch('cb'), 4)}\n    __resolve();\n  }, ${input('ms')});\n});\n`,
  },
  {
    name: 'fetch',
    label: 'Fetch',
    description: '发起 HTTP 请求并读取响应',
    type: 'function',
    category: 'core',
    width: 250,
    defaults: {
      method: 'GET',
      url: 'https://jsonplaceholder.typicode.com/todos/1',
      data: '',
      headers: '',
    },
    pins: [
      execIn(0),
      execOut(0),
      portIn('method', 1, 'select', {
        label: 'method',
        options: ['GET', 'POST', 'PUT', 'DELETE'].map((v) => ({ value: v, label: v })),
      }),
      execPin('onSuccess', 'out', 1, 'onSuccess'),
      portIn('url', 2, 'text', { label: 'url' }),
      portOut('text', 2, { label: 'text' }),
      portIn('data', 3, 'json', { label: 'data' }),
      portOut('json', 3, { label: 'json' }),
      portIn('headers', 4, 'json', { label: 'headers' }),
      execPin('onFailed', 'out', 4, 'onFailed'),
    ],
    code: ({ input, raw, execOut: branch, buildPinVarName, isConnected }) => {
      const text = buildPinVarName('text');
      const json = buildPinVarName('json');
      const hasData = isConnected('data') || Boolean(raw('data'));
      const hasHeaders = isConnected('headers') || Boolean(raw('headers'));
      const body = hasData ? input('data') : 'undefined';
      const headers = hasHeaders ? input('headers') : 'undefined';
      return `var ${text} = '';
var ${json} = {};
try {
  const __res = await fetch(${input('url')}, {
    method: ${input('method')},
    body: ${body},
    headers: ${headers},
  });
  ${text} = await __res.text();
  try {
    ${json} = JSON.parse(${text});
  } catch (__err) {}
${block(branch('onSuccess'), 2)}
} catch (__reqErr) {
${block(branch('onFailed'), 2)}
}
`;
    },
  },
  {
    name: 'raw-js',
    label: 'Javascript',
    description: '在节点内执行自定义 JS 并返回结果',
    type: 'function',
    category: 'core',
    width: 300,
    defaults: { ctx: '', js: '// ctx 是上游传入的数据\nreturn "Hello from raw JS";' },
    pins: [
      execIn(0),
      execOut(0),
      portIn('ctx', 1, 'json', { label: 'ctx' }),
      portIn('js', 2, 'code', { label: 'returnValue = (function(ctx){...})(ctx)' }),
      portOut('returnValue', 1, { label: 'returnValue' }),
    ],
    code: ({ input, raw, buildPinVarName }) => {
      const returnValue = buildPinVarName('returnValue');
      const js = indent(String(raw('js') || 'return ctx;'), 2);
      return `var ${returnValue} = (function(ctx) {\n  ${js}\n})(${input('ctx')});\n`;
    },
  },

  /* ---------------- 变量（隐藏，由变量面板创建） ---------------- */
  {
    name: 'varget',
    label: '取值',
    description: '读取一个变量',
    type: 'logic',
    category: 'core',
    hidden: true,
    width: 190,
    defaults: { name: '' },
    pins: [
      portOut('variable', 0, {
        label: '变量',
        code: ({ node }) => {
          const name = node.data?.name;
          if (!isValidIdentifier(name)) throw new Error('请为「取值」节点选择一个变量');
          return name;
        },
      }),
    ],
  },
  {
    name: 'varset',
    label: '赋值',
    description: '写入一个变量',
    type: 'function',
    category: 'core',
    hidden: true,
    width: 210,
    defaults: { name: '', value: '' },
    pins: [execIn(0), execOut(0), portIn('value', 1, 'text', { label: 'value' })],
    code: ({ node, input }) => {
      const name = node.data?.name;
      if (!isValidIdentifier(name)) throw new Error('请为「赋值」节点选择一个变量');
      return `${name} = ${input('value')};\n`;
    },
  },

  /* ---------------- 逻辑运算 ---------------- */
  buildBinaryLogic('add', 'Add', '两数相加', '+'),
  buildBinaryLogic('subtract', 'Subtract', '两数相减', '-'),
  buildBinaryLogic('multiply', 'Multiply', '两数相乘', '*'),
  buildBinaryLogic('divide', 'Divide', '两数相除', '/'),
  buildBinaryLogic('mod', 'Mod', '取余数', '%'),
  buildBinaryLogic('gt', 'Greater', 'A > B', '>'),
  buildBinaryLogic('gte', 'GreaterEqual', 'A >= B', '>='),
  buildBinaryLogic('lt', 'Less', 'A < B', '<'),
  buildBinaryLogic('lte', 'LessEqual', 'A <= B', '<='),
  buildBinaryLogic('equal', 'Equal', 'A === B', '==='),
  buildBinaryLogic('and', 'And', '逻辑与', '&&', 'boolean'),
  buildBinaryLogic('or', 'Or', '逻辑或', '||', 'boolean'),
  {
    name: 'not',
    label: 'Not',
    description: '逻辑取反',
    type: 'logic',
    category: 'logic',
    width: 160,
    defaults: { value: true },
    pins: [
      portIn('value', 0, 'boolean', { label: 'value' }),
      portOut('output', 1, { label: '结果', code: ({ input }) => `!(${input('value')})` }),
    ],
  },

  /* ---------------- 数据 ---------------- */
  {
    name: 'json-stringify',
    label: 'ToJSON',
    description: '将数据序列化为 JSON 字符串',
    type: 'logic',
    category: 'data',
    width: 180,
    defaults: { value: '' },
    pins: [
      portIn('value', 0, 'json', { label: 'value' }),
      portOut('result', 1, { label: 'JSON', code: ({ input }) => `JSON.stringify(${input('value')})` }),
    ],
  },
  {
    name: 'length',
    label: 'Length',
    description: '获取字符串或数组长度',
    type: 'logic',
    category: 'data',
    width: 170,
    defaults: { value: '' },
    pins: [
      portIn('value', 0, 'json', { label: 'value' }),
      portOut('result', 1, { label: 'length', code: ({ input }) => `((${input('value')}) ?? '').length` }),
    ],
  },
  {
    name: 'includes',
    label: 'Includes',
    description: '判断文本是否包含子串',
    type: 'logic',
    category: 'data',
    width: 190,
    defaults: { text: '', search: '' },
    pins: [
      portIn('text', 0, 'text', { label: 'text' }),
      portIn('search', 1, 'text', { label: 'search' }),
      portOut('result', 2, {
        label: '结果',
        code: ({ input }) => `((${input('text')}) ?? '').includes(${input('search')})`,
      }),
    ],
  },
  {
    name: 'obj-get',
    label: 'Get',
    description: '按路径读取对象字段，如 data.list[0].id',
    type: 'logic',
    category: 'data',
    width: 220,
    defaults: { object: '', path: 'a.b' },
    prepare: [
      {
        type: 'function',
        name: '__getPath',
        parameters: ['obj', 'path'],
        body: [
          'if (obj === null || obj === undefined) return undefined;',
          "const keys = String(path).replace(/\\[(\\d+)\\]/g, '.$1').split('.').filter(Boolean);",
          'let current = obj;',
          'for (const key of keys) {',
          '  if (current === null || current === undefined) return undefined;',
          '  current = current[key];',
          '}',
          'return current;',
        ].join('\n'),
      },
    ],
    pins: [
      portIn('object', 0, 'json', { label: 'object' }),
      portIn('path', 1, 'text', { label: 'path' }),
      portOut('result', 2, {
        label: '结果',
        code: ({ input }) => `__getPath(${input('object')}, ${input('path')})`,
      }),
    ],
  },
];

const DEF_MAP = new Map(nodeDefs.map((def) => [def.name, def]));

// 动态节点定义（用户创建的函数：调用节点、输入节点、输出节点）
const DYNAMIC_DEFS = new Map();

// 外部扩展节点定义（由 extensions/*.json 通过 ABI 注册）
const EXTERNAL_DEFS = new Map();

/** 用当前文档中的函数定义重建动态节点注册表 */
export function setDynamicNodeDefs(defs) {
  DYNAMIC_DEFS.clear();
  for (const def of defs || []) {
    if (def && def.name) DYNAMIC_DEFS.set(def.name, def);
  }
}

/** 注册外部扩展节点（服务端带 code，客户端只有布局信息） */
export function setExternalNodeDefs(defs) {
  EXTERNAL_DEFS.clear();
  for (const def of defs || []) {
    if (def && def.name) EXTERNAL_DEFS.set(def.name, def);
  }
}

export function getExternalNodeDefs() {
  return [...EXTERNAL_DEFS.values()];
}

export function getNodeDef(name) {
  return DEF_MAP.get(name) || EXTERNAL_DEFS.get(name) || DYNAMIC_DEFS.get(name) || null;
}

/** 可在节点面板中展示的节点 */
export function getVisibleNodeDefs() {
  return nodeDefs.filter((def) => !def.hidden);
}
