# 工作区与模块 JSON 规范

本文档描述：

- 工作区 / 模块的 JSON 文件格式
- 两种导入方式的区别
- 模块合并时的自动处理规则
- 模块「独立运行」与「连线传值」的语义

---

## 1. 工作区与模块的关系

Codeck Mobile 中，**工作区**和**模块**使用同一套图数据结构：

```text
工作区 = 主图（main） + 函数子图（functions） + 类（classes）
模块   = 一张图（可携带函数子图与类）
```

- 导出工作区得到完整 JSON 文件
- 导入时既可以把它当作完整工作区**替换**当前内容
- 也可以把它当作外部子图**合并**进当前画布

---

## 2. 文件格式

### 2.1 导出文件（推荐格式）

菜单「导出 JSON」下载的文件结构：

```json
{
  "version": 1,
  "name": "我的蓝图",
  "exportedAt": "2026-11-08T06:00:00.000Z",
  "graph": {
    "nodes": [],
    "connections": [],
    "variables": [],
    "functions": [],
    "classes": []
  }
}
```

字段说明：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `version` | number | 文件格式版本，当前为 `1` |
| `name` | string | 蓝图 / 模块名称 |
| `exportedAt` | string | 导出时间（ISO 8601），仅作记录 |
| `graph` | Graph | 完整工作区图 |

### 2.2 其他可接受的格式

导入时也接受以下形式：

**完整工作区对象**

```json
{
  "main": {
    "nodes": [],
    "connections": [],
    "variables": []
  },
  "functions": [],
  "classes": []
}
```

**裸图对象**

```json
{
  "nodes": [],
  "connections": [],
  "variables": [],
  "functions": [],
  "classes": []
}
```

解析优先级：

1. 存在 `graph.nodes` → 使用 `graph`
2. 存在 `main.nodes` → 组合 `main`、`functions` 与 `classes`
3. 存在 `nodes` 数组 → 直接作为图

名称优先取 `name`，其次 `moduleName`，都没有则使用「导入模块」。

---

## 3. Graph 数据结构

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
  name: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
}

interface Connection {
  id: string;
  fromNodeId: string;
  fromNodePinName: string;
  toNodeId: string;
  toNodePinName: string;
}

interface Variable {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  value: unknown;
}

interface FunctionDef {
  id: string;
  name: string;
  inputs: SignatureEntry[];
  outputs: SignatureEntry[];
  graph: Graph;
}

interface ClassDef {
  id: string;
  name: string;
  properties: ClassProperty[];
  methods: ClassMethod[];
}

interface ClassProperty {
  id: string;
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  value: unknown;
}

interface ClassMethod {
  id: string;
  name: string;
  inputs: SignatureEntry[];
  outputs: SignatureEntry[];
  graph: Graph;
}

