# Codeck Mobile

基于 [codeck](https://github.com/moonrailgun/codeck) 蓝图理念实现的**移动端可视化编程编辑器**：

- 前端：原生 ES Module + Canvas 2D，无构建步骤、无第三方前端框架
- 服务端：Node.js 原生 HTTP 服务，零第三方依赖
- 运行：蓝图编译为 JavaScript 后，在 `node:vm` 沙箱中执行
- 交互：为触控优化，支持单指平移、双指缩放、点按连线、框选与多选

> 定位：本地 / 可信局域网内的可视化脚本工具。`node:vm` 不是安全边界，请勿直接暴露到公网。

---

## 功能一览

| 能力 | 说明 |
| --- | --- |
| 可视化画布 | Canvas 2D 渲染节点与贝塞尔连线，支持平移、缩放、拖动、框选 |
| 节点体系 | 核心 / 逻辑 / 数据 / 函数 / 输入输出分类，内置运算、分支、循环、HTTP 请求、自定义 JS 等 |
| 多入口并发 | 主图可放置多个触发节点（开始、条件触发），每个触发编译为独立任务并发执行 |
| 函数（子图） | 框选节点封装为函数，支持命名输入/输出、嵌套调用、面包屑导航 |
| 变量 | 工作区级变量，可读取/赋值，默认值随蓝图保存 |
| 模块 | 工作区/子图可导出为 JSON，可替换导入或合并导入；含触发节点即可独立运行 |
| 蓝图库 | 多份命名蓝图保存到服务端文件，随时加载、覆盖、重命名、删除 |
| 扩展节点 | `extensions/` 下放置 `.json` / `.js` / `.mjs`，通过 ABI 注册自定义节点 |
| 浏览器 SDK | `window.NodeCode.api` / `window.NodeCode.abi` 提供脚本化控制 |
| 编辑体验 | 撤销/重做、复制/粘贴、框选、多选整体拖拽、节点浮窗编辑、全屏属性面板 |
| 自动保存 | 可配置间隔（关闭 / 10s / 30s / 1min / 5min），页面隐藏时兜底保存 |
| 代码预览 | 一键查看编译生成的 JavaScript，并可复制 |
| 运行日志 | 收集 `console.*` 输出、错误与耗时，按级别展示 |

---

## 环境要求

- Node.js **>= 18**（需要全局 `fetch` 与 ESM）
- 现代浏览器（Chrome / Safari / Edge / Firefox，移动端浏览器同样适用）
- 不需要执行 `npm install`，项目没有第三方依赖

---

## 快速开始

```bash
cd codeck-mobile
npm start
# 等价于 node server/index.js
```

启动后终端会输出：

```text
Codeck Mobile 已启动: http://localhost:5173
  手机访问（同一局域网）: http://192.168.x.x:5173
```

- 电脑浏览器打开 `http://localhost:5173`
- 手机与电脑处于同一局域网时，打开终端输出的局域网地址
- 开发模式：`npm run dev`（使用 `node --watch`，服务端文件变更后自动重启）

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `5173` | HTTP 端口 |
| `HOST` | `0.0.0.0` | 监听地址；仅本机使用可设为 `127.0.0.1` |

```bash
PORT=8080 HOST=127.0.0.1 node server/index.js
```

---

## 目录结构

```text
codeck-mobile/
├── package.json
├── README.md
├── tutorial.md            # 从零上手教程
├── api.md                 # HTTP API 与浏览器 SDK
├── abi.md                 # 外部扩展节点 ABI
├── nodes.md               # 内置节点参考
├── modules.md             # 工作区 / 模块 JSON 规范
├── architecture.md        # 架构与实现说明
├── server/
│   ├── index.js           # HTTP 服务、API 路由、静态资源
│   ├── compiler.js        # 蓝图 -> JS 编译器
│   ├── sandbox.js         # node:vm 沙箱执行与日志收集
│   ├── storage.js         # 工作区持久化（data/workspace.json）
│   ├── blueprints.js      # 蓝图库（data/blueprints/*.json）
│   ├── examples.js        # 内置示例蓝图
│   └── extensions.js      # 外部扩展节点加载器
├── shared/                # 前后端共享代码
│   ├── node-defs.js       # 内置节点定义（布局 + 代码生成）
│   ├── graph-utils.js     # 图归一化、布局、连线校验
│   ├── function-defs.js   # 函数动态节点定义
│   ├── function-wrap.js   # 框选节点封装为函数
│   ├── module-utils.js    # 模块解析与合并
│   └── abi.js             # 节点 ABI 校验、序列化、模板渲染
├── public/
│   ├── index.html         # 单页应用结构
│   ├── styles.css         # 移动端样式
│   ├── manifest.webmanifest
│   └── js/
│       ├── app.js         # 应用逻辑、面板、SDK
│       ├── editor.js      # Canvas 编辑器（手势、渲染、历史）
│       └── api.js         # 服务端 API 客户端
├── extensions/            # 外部扩展节点（.json / .js / .mjs）
└── data/                  # 运行时数据（.gitignore 已忽略）
    ├── workspace.json
    └── blueprints/*.json
```

---

## 数据存储

| 位置 | 内容 |
| --- | --- |
| `data/workspace.json` | 当前工作区（名称、更新时间、主图、函数、变量） |
| `data/blueprints/<id>.json` | 蓝图库中的单份蓝图 |
| `extensions/*.json` / `*.js` / `*.mjs` | 外部扩展节点，服务启动时加载 |
| `localStorage` | 界面偏好：自动保存间隔、面板列数/高度、节点浮窗位置 |

`data/` 已被 `.gitignore` 忽略，属于本地运行数据。

---

## 文档索引

- [tutorial.md](tutorial.md) — 界面导览、手势、从零搭建蓝图、函数、模块、扩展节点
- [api.md](api.md) — HTTP API、图数据结构、浏览器 `window.NodeCode` SDK
- [abi.md](abi.md) — 外部扩展节点 ABI（JSON / JS 两种写法、代码模板、校验规则）
- [nodes.md](nodes.md) — 内置节点与端点参考
- [modules.md](modules.md) — 工作区/模块 JSON 格式、导入合并规则、独立运行语义
- [architecture.md](architecture.md) — 编译器、沙箱、作用域、持久化与性能设计

---

## 常用操作速览

### 触控

| 操作 | 效果 |
| --- | --- |
| 单指拖动空白处 | 平移画布 |
| 单指拖动节点 | 移动节点 |
| 双指捏合 | 缩放画布 |
| 点按端点，再点另一个端点 | 建立连线 |
| 点按节点 | 打开节点浮窗编辑卡片 |
| 点按连线 | 删除该连线（可撤销） |
| 点按右下角 `＋` | 打开添加节点面板（悬浮，可连续添加） |

### 桌面快捷键

| 快捷键 | 效果 |
| --- | --- |
| `Ctrl/Cmd + Z` | 撤销 |
| `Ctrl/Cmd + Shift + Z` 或 `Ctrl/Cmd + Y` | 重做 |
| `Ctrl/Cmd + C` | 复制选中节点 |
| `Ctrl/Cmd + V` | 粘贴节点 |
| `Delete` / `Backspace` | 删除选中节点 |
| `Esc` | 关闭面板 / 退出框选 / 取消未完成的连线 |

### 画布工具

- `↶` / `↷`：撤销 / 重做
- `▭`：框选模式（开启后单指拖动为框选，画布不再平移）
- `⚙`：当前函数设置（位于函数子图时显示）
- `＋` / `－` / `⤢`：放大 / 缩小 / 适应画布

---

## 安全说明

- 蓝图代码在 `node:vm` 中运行，`vm` **不是**严格的安全沙箱，无法防御恶意代码
- 服务默认监听 `0.0.0.0` 且没有身份认证，只应在本地或可信局域网使用
- 沙箱提供 `console`、`setTimeout`、`clearTimeout`、`fetch`，不提供 `require` / `process`
- 运行有超时限制（默认 8000ms，可在 500–30000ms 之间调整）
- 如需公网部署，请自行增加鉴权、网络隔离与更严格的沙箱方案

---

## 脚本

| 命令 | 说明 |
| --- | --- |
| `npm start` | 启动服务 |
| `npm run dev` | 启动服务并在服务端文件变更时自动重启 |

---

## 相关文件

- 服务入口：[server/index.js](server/index.js)
- 编译器：[server/compiler.js](server/compiler.js)
- 沙箱：[server/sandbox.js](server/sandbox.js)
- 前端应用：[public/js/app.js](public/js/app.js)
- Canvas 编辑器：[public/js/editor.js](public/js/editor.js)
