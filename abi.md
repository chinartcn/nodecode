# 外部扩展节点 ABI

ABI（Application Binary Interface）在这里指**外部节点与 Codeck Mobile 之间的约定**：

- 节点如何描述（名称、类型、端点、默认值）
- 节点如何生成 JavaScript
- 如何把定义注册到服务端编译器与前端添加面板

ABI 版本：`1`

---

## 1. 扩展节点的两种写法

| 方式 | 文件 | 特点 |
| --- | --- | --- |
| 声明式 JSON | `extensions/*.json` | 使用 `codeTemplate` 模板生成代码，适合简单节点 |
| JavaScript ESM | `extensions/*.js` / `*.mjs` | 直接提供 `code(ctx)` 函数，可实现任意逻辑 |

服务端启动时读取 `extensions/` 目录：

- 文件按名称排序加载
- 同名节点只保留第一个，后续会输出 `[extensions] 跳过重复节点`
- 单个文件加载失败只打印警告，不影响其它扩展
- 手动新增/修改扩展文件后需要**重启服务**
- 通过 `.zip` 扩展包导入会立即热重载，无需重启

服务端加载完成后：

- 编译 `/api/compile`、`/api/run` 时可识别这些节点
- 前端通过 `/api/nodes` 获取 `external: true` 的节点并显示在添加面板

### 1.1 通过 ZIP 扩展包导入

`☰` → 「扩展包 → 导入扩展包（.zip）」，或调用：

```http
POST /api/extensions/import
Content-Type: application/zip
```

规则：

- ZIP 内可以包含多层目录，其中的 `.json` / `.js` / `.mjs` 会被扁平化到 `extensions/`
- 其它文件（README、图片等）会被忽略
- 同名文件会被覆盖
- 路径中包含 `..` 的条目会被拒绝
- 导入完成后立即重载扩展节点，前端自动刷新添加面板

压缩包示例：

```text
my-extensions.zip
├── my-nodes/
│   ├── double.json
│   └── log.js
└── README.md
```

导入后 `extensions/double.json` 与 `extensions/log.js` 生效。

---

## 2. 文件导出格式

无论 JSON 还是 JS，文件内容都可以是以下三种之一：

```json
// 1. 单个节点
{ "name": "double", "label": "Double", ... }
```

```json
// 2. 节点数组
[
  { "name": "double", "label": "Double", ... },
  { "name": "triple", "label": "Triple", ... }
]
```

```json
// 3. 包装对象
{ "nodes": [ { "name": "double", "label": "Double", ... } ] }
```

JS 扩展还支持默认导出一个函数（可 async），函数会收到 ABI 辅助对象：

```js
export default function define(abi) {
  return {
    nodes: [
      {
        name: 'double',
        label: 'Double',
        type: 'logic',
        pins: [
          { name: 'value', kind: 'port', dir: 'in', row: 0, editor: 'number' },
          {
            name: 'result',
            kind: 'port',
            dir: 'out',
            row: 1,
            code: ({ input }) => `((${input('value')}) * 2)`,
          },
        ],
      },
    ],
  };
}
```

`abi` 辅助对象包含：

| 字段 | 说明 |
| --- | --- |
| `version` | ABI 版本，当前为 `1` |
| `defineNode(def)` | 校验并构建 JSON 风格的节点定义 |
| `buildNode(def)` | 同 `defineNode` |
| `render(template, ctx)` | 渲染 `codeTemplate` |
| `EXEC_IN` | `'$exec_in'` |
| `EXEC_OUT` | `'$exec_out'` |

---

## 3. 节点定义字段

### 3.1 JSON 节点（严格校验）

| 字段 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `abiVersion` | number | 否 | `1` | 不等于 1 会产生警告 |
| `name` | string | 是 | — | 唯一节点名；必须以字母开头，只含字母、数字、`_`、`-` |
| `label` | string | 是 | — | 节点标题，不能为空 |
| `description` | string | 否 | `''` | 节点说明 |
| `type` | `'function' \| 'logic'` | 是 | — | `function` 可包含执行流；`logic` 为纯数据节点 |
| `category` | string | 否 | `'custom'` | 添加面板分类 |
| `width` | number | 否 | `220` | 节点宽度，必须在 `120` – `520` 之间 |
| `pins` | array | 是 | — | 非空端点数组 |
| `defaults` | object | 否 | `{}` | 节点参数默认值 |
| `codeTemplate` | string | 否 | — | 节点执行代码模板；`function` 类型未提供时会有警告 |

