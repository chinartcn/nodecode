# API 文档

本文档包含两部分：

1. **HTTP API**：服务端提供的 REST 接口
2. **浏览器 SDK**：页面内的 `window.NodeCode`

外部扩展节点的定义约定请阅读 [abi.md](abi.md)。

---

## 一、HTTP API

### 1.1 基础约定

| 项目 | 说明 |
| --- | --- |
| Base URL | `http://<host>:<port>`，默认 `http://localhost:5173` |
| 数据格式 | 请求与响应均为 JSON（`Content-Type: application/json`） |
| 字符编码 | UTF-8 |
| 请求体上限 | 4 MB |
| 缓存 | API 响应 `Cache-Control: no-store` |
| 版本 | 当前 API / ABI 版本为 `1` |

成功响应示例：

```json
{ "ok": true }
```

错误响应统一为：

```json
{ "error": "错误说明" }
```

常见状态码：

| 状态码 | 含义 |
| --- | --- |
| 200 | 成功 |
| 400 | 参数错误 / 编译失败 / 校验失败 |
| 404 | 接口或资源不存在 |
| 500 | 服务端内部错误 |

### 1.2 CORS

仅以下接口允许跨域，其余接口不返回 CORS 头：

- `GET /api/abi`
- `GET /api/nodes`
- `GET /api/node-defs`
- `POST /api/abi/validate`

允许方法：`GET, POST, OPTIONS`；允许请求头：`Content-Type`。

### 1.3 接口总览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/abi` | 获取 ABI 约定文档与已加载的外部节点 |
| GET | `/api/nodes` | 获取全部节点定义（含 hidden） |
| GET | `/api/node-defs` | 同 `/api/nodes` |
| POST | `/api/abi/validate` | 校验外部节点定义（不注册） |
| GET | `/api/state` | 读取当前工作区 |
| POST | `/api/state` | 保存当前工作区 |
| GET | `/api/examples` | 获取内置示例蓝图 |
| GET | `/api/blueprints` | 蓝图库列表 |
| POST | `/api/blueprints` | 新建蓝图 |
| GET | `/api/blueprints/:id` | 读取指定蓝图 |
| PUT | `/api/blueprints/:id` | 更新指定蓝图 |
| DELETE | `/api/blueprints/:id` | 删除指定蓝图 |
| POST | `/api/compile` | 编译蓝图为 JavaScript |
| POST | `/api/run` | 编译并在沙箱中运行 |

静态资源：

| 路径 | 说明 |
| --- | --- |
| `/` | 返回 `public/index.html` |
| `/<文件>` | `public/` 下的静态文件，如 `/styles.css`、`/js/app.js` |
| `/shared/*` | 前端可直接导入的共享模块，如 `/shared/node-defs.js` |

---

### 1.4 `GET /api/health`

健康检查。

**响应**

```json
{ "ok": true, "name": "codeck-mobile" }
```

---

### 1.5 `GET /api/abi`

返回 ABI 约定文档、节点定义示例，以及当前已加载的外部扩展节点。

**响应结构（节选）**

```json
{
  "abiVersion": 1,
  "name": "Codeck Mobile Node ABI",
  "endpoints": { "...": "..." },
  "valueTypes": ["string", "number", "boolean", "object", "array"],
  "editors": ["text", "number", "boolean", "select", "json", "code"],
  "nodeDefinition": {
    "fields": { "...": "..." },
    "pin": { "...": "..." },
    "tokens": { "...": "..." },
    "examples": { "...": "..." },
    "notes": ["..."]
  },
  "extensions": { "...": "..." },
  "global": {
    "path": "window.NodeCode",
    "abi": { "...": "..." },
    "api": { "...": "..." }
  },
  "externalNodes": []
}
```

完整字段含义见 [abi.md](abi.md)。

---

### 1.6 `GET /api/nodes` 与 `GET /api/node-defs`

获取节点定义，包含内置节点与外部扩展节点。`hidden: true` 的节点也会返回，由客户端决定是否展示。

**响应**

```json
{
  "abiVersion": 1,
  "nodes": [
    {
      "name": "log",
      "label": "Log",
      "description": "在运行面板输出一条日志",
      "type": "function",
      "category": "core",
      "width": 230,
      "hidden": false,
      "external": false,
      "defaults": { "message": "Hello Codeck Mobile" },
      "pins": [
        { "name": "$exec_in", "kind": "exec", "dir": "in", "row": 0, "label": "" },
        { "name": "$exec_out", "kind": "exec", "dir": "out", "row": 0, "label": "" },
        { "name": "message", "kind": "port", "dir": "in", "row": 1, "label": "message", "editor": "text" }
      ]
    }
  ]
}
```

