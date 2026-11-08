# 内置节点参考

本文档列出 Codeck Mobile 内置节点的类型、端点、默认值与代码语义。

相关约定：

- 执行端点：`$exec_in` / `$exec_out`（也可有自定义执行分支，如 `true`、`false`、`body`）
- 数据端点：`kind: 'port'`
- 节点类型：`begin`（触发）/ `function`（可含执行流）/ `logic`（纯数据）
- 添加面板会隐藏 `hidden: true` 的节点（如变量节点）

---

## 1. 节点总览

| 名称 | 标题 | 分类 | 类型 | 说明 |
| --- | --- | --- | --- | --- |
| `begin` | 开始 | 核心 | begin | 独立触发起点，可添加多个 |
| `if-trigger` | 条件触发 | 核心 | begin | 条件为真时触发独立运行 |
| `log` | Log | 核心 | function | 输出一条运行日志 |
| `if` | If | 核心 | function | 条件分支 |
| `loop` | Loop | 核心 | function | 按次数循环 |
| `foreach` | ForEach | 核心 | function | 遍历数组 |
| `sleep` | Sleep | 核心 | function | 等待若干毫秒 |
| `fetch` | Fetch | 核心 | function | 发起 HTTP 请求 |
| `raw-js` | Javascript | 核心 | function | 执行自定义 JS |
| `varget` | 取值 | 核心 | logic | 读取变量（隐藏在面板中） |
| `varset` | 赋值 | 核心 | function | 写入变量（隐藏在面板中） |
| `add` | Add | 逻辑 | logic | 两数相加 |
| `subtract` | Subtract | 逻辑 | logic | 两数相减 |
| `multiply` | Multiply | 逻辑 | logic | 两数相乘 |
| `divide` | Divide | 逻辑 | logic | 两数相除 |
| `mod` | Mod | 逻辑 | logic | 取余数 |
| `gt` | Greater | 逻辑 | logic | `A > B` |
| `gte` | GreaterEqual | 逻辑 | logic | `A >= B` |
| `lt` | Less | 逻辑 | logic | `A < B` |
| `lte` | LessEqual | 逻辑 | logic | `A <= B` |
| `equal` | Equal | 逻辑 | logic | `A === B` |
| `and` | And | 逻辑 | logic | 逻辑与 |
| `or` | Or | 逻辑 | logic | 逻辑或 |
| `not` | Not | 逻辑 | logic | 逻辑取反 |
| `json-stringify` | ToJSON | 数据 | logic | 序列化为 JSON 字符串 |
| `length` | Length | 数据 | logic | 字符串/数组长度 |
| `includes` | Includes | 数据 | logic | 文本包含判断 |
| `obj-get` | Get | 数据 | logic | 按路径读取对象字段 |

---

## 2. 触发节点

### 2.1 `begin`（开始）

- 类型：`begin`
- 描述：独立触发起点，可添加多个，运行时并发执行
- 默认值：无

| 端点 | 方向 | 类型 | 行 | 说明 |
| --- | --- | --- | --- | --- |
| `$exec_out` | out | exec | 0 | 下游执行流 |

语义：

- 每个 `begin` 节点都会在后端生成一个独立任务函数
- 多个 `begin` 之间并发执行、互不阻塞
- 主图至少保留一个触发节点
- 函数子图内也保留一个「开始」作为执行入口，但不能从添加面板新增

### 2.2 `if-trigger`（条件触发）

- 类型：`begin`
- 描述：条件为真时才触发独立运行
- 默认值：`{ condition: true }`

| 端点 | 方向 | 类型 | 行 | 编辑器 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `$exec_out` | out | exec | 0 | — | 条件为真时执行 |
| `condition` | in | port | 0 | boolean | 触发条件 |

生成代码结构：

```js
async function __task_xxx() {
  let 变量声明;
  if (condition) {
    // 下游执行链
  }
}
```

条件未连线时使用节点内联值。

---

## 3. 核心执行节点

### 3.1 `log`（Log）

- 类型：`function`
- 默认值：`{ message: 'Hello Codeck Mobile' }`

| 端点 | 方向 | 类型 | 行 | 编辑器 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `$exec_in` | in | exec | 0 | — | 执行入口 |
| `$exec_out` | out | exec | 0 | — | 执行出口 |
| `message` | in | port | 1 | text | 要输出的内容 |

生成代码：

```js
console.log(message);
```

### 3.2 `if`（If）

- 类型：`function`
- 默认值：`{ condition: true }`

| 端点 | 方向 | 类型 | 行 | 编辑器 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `$exec_in` | in | exec | 0 | — | 执行入口 |
| `$exec_out` | out | exec | 0 | — | 分支结束后的继续执行 |
| `condition` | in | port | 1 | boolean | 条件 |
| `true` | out | exec | 1 | — | 条件为真分支 |
| `false` | out | exec | 2 | — | 条件为假分支 |

