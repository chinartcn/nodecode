# 架构与实现说明

本文档说明 Codeck Mobile 的分层结构、图模型、编译流程、沙箱执行与持久化设计，方便二次开发与排查问题。

---

## 1. 总览

```text
┌──────────────────────────── 浏览器 ────────────────────────────┐
│  public/index.html + styles.css                                │
│                                                                │
│  public/js/app.js       应用逻辑、面板、导入导出、SDK            │
│  public/js/editor.js    Canvas 渲染、手势、历史、选择            │
│  public/js/api.js       HTTP 客户端                             │
│                                                                │
│  shared/*.js            节点定义、图工具、函数、模块、ABI          │
└───────────────────────────────┬────────────────────────────────┘
                                │ HTTP JSON
┌───────────────────────────────▼────────────────────────────────┐
│  server/index.js        静态资源 + API 路由                     │
│  server/compiler.js     蓝图 -> JavaScript                      │
│  server/sandbox.js      node:vm 执行 + 日志收集                  │
│  server/storage.js      data/workspace.json                     │
│  server/blueprints.js   data/blueprints/*.json                  │
│  server/extensions.js   extensions/*.json|js|mjs                │
│  server/examples.js     内置示例                                 │
└────────────────────────────────────────────────────────────────┘
```

设计取舍：

- **零第三方依赖**：服务端只用 Node 内置模块，前端无构建、无框架
- **前后端共享模型**：`shared/` 同时被浏览器 ESM 与 Node 导入
- **节点定义即代码生成器**：节点定义同时描述布局、端点与生成代码
- **服务端编译**：前端只负责图编辑，编译与执行统一在服务端完成

---

## 2. 图模型

### 2.1 作用域

```text
workspace
├── main       主图
├── functions[]
│   ├── fn A   函数子图
│   └── fn B   函数子图
└── classes[]
    └── cls A
        ├── properties[]
        └── methods[]
            └── method graph  方法子图
```

每个作用域包含：

- `nodes`
- `connections`
- `variables`

函数额外包含：

- `id`
- `name`
- `inputs` / `outputs` 签名

类额外包含：

- `id`
- `name`
- `properties`：属性 id、名称、类型、默认值
- `methods`：方法 id、名称、输入/输出签名、方法子图

方法子图的作用域 id 为 `cls:<classId>:<methodId>`。

### 2.2 端点

节点定义中的 `pins` 是编译与连线的核心：

| 字段 | 说明 |
| --- | --- |
| `name` | 端点名 |
| `kind` | `exec` 或 `port` |
| `dir` | `in` 或 `out` |
| `row` | 布局行 |
| `editor` | 数据输入端的编辑器类型 |
| `code` | 数据输出端的表达式生成函数 |
| `codeTemplate` | 外部节点的表达式模板 |

执行端点约定为 `$exec_in` / `$exec_out`，但分支节点可使用自定义名称（如 `true`、`false`、`body`）。

### 2.3 归一化

`shared/graph-utils.js` 的 `normalizeGraph` 是所有入口的统一过滤层：

- 丢弃未知节点
- 去重节点 ID 与连线
- 补齐触发节点
- 函数内只保留一个触发
- 清理非法变量

前端加载、服务端 `/api/compile`、`/api/run`、工作区保存、蓝图库读写都会经过归一化。

---

## 3. 前端

### 3.1 `app.js`

职责：

- 工作区状态：`workspace.main`、`workspace.functions`
- 当前作用域与导航栈：`currentScope`、`scopeStack`
- 面板：添加节点、属性检查器、变量、函数、蓝图、运行结果、代码
- 节点浮窗与全屏编辑
- 导入 / 导出 / 模块合并
- 自动保存与页面隐藏兜底保存
- `window.NodeCode` SDK
- 扩展节点客户端注册

### 3.2 `editor.js`

职责：

- Canvas 2D 渲染
- Pointer Events 手势
- 连线绘制与命中测试
- 框选、多选、整体拖拽
- 复制 / 粘贴 / 删除
- 撤销 / 重做
- 视图缩放与适配

渲染优化：