> JSON 节点不支持 `hidden`、`prepare`、`code` 函数；这些能力请使用 JS 扩展。

### 3.2 JS 节点（宽松构建）

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `name` | string | — | 必填，规则同上，不能与已有节点重名 |
| `label` | string | 等于 `name` | 节点标题 |
| `description` | string | `''` | 说明 |
| `type` | `'function' \| 'logic'` | `'function'` | 非 `logic` 一律按 `function` |
| `category` | string | `'custom'` | 分类 |
| `width` | number | `220` | 宽度 |
| `hidden` | boolean | `false` | 是否在添加面板隐藏 |
| `defaults` | object | `{}` | 默认参数 |
| `pins` | array | — | 必须非空 |
| `code` | function | — | 节点代码生成函数 `code(ctx)` |
| `prepare` | array | — | 需要注入到生成代码顶部的辅助函数 |

> JS 节点跳过 JSON 的严格范围校验；仍然会校验名称唯一性、`label` 非空、`pins` 非空。

### 3.3 端点（pin）字段

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `name` | string | — | 端点名，必填；同一方向内不能重复 |
| `kind` | `'exec' \| 'port'` | — | `exec` 执行端点 / `port` 数据端点 |
| `dir` | `'in' \| 'out'` | — | 输入 / 输出 |
| `row` | integer | 数组下标 | 所在行，`0` – `50` |
| `label` | string | `''` | 端点显示文字 |
| `editor` | string | `'text'` | 仅数据输入端：`text` / `number` / `boolean` / `select` / `json` / `code` |
| `options` | array | — | `editor: 'select'` 时必填，格式 `[{ value, label }]` 或字符串数组 |
| `codeTemplate` | string | — | 仅数据输出端：表达式模板 |
| `code` | function | — | 仅 JS 扩展：输出端表达式生成函数 |

校验规则：

- `kind`、`dir`、`name` 必填
- 重复端点按 `dir:name` 判断，例如 `in:value` 与 `out:value` 可以共存
- `row` 必须是 `0` – `50` 的整数
- `editor: 'select'` 必须提供非空 `options`

### 3.4 执行端点命名约定

内置节点统一使用：

- 输入：`$exec_in`
- 输出：`$exec_out`

自定义执行分支可以使用任意名称，例如 `true`、`false`、`body`、`onSuccess`。

---

## 4. 代码生成

### 4.1 JSON：`codeTemplate`

`function` 类型的节点级模板会在执行流到达该节点时插入：

```json
{
  "name": "log-ext",
  "label": "Log Ext",
  "type": "function",
  "pins": [
    { "name": "$exec_in", "kind": "exec", "dir": "in", "row": 0 },
    { "name": "$exec_out", "kind": "exec", "dir": "out", "row": 0 },
    { "name": "message", "kind": "port", "dir": "in", "row": 1, "editor": "text", "label": "message" }
  ],
  "codeTemplate": "console.log({{input:message}});\n"
}
```

数据输出端也可以有模板，用于纯表达式：

```json
{
  "name": "result",
  "kind": "port",
  "dir": "out",
  "row": 1,
  "codeTemplate": "({{input:value}} * 2)"
}
```

### 4.2 模板占位符

| 占位符 | 替换结果 | 典型用途 |
| --- | --- | --- |
| `{{input:pin}}` | 输入端表达式：已连接则递归解析上游，否则使用节点内联值 | 读取参数 |
| `{{var:pin}}` | 输出端对应的变量名 | `var {{var:result}} = 1;` |
| `{{exec:pin}}` | 该执行输出端连接的下游代码，原样插入 | 串联执行流 |
| `{{block:pin}}` | 同上，但自动缩进 2 空格 | 插入 `if` / `for` 代码块 |
| `{{data:pin}}` | 输入端内联值的 JSON 字符串 | 调试或字面量 |