说明：

- `type` 取值为 `begin` / `function` / `logic`
- `kind` 取值为 `exec` / `port`
- `dir` 取值为 `in` / `out`
- `editor` 仅出现在数据输入端
- 函数相关节点名形如 `fncall:<fnId>`、`fnarg:<fnId>:<entryId>`、`fnret:<fnId>:<entryId>`

---

### 1.7 `POST /api/abi/validate`

校验一个外部节点定义，不注册。请求体可以直接是节点定义，也可以是 `{ "node": { ... } }`。

**请求**

```json
{
  "node": {
    "name": "double",
    "label": "Double",
    "type": "logic",
    "pins": [
      { "name": "value", "kind": "port", "dir": "in", "row": 0, "editor": "number" },
      { "name": "result", "kind": "port", "dir": "out", "row": 1, "codeTemplate": "({{input:value}} * 2)" }
    ]
  }
}
```

**成功响应（200）**

```json
{
  "ok": true,
  "errors": [],
  "warnings": [],
  "node": {
    "abiVersion": 1,
    "name": "double",
    "label": "Double",
    "description": "",
    "type": "logic",
    "category": "custom",
    "width": 220,
    "pins": [],
    "defaults": {}
  }
}
```

**校验失败（400）**

```json
{
  "ok": false,
  "errors": ["label 不能为空"],
  "warnings": [],
  "node": {}
}
```

---

### 1.8 `GET /api/state`

读取当前工作区。

**响应**

```json
{
  "name": "我的蓝图",
  "updatedAt": "2026-11-08T06:00:00.000Z",
  "graph": {
    "nodes": [],
    "connections": [],
    "variables": [],
    "functions": []
  }
}
```

如果工作区文件不存在或损坏，会自动使用第一个内置示例重建并保存。

---

### 1.9 `POST /api/state`

保存当前工作区。

**请求**

```json
{
  "name": "我的蓝图",
  "graph": {
    "nodes": [],
    "connections": [],
    "variables": [],
    "functions": []
  }
}
```

**响应**

```json
{
  "ok": true,
  "name": "我的蓝图",
  "updatedAt": "2026-11-08T06:01:00.000Z"
}
```

说明：

- `name` 最长 60 字符
- 保存前会执行 `normalizeGraph` 归一化
- 写入采用临时文件 + 原子重命名，避免半写状态

---

### 1.10 `GET /api/examples`

返回内置示例蓝图。

**响应**

```json
[
  {
    "id": "hello",
    "name": "入门问候",
    "description": "最简单的执行链：开始 → 两条日志",
    "graph": {
      "nodes": [],
      "connections": [],
      "variables": []
    }
  }
]
```

---

### 1.11 蓝图库

#### `GET /api/blueprints`

**响应**

```json
{
  "blueprints": [
    {
      "id": "bp_m3x9abc",
      "name": "登录流程",
      "createdAt": "2026-11-08T05:00:00.000Z",
      "updatedAt": "2026-11-08T06:00:00.000Z",
      "nodeCount": 12,
      "connectionCount": 10,
      "functionCount": 2,
      "variableCount": 3
    }
  ]
}
```

按 `updatedAt` 倒序排列。

#### `POST /api/blueprints`

**请求**

```json
{
  "name": "登录流程",
  "graph": {
    "nodes": [],
    "connections": [],
    "variables": [],
    "functions": []
  }
}
```

**响应**

```json
{
  "id": "bp_m3x9abc",
  "name": "登录流程",
  "createdAt": "2026-11-08T05:00:00.000Z",
  "updatedAt": "2026-11-08T05:00:00.000Z"
}
```

#### `GET /api/blueprints/:id`

**响应**

```json
{
  "id": "bp_m3x9abc",
  "name": "登录流程",
  "createdAt": "2026-11-08T05:00:00.000Z",
  "updatedAt": "2026-11-08T06:00:00.000Z",
  "graph": {
    "nodes": [],
    "connections": [],
    "variables": [],
    "functions": []
  }
}
```

不存在时返回 `404 { "error": "ENOENT: ..." }`。

#### `PUT /api/blueprints/:id`

**请求**（`name` 与 `graph` 均可选）

```json
{
  "name": "新名称",
  "graph": { "nodes": [], "connections": [], "variables": [], "functions": [] }
}
```

**响应**

```json
{
  "id": "bp_m3x9abc",
  "name": "新名称",
  "updatedAt": "2026-11-08T06:10:00.000Z"
}
```