- 网格使用离屏 pattern，避免每帧大量 `fillRect`
- 节点布局按类型缓存
- 连线端点索引缓存
- `devicePixelRatio` 上限为 2
- 不使用 `desynchronized`，避免移动端文字闪烁
- 页面恢复、Canvas 上下文恢复时主动重绘

### 3.3 历史记录

- 快照为 `{ nodes, connections, variables }` 的 JSON 字符串
- 最多 60 步
- 同一字段连续输入在 800ms 内合并为一次记录
- 拖动在松手时记录一次
- 触发节点不会被批量删除

### 3.4 自动保存

- 初始默认 30 秒
- 配置写入 `localStorage` 的 `codeck.autosaveMs`
- 改动只标记 `pendingChanges`，由定时器统一保存
- 页面隐藏时使用 `fetch(..., { keepalive: true })` 兜底提交
- 顶栏显示 `已保存` / `未保存` / `保存中…`

### 3.5 本地偏好

| Key | 内容 |
| --- | --- |
| `codeck.autosaveMs` | 自动保存间隔 |
| `codeck.palette.compact` | 面板高度（1/2 或 1/4） |
| `codeck.palette.columns` | 单列 / 双列 |
| `codeck.nodeCardPos` | 节点浮窗位置 |

---

## 4. 编译器

核心实现：[server/compiler.js](server/compiler.js)

### 4.1 编译入口

```js
compileGraph(graph) -> string
```

流程：

1. 读取 `graph.functions` 与 `graph.classes`
2. 注册函数与类动态节点定义（`fncall` / `fnarg` / `fnret` / `clsnew` / `clscall` 等）
3. 检测函数循环调用
4. 编译每个函数为 async 函数
5. 编译每个类为 class（属性初始化 + async 方法）
6. 为主图每个触发节点生成独立任务
7. 拼接任务调度代码

### 4.2 变量声明

每个作用域编译时先生成变量声明：

```js
let count = 0;
let name;
```

规则：

- 变量名必须是合法 JS 标识符，并排除保留字
- `number` / `boolean` / `object` / `array` 使用对应字面量
- 空值生成 `let name;`

### 4.3 数据流解析

`getInputCode(pinName, nodeId)`：

```text
输入端点
├── 无连线 -> emitLiteral(编辑器类型, node.data[pinName])
└── 有连线 -> resolveOutputCode(上游节点, 上游端点)
```

`resolveOutputCode`：

- 输出端点有 `code` 函数 → 调用 `code(ctx)` 得到表达式
- 否则 → 返回该输出端派生出的变量名

为防止循环依赖，解析时维护 `_dataStack`，重复进入同一 `nodeId:pinName` 会抛错：

```text
检测到数据流循环依赖，请检查连线
```

### 4.4 执行流生成

`generateCodeFromNode(startNode)`：

- 从触发节点或分支端点开始
- 按 `$exec_out` / 自定义执行端点查找下一个节点
- 每个节点调用其 `code(ctx)` 生成语句
- 维护 `_execActive` 防止执行流循环
- 同一执行端点存在多条连线时抛错

分支节点（如 `if`、`loop`）通过 `ctx.execOut(pin)` 递归生成分支代码。

### 4.5 节点代码约定

- `def.code(ctx)` 返回**语句**
- `pin.code(ctx)` 返回**表达式**
- 输出变量使用 `var`，避免块级作用域问题
- 变量名由 `buildPinVarName(pinName, nodeId)` 派生，确保唯一

### 4.6 函数编译

每个函数编译为 async 函数：

```js
async function _fn_函数名_函数id(参数...) {
  let __fnResult = {};
  // 变量声明
  // 从函数内开始节点生成执行流
  __fnResult["输出参数id"] = 输出值;
  return __fnResult;
}
```

调用节点生成：

```js
var result = await _fn_xxx(参数...);
var out1 = result == null ? undefined : result["o1"];
```

特点：

- 函数支持内部 `await`
- 函数可以嵌套调用其它函数
- 函数循环调用会在编译前被检测并拒绝

### 4.7 类编译

每个类编译为真正的 JavaScript class：

```js
class _cls_类名_类id {
  constructor(__init = {}) {
    this["count"] = __init["属性id"] !== undefined ? __init["属性id"] : 0;
  }
  async ["increment"](_arg_参数id) {
    let __fnResult = {};
    // 方法变量声明
    // 从方法内开始节点生成执行流
    __fnResult["输出参数id"] = 输出值;
    return __fnResult;
  }
}
```