说明：

- 若某个 token 解析失败（如端点不存在），会**原样保留**该 token，便于排查
- `{{input:...}}` 返回的是表达式字符串，不会自动加括号；需要时请自行包裹
- 输出端变量名由节点 id 与端点名派生，保证在生成代码中唯一

### 4.3 JS：`code(ctx)`

节点级 `code` 返回**语句字符串**：

```js
export default {
  name: 'log-js',
  label: 'Log JS',
  type: 'function',
  pins: [
    { name: '$exec_in', kind: 'exec', dir: 'in', row: 0 },
    { name: '$exec_out', kind: 'exec', dir: 'out', row: 0 },
    { name: 'message', kind: 'port', dir: 'in', row: 1, editor: 'text' },
  ],
  code: ({ input }) => `console.log(${input('message')});\n`,
};
```

输出端 `pin.code` 返回**表达式字符串**：

```js
{
  name: 'value',
  kind: 'port',
  dir: 'in',
  row: 0,
  editor: 'number',
}
{
  name: 'result',
  kind: 'port',
  dir: 'out',
  row: 1,
  code: ({ input }) => `((${input('value')}) * 2)`,
}
```

### 4.4 `ctx` 上下文 API

`code(ctx)` 与 `pin.code(ctx)` 都会收到同一个上下文对象：

| 成员 | 签名 | 说明 |
| --- | --- | --- |
| `node` | `Node` | 当前节点对象（含 `id`、`name`、`data`） |
| `input` | `(pinName, nodeId?) => string` | 解析输入端点表达式；默认当前节点 |
| `raw` | `(pinName) => unknown` | 读取节点内联值 `node.data[pinName]` |
| `isConnected` | `(pinName, nodeId?) => boolean` | 判断输入是否已连线 |
| `execOut` | `(pinName, nodeId?) => string \| null` | 生成并返回执行输出端下游代码 |
| `buildPinVarName` | `(pinName, nodeId?) => string` | 生成输出端变量名 |
| `indent` | `(text, size?) => string` | 缩进文本，默认 2 空格 |
| `block` | `(text, size?) => string` | 缩进代码块，空内容返回空串 |

#### 示例：带分支的函数节点

```js
export default {
  name: 'maybe-log',
  label: 'Maybe Log',
  type: 'function',
  pins: [
    { name: '$exec_in', kind: 'exec', dir: 'in', row: 0 },
    { name: '$exec_out', kind: 'exec', dir: 'out', row: 0 },
    { name: 'ok', kind: 'exec', dir: 'out', row: 1, label: 'ok' },
    { name: 'fail', kind: 'exec', dir: 'out', row: 2, label: 'fail' },
    { name: 'enabled', kind: 'port', dir: 'in', row: 1, editor: 'boolean' },
    { name: 'message', kind: 'port', dir: 'in', row: 2, editor: 'text' },
  ],
  code: ({ input, execOut }) => `
if (${input('enabled')}) {
  console.log(${input('message')});
${execOut('ok') || ''}
} else {
${execOut('fail') || ''}
}
`,
};
```

> 建议用 `var` 声明输出变量，而不是 `const` / `let`。内置节点全部使用 `var`，以避免输出变量在 `if` / `for` 块内声明、却在块外被引用时触发 `ReferenceError`。

### 4.5 `prepare`：注入辅助函数

`prepare` 是数组，每项描述一个需要注入到生成代码顶部的函数：

```js
prepare: [
  {
    type: 'function',
    name: '__getPath',
    parameters: ['obj', 'path'],
    body: [
      'if (obj == null) return undefined;',
      "const keys = String(path).split('.');",
      'let current = obj;',
      'for (const key of keys) {',
      '  if (current == null) return undefined;',
      '  current = current[key];',
      '}',
      'return current;',
    ].join('\n'),
  },
]
```

生成结果：

```js
function __getPath(obj, path) {
  if (obj == null) return undefined;
  // ...
}
```

规则：