#### `DELETE /api/blueprints/:id`

**响应**

```json
{ "ok": true }
```

说明：

- 蓝图 ID 必须匹配 `[A-Za-z0-9_-]{4,80}`
- 存储位置：`data/blueprints/<id>.json`
- 删除不存在的蓝图不会报错

---

### 1.12 `POST /api/compile`

把蓝图编译为 JavaScript，不执行。

**请求**

```json
{
  "graph": {
    "nodes": [
      { "id": "n1", "name": "begin", "position": { "x": 0, "y": 0 }, "data": {} },
      { "id": "n2", "name": "log", "position": { "x": 200, "y": 0 }, "data": { "message": "hi" } }
    ],
    "connections": [
      {
        "id": "c1",
        "fromNodeId": "n1",
        "fromNodePinName": "$exec_out",
        "toNodeId": "n2",
        "toNodePinName": "$exec_in"
      }
    ],
    "variables": [],
    "functions": []
  }
}
```

**成功响应（200）**

```json
{
  "code": "async function __task_n1() {\n  // Log · n2\n  console.log(\"hi\");\n\n}\n\nconst __tasks = [\n  { name: \"开始 · n1\", run: () => __task_n1() },\n];\nconst __results = await Promise.allSettled(__tasks.map((task) => task.run()));\n..."
}
```

**编译失败（400）**

```json
{ "error": "主图至少需要一个触发节点" }
```

> 请求中的 `graph` 会先经过归一化：缺失触发节点时自动补一个「开始」节点；未知节点、非法连线会被丢弃。

---

### 1.13 `POST /api/run`

编译并在 `node:vm` 沙箱中执行。

**请求**

```json
{
  "graph": { "nodes": [], "connections": [], "variables": [], "functions": [] },
  "timeoutMs": 8000
}
```

`timeoutMs` 可选，默认 `8000`，服务端会限制在 `500` – `30000` 之间。

**成功响应（200）**

```json
{
  "code": "async function __task_n1() { ... }",
  "ok": true,
  "logs": [
    { "level": "log", "text": "hi" }
  ],
  "error": null,
  "durationMs": 12
}
```

**运行失败（HTTP 仍为 200）**

```json
{
  "code": "...",
  "ok": false,
  "logs": [
    { "level": "log", "text": "任务 B 已执行" },
    { "level": "error", "text": "[触发任务失败] 开始 · n_a: boom" }
  ],
  "error": {
    "name": "Error",
    "message": "部分触发任务执行失败：开始 · n_a",
    "stack": "Error: ..."
  },
  "durationMs": 20
}
```

**编译失败（400）**

```json
{ "error": "检测到数据流循环依赖，请检查连线" }
```

运行结果字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `code` | string | 编译生成的代码 |
| `ok` | boolean | 是否全部成功 |
| `logs` | array | `{ level, text }`，最多 300 条，单条最长 4000 字符 |
| `error` | object \| null | `{ name, message, stack }` |
| `durationMs` | number | 执行耗时 |

> 多触发任务使用 `Promise.allSettled`：一个任务失败不会阻止其它任务执行；全部结束后若有失败，会返回聚合错误。

---

## 二、浏览器 SDK

页面加载后，全局对象 `window.NodeCode` 可用：

```js
window.NodeCode = {
  version: 1,
  ready: Promise<void>,
  abi: { ... },   // 扩展节点 ABI
  api: { ... },   // 编辑器控制 API
};
```

### 2.1 等待初始化

```js
await window.NodeCode.ready;
console.log(window.NodeCode.abi.getNodes().length);
```

`ready` 在首次工作区加载、节点目录获取完成后 resolve。

---

### 2.2 `window.NodeCode.api`

#### 读取

| 方法 | 返回 | 说明 |
| --- | --- | --- |
| `getGraph()` | `Graph` | 当前作用域的图（深拷贝） |
| `getWorkspace()` | `WorkspaceGraph` | 完整工作区（主图 + 函数 + 类） |
| `getScope()` | `'main' \| string` | 当前作用域：`main`、函数 id 或 `cls:<classId>:<methodId>` |
| `getScopeStack()` | `[{ id, name }]` | 当前子图路径 |
| `getFunctions()` | `[{ id, name, inputs, outputs }]` | 函数列表 |
| `getClasses()` | `[{ id, name, properties, methods }]` | 类列表（含属性与方法签名） |
| `getNodeDefs()` | `NodeDef[]` | 当前添加面板可用的节点定义 |
| `getNodeCatalog()` | `Promise<{ abiVersion, nodes }>` | 请求 `/api/nodes` |
| `getAbi()` | `Promise<object>` | 请求 `/api/abi` |
| `getSelection()` | `Node[]` | 当前选中的节点 |
| `exportJson()` | `{ version, name, graph }` | 导出当前完整工作区对象（不下载文件） |