要点：

- 属性使用 `this["属性名"]` 方括号访问，支持任意属性名
- 构造参数按属性 id 传值，缺省时回退属性默认值
- 方法使用计算属性名 `async ["方法名"]()`，支持任意方法名
- 方法体复用函数编译逻辑：变量声明、执行流、数据流
- 方法返回值节点 `clsret:*` 在方法末尾统一写入返回对象
- 类与函数可以互相引用：函数可实例化类，方法可调用函数或其它类
- 类声明与函数声明都在任务运行前完成初始化

### 4.8 多触发任务

主图不再只从单个 `begin` 编译，而是遍历所有 `type === 'begin'` 的节点：

```js
for (const trigger of triggers) {
  const compiler = new Compiler(scopeGraph, { prepares, functionMap });
  const body = compiler.generateTriggerBody(trigger);
  declarations.push(`async function __task_<id>() { ... }`);
}
```

每个任务：

- 独立生成变量声明
- 独立生成执行链
- 条件触发会包裹一层 `if (condition) { ... }`

调度代码：

```js
const __tasks = [
  { name: "开始 · n1", run: () => __task_n1() },
  { name: "开始 · n2", run: () => __task_n2() },
];
const __results = await Promise.allSettled(__tasks.map((task) => task.run()));
```

失败处理：

- 单个任务 reject 不影响其它任务
- 失败的 rejected reason 会输出到 `console.error`
- 全部结束后若有失败，抛出聚合错误：

```text
部分触发任务执行失败：开始 · n1, 开始 · n2
```

### 4.9 任务隔离

由于每个任务都是独立 async 函数：

- 变量声明在任务内部，任务之间不共享运行时变量
- 一个任务修改变量不会影响另一个任务
- 函数定义在所有任务之前统一声明，可被各任务共享调用

---

## 5. 沙箱

实现：[server/sandbox.js](server/sandbox.js)

### 5.1 执行方式

生成代码被包装为 async IIFE：

```js
(async () => {
  // 生成代码
})()
```

因此支持顶层 `await`、`Promise.allSettled` 等异步语法。

### 5.2 沙箱上下文

提供：

- `console.log/info/warn/error/debug`
- `setTimeout` / `clearTimeout`
- `fetch`
- `window` 指向沙箱本身（兼容 `window.setTimeout`）

不提供：

- `require`
- `process`
- 文件系统
- 模块加载

### 5.3 超时

- 默认 8000ms
- 服务端限制 500–30000ms
- `vm.Script.runInContext` 有同步超时
- 异步阶段使用 `Promise.race` + 硬定时器
- 未完成的定时器与未 await 的 fetch 会被跟踪，执行结束后清理

### 5.4 日志

- 最多 300 条，超出后丢弃最早一条
- 单条最长 4000 字符
- 结构：`{ level, text }`

### 5.5 跨 realm 错误

`vm` 上下文创建的 `Error` 与宿主 realm 的 `Error` 不同源，`instanceof Error` 会失败。沙箱改为判断 reject 值本身是否存在：

```js
const outcome = await Promise.race([
  result.then(() => null, (err) => err || new Error('执行失败')),
  hardTimeout,
]);
if (outcome === '__TIMEOUT__') { ... }
else if (outcome) { error = outcome; }
```

避免运行失败被误报为成功。

---

## 6. 服务端

实现：[server/index.js](server/index.js)

### 6.1 路由

- 所有 `/api/*` 请求进入 `handleApi`
- 其它 GET / HEAD 请求走静态资源
- `/shared/*` 映射到 `shared/`，其余映射到 `public/`
- 静态路径经过 `path.resolve` 与相对路径校验，阻止目录穿越

### 6.2 请求处理

- 请求体上限 4MB
- JSON 解析失败返回 400
- API 错误统一 `{ error }`
- API 响应禁用缓存

### 6.3 持久化

**工作区** `data/workspace.json`

- 写入临时文件后原子重命名
- 文件不存在或损坏时用示例重建

**蓝图库** `data/blueprints/<id>.json`