生成代码：

```js
if (condition) {
  // true 分支
} else {
  // false 分支
}
```

> `true` / `false` 两个分支互斥；`$exec_out` 在分支之后继续。

### 3.3 `loop`（Loop）

- 类型：`function`
- 默认值：`{ times: 3 }`

| 端点 | 方向 | 类型 | 行 | 编辑器 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `$exec_in` | in | exec | 0 | — | 执行入口 |
| `$exec_out` | out | exec | 0 | — | 循环结束后的继续执行 |
| `times` | in | port | 1 | number | 循环次数 |
| `body` | out | exec | 1 | — | 每次循环执行的代码 |
| `inc` | out | port | 2 | — | 当前索引（从 0 开始） |

生成代码：

```js
for (var inc = 0; inc < times; inc++) {
  // body
}
```

`inc` 输出可连接到下游节点（例如 `raw-js` 的 `ctx`）。

### 3.4 `foreach`（ForEach）

- 类型：`function`
- 默认值：`{ array: '[]' }`

| 端点 | 方向 | 类型 | 行 | 编辑器 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `$exec_in` | in | exec | 0 | — | 执行入口 |
| `$exec_out` | out | exec | 0 | — | 遍历结束后的继续执行 |
| `array` | in | port | 1 | json | 要遍历的数组 |
| `iteration` | out | exec | 1 | — | 每次迭代执行的代码 |
| `item` | out | port | 2 | — | 当前元素 |

生成代码：

```js
for (var item of (array ?? [])) {
  // iteration
}
```

### 3.5 `sleep`（Sleep）

- 类型：`function`
- 默认值：`{ ms: 1000 }`

| 端点 | 方向 | 类型 | 行 | 编辑器 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `$exec_in` | in | exec | 0 | — | 执行入口 |
| `ms` | in | port | 1 | number | 等待毫秒数 |
| `cb` | out | exec | 0 | — | 等待结束后的继续执行 |

生成代码：

```js
await new Promise((__resolve) => {
  setTimeout(() => {
    // cb
    __resolve();
  }, ms);
});
```

### 3.6 `fetch`（Fetch）

- 类型：`function`
- 默认值：

```json
{
  "method": "GET",
  "url": "https://jsonplaceholder.typicode.com/todos/1",
  "data": "",
  "headers": ""
}
```

| 端点 | 方向 | 类型 | 行 | 编辑器/选项 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `$exec_in` | in | exec | 0 | — | 执行入口 |
| `$exec_out` | out | exec | 0 | — | 请求完成后的继续执行 |
| `method` | in | port | 1 | select: GET/POST/PUT/DELETE | 请求方法 |
| `onSuccess` | out | exec | 1 | — | 请求成功分支 |
| `url` | in | port | 2 | text | 请求地址 |
| `text` | out | port | 2 | — | 响应文本 |
| `data` | in | port | 3 | json | 请求体 |
| `json` | out | port | 3 | — | 解析后的 JSON（失败时为 `{}`） |
| `headers` | in | port | 4 | json | 请求头 |
| `onFailed` | out | exec | 4 | — | 请求失败分支 |

生成代码：

```js
var text = '';
var json = {};
try {
  const __res = await fetch(url, {
    method,
    body: data,
    headers,
  });
  text = await __res.text();
  try {
    json = JSON.parse(text);
  } catch (__err) {}
  // onSuccess
} catch (__reqErr) {
  // onFailed
}
```

说明：

- `data` / `headers` 未连线且内联值为空时，传入 `undefined`
- `onSuccess` 与 `onFailed` 互斥
- 需要网络；失败会进入 `onFailed`，不会抛出到任务外

### 3.7 `raw-js`（Javascript）

- 类型：`function`
- 默认值：

```json
{
  "ctx": "",
  "js": "// ctx 是上游传入的数据\nreturn \"Hello from raw JS\";"
}
```

| 端点 | 方向 | 类型 | 行 | 编辑器 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `$exec_in` | in | exec | 0 | — | 执行入口 |
| `$exec_out` | out | exec | 0 | — | 执行出口 |
| `ctx` | in | port | 1 | json | 传入函数的参数 |
| `js` | in | port | 2 | code | 函数体代码 |
| `returnValue` | out | port | 1 | — | 函数返回值 |

生成代码：

```js
var returnValue = (function (ctx) {
  // js
})(ctx);
```

说明：