#### 作用域

| 方法 | 说明 |
| --- | --- |
| `enterScope(id)` | 进入函数子图或类方法子图；函数传函数 id，方法传 `cls:<classId>:<methodId>` |
| `backScope()` | 返回上一级子图，最终回到主图 |

#### 编辑

| 方法 | 返回 | 说明 |
| --- | --- | --- |
| `selectNode(id)` | `void` | 选中指定节点 |
| `addNode(name, data?)` | `Node \| null` | 在当前画布添加节点，`data` 会覆盖默认值 |
| `removeNode(id)` | `boolean` | 删除节点；最后一个触发节点会被拒绝 |
| `updateNodeData(id, key, value)` | `void` | 修改节点参数 |
| `undo()` | `boolean` | 撤销 |
| `redo()` | `boolean` | 重做 |
| `fitView()` | `void` | 适应画布 |

#### 工作区与持久化

| 方法 | 返回 | 说明 |
| --- | --- | --- |
| `loadWorkspace(graph)` | `Promise<WorkspaceGraph>` | 加载完整工作区并立即保存 |
| `save()` | `Promise<void>` | 标记并立即保存 |
| `importJson(payload)` | `Promise<WorkspaceGraph>` | 替换导入工作区 |
| `importModule(payload)` | `Promise<ModuleSummary>` | 合并导入模块 |
| `compile(graph?)` | `Promise<{ code }>` | 编译，默认当前工作区 |
| `run(graph?, timeoutMs?)` | `Promise<RunResult>` | 运行，默认当前工作区、8000ms |

#### 蓝图库

| 方法 | 返回 | 说明 |
| --- | --- | --- |
| `listBlueprints()` | `Promise<{ blueprints }>` | 蓝图列表 |
| `saveBlueprint(name)` | `Promise<record>` | 保存当前工作区为新蓝图 |
| `loadBlueprint(id)` | `Promise<WorkspaceGraph>` | 加载蓝图（替换当前工作区并保存） |
| `deleteBlueprint(id)` | `Promise<{ ok }>` | 删除蓝图 |

#### 其他

| 方法 | 说明 |
| --- | --- |
| `toast(message)` | 显示一条底部提示 |
| `on(event, handler)` | 订阅事件 |
| `off(event, handler)` | 取消订阅 |

#### 事件

```js
const onScope = (payload) => console.log('scope', payload);
window.NodeCode.api.on('scope', onScope);
// window.NodeCode.api.off('scope', onScope);
```

| 事件 | Payload | 触发时机 |
| --- | --- | --- |
| `change` | `{ scope }` | 图内容发生变化 |
| `select` | `{ scope, nodes }` | 选择变化 |
| `structure` | `{ scope }` | 节点/连线结构变化 |
| `scope` | `{ id, name, stack }` | 切换子图 |

#### 示例：读取并运行

```js
await window.NodeCode.ready;
const { api } = window.NodeCode;

const workspace = api.getWorkspace();
console.log('节点数', workspace.nodes.length);

const result = await api.run(undefined, 5000);
console.log(result.ok, result.logs, result.error);
```

#### 示例：添加节点并修改参数

```js
await window.NodeCode.ready;
const { api } = window.NodeCode;

const node = api.addNode('log', { message: '来自 SDK 的日志' });
if (node) {
  api.updateNodeData(node.id, 'message', '修改后的日志');
  api.selectNode(node.id);
  await api.save();
}
```

#### 示例：合并模块

```js
await window.NodeCode.ready;
const summary = await window.NodeCode.api.importModule({
  name: '外部模块',
  graph: {
    nodes: [
      { id: 't', name: 'begin', position: { x: 0, y: 0 }, data: {} },
      { id: 'l', name: 'log', position: { x: 220, y: 0 }, data: { message: '模块任务' } },
    ],
    connections: [
      {
        id: 'c1',
        fromNodeId: 't',
        fromNodePinName: '$exec_out',
        toNodeId: 'l',
        toNodePinName: '$exec_in',
      },
    ],
    variables: [],
  },
});
console.log(summary);
```

`ModuleSummary`：

