/**
 * Codeck Mobile 对外 API / 节点 ABI。
 * ABI 是外部扩展节点的约定：JSON 定义 -> 服务端编译 -> 客户端渲染。
 */

import { EXEC_IN, EXEC_OUT, getNodeDef } from './node-defs.js';

export const ABI_VERSION = 1;

export const VALUE_TYPES = ['string', 'number', 'boolean', 'object', 'array'];
export const EDITOR_TYPES = ['text', 'number', 'boolean', 'select', 'json', 'code'];

const NODE_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** 序列化单个端点，去掉函数/组件，只保留可传输信息 */
export function serializePin(pin) {
  const result = {
    name: pin.name,
    kind: pin.kind,
    dir: pin.dir,
    row: pin.row,
    label: pin.label || '',
  };
  if (pin.editor) result.editor = pin.editor;
  if (Array.isArray(pin.options)) result.options = pin.options;
  if (typeof pin.codeTemplate === 'string') result.codeTemplate = pin.codeTemplate;
  return result;
}

/** 序列化节点定义，供 /api/nodes 与客户端调色板使用 */
export function serializeNodeDef(def) {
  if (!def) return null;
  return {
    name: def.name,
    label: def.label,
    description: def.description || '',
    type: def.type,
    category: def.category,
    width: def.width,
    hidden: Boolean(def.hidden),
    external: Boolean(def.external),
    defaults: def.defaults || {},
    pins: (def.pins || []).map(serializePin),
    ...(typeof def.codeTemplate === 'string' ? { codeTemplate: def.codeTemplate } : {}),
  };
}

export function serializeNodeDefs(defs) {
  return (defs || []).map(serializeNodeDef).filter(Boolean);
}

/** 校验外部节点定义，返回可直接用于扩展的规范化结构 */
export function validateExternalNodeDefinition(raw, options = {}) {
  const errors = [];
  const warnings = [];
  const source = raw && typeof raw === 'object' ? raw : {};

  if (source.abiVersion !== undefined && Number(source.abiVersion) !== ABI_VERSION) {
    warnings.push(`abiVersion 建议为 ${ABI_VERSION}`);
  }

  const name = String(source.name || '').trim();
  if (!NODE_NAME_RE.test(name)) {
    errors.push('name 必须以字母开头，只能包含字母、数字、下划线和短横线');
  } else if (!options.allowExisting && getNodeDef(name)) {
    errors.push(`节点名「${name}」已存在`);
  }

  const label = String(source.label || '').trim();
  if (!label) errors.push('label 不能为空');

  const type = source.type === 'logic' || source.type === 'function' ? source.type : null;
  if (!type) errors.push("type 必须是 'function' 或 'logic'");

  const category = String(source.category || 'custom').trim() || 'custom';
  const width = Number(source.width ?? 220);
  if (!Number.isFinite(width) || width < 120 || width > 520) {
    errors.push('width 必须是 120 到 520 之间的数字');
  }

  const pins = [];
  if (!Array.isArray(source.pins) || source.pins.length === 0) {
    errors.push('pins 必须是非空数组');
  } else {
    const usedKeys = new Set();
    source.pins.forEach((rawPin, index) => {
      const pinSource = rawPin && typeof rawPin === 'object' ? rawPin : {};
      const kind =
        pinSource.kind === 'exec' ? 'exec' : pinSource.kind === 'port' ? 'port' : null;
      const dir = pinSource.dir === 'in' ? 'in' : pinSource.dir === 'out' ? 'out' : null;
      const pinName = String(pinSource.name || '').trim();

      if (!kind) errors.push(`pins[${index}].kind 必须是 'exec' 或 'port'`);
      if (!dir) errors.push(`pins[${index}].dir 必须是 'in' 或 'out'`);
      if (!pinName) errors.push(`pins[${index}].name 不能为空`);

      const key = `${dir}:${pinName}`;
      if (usedKeys.has(key)) errors.push(`端点重复：${key}`);
      usedKeys.add(key);

      const row = Number(pinSource.row ?? index);
      if (!Number.isInteger(row) || row < 0 || row > 50) {
        errors.push(`pins[${index}].row 必须是 0 到 50 的整数`);
      }

      if (!kind || !dir || !pinName) return;

      const pin = {
        name: pinName,
        kind,
        dir,
        row,
        label: String(pinSource.label ?? ''),
      };

      if (kind === 'port' && dir === 'in') {
        const editor = EDITOR_TYPES.includes(pinSource.editor) ? pinSource.editor : 'text';
        pin.editor = editor;
        if (editor === 'select') {
          if (!Array.isArray(pinSource.options) || pinSource.options.length === 0) {
            errors.push(`pins[${index}] 使用 select 时必须提供 options`);
          } else {
            pin.options = pinSource.options.map((option) => {
              const value = String(option?.value ?? option ?? '');
              return { value, label: String(option?.label ?? value) };
            });
          }
        }
      }

      if (kind === 'port' && dir === 'out' && typeof pinSource.codeTemplate === 'string') {
        pin.codeTemplate = pinSource.codeTemplate;
      }

      pins.push(pin);
    });
  }

  if (type === 'function' && typeof source.codeTemplate !== 'string') {
    warnings.push('function 类型节点没有 codeTemplate，将不会生成执行代码');
  }

  const defaults =
    source.defaults && typeof source.defaults === 'object' && !Array.isArray(source.defaults)
      ? source.defaults
      : {};

  const node = {
    abiVersion: ABI_VERSION,
    name,
    label,
    description: String(source.description || ''),
    type: type || 'function',
    category,
    width,
    pins,
    defaults,
    ...(typeof source.codeTemplate === 'string' ? { codeTemplate: source.codeTemplate } : {}),
  };

  return { ok: errors.length === 0, errors, warnings, node };
}