- `js` 中的代码位于普通函数作用域，`return` 的值会写入 `returnValue`
- 可使用 `ctx` 访问上游数据
- 不能使用顶层 `await`（这是同步函数）；需要异步请使用 `fetch` 或把逻辑放到其它节点
- `js` 是节点内联值，也可以通过连线动态传入代码字符串

---

## 4. 变量节点

变量节点默认不在添加面板显示，需要在「变量管理」中点击「取值 / 赋值」创建。

### 4.1 `varget`（取值）

- 类型：`logic`
- 默认值：`{ name: '' }`

| 端点 | 方向 | 类型 | 行 | 说明 |
| --- | --- | --- | --- | --- |
| `variable` | out | port | 0 | 变量值 |

生成代码：直接输出变量名。

变量名必须是合法 JS 标识符，否则编译失败。

### 4.2 `varset`（赋值）

- 类型：`function`
- 默认值：`{ name: '', value: '' }`

| 端点 | 方向 | 类型 | 行 | 编辑器 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `$exec_in` | in | exec | 0 | — | 执行入口 |
| `$exec_out` | out | exec | 0 | — | 执行出口 |
| `value` | in | port | 1 | text | 要写入的值 |

生成代码：

```js
变量名 = value;
```

---

## 5. 逻辑运算节点

### 5.1 二元运算

包括：

| 名称 | 运算 |
| --- | --- |
| `add` | `+` |
| `subtract` | `-` |
| `multiply` | `*` |
| `divide` | `/` |
| `mod` | `%` |
| `gt` | `>` |
| `gte` | `>=` |
| `lt` | `<` |
| `lte` | `<=` |
| `equal` | `===` |
| `and` | `&&`（布尔编辑器） |
| `or` | `\|\|`（布尔编辑器） |

共同端点：

| 端点 | 方向 | 类型 | 行 | 编辑器 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `input1` | in | port | 0 | number / boolean | 操作数 A |
| `input2` | in | port | 1 | number / boolean | 操作数 B |
| `output` | out | port | 2 | — | 运算结果 |

默认值：

- 数字运算：`{ input1: 0, input2: 0 }`
- 布尔运算（`and` / `or`）：`{ input1: true, input2: true }`

生成代码：

```js
(input1 运算符 input2)
```

### 5.2 `not`（Not）

| 端点 | 方向 | 类型 | 行 | 编辑器 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `value` | in | port | 0 | boolean | 输入 |
| `output` | out | port | 1 | — | 取反结果 |

生成代码：

```js
!(value)
```

---

## 6. 数据节点

### 6.1 `json-stringify`（ToJSON）

| 端点 | 方向 | 类型 | 行 | 编辑器 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `value` | in | port | 0 | json | 任意值 |
| `result` | out | port | 1 | — | JSON 字符串 |

生成代码：

```js
JSON.stringify(value)
```

### 6.2 `length`（Length）

| 端点 | 方向 | 类型 | 行 | 编辑器 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `value` | in | port | 0 | json | 字符串或数组 |
| `result` | out | port | 1 | — | 长度 |

生成代码：

```js
((value) ?? '').length
```

### 6.3 `includes`（Includes）

| 端点 | 方向 | 类型 | 行 | 编辑器 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `text` | in | port | 0 | text | 原文本 |
| `search` | in | port | 1 | text | 子串 |
| `result` | out | port | 2 | — | 是否包含 |

生成代码：

```js
((text) ?? '').includes(search)
```

### 6.4 `obj-get`（Get）

按路径读取对象字段，支持 `data.list[0].id` 这类写法。

| 端点 | 方向 | 类型 | 行 | 编辑器 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `object` | in | port | 0 | json | 目标对象 |
| `path` | in | port | 1 | text | 路径，如 `data.list[0].id` |
| `result` | out | port | 2 | — | 读取结果 |

生成代码依赖 `prepare` 注入的 `__getPath`：

```js
__getPath(object, path)
```

`__getPath` 会把 `[0]` 形式转换为 `.0`，逐段读取；任一段为 `null` / `undefined` 时返回 `undefined`。

---

## 7. 函数动态节点

函数由用户创建，节点定义在运行时动态生成。

### 7.1 调用节点 `fncall:<fnId>`

| 端点 | 方向 | 类型 | 行 | 说明 |
| --- | --- | --- | --- | --- |
| `$exec_in` | in | exec | 0 | 执行入口 |
| `$exec_out` | out | exec | 0 | 执行出口 |
| `i_<entryId>` | in | port | 1..n | 每个输入参数一个 |
| `o_<entryId>` | out | port | n+1.. | 每个输出参数一个 |

生成代码：

```js
var result = await _fn_函数名_函数id(参数...);
var 输出变量 = result == null ? undefined : result["输出参数id"];
```

无输出参数的函数：