```json
{
  "nodes": 2,
  "connections": 1,
  "variables": 0,
  "functions": 0,
  "classes": 0,
  "triggers": 1,
  "hasTrigger": true,
  "name": "外部模块"
}
```

---

### 2.3 `window.NodeCode.abi`

详见 [abi.md](abi.md)。提供：

| 方法 | 说明 |
| --- | --- |
| `validateNode(def)` | 校验并返回 `{ ok, errors, warnings, node }` |
| `defineNode(def)` | 校验并返回规范化节点定义，失败抛错 |
| `registerNode(def)` | 注册节点到当前客户端添加面板 |
| `registerNodes(defs)` | 批量注册 |
| `getNodes()` | 获取全部节点定义（内置 + 外部） |
| `getExternalNodes()` | 仅外部扩展节点 |
| `load(url)` | 动态 `import(url)` 并注册导出的节点 |

示例：

```js
await window.NodeCode.ready;

window.NodeCode.abi.registerNode({
  name: 'browser-only',
  label: 'Browser Only',
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
```

> 通过 `registerNode` 注册的节点只存在于当前页面会话，不会写入服务端。若希望服务端编译时识别该节点，必须把它放到 `extensions/` 目录并重启服务。

---

## 三、Graph 数据结构

```ts
interface Graph {
  nodes: Node[];
  connections: Connection[];
  variables: Variable[];
  functions?: FunctionDef[];
  classes?: ClassDef[];
}

interface Node {
  id: string;
  name: string;            // 节点类型名，如 'log'、'fncall:fn_xxx'、'clsnew:cls_xxx'
  position: { x: number; y: number };
  data: Record<string, unknown>;
}

interface Connection {
  id: string;
  fromNodeId: string;
  fromNodePinName: string; // 输出端点名，执行端点通常为 '$exec_out'
  toNodeId: string;
  toNodePinName: string;   // 输入端点名，执行端点通常为 '$exec_in'
}

interface Variable {
  name: string;            // 合法 JS 标识符
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  value: unknown;          // object/array 以 JSON 字符串保存
}

interface FunctionDef {
  id: string;
  name: string;
  inputs: SignatureEntry[];
  outputs: SignatureEntry[];
  graph: {
    nodes: Node[];
    connections: Connection[];
    variables: Variable[];
  };
}

interface ClassDef {
  id: string;
  name: string;
  properties: {
    id: string;
    name: string;
    type: 'string' | 'number' | 'boolean' | 'object' | 'array';
    value: unknown;
  }[];
  methods: {
    id: string;
    name: string;
    inputs: SignatureEntry[];
    outputs: SignatureEntry[];
    graph: {
      nodes: Node[];
      connections: Connection[];
      variables: Variable[];
    };
  }[];
}

interface SignatureEntry {
  id: string;
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
}
```

### 3.1 归一化规则

服务端与前端在加载图时都会调用 `normalizeGraph`：

- 非对象或缺失节点时，生成一个空的「开始」节点
- 未知节点类型（`name` 不存在）会被丢弃
- 重复节点 id 只保留第一个
- 函数内部只保留第一个触发节点；主图允许多个
- 类/方法/属性 id 或名称重复时自动重新分配或追加序号
- 连线两端节点或端点不存在、类型不匹配时会被丢弃
- 重复连线（相同四点）会被去重
- 变量名重复时只保留第一个
- 变量类型不在允许集合时回退为 `string`

### 3.2 作用域

- `main`：主图
- `functions[i].graph`：函数子图
- `classes[i].methods[j].graph`：类方法子图，作用域 id 为 `cls:<classId>:<methodId>`

每个作用域有自己的 `nodes` / `connections` / `variables`。函数签名与方法签名的输入输出参数通过动态节点在子图内外传值。

---

## 四、常见调用方式

### 4.1 curl

```bash
# 健康检查
curl http://localhost:5173/api/health

# 运行当前保存的工作区
GRAPH=$(curl -s http://localhost:5173/api/state)
curl -s -X POST http://localhost:5173/api/run \
  -H 'Content-Type: application/json' \
  -d "$(echo "$GRAPH" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const g=JSON.parse(s).graph;console.log(JSON.stringify({graph:g,timeoutMs:5000}))})')"
```

### 4.2 Node.js

```js
const state = await (await fetch('http://localhost:5173/api/state')).json();
const response = await fetch('http://localhost:5173/api/run', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ graph: state.graph, timeoutMs: 5000 }),
});
console.log(await response.json());
```

### 4.3 浏览器控制台

```js
await window.NodeCode.ready;
const result = await window.NodeCode.api.run();
console.table(result.logs);
```