- `type` 目前只支持 `'function'`
- `name` 相同的 `prepare` 在整张工作区中只注入一次
- 函数在执行代码之前声明，可直接在节点代码中调用

---

## 5. 完整示例

### 5.1 JSON：纯数据节点

`extensions/double.json`

```json
{
  "abiVersion": 1,
  "name": "double",
  "label": "Double",
  "description": "输出输入值的两倍",
  "type": "logic",
  "category": "custom",
  "width": 180,
  "pins": [
    {
      "name": "value",
      "kind": "port",
      "dir": "in",
      "row": 0,
      "editor": "number",
      "label": "value"
    },
    {
      "name": "result",
      "kind": "port",
      "dir": "out",
      "row": 1,
      "label": "result",
      "codeTemplate": "({{input:value}} * 2)"
    }
  ]
}
```

使用：把任意数字输出连接到 `value`，`result` 即可作为两倍值继续连线。

### 5.2 JSON：执行节点

`extensions/log-ext.json`

```json
{
  "abiVersion": 1,
  "name": "log-ext",
  "label": "Log Ext",
  "description": "外部日志节点",
  "type": "function",
  "category": "custom",
  "width": 220,
  "pins": [
    { "name": "$exec_in", "kind": "exec", "dir": "in", "row": 0 },
    { "name": "$exec_out", "kind": "exec", "dir": "out", "row": 0 },
    { "name": "message", "kind": "port", "dir": "in", "row": 1, "editor": "text", "label": "message" }
  ],
  "codeTemplate": "console.log({{input:message}});\n"
}
```

### 5.3 JS：使用上下文与分支

`extensions/http-status.js`

```js
export default {
  name: 'http-status',
  label: 'HTTP Status',
  description: '根据状态码走成功或失败分支',
  type: 'function',
  category: 'custom',
  width: 240,
  defaults: { status: 200 },
  pins: [
    { name: '$exec_in', kind: 'exec', dir: 'in', row: 0 },
    { name: '$exec_out', kind: 'exec', dir: 'out', row: 0 },
    { name: 'ok', kind: 'exec', dir: 'out', row: 1, label: 'ok' },
    { name: 'fail', kind: 'exec', dir: 'out', row: 2, label: 'fail' },
    { name: 'status', kind: 'port', dir: 'in', row: 1, editor: 'number' },
  ],
  code: ({ input, execOut, block }) => `
if (${input('status')} >= 200 && ${input('status')} < 300) {
${block(execOut('ok'), 2)}
} else {
${block(execOut('fail'), 2)}
}
`,
};
```

### 5.4 JS：函数式导出

`extensions/batch.js`

```js
export default function (abi) {
  return [
    {
      name: 'alpha',
      label: 'Alpha',
      type: 'logic',
      pins: [
        { name: 'value', kind: 'port', dir: 'in', row: 0, editor: 'number' },
        {
          name: 'result',
          kind: 'port',
          dir: 'out',
          row: 1,
          code: ({ input }) => `(${input('value')} + 1)`,
        },
      ],
    },
    {
      name: 'beta',
      label: 'Beta',
      type: 'logic',
      pins: [
        { name: 'value', kind: 'port', dir: 'in', row: 0, editor: 'number' },
        {
          name: 'result',
          kind: 'port',
          dir: 'out',
          row: 1,
          code: ({ input }) => `(${input('value')} - 1)`,
        },
      ],
    },
  ];
}
```

---

## 6. 客户端动态注册

除了 `extensions/`，也可以在浏览器里通过 `window.NodeCode.abi` 临时注册节点：

```js
await window.NodeCode.ready;

const def = window.NodeCode.abi.defineNode({
  name: 'triple',
  label: 'Triple',
  type: 'logic',
  category: 'custom',
  pins: [
    { name: 'value', kind: 'port', dir: 'in', row: 0, editor: 'number' },
    {
      name: 'result',
      kind: 'port',
      dir: 'out',
      row: 1,
      codeTemplate: '({{input:value}} * 3)',
    },
  ],
});

window.NodeCode.abi.registerNode(def);
```