interface SignatureEntry {
  id: string;
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
}
```

### 3.1 Node

| 字段 | 说明 |
| --- | --- |
| `id` | 节点唯一 ID，同一作用域内不能重复 |
| `name` | 节点类型名；内置节点如 `log`、`if`；函数节点如 `fncall:<fnId>`；类节点如 `clsnew:<classId>`、`clscall:<classId>:<methodId>` |
| `position` | 世界坐标，单位与缩放为 1 时的 CSS 像素一致 |
| `data` | 节点参数，键名对应端点名或节点自定义字段 |

### 3.2 Connection

| 字段 | 说明 |
| --- | --- |
| `fromNodeId` / `fromNodePinName` | 输出端节点与端点名 |
| `toNodeId` / `toNodePinName` | 输入端节点与端点名 |

执行端点约定：

- 输入：`$exec_in`
- 输出：`$exec_out`

数据端点使用节点定义中的名称，如 `message`、`output`、`result`。

### 3.3 Variable

| 字段 | 说明 |
| --- | --- |
| `name` | 合法 JS 标识符；同一作用域内唯一 |
| `type` | `string` / `number` / `boolean` / `object` / `array` |
| `value` | 默认值；`object` / `array` 通常以 JSON 字符串保存 |

### 3.4 FunctionDef

| 字段 | 说明 |
| --- | --- |
| `id` | 函数唯一 ID |
| `name` | 函数显示名称 |
| `inputs` | 输入参数签名 |
| `outputs` | 输出参数签名 |
| `graph` | 函数子图 |

### 3.5 ClassDef

| 字段 | 说明 |
| --- | --- |
| `id` | 类唯一 ID |
| `name` | 类显示名称 |
| `properties` | 属性列表，每项含 `id`、`name`、`type`、`value` |
| `methods` | 方法列表，每个方法含 `id`、`name`、`inputs`、`outputs`、`graph` |

类相关节点命名：

| 节点名 | 说明 |
| --- | --- |
| `clsnew:<classId>` | 创建实例 |
| `clsget:<classId>:<propId>` | 读取实例属性 |
| `clsset:<classId>:<propId>` | 写入实例属性 |
| `clscall:<classId>:<methodId>` | 调用实例方法 |
| `clsselfget:<classId>:<propId>` | 方法内读取 `this` 属性 |
| `clsselfset:<classId>:<propId>` | 方法内写入 `this` 属性 |
| `clsarg:<classId>:<methodId>:<entryId>` | 方法输入参数节点 |
| `clsret:<classId>:<methodId>:<entryId>` | 方法返回值节点 |

方法子图的作用域 ID 为 `cls:<classId>:<methodId>`。

---

## 4. 导入方式

菜单位于「工作区」分组：

| 按钮 | 行为 | 适用场景 |
| --- | --- | --- |
| 导入 JSON（替换工作区） | 用文件内容替换当前主图、函数与变量 | 打开一份完整蓝图 |
| 导入模块（合并到当前图） | 把文件当作外部子图合并进当前作用域 | 复用模块、组合多个子图 |

替换导入会丢失当前未保存内容，请先保存或导出。

---

## 5. 合并导入规则

合并入口对应 `mergeModuleGraph()`，规则如下。

### 5.1 触发节点

先判断模块**原始数据**中是否存在触发节点（`type === 'begin'`）：

| 条件 | 结果 |
| --- | --- |
| 模块含触发 + 目标是主图 | 保留触发节点，作为新的独立入口并发运行 |
| 模块含触发 + 目标是函数子图 | 移除触发节点（函数内不允许触发） |
| 模块不含触发 + 任意作用域 | 移除归一化自动补的「开始」，只保留纯数据节点 |

> 归一化过程会自动补充触发节点，因此是否保留必须基于原始文件判断。

### 5.2 ID 重映射

合并时所有内容都会分配新 ID：

| 内容 | 处理 |
| --- | --- |
| 节点 | 生成新 `id` |
| 连线 | 生成新 `id`，并映射到新节点 ID |
| 函数 | 生成新 `fn_...` ID |
| 函数内部节点 | 重新分配节点 ID |
| 函数参数 | 保留参数 ID（仅在函数内部使用） |
| 类 | 生成新 `cls_...` ID |
| 类方法子图节点 | 重新分配节点 ID |
| 类属性 / 方法 | 保留属性 ID 与方法 ID（仅在类内部使用） |

函数相关节点名会同步改写：

- `fncall:<oldFnId>` → `fncall:<newFnId>`
- `fnin:<oldFnId>` → `fnin:<newFnId>`
- `fnout:<oldFnId>` → `fnout:<newFnId>`
- `fnarg:<oldFnId>:<entryId>` → `fnarg:<newFnId>:<entryId>`
- `fnret:<oldFnId>:<entryId>` → `fnret:<newFnId>:<entryId>`

类相关节点名会同步改写：

- `clsnew:<oldClassId>` → `clsnew:<newClassId>`
- `clsget:<oldClassId>:<propId>` → `clsget:<newClassId>:<propId>`
- `clsset:<oldClassId>:<propId>` → `clsset:<newClassId>:<propId>`
- `clscall:<oldClassId>:<methodId>` → `clscall:<newClassId>:<methodId>`
- `clsselfget` / `clsselfset` / `clsarg` / `clsret` 同理

### 5.3 函数与类命名

- 导入的函数总是获得新 ID
- 导入的类总是获得新 ID
- 若名称与现有函数/类冲突，自动追加序号：
  - `打招呼` → `打招呼_2`
  - 若 `打招呼_2` 也存在 → `打招呼_3`
- 函数与类分别使用各自的名称空间（函数 `calc` 与类 `calc` 可以共存）

### 5.4 变量合并

| 情况 | 处理 |
| --- | --- |
| 目标作用域没有同名变量 | 直接添加 |
| 同名且类型相同 | 复用目标变量，不新增 |
| 同名但类型不同 | 自动重命名，如 `count` → `count_2` |

变量重命名会同步更新模块中 `varget` / `varset` 节点的 `data.name`。

> 如果自定义扩展节点在代码里硬编码了变量名，合并无法自动改写，需要手动检查。

### 5.5 位置偏移

模块节点会整体平移到现有图的右侧：

```text
offset.x = 目标图最右边界 - 模块最左边界 + 80
offset.y = 目标图最上边界 - 模块最上边界
```

如果目标图为空，则保持模块原始位置。

### 5.6 连线

- 模块内部连线完整保留
- 被移除的触发节点相关连线会被丢弃
- 与当前图之间**不会自动建立连线**

### 5.7 合并结果摘要

`importModule` 返回：

```json
{
  "nodes": 3,
  "connections": 2,
  "variables": 1,
  "functions": 1,
  "classes": 1,
  "triggers": 1,
  "hasTrigger": true,
  "name": "外部模块"
}
```

| 字段 | 说明 |
| --- | --- |
| `nodes` | 新增节点数 |
| `connections` | 新增连线数 |
| `variables` | 新增变量数 |
| `functions` | 新增函数数 |
| `classes` | 新增类数 |
| `triggers` | 实际保留下来的触发节点数 |
| `hasTrigger` | 模块原始数据是否含触发节点 |
| `name` | 模块名称 |

---

## 6. 模块独立运行

「独立运行」指模块自身的触发节点会参与服务端编译与执行。

### 6.1 含触发模块

模块：

```json
{
  "name": "定时任务模块",
  "graph": {
    "nodes": [
      { "id": "t", "name": "begin", "position": { "x": 0, "y": 0 }, "data": {} },
      { "id": "l", "name": "log", "position": { "x": 220, "y": 0 }, "data": { "message": "模块任务" } }
    ],
    "connections": [
      {
        "id": "c1",
        "fromNodeId": "t",
        "fromNodePinName": "$exec_out",
        "toNodeId": "l",
        "toNodePinName": "$exec_in"
      }
    ],
    "variables": []
  }
}
```

合并到主图后，编译结果会包含两个任务（假设主图已有一个触发）：

```js
async function __task_main() {
  console.log("主图任务");
}