/** 把 ABI 定义转换为内部节点定义（含代码生成函数） */
export function buildExternalNodeDef(raw) {
  const result = validateExternalNodeDefinition(raw);
  if (!result.ok) throw new Error(result.errors.join('；'));
  const source = result.node;

  const def = {
    name: source.name,
    label: source.label,
    description: source.description,
    type: source.type,
    category: source.category,
    width: source.width,
    external: true,
    defaults: source.defaults,
    pins: source.pins.map((pin) => {
      const next = { ...pin };
      if (pin.codeTemplate) {
        const template = pin.codeTemplate;
        delete next.codeTemplate;
        next.code = (ctx) => renderTemplate(template, ctx);
      }
      return next;
    }),
    ...(source.codeTemplate ? { codeTemplate: source.codeTemplate } : {}),
  };

  if (source.codeTemplate) {
    def.code = (ctx) => renderTemplate(source.codeTemplate, ctx);
  }

  return def;
}

/**
 * 渲染外部节点代码模板。
 * 支持：{{input:pin}} / {{var:pin}} / {{exec:pin}} / {{block:pin}} / {{data:pin}}
 */
export function renderTemplate(template, ctx) {
  return String(template).replace(
    /\{\{\s*(input|var|exec|block|data)\s*:\s*([^}]+?)\s*\}\}/g,
    (match, token, pinName) => {
      const pin = String(pinName).trim();
      try {
        switch (token) {
          case 'input':
            return ctx.input(pin);
          case 'var':
            return ctx.buildPinVarName(pin);
          case 'exec':
            return ctx.execOut(pin) || '';
          case 'block':
            return ctx.block(ctx.execOut(pin), 2);
          case 'data':
            return JSON.stringify(ctx.raw(pin) ?? '');
          default:
            return match;
        }
      } catch {
        return match;
      }
    }
  );
}

/** 构建 JS 扩展节点定义（保留 code 函数，供服务端 .js 扩展使用） */
export function buildJsExternalNodeDef(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const name = String(source.name || '').trim();
  if (!NODE_NAME_RE.test(name)) throw new Error('name 必须以字母开头，只能包含字母、数字、下划线和短横线');
  if (getNodeDef(name)) throw new Error(`节点名「${name}」已存在`);

  const label = String(source.label || name).trim();
  if (!label) throw new Error('label 不能为空');
  const pins = Array.isArray(source.pins) ? source.pins : [];
  if (pins.length === 0) throw new Error('pins 必须是非空数组');

  const normalizedPins = pins.map((pin, index) => {
    const pinSource = pin && typeof pin === 'object' ? pin : {};
    const pinName = String(pinSource.name || '').trim();
    if (!pinName) throw new Error(`pins[${index}].name 不能为空`);
    const kind = pinSource.kind === 'exec' ? 'exec' : 'port';
    const dir = pinSource.dir === 'out' ? 'out' : 'in';
    const result = {
      name: pinName,
      kind,
      dir,
      row: Number.isInteger(pinSource.row) ? pinSource.row : index,
      label: String(pinSource.label ?? ''),
    };
    if (pinSource.editor) result.editor = pinSource.editor;
    if (Array.isArray(pinSource.options)) result.options = pinSource.options;
    if (typeof pinSource.code === 'function') result.code = pinSource.code;
    return result;
  });

  return {
    name,
    label,
    description: String(source.description || ''),
    type: source.type === 'logic' ? 'logic' : 'function',
    category: String(source.category || 'custom'),
    width: Number.isFinite(Number(source.width)) ? Number(source.width) : 220,
    external: true,
    hidden: Boolean(source.hidden),
    defaults:
      source.defaults && typeof source.defaults === 'object' && !Array.isArray(source.defaults)
        ? source.defaults
        : {},
    pins: normalizedPins,
    ...(typeof source.code === 'function' ? { code: source.code } : {}),
    ...(Array.isArray(source.prepare) ? { prepare: source.prepare } : {}),
  };
}