- ID 格式校验，防止路径穿越
- 列表读取时忽略损坏文件
- 更新采用临时文件 + 重命名

### 6.4 扩展加载

`server/extensions.js`：

1. 读取 `extensions/` 下 `.json` / `.js` / `.mjs`
2. JSON 通过 ABI 校验并构建节点定义
3. JS 动态 `import()`，支持默认导出对象 / 数组 / `{ nodes }` / 函数
4. 同名节点跳过
5. 注册到 `setExternalNodeDefs`

加载前会先清空旧的外部节点注册表，保证热重载时不会把上一版节点误判为同名冲突。

扩展包导入流程：

1. 前端 `POST /api/extensions/import` 上传 ZIP 二进制
2. `server/zip.js` 解析中央目录并解压（Store / Deflate，零第三方依赖）
3. `installExtensionZip` 过滤 `.json` / `.js` / `.mjs`，扁平化并写入 `extensions/`
4. 重新执行 `loadExtensions()` 热重载
5. 前端重新拉取 `/api/nodes`，刷新添加面板

手动修改扩展文件仍需重启服务；通过 ZIP 导入会立即生效。

---

## 7. 共享层

| 文件 | 职责 |
| --- | --- |
| `shared/node-defs.js` | 内置节点定义、端点构造器、动态/外部节点注册表 |
| `shared/graph-utils.js` | 布局、连线校验、图归一化 |
| `shared/function-defs.js` | 函数动态节点定义 |
| `shared/function-wrap.js` | 框选节点封装为函数 |
| `shared/class-defs.js` | 类动态节点定义（实例化/属性/方法/this） |
| `shared/dynamic-defs.js` | 函数 + 类动态节点统一注册 |
| `shared/module-utils.js` | 模块解析、ID 重映射、合并 |
| `shared/abi.js` | ABI 校验、序列化、模板渲染、文档生成 |

浏览器通过 `/shared/*.js` 直接以 ESM 导入；Node 端通过相对路径导入。

---

## 8. 模块合并实现

`mergeModuleGraph(targetGraph, payload, options)`：

1. `extractModule` 兼容三种输入格式
2. 基于原始节点判断是否含触发
3. `normalizeGraph` 归一化模块（函数、类、方法）
4. 为模块函数分配新 ID 与唯一名称
5. 为模块类分配新 ID 与唯一名称
6. 重写所有函数节点名与类节点名
7. 合并变量，处理同名同类型 / 同名不同类型
8. 过滤触发节点（目标为函数子图或模块本身无触发时）
9. 重映射节点 ID、连线 ID
10. 计算位置偏移
11. 返回合并后的图、导入函数/类列表与摘要

前端 `applyModule` 随后：

- 把导入函数加入 `workspace.functions`
- 把导入类加入 `workspace.classes`
- 重建函数与类动态节点定义
- 用 `editor.setGraph` 应用合并结果
- 同步当前作用域、刷新面板与统计
- 保存工作区

---

## 9. 安全模型

- `node:vm` 不是安全边界，无法防御恶意代码
- 服务无鉴权，默认监听 `0.0.0.0`
- 仅适合本地或可信局域网
- 扩展节点代码由服务端直接执行
- 如需公网部署，需要额外的进程隔离、鉴权与资源限制

---

## 10. 扩展点

| 扩展点 | 方式 |
| --- | --- |
| 新节点 | `extensions/*.json` / `*.js` / `*.mjs` |
| 页面内临时节点 | `window.NodeCode.abi.registerNode` |
| 脚本化控制 | `window.NodeCode.api` |
| 外部系统集成 | HTTP API |
| 自定义示例 | `server/examples.js` |
| 工作区存储位置 | `server/storage.js` |
| 蓝图存储 | `server/blueprints.js` |
| 运行限制 | `server/sandbox.js` |

---

## 11. 相关文档

- [README.md](README.md) — 项目总览
- [tutorial.md](tutorial.md) — 使用教程
- [api.md](api.md) — HTTP API 与 SDK
- [abi.md](abi.md) — 扩展节点 ABI
- [nodes.md](nodes.md) — 内置节点
- [modules.md](modules.md) — 模块 JSON 与合并规则