async function __task_module() {
  console.log("模块任务");
}

const __tasks = [
  { name: "开始 · 主图", run: () => __task_main() },
  { name: "开始 · 模块", run: () => __task_module() },
];
const __results = await Promise.allSettled(__tasks.map((task) => task.run()));
```

两个任务并发执行、互不阻塞。

### 6.2 纯数据模块

模块不含触发节点：

```json
{
  "name": "数值工具",
  "graph": {
    "nodes": [
      { "id": "a", "name": "add", "position": { "x": 0, "y": 0 }, "data": { "input1": 1, "input2": 2 } },
      { "id": "l", "name": "log", "position": { "x": 220, "y": 0 }, "data": { "message": "" } }
    ],
    "connections": [
      {
        "id": "c1",
        "fromNodeId": "a",
        "fromNodePinName": "output",
        "toNodeId": "l",
        "toNodePinName": "message"
      }
    ],
    "variables": []
  }
}
```

合并后：

- 不会新增触发节点
- 节点与内部连线原样保留
- 需要把模块的输出端点手动连接到目标节点，形成「连线传值」

例如把模块中 `add` 的 `output` 连接到主图某个 `log` 的 `message`。

### 6.3 函数子图内导入

在函数子图内执行「导入模块」时：

- 模块触发节点会被移除
- 模块中的函数仍会被合并到工作区
- 纯数据节点可直接与函数内的输入节点、输出节点连线

---

## 7. 完整示例：带函数的模块

```json
{
  "version": 1,
  "name": "问候模块",
  "graph": {
    "nodes": [
      { "id": "begin", "name": "begin", "position": { "x": 0, "y": 0 }, "data": {} },
      { "id": "call", "name": "fncall:fn_hello", "position": { "x": 220, "y": 0 }, "data": {} }
    ],
    "connections": [
      {
        "id": "c1",
        "fromNodeId": "begin",
        "fromNodePinName": "$exec_out",
        "toNodeId": "call",
        "toNodePinName": "$exec_in"
      }
    ],
    "variables": [],
    "functions": [
      {
        "id": "fn_hello",
        "name": "打招呼",
        "inputs": [{ "id": "i1", "name": "name", "type": "string" }],
        "outputs": [{ "id": "o1", "name": "text", "type": "string" }],
        "graph": {
          "nodes": [
            { "id": "arg", "name": "fnarg:fn_hello:i1", "position": { "x": 0, "y": 0 }, "data": {} },
            { "id": "ret", "name": "fnret:fn_hello:o1", "position": { "x": 300, "y": 0 }, "data": {} },
            { "id": "begin2", "name": "begin", "position": { "x": 0, "y": -120 }, "data": {} }
          ],
          "connections": [
            {
              "id": "c2",
              "fromNodeId": "arg",
              "fromNodePinName": "value",
              "toNodeId": "ret",
              "toNodePinName": "value"
            }
          ],
          "variables": []
        }
      }
    ]
  }
}
```

合并后：

- 模块触发节点保留（目标为主图）
- 函数获得新 ID，`fncall` / `fnarg` / `fnret` 节点名同步改写
- 若工作区已有同名函数「打招呼」，新函数会变成「打招呼_2」

---

## 8. 归一化与容错

`normalizeGraph` 会在加载、导入、保存时执行：

- 缺失触发节点：自动补一个「开始」
- 未知节点类型：丢弃
- 重复节点 ID：只保留第一个
- 非法连线（节点不存在、端点不存在、类型不匹配）：丢弃
- 重复连线：去重
- 函数内部多余触发节点：只保留第一个
- 类/方法 ID 或名称重复：自动重新分配/追加序号
- 类属性 ID 或名称重复：自动重新分配/追加序号
- 重复变量名：只保留第一个
- 非法变量类型：回退为 `string`

因此，手写模块 JSON 时即使有少量问题也可能被静默修正；建议导入后检查节点数量与连线。

---

## 9. 限制与注意事项

1. **不会自动跨模块连线**：合并只保留模块内部连线，与当前图的连接需要手动完成。
2. **导出始终是完整工作区**：菜单「导出 JSON」会导出主图与全部函数。纯数据模块需要按本文格式自行构造，或对导出文件编辑后使用。
3. **依赖函数必须一起导出**：如果模块主图调用了某个函数，请确保该函数的定义也包含在模块的 `functions` 中，否则导入时调用节点可能被归一化丢弃。
4. **变量名硬编码无法自动改写**：只有 `varget` / `varset` 节点会随变量重命名更新。
5. **触发节点只在主图保留**：函数子图内的触发节点会被移除。
6. **ID 会全部变化**：不要依赖导入后的节点 ID 与文件中的 ID 一致。
7. **同名函数会自动改名**：需要固定名称时，导入后在函数管理中手动调整。

---

## 10. 相关文档

- [api.md](api.md) — HTTP API 与 `importModule` SDK 用法
- [abi.md](abi.md) — 外部扩展节点
- [nodes.md](nodes.md) — 内置节点端点
- [architecture.md](architecture.md) — 编译与执行模型