/** 构建 /api/abi 返回的完整约定文档 */
export function buildAbiDocument(externalNodes = []) {
  return {
    abiVersion: ABI_VERSION,
    name: 'Codeck Mobile Node ABI',
    description:
      'Codeck Mobile 外部节点扩展约定。节点 JSON 定义可放到 extensions/*.json，服务端加载后即可参与编译，客户端会从 /api/nodes 获取并显示在添加面板。',
    endpoints: {
      abi: { method: 'GET', path: '/api/abi', description: '获取本约定与已加载的外部节点' },
      nodes: {
        method: 'GET',
        path: '/api/nodes',
        description: '获取全部节点定义（含 hidden，客户端按 hidden 过滤）',
      },
      validateNode: {
        method: 'POST',
        path: '/api/abi/validate',
        body: 'ABI 节点定义 JSON',
        response: '{ ok, errors, warnings, node }',
        description: '校验外部节点定义，不注册',
      },
      state: { method: 'GET', path: '/api/state', description: '读取当前工作区' },
      saveState: {
        method: 'POST',
        path: '/api/state',
        body: '{ name, graph }',
        description: '保存工作区',
      },
      compile: {
        method: 'POST',
        path: '/api/compile',
        body: '{ graph }',
        response: '{ code } 或 { error }',
      },
      run: {
        method: 'POST',
        path: '/api/run',
        body: '{ graph, timeoutMs? }',
        response: '{ code, ok, logs, error, durationMs }',
      },
      examples: { method: 'GET', path: '/api/examples' },
      blueprints: {
        method: 'GET',
        path: '/api/blueprints',
        description: '蓝图库列表（含节点/函数数量与更新时间）',
      },
      createBlueprint: {
        method: 'POST',
        path: '/api/blueprints',
        body: '{ name, graph }',
        description: '保存为新的命名蓝图',
      },
      blueprint: {
        method: 'GET',
        path: '/api/blueprints/:id',
        description: '读取指定蓝图（含完整 graph）',
      },
      updateBlueprint: {
        method: 'PUT',
        path: '/api/blueprints/:id',
        body: '{ name?, graph? }',
        description: '覆盖蓝图内容或重命名',
      },
      deleteBlueprint: {
        method: 'DELETE',
        path: '/api/blueprints/:id',
        description: '删除蓝图',
      },
    },
    valueTypes: VALUE_TYPES,
    editors: EDITOR_TYPES,
    nodeDefinition: {
      fields: {
        name: '唯一节点名，字母开头，可含数字、下划线和短横线',
        label: '节点标题',
        description: '节点说明，可选',
        type: "'function'（可含执行流）或 'logic'（纯数据节点）",
        category: '添加面板分类，例如 custom',
        width: '节点宽度 120-520，默认 220',
        pins: '端点数组',
        defaults: '节点数据的默认值，可选',
        codeTemplate:
          '节点执行代码模板，可选；仅 function 类型使用。支持 {{input:pin}}、{{var:pin}}、{{exec:pin}}、{{block:pin}}、{{data:pin}}',
      },
      pin: {
        name: '端点名；执行端点建议使用 $exec_in / $exec_out',
        kind: "'exec' 执行端点 / 'port' 数据端点",
        dir: "'in' 输入 / 'out' 输出",
        row: '端点所在行，0-50',
        label: '端点显示文字，可选',
        editor: 'port 输入端编辑器：text / number / boolean / select / json / code',
        options: 'editor=select 时的选项 [{value,label}]',
        codeTemplate: 'port 输出端表达式模板，可选',
      },
      tokens: {
        '{{input:pin}}': '解析输入端的表达式（已连接则递归解析上游，否则使用节点内联值）',
        '{{var:pin}}': '输出端对应的变量名，例如 var {{var:result}} = 1;',
        '{{exec:pin}}': '执行输出端的下游代码（原样插入）',
        '{{block:pin}}': '执行输出端的下游代码（自动缩进 2 空格）',
        '{{data:pin}}': '输入端内联值的 JSON 字符串',
      },
      examples: {
        logicNode: {
          abiVersion: ABI_VERSION,
          name: 'double',
          label: 'Double',
          description: '输出输入值的两倍',
          type: 'logic',
          category: 'custom',
          width: 180,
          pins: [
            { name: 'value', kind: 'port', dir: 'in', row: 0, editor: 'number', label: 'value' },
            {
              name: 'result',
              kind: 'port',
              dir: 'out',
              row: 1,
              label: 'result',
              codeTemplate: '({{input:value}} * 2)',
            },
          ],
        },
        functionNode: {
          abiVersion: ABI_VERSION,
          name: 'log-ext',
          label: 'Log Ext',
          description: '外部日志节点',
          type: 'function',
          category: 'custom',
          width: 220,
          pins: [
            { name: EXEC_IN, kind: 'exec', dir: 'in', row: 0 },
            { name: EXEC_OUT, kind: 'exec', dir: 'out', row: 0 },
            { name: 'message', kind: 'port', dir: 'in', row: 1, editor: 'text', label: 'message' },
          ],
          codeTemplate: 'console.log({{input:message}});\n',
        },
      },
      notes: [
        '外部节点文件放在项目 extensions/ 目录，支持 .json 与 .js/.mjs（ESM）。',
        'JSON 使用 codeTemplate；JS 扩展可直接提供 code(ctx) 函数与 prepare 函数。',
        '服务端启动时加载外部节点；修改后需重启服务。',
        '客户端会通过 /api/nodes 获取 external: true 的节点并显示在添加面板。',
        '执行端点不能重名；数据端点同名需区分方向。',
      ],
    },
    extensions: {
      directory: 'extensions/',
      json: '单个节点对象、数组，或 { "nodes": [...] }',
      javascript: 'ESM 模块：export default 节点 / 节点数组 / { nodes } / function(abi)',
      jsExample: {
        name: 'log-js',
        label: 'Log JS',
        description: '用 JS 写的外部日志节点',
        type: 'function',
        category: 'custom',
        width: 220,
        pins: [
          { name: EXEC_IN, kind: 'exec', dir: 'in', row: 0 },
          { name: EXEC_OUT, kind: 'exec', dir: 'out', row: 0 },
          { name: 'message', kind: 'port', dir: 'in', row: 1, editor: 'text', label: 'message' },
        ],
        code: '({ input }) => `console.log(${input("message")});\\n`',
      },
    },
    global: {
      path: 'window.NodeCode',
      ready: 'Promise；外部脚本可 await window.NodeCode.ready 后再调用',
      abi: {
        version: 'ABI 版本',
        valueTypes: '支持的数据类型',
        editors: '支持的编辑器',
        validateNode: 'validateNode(def) -> { ok, errors, warnings, node }',
        defineNode: 'defineNode(def) -> 规范化节点定义',
        registerNode: 'registerNode(def) -> 注册到当前客户端节点面板',
        registerNodes: 'registerNodes(defs) -> 批量注册',
        getNodes: 'getNodes() -> 全部节点定义（内置 + 外部扩展）',
        getExternalNodes: 'getExternalNodes() -> 仅外部扩展节点',
        load: 'load(url) -> 动态 import 一个 JS ABI 模块并注册',
      },
      api: {
        getGraph: '当前视图的图',
        getWorkspace: '完整工作区（主图 + 函数）',
        loadWorkspace: '加载完整工作区 JSON',
        getScope: '当前视图：main 或函数 id',
        getScopeStack: '当前子图路径 [{ id, name }]',
        enterScope: '进入函数子图，支持在子图里继续进入其它子图',
        backScope: '返回上一级子图',
        getFunctions: '函数列表',
        getNodeDefs: '当前添加面板中的节点定义',
        getSelection: '当前选中的节点',
        selectNode: '选择节点',
        addNode: 'addNode(name, data)',
        removeNode: 'removeNode(id)',
        updateNodeData: 'updateNodeData(id, key, value)',
        compile: 'compile(graph?) -> Promise<{ code }>',
        run: 'run(graph?, timeoutMs?) -> Promise<{ ok, logs, error }>',
        save: '保存工作区',
        exportJson: '导出 JSON 对象',
        importJson: 'importJson(payload) 导入工作区',
        listBlueprints: '蓝图库列表',
        saveBlueprint: 'saveBlueprint(name) 保存当前工作区为命名蓝图',
        loadBlueprint: 'loadBlueprint(id) 加载指定蓝图',
        deleteBlueprint: 'deleteBlueprint(id) 删除蓝图',
        toast: '显示提示',
        on: "on(event, handler)：change / select / structure / scope",
        off: 'off(event, handler)',
        undo: '撤销',
        redo: '重做',
        fitView: '适应画布',
      },
    },
    externalNodes: serializeNodeDefs(externalNodes),
  };
}