| 方法 | 说明 |
| --- | --- |
| `validateNode(def)` | 返回 `{ ok, errors, warnings, node }`，不抛错 |
| `defineNode(def)` | 校验并返回规范化定义，失败抛 `Error` |
| `registerNode(def)` | 注册到当前页面添加面板 |
| `registerNodes(defs)` | 批量注册 |
| `getNodes()` | 全部节点定义（内置 + 外部） |
| `getExternalNodes()` | 仅外部扩展节点 |
| `load(url)` | `await import(url)` 并注册模块导出的节点 |

`load(url)` 支持的模块导出形式与 `extensions/*.js` 相同。

### 客户端注册的边界

- 客户端注册只更新**当前页面**的节点面板与图编辑能力
- 服务端编译时仍然只认识 `extensions/` 中加载的节点
- 若要让某个节点真正参与服务端执行，必须把它放到 `extensions/` 并重启服务
- 注册名不能与内置节点冲突，否则会抛错

---

## 7. 校验与错误

### 7.1 服务端校验

```bash
curl -s -X POST http://localhost:5173/api/abi/validate \
  -H 'Content-Type: application/json' \
  -d '{"node":{"name":"double","label":"Double","type":"logic","pins":[{"name":"v","kind":"port","dir":"in","row":0}]}}'
```

返回：

```json
{
  "ok": true,
  "errors": [],
  "warnings": [],
  "node": { "...": "..." }
}
```

常见错误：

| 错误 | 原因 |
| --- | --- |
| `name 必须以字母开头...` | 名称不符合正则 |
| `节点名「x」已存在` | 与内置或已加载节点重名 |
| `label 不能为空` | 缺少标题 |
| `type 必须是 'function' 或 'logic'` | 类型不合法 |
| `width 必须是 120 到 520 之间的数字` | 宽度越界 |
| `pins 必须是非空数组` | 没有端点 |
| `pins[i].kind 必须是 'exec' 或 'port'` | 端点类型错误 |
| `pins[i].dir 必须是 'in' 或 'out'` | 方向错误 |
| `端点重复：in:value` | 同方向重复名称 |
| `pins[i] 使用 select 时必须提供 options` | 下拉框缺少选项 |

常见警告：

| 警告 | 说明 |
| --- | --- |
| `abiVersion 建议为 1` | 版本不匹配 |
| `function 类型节点没有 codeTemplate，将不会生成执行代码` | 节点可以显示，但执行时不会产生代码 |

### 7.2 编译期错误

扩展节点代码生成函数抛出的异常会被编译器捕获并作为编译错误返回。

常见原因：

- `ctx.input()` 引用了不存在的端点
- 输出端 `code` 返回了语句而不是表达式
- `codeTemplate` 中引用了不存在的占位符（不会抛错，但会保留原 token）
- 生成代码存在语法错误

### 7.3 运行期错误

扩展节点生成的代码在沙箱中运行，错误会出现在运行结果的 `error` 字段与 `logs` 中。

---

## 8. 最佳实践

1. **名称使用小写短横线**：如 `http-status`，避免与内置节点冲突
2. **纯计算节点用 `logic`**：不参与执行流，只做数据转换
3. **需要执行顺序的节点用 `function`**：至少包含 `$exec_in`，通常也包含 `$exec_out`
4. **输出变量用 `var`**：避免块级作用域导致的引用错误
5. **表达式加括号**：`{{input:value}}` 原样插入，复杂表达式请自行加括号
6. **分支端点用 `block`**：缩进下游代码，生成结果更易读
7. **`prepare` 用于无副作用工具函数**：会注入到整份生成代码顶部
8. **不要把密钥写进扩展代码**：扩展代码会随服务端运行，且没有隔离
9. **手动改文件需重启；用 ZIP 导入无需重启**：通过界面导入 `.zip` 会自动热重载并刷新节点面板
10. **优先在 `extensions/` 中实现**：才能同时支持服务端编译和客户端展示

---

## 9. 相关文档

- [nodes.md](nodes.md) — 内置节点端点与语义参考
- [api.md](api.md) — HTTP API 与浏览器 SDK
- [architecture.md](architecture.md) — 编译器与沙箱实现