```js
await _fn_函数名_函数id(参数...);
```

### 7.2 输入参数节点 `fnarg:<fnId>:<entryId>`

- 类型：`logic`
- 标题即参数名

| 端点 | 方向 | 类型 | 行 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | out | port | 0 | 参数值 |

生成代码：输出函数参数变量（由参数 id 派生）。

### 7.3 输出参数节点 `fnret:<fnId>:<entryId>`

- 类型：`function`
- 标题即输出名

| 端点 | 方向 | 类型 | 行 | 说明 |
| --- | --- | --- | --- | --- |
| `value` | in | port | 0 | 要返回的值 |

函数结束时把该值写入返回值对象。

### 7.4 旧版聚合节点

为兼容旧蓝图仍保留：

- `fnin:<fnId>`：函数输入节点，多个输出端点
- `fnout:<fnId>`：函数输出节点，多个输入端点

新蓝图建议使用独立的 `fnarg` / `fnret` 节点。

---

## 8. 类动态节点

类由用户在「类管理」中创建，节点定义在运行时动态生成。

### 8.1 实例化 `clsnew:<classId>`

| 端点 | 方向 | 类型 | 行 | 说明 |
| --- | --- | --- | --- | --- |
| `$exec_in` | in | exec | 0 | 执行入口 |
| `$exec_out` | out | exec | 0 | 执行出口 |
| `p_<propId>` | in | port | 1..n | 每个属性一个，可覆盖默认值 |
| `instance` | out | port | 1 | 实例 |

生成代码：

```js
var instance = new _cls_类名_类id({ "属性id": 值, ... });
```

### 8.2 属性读取 `clsget:<classId>:<propId>`

| 端点 | 方向 | 类型 | 行 | 说明 |
| --- | --- | --- | --- | --- |
| `instance` | in | port | 0 | 实例（必须连接） |
| `value` | out | port | 1 | 属性值 |

生成代码：

```js
(instance)["属性名"]
```

### 8.3 属性写入 `clsset:<classId>:<propId>`

| 端点 | 方向 | 类型 | 行 | 说明 |
| --- | --- | --- | --- | --- |
| `$exec_in` | in | exec | 0 | 执行入口 |
| `$exec_out` | out | exec | 0 | 执行出口 |
| `instance` | in | port | 1 | 实例（必须连接） |
| `value` | in | port | 2 | 要写入的值 |

生成代码：

```js
(instance)["属性名"] = value;
```

### 8.4 方法调用 `clscall:<classId>:<methodId>`

| 端点 | 方向 | 类型 | 行 | 说明 |
| --- | --- | --- | --- | --- |
| `$exec_in` | in | exec | 0 | 执行入口 |
| `$exec_out` | out | exec | 0 | 执行出口 |
| `instance` | in | port | 1 | 实例（必须连接） |
| `i_<entryId>` | in | port | 2.. | 每个方法输入参数一个 |
| `o_<entryId>` | out | port | ... | 每个方法输出参数一个 |

生成代码：

```js
var result = await (instance)["方法名"](参数...);
var 输出变量 = result == null ? undefined : result["输出参数id"];
```

无返回值的方法：

```js
await (instance)["方法名"](参数...);
```

### 8.5 方法内部节点

| 节点 | 端点 | 说明 |
| --- | --- | --- |
| `clsselfget:<classId>:<propId>` | `value` out | 读取 `this["属性名"]` |
| `clsselfset:<classId>:<propId>` | exec in/out、`value` in | 写入 `this["属性名"]` |
| `clsarg:<classId>:<methodId>:<entryId>` | `value` out | 方法输入参数 |
| `clsret:<classId>:<methodId>:<entryId>` | `value` in | 方法返回值 |

说明：

- `clsselfget` / `clsselfset` 只在对应类的方法子图中可用
- 方法输入输出节点由方法签名自动生成/清理
- 方法返回值在方法结束时写入返回对象

---

## 9. 端点连接规则

| 规则 | 说明 |
| --- | --- |
| exec 对 exec | 执行端点只能连接执行端点 |
| port 对 port | 数据端点只能连接数据端点 |
| exec 一对一 | 每个执行输出只能连接一个下游；每个执行输入只能有一个上游 |
| port 输入一对一 | 每个数据输入只能有一条入线 |
| port 输出一对多 | 同一个数据输出可以连接到多个输入 |
| 禁止自连 | 不能连接同一个节点 |
| 禁止循环 | 执行流与数据流都会检测循环 |

> 数据端点连线时会自动覆盖输入端的旧连线。

---

## 10. 与扩展节点的关系

外部扩展节点可以复用上述分类、端点与代码生成约定。编写自定义节点请阅读 [abi.md](abi.md)。
