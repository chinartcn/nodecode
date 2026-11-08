import {
  CATEGORY_COLORS,
  CATEGORY_LABELS,
  NODE_TYPE_COLORS,
  getNodeDef,
  getVisibleNodeDefs,
  isValidIdentifier,
  nodeDefs,
  setExternalNodeDefs,
} from '/shared/node-defs.js';
import {
  serializeNodeDef,
  serializeNodeDefs,
  validateExternalNodeDefinition,
} from '/shared/abi.js';
import {
  clearLayoutCache,
  generateId,
  getNodeLayout,
  getPinLayout,
  normalizeGraph,
} from '/shared/graph-utils.js';
import {
  functionArgDefName,
  functionCallDefName,
  functionRetDefName,
} from '/shared/function-defs.js';
import {
  PROPERTY_TYPES,
  classArgDefName,
  classCallDefName,
  classGetDefName,
  classNewDefName,
  classRetDefName,
  classSelfGetDefName,
  classSelfSetDefName,
  classSetDefName,
  defaultPropertyValue,
  isMethodScopeId,
  listClassPaletteNodeNames,
  listClassSelfNodeNames,
  methodScopeId,
  parseMethodScopeId,
} from '/shared/class-defs.js';
import { applyDynamicNodeDefs } from '/shared/dynamic-defs.js';
import { wrapSelectionAsFunction } from '/shared/function-wrap.js';
import { mergeModuleGraph } from '/shared/module-utils.js';
import { BlueprintEditor } from './editor.js';
import { api } from './api.js';

const $ = (id) => document.getElementById(id);
const canvas = $('canvas');

const editor = new BlueprintEditor(canvas, {
  onChange: handleEditorChange,
  onSelect: () => {
    handleSelectionChange();
    emitSdk('select', { scope: currentScope, nodes: editor.getSelectedNodes() });
  },
  onStructure: () => {
    refreshSelectionBar();
    updateStats();
    refreshInspector();
    emitSdk('structure', { scope: currentScope });
  },
  onConnectionTap: (connectionId) => askDeleteConnection(connectionId),
  onNodeTap: handleNodeTap,
  onHint: handleHint,
  onHidden: handlePageHidden,
  onHistory: refreshHistoryButtons,
  onModeChange: handleSelectionModeChange,
});

const AUTOSAVE_KEY = 'codeck.autosaveMs';
const AUTOSAVE_DEFAULT = 30000;
const PALETTE_COMPACT_KEY = 'codeck.palette.compact';
const PALETTE_COLUMNS_KEY = 'codeck.palette.columns';
const NODE_CARD_POS_KEY = 'codeck.nodeCardPos';

let currentName = '我的蓝图';
let examples = [];
let openSheetName = null;
let confirmCallback = null;
let promptCallback = null;
let promptReopen = null;
let toastTimer = null;
let hintTimer = null;
let lastOutputText = '';
let lastCode = '';
let paletteState = { category: 'all', query: '' };
let paletteCompact = readFlag(PALETTE_COMPACT_KEY);
let paletteTwoCols = readFlag(PALETTE_COLUMNS_KEY);

// 工作区：主图 + 用户函数（子图）+ 用户类
let workspace = {
  main: { nodes: [], connections: [], variables: [] },
  functions: [],
  classes: [],
};
let currentScope = 'main';
let scopeStack = [{ id: 'main' }];
let pendingFunctionMode = null;
let signatureTarget = null;
let signatureDraft = { name: '', inputs: [], outputs: [] };
let classSettingsId = null;
let classDraft = { name: '', properties: [] };
let externalNodeDefs = [];
let nodeCatalog = [];
let nodeCardNodeId = null;
let nodeCardDrag = null;
let nodeCardPosition = readNodeCardPosition();

// 浏览器全局 SDK（window.NodeCode）
const sdkListeners = {
  change: new Set(),
  select: new Set(),
  structure: new Set(),
  scope: new Set(),
};
let sdkReadyResolve = null;
const sdkReady = new Promise((resolve) => {
  sdkReadyResolve = resolve;
});

let autoSaveMs = readAutoSaveSetting();
let autoSaveTimer = null;
let pendingChanges = false;
let changeRevision = 0;
let saving = false;
let hiddenSaveInFlight = false;

function handleEditorChange() {
  markDirty();
  emitSdk('change', { scope: currentScope });
  const card = $('node-card');
  const node = editor.getSelectedNode();
  if (card && !card.hidden && node) positionNodeCard(node);
}

function emitSdk(event, payload) {
  const listeners = sdkListeners[event];
  if (!listeners) return;
  for (const listener of listeners) {
    try {
      listener(payload);
    } catch (error) {
      console.error('[NodeCode]', error);
    }
  }
}

function registerClientExternalNode(def) {
  const result = validateExternalNodeDefinition(def, { allowExisting: true });
  if (!result.ok) throw new Error(result.errors.join('；'));
  const existing = getNodeDef(result.node.name);
  if (existing && !existing.external) {
    throw new Error(`节点名「${result.node.name}」与内置节点冲突`);
  }
  const serialized = serializeNodeDef({ ...result.node, external: true });
  const index = externalNodeDefs.findIndex((item) => item.name === serialized.name);
  if (index >= 0) externalNodeDefs[index] = serialized;
  else externalNodeDefs.push(serialized);
  setExternalNodeDefs(externalNodeDefs);
  renderPalette();
  return serialized;
}

const NodeCodeAbi = {
  version: 1,
  valueTypes: ['string', 'number', 'boolean', 'object', 'array'],
  editors: ['text', 'number', 'boolean', 'select', 'json', 'code'],
  validateNode: (def) => validateExternalNodeDefinition(def, { allowExisting: true }),
  defineNode: (def) => {
    const result = validateExternalNodeDefinition(def, { allowExisting: true });
    if (!result.ok) throw new Error(result.errors.join('；'));
    return result.node;
  },
  registerNode: (def) => registerClientExternalNode(def),
  registerNodes: (defs) => (defs || []).map(registerClientExternalNode),
  getNodes: () =>
    nodeCatalog.length > 0
      ? nodeCatalog.slice()
      : [...serializeNodeDefs(nodeDefs), ...externalNodeDefs],
  getExternalNodes: () => externalNodeDefs.slice(),
  load: async (url) => {
    const module = await import(url);
    let exported = module.default ?? module.nodes ?? module;
    if (typeof exported === 'function') exported = await exported(NodeCodeAbi);
    const list = Array.isArray(exported)
      ? exported
      : Array.isArray(exported?.nodes)
        ? exported.nodes
        : [exported];
    return list.filter(Boolean).map(registerClientExternalNode);
  },
};

const NodeCodeApi = {
  version: 1,
  getGraph: () => editor.getGraph(),
  getWorkspace: () => getWorkspaceGraph(),
  loadWorkspace: async (graph) => {
    loadWorkspace(graph);
    markDirty();
    await saveNow();
    return getWorkspaceGraph();
  },
  getScope: () => currentScope,
  getScopeStack: () => scopeStack.map((item) => ({ id: item.id, name: scopeName(item.id) })),
  enterScope: (id) => enterScope(id),
  backScope: () => goBackScope(),
  getFunctions: () =>
    workspace.functions.map((fn) => ({
      id: fn.id,
      name: fn.name,
      inputs: fn.inputs,
      outputs: fn.outputs,
    })),
  getClasses: () =>
    workspace.classes.map((cls) => ({
      id: cls.id,
      name: cls.name,
      properties: cls.properties,
      methods: (cls.methods || []).map((method) => ({
        id: method.id,
        name: method.name,
        inputs: method.inputs,
        outputs: method.outputs,
      })),
    })),
  getNodeDefs: () => getPaletteDefs(),
  getAbi: () => api.getAbi(),
  getNodeCatalog: () => api.getNodeCatalog(),
  getSelection: () => editor.getSelectedNodes(),
  listBlueprints: () => api.listBlueprints(),
  saveBlueprint: (name) => api.createBlueprint({ name, graph: getWorkspaceGraph() }),
  loadBlueprint: async (id) => {
    const blueprint = await api.getBlueprint(id);
    currentName = blueprint.name;
    $('blueprint-name').value = currentName;
    loadWorkspace(blueprint.graph);
    markDirty();
    await saveNow();
    return getWorkspaceGraph();
  },
  deleteBlueprint: (id) => api.deleteBlueprint(id),
  selectNode: (id) => editor.selectNode(id),
  addNode: (name, data) => editor.addNode(name, data),
  removeNode: (id) => editor.deleteNode(id),
  updateNodeData: (id, key, value) => editor.updateNodeData(id, key, value),
  compile: (graph) => api.compile(graph || getWorkspaceGraph()),
  run: (graph, timeoutMs) => api.run(graph || getWorkspaceGraph(), timeoutMs ?? 8000),
  save: async () => {
    markDirty();
    await saveNow();
  },
  exportJson: () => ({ version: 1, name: currentName, graph: getWorkspaceGraph() }),
  importJson: async (payload) => {
    const graph =
      payload && typeof payload === 'object' && payload.graph && typeof payload.graph === 'object'
        ? payload.graph
        : payload;
    loadWorkspace(graph);
    if (payload && typeof payload.name === 'string' && payload.name.trim()) {
      currentName = payload.name.trim();
      $('blueprint-name').value = currentName;
    }
    markDirty();
    await saveNow();
    return getWorkspaceGraph();
  },
  importModule: (payload) => applyModule(payload),
  toast: (message) => toast(String(message)),
  on: (event, handler) => {
    if (sdkListeners[event] && typeof handler === 'function') sdkListeners[event].add(handler);
  },
  off: (event, handler) => {
    sdkListeners[event]?.delete(handler);
  },
  undo: () => editor.undo(),
  redo: () => editor.redo(),
  fitView: () => editor.fitView(),
};

window.NodeCode = {
  version: 1,
  ready: sdkReady,
  abi: NodeCodeAbi,
  api: NodeCodeApi,
};

/* ---------------- 启动 ---------------- */

async function boot() {
  bindUI();
  setupAutoSave();
  renderPalette();
  applyPaletteLayout();
  refreshHistoryButtons();

  try {
    const [state, exampleList] = await Promise.all([api.getState(), api.getExamples()]);
    examples = Array.isArray(exampleList) ? exampleList : [];

    try {
      const catalog = await api.getNodeCatalog();
      nodeCatalog = catalog.nodes || [];
      const catalogDefs = nodeCatalog.filter((def) => def.external);
      const byName = new Map(catalogDefs.map((def) => [def.name, def]));
      for (const def of externalNodeDefs) {
        if (!byName.has(def.name)) byName.set(def.name, def);
      }
      externalNodeDefs = [...byName.values()];
      setExternalNodeDefs(externalNodeDefs);
    } catch {
      /* 节点目录加载失败时保留客户端已注册的扩展节点 */
    }

    currentName = state.name || '我的蓝图';
    $('blueprint-name').value = currentName;
    loadWorkspace(state.graph);
    renderExamples();
  } catch (error) {
    toast(`加载失败：${error.message}`);
  }

  updateStats();
  updateScopeBar();
  requestAnimationFrame(() => editor.fitView());
  setTimeout(() => $('tip').classList.add('hide'), 5200);
  refreshBlueprintBadge();
  sdkReadyResolve?.(window.NodeCode);
}

/* ---------------- 面板管理 ---------------- */

function openSheet(name) {
  if (openSheetName && openSheetName !== name) closeSheet(openSheetName, true);
  const sheet = $(`sheet-${name}`);
  if (!sheet) return;
  const floating = name === 'palette';
  const card = $('node-card');
  if (card) card.hidden = true;
  nodeCardNodeId = null;
  sheet.classList.add('open');
  sheet.setAttribute('aria-hidden', 'false');
  if (floating) $('scrim').classList.remove('show');
  else $('scrim').classList.add('show');
  $('selection-bar').hidden = true;
  openSheetName = name;
  if (floating) updatePaletteInset();
  refreshMultiToolbar();
}

function closeSheet(name = openSheetName, keepScrim = false) {
  if (!name) return;
  const sheet = $(`sheet-${name}`);
  sheet?.classList.remove('open');
  sheet?.setAttribute('aria-hidden', 'true');
  if (name === openSheetName) openSheetName = null;
  if (!keepScrim) $('scrim').classList.remove('show');
  if (name === 'palette') editor.setBottomInset(0);
  if (name === 'inspector') {
    sheet?.classList.remove('fullscreen');
    const fullscreenButton = $('inspector-fullscreen');
    if (fullscreenButton) fullscreenButton.textContent = '全屏';
  }
  refreshSelectionBar();
  refreshMultiToolbar();
}

/** 让新节点添加到悬浮面板上方的可见区域 */
function updatePaletteInset() {
  if (openSheetName !== 'palette') {
    editor.setBottomInset(0);
    return;
  }
  const rect = $('sheet-palette').getBoundingClientRect();
  editor.setBottomInset(rect.height + 20);
}

function readFlag(key) {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key, value) {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    /* ignore */
  }
}

/** 应用节点面板的高度 / 列数偏好 */
function applyPaletteLayout() {
  $('sheet-palette').classList.toggle('compact', paletteCompact);
  $('palette-list').classList.toggle('two-columns', paletteTwoCols);
  $('palette-height').textContent = paletteCompact ? '1/2' : '1/4';
  $('palette-columns').textContent = paletteTwoCols ? '单列' : '双列';
  updatePaletteInset();
}

function handleSelectionChange() {
  refreshSelectionBar();
  refreshMultiToolbar();
  const node = editor.getSelectedNode();
  if (!node || editor.selectionMode || node.id !== nodeCardNodeId) {
    hideNodeCard();
  }
}

function handleNodeTap(node) {
  if (!node || editor.selectionMode) return;
  showNodeCard(node.id);
}

function handleSelectionModeChange(enabled) {
  $('btn-marquee').classList.toggle('active', enabled);
  refreshMultiToolbar();
  toast(enabled ? '框选模式已开启：拖动框选节点' : '框选模式已关闭');
}

function refreshHistoryButtons() {
  const undo = $('btn-undo');
  const redo = $('btn-redo');
  if (!undo || !redo) return;
  undo.disabled = !editor.canUndo();
  redo.disabled = !editor.canRedo();
}

function refreshMultiToolbar() {
  const toolbar = $('multi-toolbar');
  if (!toolbar) return;
  const count = editor.selectedIds.size;
  const show = editor.selectionMode && count > 0 && !openSheetName;
  toolbar.hidden = !show;
  if (!show) return;
  $('multi-count').textContent = `${count} 个`;
  $('multi-drag').classList.toggle('active', editor.multiDrag);
  $('multi-copy').disabled = count === 0;
  $('multi-delete').disabled = count === 0;
  $('multi-paste').disabled = !editor.hasClipboard();
}

/* ---------------- 工作区 / 函数 / 类 ---------------- */

function applyDynamicDefs() {
  clearLayoutCache();
  applyDynamicNodeDefs(workspace.functions, workspace.classes);
}

function findMethodScope(scopeId) {
  const parsed = parseMethodScopeId(scopeId);
  if (!parsed) return null;
  const cls = workspace.classes.find((item) => item.id === parsed.classId);
  if (!cls) return null;
  const method = (cls.methods || []).find((item) => item.id === parsed.methodId);
  return method ? { cls, method } : null;
}

function getScopeGraph(scopeId) {
  if (scopeId === 'main') return workspace.main;
  const fn = workspace.functions.find((item) => item.id === scopeId);
  if (fn) return fn.graph;
  const found = findMethodScope(scopeId);
  return found ? found.method.graph : null;
}

function loadWorkspace(rawGraph, options = {}) {
  const normalized = normalizeGraph(rawGraph);
  workspace = {
    main: {
      nodes: normalized.nodes,
      connections: normalized.connections,
      variables: normalized.variables,
    },
    functions: normalized.functions || [],
    classes: normalized.classes || [],
  };
  applyDynamicDefs();
  for (const fn of workspace.functions) syncSignatureNodes(fn);
  for (const cls of workspace.classes) {
    for (const method of cls.methods || []) syncMethodSignatureNodes(cls, method);
  }
  pruneAllConnections();
  currentScope = 'main';
  scopeStack = [{ id: 'main' }];
  editor.setGraph(workspace.main, { recordHistory: false });
  editor.clearHistory();
  closeSheet();
  renderPalette();
  updateScopeBar();
  updateStats();
  refreshHistoryButtons();
  refreshSelectionBar();
  refreshMultiToolbar();
  if (options.fit !== false) editor.fitView();
}

function syncCurrentScope() {
  if (!editor?.graph) return;
  const snapshot = editor.getGraph();
  if (currentScope === 'main') {
    workspace.main = snapshot;
    return;
  }
  const fn = workspace.functions.find((item) => item.id === currentScope);
  if (fn) {
    fn.graph = snapshot;
    return;
  }
  const found = findMethodScope(currentScope);
  if (found) found.method.graph = snapshot;
}

function getWorkspaceGraph() {
  syncCurrentScope();
  const scope = (graph) => ({
    nodes: graph.nodes,
    connections: graph.connections,
    variables: graph.variables,
  });
  return {
    ...scope(workspace.main),
    functions: workspace.functions.map((fn) => ({ ...fn, graph: scope(fn.graph) })),
    classes: workspace.classes.map((cls) => ({
      ...cls,
      properties: cls.properties.map((property) => ({ ...property })),
      methods: (cls.methods || []).map((method) => ({
        ...method,
        inputs: method.inputs,
        outputs: method.outputs,
        graph: scope(method.graph),
      })),
    })),
  };
}

function scopeName(id) {
  if (id === 'main') return '主图';
  const fn = workspace.functions.find((item) => item.id === id);
  if (fn) return fn.name;
  const found = findMethodScope(id);
  return found ? `${found.cls.name}.${found.method.name}` : '已删除作用域';
}

function updateScopeBar() {
  const bar = $('scope-bar');
  if (!bar) return;
  const settingsButton = $('btn-function-settings');
  if (currentScope === 'main') {
    bar.hidden = true;
    if (settingsButton) settingsButton.hidden = true;
    return;
  }
  const parent = scopeStack[scopeStack.length - 2];
  const path = scopeStack.map((item) => scopeName(item.id)).join(' / ');
  $('scope-back').textContent = parent ? `‹ ${scopeName(parent.id)}` : '‹ 主图';
  $('scope-name').textContent = path;
  $('scope-name').title = path;
  bar.hidden = false;
  if (settingsButton) settingsButton.hidden = false;
}

function loadScope(entry, { sync = false, fit = true } = {}) {
  if (sync) syncCurrentScope();

  let target = entry;
  let fn = null;
  let methodScope = null;
  if (target.id !== 'main') {
    fn = workspace.functions.find((item) => item.id === target.id) || null;
    if (!fn) methodScope = findMethodScope(target.id);
    if (!fn && !methodScope) {
      scopeStack = [{ id: 'main' }];
      target = scopeStack[0];
    }
  }

  currentScope = target.id;
  applyDynamicDefs();
  if (fn) syncSignatureNodes(fn);
  if (methodScope) syncMethodSignatureNodes(methodScope.cls, methodScope.method);

  const graph =
    target.id === 'main'
      ? workspace.main
      : fn
        ? fn.graph
        : methodScope.method.graph;

  editor.setGraph(graph, {
    fit,
    recordHistory: false,
  });
  editor.clearHistory();
  closeSheet();
  renderPalette();
  updateScopeBar();
  updateStats();
  refreshHistoryButtons();
  refreshSelectionBar();
  refreshMultiToolbar();
  emitSdk('scope', {
    id: target.id,
    name: scopeName(target.id),
    stack: scopeStack.map((item) => ({ id: item.id, name: scopeName(item.id) })),
  });
}

function enterScope(scopeId) {
  if (scopeId === currentScope) {
    closeSheet();
    return;
  }
  syncCurrentScope();

  if (scopeId === 'main') {
    scopeStack = [{ id: 'main' }];
    loadScope(scopeStack[0], { fit: true });
    toast('已返回主图');
    return;
  }

  const fn = workspace.functions.find((item) => item.id === scopeId);
  const methodScope = fn ? null : findMethodScope(scopeId);
  if (!fn && !methodScope) return;

  const existingIndex = scopeStack.findIndex((item) => item.id === scopeId);
  if (existingIndex >= 0) {
    scopeStack = scopeStack.slice(0, existingIndex + 1);
  } else {
    scopeStack.push({ id: scopeId });
  }

  loadScope(scopeStack[scopeStack.length - 1], { fit: true });
  toast(
    fn
      ? `进入函数「${fn.name}」`
      : `进入方法「${methodScope.cls.name}.${methodScope.method.name}」`
  );
}

function goBackScope() {
  if (scopeStack.length <= 1) return;
  syncCurrentScope();
  scopeStack.pop();
  const entry = scopeStack[scopeStack.length - 1];
  loadScope(entry, { fit: true });
  toast(entry.id === 'main' ? '已返回主图' : `返回「${scopeName(entry.id)}」`);
}

function getPaletteDefs() {
  const allDefs = [
    ...getVisibleNodeDefs(),
    ...externalNodeDefs.filter((def) => !def.hidden),
  ];
  // 函数/方法子图内不能再添加触发节点
  const defs = currentScope === 'main' ? allDefs : allDefs.filter((def) => def.type !== 'begin');
  const seen = new Set(defs.map((def) => def.name));
  const pushDef = (name) => {
    if (!name || seen.has(name)) return;
    const def = getNodeDef(name);
    if (!def) return;
    seen.add(name);
    defs.push(def);
  };

  if (currentScope !== 'main') {
    const fn = workspace.functions.find((item) => item.id === currentScope);
    if (fn) {
      for (const entry of fn.inputs || []) {
        pushDef(functionArgDefName(fn.id, entry.id));
      }
      for (const entry of fn.outputs || []) {
        pushDef(functionRetDefName(fn.id, entry.id));
      }
    }
  }

  for (const fn of workspace.functions) {
    if (fn.id === currentScope) continue;
    pushDef(functionCallDefName(fn.id));
  }

  // 类的外部节点：实例化、属性读写、方法调用
  for (const cls of workspace.classes) {
    for (const name of listClassPaletteNodeNames(cls)) pushDef(name);
  }

  // 方法内部可用的 this 属性节点
  const methodScope = parseMethodScopeId(currentScope);
  if (methodScope) {
    const cls = workspace.classes.find((item) => item.id === methodScope.classId);
    if (cls) {
      for (const name of listClassSelfNodeNames(cls)) pushDef(name);
    }
  }

  return defs;
}

/* ---------------- 函数管理 ---------------- */

function openFunctions() {
  renderFunctions();
  openSheet('functions');
}

function renderFunctions() {
  const container = $('function-list');
  container.replaceChildren();

  if (!workspace.functions.length) {
    container.append(
      div('empty', '还没有函数。框选节点后使用「封装」，或在这里创建空函数。')
    );
  }

  for (const fn of workspace.functions) {
    const card = div('fn-card');

    const head = div('fn-head');
    const name = span(
      'fn-name',
      currentScope === fn.id ? `${fn.name}（当前）` : fn.name
    );
    const summary = span(
      'var-type',
      `入 ${(fn.inputs || []).length} · 出 ${(fn.outputs || []).length}`
    );
    head.append(name, summary);

    const ops = div('fn-ops');
    const enterButton = document.createElement('button');
    enterButton.textContent = '进入';
    enterButton.addEventListener('click', () => enterScope(fn.id));

    const callButton = document.createElement('button');
    callButton.textContent = '调用';
    callButton.disabled = currentScope === fn.id;
    callButton.addEventListener('click', () => addFunctionCall(fn.id));

    const settingsButton = document.createElement('button');
    settingsButton.textContent = '设置';
    settingsButton.addEventListener('click', () => openSignature(fn.id));

    const removeButton = document.createElement('button');
    removeButton.className = 'danger';
    removeButton.textContent = '删除';
    removeButton.addEventListener('click', () => deleteFunction(fn.id));

    ops.append(enterButton, callButton, settingsButton, removeButton);
    card.append(head, ops);
    container.append(card);
  }
}

function addFunctionCall(fnId) {
  const fn = workspace.functions.find((item) => item.id === fnId);
  if (!fn) return;
  if (currentScope === fnId) {
    toast('不能调用当前函数本身');
    return;
  }
  applyDynamicDefs();
  const node = editor.addNode(functionCallDefName(fnId));
  closeSheet('functions');
  if (node) {
    toast(`已添加调用：${fn.name}`);
    showNodeCard(node.id);
  }
}

function createEmptyFunction(name) {
  const fn = {
    id: generateId('fn'),
    name,
    inputs: [],
    outputs: [],
    graph: { nodes: [], connections: [], variables: [] },
  };
  workspace.functions.push(fn);
  applyDynamicDefs();
  markDirty();
  renderFunctions();
  renderPalette();
  updateStats();
  enterScope(fn.id);
  toast(`已创建函数「${name}」，可在设置中添加输入/输出`);
}

function deleteFunction(fnId) {
  const fn = workspace.functions.find((item) => item.id === fnId);
  if (!fn) return;
  syncCurrentScope();

  workspace.functions = workspace.functions.filter((item) => item.id !== fnId);
  const prefixes = [`fncall:${fnId}`, `fnin:${fnId}`, `fnout:${fnId}`];
  const cleanScope = (scope) => {
    const removed = new Set(
      scope.nodes.filter((node) => prefixes.includes(node.name)).map((node) => node.id)
    );
    scope.nodes = scope.nodes.filter((node) => !removed.has(node.id));
    scope.connections = scope.connections.filter(
      (conn) => !removed.has(conn.fromNodeId) && !removed.has(conn.toNodeId)
    );
  };
  cleanScope(workspace.main);
  for (const item of workspace.functions) cleanScope(item.graph);
  for (const cls of workspace.classes) {
    for (const method of cls.methods || []) cleanScope(method.graph);
  }

  applyDynamicDefs();
  const affectsStack = scopeStack.some((item) => item.id === fnId);
  if (affectsStack || currentScope === 'main') {
    scopeStack = [{ id: 'main' }];
    currentScope = 'main';
  }
  const target = getScopeGraph(currentScope) || workspace.main;

  editor.setGraph(target, { fit: affectsStack, recordHistory: false });
  editor.clearHistory();
  markDirty();
  renderFunctions();
  renderPalette();
  updateScopeBar();
  updateStats();
  refreshHistoryButtons();
  toast(`已删除函数「${fn.name}」`);
}

/* ---------------- 类管理 ---------------- */

function removeNodesEverywhere(predicate) {
  const clean = (scope) => {
    if (!scope) return;
    const removed = new Set(
      (scope.nodes || []).filter((node) => predicate(node)).map((node) => node.id)
    );
    if (!removed.size) return;
    scope.nodes = scope.nodes.filter((node) => !removed.has(node.id));
    scope.connections = (scope.connections || []).filter(
      (conn) => !removed.has(conn.fromNodeId) && !removed.has(conn.toNodeId)
    );
  };
  clean(workspace.main);
  for (const fn of workspace.functions) clean(fn.graph);
  for (const cls of workspace.classes) {
    for (const method of cls.methods || []) clean(method.graph);
  }
}

function classPrefixPredicate(classId, extra) {
  const prefixes = [
    `clsget:${classId}:`,
    `clsset:${classId}:`,
    `clscall:${classId}:`,
    `clsselfget:${classId}:`,
    `clsselfset:${classId}:`,
    `clsarg:${classId}:`,
    `clsret:${classId}:`,
  ];
  return (node) =>
    node.name === `clsnew:${classId}` ||
    (extra ? extra(node) : false) ||
    prefixes.some((prefix) => node.name.startsWith(prefix));
}

function openClasses() {
  renderClasses();
  openSheet('classes');
}

function renderClasses() {
  const container = $('class-list');
  const badge = $('class-count');
  if (badge) badge.textContent = String(workspace.classes.length);
  if (!container) return;
  container.replaceChildren();

  if (!workspace.classes.length) {
    container.append(
      div('empty', '还没有类。创建一个类后，可以添加属性与方法，并在画布中实例化。')
    );
    return;
  }

  for (const cls of workspace.classes) {
    const card = div('fn-card');
    const head = div('fn-head');
    head.append(
      span('fn-name', cls.name),
      span('var-type', `属性 ${(cls.properties || []).length} · 方法 ${(cls.methods || []).length}`)
    );

    const meta = div(
      'bp-meta',
      (cls.properties || []).length
        ? (cls.properties || []).map((property) => property.name).join(' · ')
        : '暂无属性'
    );

    const ops = div('fn-ops');
    ops.append(
      makeMiniButton('设置', () => openClassSettings(cls.id)),
      makeMiniButton('加方法', () => promptAddMethod(cls.id)),
      makeMiniButton('删除', () => deleteClass(cls.id), 'danger')
    );

    const methodList = div('node-list');
    if (!(cls.methods || []).length) {
      methodList.append(div('empty', '暂无方法。点击「加方法」创建。'));
    }
    for (const method of cls.methods || []) {
      const row = div('fn-card');
      const methodHead = div('fn-head');
      const current = currentScope === methodScopeId(cls.id, method.id);
      methodHead.append(
        span('fn-name', current ? `${method.name}（当前）` : method.name),
        span(
          'var-type',
          `入 ${(method.inputs || []).length} · 出 ${(method.outputs || []).length}`
        )
      );
      const methodOps = div('fn-ops');
      methodOps.append(
        makeMiniButton('进入', () => enterScope(methodScopeId(cls.id, method.id))),
        makeMiniButton('设置', () => openMethodSignature(cls.id, method.id)),
        makeMiniButton('删除', () => deleteMethod(cls.id, method.id), 'danger')
      );
      row.append(methodHead, methodOps);
      methodList.append(row);
    }

    card.append(head, meta, ops, methodList);
    container.append(card);
  }
}

function createClass(name) {
  if (workspace.classes.some((cls) => cls.name === name)) {
    toast('类名已存在');
    return;
  }
  workspace.classes.push({
    id: generateId('cls'),
    name,
    properties: [],
    methods: [],
  });
  applyDynamicDefs();
  markDirty();
  renderClasses();
  renderPalette();
  updateStats();
  toast(`已创建类「${name}」`);
}

function promptAddMethod(classId) {
  const cls = workspace.classes.find((item) => item.id === classId);
  if (!cls) return;
  openPrompt({
    title: '添加方法',
    hint: `类「${cls.name}」的新方法`,
    value: '',
    reopen: null,
    onConfirm: (name) => addMethod(cls, name),
  });
}

function addMethod(cls, name) {
  if (!cls) return;
  if (name === 'constructor') {
    toast('方法名不能是 constructor');
    return;
  }
  if ((cls.methods || []).some((method) => method.name === name)) {
    toast('方法名已存在');
    return;
  }
  const method = {
    id: generateId('m'),
    name,
    inputs: [],
    outputs: [],
    graph: { nodes: [], connections: [], variables: [] },
  };
  cls.methods = cls.methods || [];
  cls.methods.push(method);
  applyDynamicDefs();
  syncMethodSignatureNodes(cls, method);
  markDirty();
  renderClasses();
  renderPalette();
  updateStats();
  toast(`已添加方法「${cls.name}.${name}」`);
  enterScope(methodScopeId(cls.id, method.id));
}

function deleteMethod(classId, methodId) {
  const cls = workspace.classes.find((item) => item.id === classId);
  const method = cls?.methods?.find((item) => item.id === methodId);
  if (!cls || !method) return;
  syncCurrentScope();

  cls.methods = cls.methods.filter((item) => item.id !== methodId);
  const exactName = `clscall:${classId}:${methodId}`;
  removeNodesEverywhere(
    (node) =>
      node.name === exactName ||
      node.name.startsWith(`clsarg:${classId}:${methodId}:`) ||
      node.name.startsWith(`clsret:${classId}:${methodId}:`)
  );

  applyDynamicDefs();
  if (currentScope === methodScopeId(classId, methodId)) {
    scopeStack = [{ id: 'main' }];
    currentScope = 'main';
  }
  const target = getScopeGraph(currentScope) || workspace.main;
  editor.setGraph(target, { fit: false, recordHistory: false });
  editor.clearHistory();
  markDirty();
  renderClasses();
  renderPalette();
  updateScopeBar();
  updateStats();
  refreshHistoryButtons();
  toast(`已删除方法「${cls.name}.${method.name}」`);
}

function deleteClass(classId) {
  const cls = workspace.classes.find((item) => item.id === classId);
  if (!cls) return;
  syncCurrentScope();

  workspace.classes = workspace.classes.filter((item) => item.id !== classId);
  removeNodesEverywhere(classPrefixPredicate(classId));

  applyDynamicDefs();
  const affectsScope = scopeStack.some((item) => {
    const parsed = parseMethodScopeId(item.id);
    return parsed && parsed.classId === classId;
  });
  if (affectsScope) {
    scopeStack = [{ id: 'main' }];
    currentScope = 'main';
  }
  const target = getScopeGraph(currentScope) || workspace.main;
  editor.setGraph(target, { fit: affectsScope, recordHistory: false });
  editor.clearHistory();
  markDirty();
  renderClasses();
  renderPalette();
  updateScopeBar();
  updateStats();
  refreshHistoryButtons();
  toast(`已删除类「${cls.name}」`);
}

function openClassSettings(classId) {
  const cls = workspace.classes.find((item) => item.id === classId);
  if (!cls) return;
  classSettingsId = classId;
  classDraft = {
    name: cls.name,
    properties: (cls.properties || []).map((property) => ({ ...property })),
  };
  $('class-settings-name').value = cls.name;
  $('class-settings-sub').textContent = `属性 ${classDraft.properties.length} · 方法 ${(cls.methods || []).length}`;
  renderClassProperties();
  openSheet('class-settings');
}

function renderClassProperties() {
  const container = $('class-properties');
  if (!container) return;
  container.replaceChildren();

  if (!classDraft.properties.length) {
    container.append(div('empty', '暂无属性。添加后可在方法内用 this.属性名 读写。'));
    return;
  }

  for (const property of classDraft.properties) {
    const row = div('sig-row class-prop-row');

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = property.name;
    nameInput.placeholder = '属性名';
    nameInput.addEventListener('input', () => {
      property.name = nameInput.value;
    });

    const typeSelect = document.createElement('select');
    for (const type of PROPERTY_TYPES) {
      const option = document.createElement('option');
      option.value = type;
      option.textContent = type;
      typeSelect.append(option);
    }
    typeSelect.value = property.type;
    typeSelect.addEventListener('change', () => {
      property.type = typeSelect.value;
      property.value = defaultPropertyValue(property.type, property.value);
    });

    const valueInput = document.createElement('input');
    valueInput.type = 'text';
    valueInput.value =
      typeof property.value === 'object'
        ? JSON.stringify(property.value)
        : String(property.value ?? '');
    valueInput.placeholder = '默认值';
    valueInput.addEventListener('input', () => {
      property.value = valueInput.value;
    });

    const remove = document.createElement('button');
    remove.className = 'sig-remove';
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      classDraft.properties = classDraft.properties.filter((item) => item !== property);
      renderClassProperties();
    });

    row.append(nameInput, typeSelect, valueInput, remove);
    container.append(row);
  }
}

function addClassProperty() {
  const name = $('class-prop-name').value.trim();
  if (!isValidIdentifier(name)) {
    toast('属性名需以字母、下划线或 $ 开头');
    return;
  }
  if (classDraft.properties.some((property) => property.name === name)) {
    toast('属性已存在');
    return;
  }
  const type = $('class-prop-type').value;
  const raw = $('class-prop-value').value.trim();
  let value = raw;

  if (type === 'number') {
    if (raw !== '' && !Number.isFinite(Number(raw))) {
      toast('默认值需为数字');
      return;
    }
    value = raw === '' ? 0 : Number(raw);
  } else if (type === 'boolean') {
    value = raw === 'true';
  } else if (type === 'object' || type === 'array') {
    if (raw) {
      try {
        JSON.parse(raw);
      } catch {
        toast('默认值需为合法 JSON');
        return;
      }
    }
  }

  classDraft.properties.push({
    id: generateId('p'),
    name,
    type,
    value: defaultPropertyValue(type, value),
  });
  $('class-prop-name').value = '';
  $('class-prop-value').value = '';
  renderClassProperties();
}

function syncClassPropertyNodes(cls, removedPropertyIds = []) {
  const validSelfNames = new Set(listClassSelfNodeNames(cls));
  const removed = new Set(removedPropertyIds);
  removeNodesEverywhere((node) => {
    const isSelf =
      node.name.startsWith(`clsselfget:${cls.id}:`) ||
      node.name.startsWith(`clsselfset:${cls.id}:`);
    if (isSelf) return !validSelfNames.has(node.name);

    const parts = node.name.split(':');
    if (
      parts.length === 3 &&
      (parts[0] === 'clsget' || parts[0] === 'clsset') &&
      parts[1] === cls.id
    ) {
      return removed.has(parts[2]);
    }
    return false;
  });
}

function saveClassSettings() {
  const cls = workspace.classes.find((item) => item.id === classSettingsId);
  if (!cls) {
    closeSheet('class-settings');
    return;
  }
  const name = $('class-settings-name').value.trim();
  if (!name) {
    toast('请输入类名');
    return;
  }
  if (workspace.classes.some((item) => item.id !== cls.id && item.name === name)) {
    toast('类名已存在');
    return;
  }

  const usedNames = new Set();
  const properties = [];
  for (const property of classDraft.properties) {
    const propertyName = String(property.name || '').trim();
    if (!isValidIdentifier(propertyName)) {
      toast(`属性名不合法：${propertyName || '(空)'}`);
      return;
    }
    if (usedNames.has(propertyName)) {
      toast(`属性名重复：${propertyName}`);
      return;
    }
    usedNames.add(propertyName);
    properties.push({
      id: property.id,
      name: propertyName,
      type: PROPERTY_TYPES.includes(property.type) ? property.type : 'string',
      value: defaultPropertyValue(property.type, property.value),
    });
  }

  syncCurrentScope();
  const oldIds = new Set((cls.properties || []).map((property) => property.id));
  const newIds = new Set(properties.map((property) => property.id));
  const removedPropertyIds = [...oldIds].filter((id) => !newIds.has(id));

  cls.name = name;
  cls.properties = properties;
  applyDynamicDefs();
  syncClassPropertyNodes(cls, removedPropertyIds);
  pruneAllConnections();

  const target = getScopeGraph(currentScope) || workspace.main;
  editor.setGraph(target, { fit: false, recordHistory: false });
  editor.clearHistory();
  markDirty();
  renderClasses();
  renderPalette();
  updateStats();
  updateScopeBar();
  refreshHistoryButtons();
  closeSheet('class-settings');
  toast('类设置已保存');
}



function openFunctionNameSheet(mode) {
  pendingFunctionMode = mode;
  const input = $('fn-name-input');
  let index = workspace.functions.length + 1;
  let defaultName = `函数${index}`;
  while (workspace.functions.some((fn) => fn.name === defaultName)) {
    index += 1;
    defaultName = `函数${index}`;
  }
  input.value = defaultName;
  $('fn-name-title').textContent = mode === 'wrap' ? '封装为函数' : '新建函数';
  $('fn-name-hint').textContent =
    mode === 'wrap'
      ? `将选中的 ${editor.selectedIds.size} 个节点封装为函数，边界连线会自动生成输入/输出。`
      : '创建一个空函数，之后可在函数设置中添加输入/输出。';
  openSheet('fnname');
  setTimeout(() => input.focus(), 260);
}

function confirmFunctionName() {
  const name = $('fn-name-input').value.trim();
  if (!name) {
    toast('请输入函数名');
    return;
  }
  if (workspace.functions.some((fn) => fn.name === name)) {
    toast('函数名已存在');
    return;
  }
  const mode = pendingFunctionMode;
  pendingFunctionMode = null;
  closeSheet('fnname');
  if (mode === 'wrap') executeWrap(name);
  else createEmptyFunction(name);
}

function startWrap() {
  if (!editor.selectedIds.size) {
    toast('请先选择要封装的节点');
    return;
  }
  openFunctionNameSheet('wrap');
}

function executeWrap(name) {
  const result = wrapSelectionAsFunction(editor.graph, [...editor.selectedIds], name);
  if (result.error) {
    toast(result.error);
    return;
  }

  workspace.functions.push(result.functionDef);
  applyDynamicDefs();

  editor.setGraph(result.outerGraph, { fit: false, recordHistory: true });
  editor.selectNode(result.callNodeId);
  markDirty();
  renderPalette();
  updateStats();
  refreshHistoryButtons();
  toast(`已封装为函数「${name}」，可在菜单 → 函数管理中进入`);
  if (result.warnings?.length) {
    setTimeout(() => toast(result.warnings[0]), 2300);
  }
}

/* ---------------- 函数 / 方法签名 ---------------- */

function openSignature(fnId) {
  const fn = workspace.functions.find((item) => item.id === fnId);
  if (!fn) return;
  signatureTarget = { kind: 'function', id: fnId };
  signatureDraft = {
    name: fn.name,
    inputs: (fn.inputs || []).map((entry) => ({ ...entry })),
    outputs: (fn.outputs || []).map((entry) => ({ ...entry })),
  };
  $('signature-name').value = fn.name;
  $('signature-sub').textContent = `输入 ${signatureDraft.inputs.length} · 输出 ${signatureDraft.outputs.length}`;
  renderSignatureRows('inputs');
  renderSignatureRows('outputs');
  openSheet('signature');
}

function openMethodSignature(classId, methodId) {
  const cls = workspace.classes.find((item) => item.id === classId);
  const method = cls?.methods?.find((item) => item.id === methodId);
  if (!cls || !method) return;
  signatureTarget = { kind: 'method', classId, methodId };
  signatureDraft = {
    name: method.name,
    inputs: (method.inputs || []).map((entry) => ({ ...entry })),
    outputs: (method.outputs || []).map((entry) => ({ ...entry })),
  };
  $('signature-name').value = method.name;
  $('signature-sub').textContent = `${cls.name} · 输入 ${signatureDraft.inputs.length} · 输出 ${signatureDraft.outputs.length}`;
  renderSignatureRows('inputs');
  renderSignatureRows('outputs');
  openSheet('signature');
}

function renderSignatureRows(kind) {
  const container = $(kind === 'inputs' ? 'signature-inputs' : 'signature-outputs');
  container.replaceChildren();
  const list = signatureDraft[kind];

  if (!list.length) {
    container.append(div('empty', kind === 'inputs' ? '暂无输入参数' : '暂无输出参数'));
    return;
  }

  for (const entry of list) {
    const row = div('sig-row');

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = entry.name;
    nameInput.placeholder = kind === 'inputs' ? '输入名称' : '输出名称';
    nameInput.addEventListener('input', () => {
      entry.name = nameInput.value;
    });

    const typeSelect = document.createElement('select');
    for (const type of ['string', 'number', 'boolean', 'object', 'array']) {
      const option = document.createElement('option');
      option.value = type;
      option.textContent = type;
      typeSelect.append(option);
    }
    typeSelect.value = entry.type;
    typeSelect.addEventListener('change', () => {
      entry.type = typeSelect.value;
    });

    const remove = document.createElement('button');
    remove.className = 'sig-remove';
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      const index = list.indexOf(entry);
      if (index >= 0) list.splice(index, 1);
      renderSignatureRows(kind);
    });

    row.append(nameInput, typeSelect, remove);
    container.append(row);
  }
}

function addSignatureEntry(kind) {
  const list = signatureDraft[kind];
  list.push({
    id: generateId('p'),
    name: kind === 'inputs' ? `输入${list.length + 1}` : `输出${list.length + 1}`,
    type: 'string',
  });
  renderSignatureRows(kind);
}

/** 根据签名自动补齐/清理函数内部的输入输出节点，并迁移旧版聚合节点 */
function syncSignatureNodes(fn) {
  if (!fn) return;
  if (!fn.graph) fn.graph = { nodes: [], connections: [], variables: [] };
  const graph = fn.graph;
  graph.nodes = graph.nodes || [];
  graph.connections = graph.connections || [];

  const minX = graph.nodes.length ? Math.min(...graph.nodes.map((node) => node.position.x)) : 40;
  const minY = graph.nodes.length ? Math.min(...graph.nodes.map((node) => node.position.y)) : 60;
  const maxX = graph.nodes.length
    ? Math.max(
        ...graph.nodes.map(
          (node) => node.position.x + (getNodeLayout(node)?.width || 180)
        )
      )
    : 260;

  (fn.inputs || []).forEach((entry, index) => {
    const name = functionArgDefName(fn.id, entry.id);
    if (!graph.nodes.some((node) => node.name === name)) {
      graph.nodes.push({
        id: generateId('n'),
        name,
        position: { x: minX - 260, y: minY + 40 + index * 110 },
        data: {},
      });
    }
  });

  (fn.outputs || []).forEach((entry, index) => {
    const name = functionRetDefName(fn.id, entry.id);
    if (!graph.nodes.some((node) => node.name === name)) {
      graph.nodes.push({
        id: generateId('n'),
        name,
        position: { x: maxX + 80, y: minY + 40 + index * 110 },
        data: {},
      });
    }
  });

  // 迁移旧版聚合输入节点
  const legacyIn = graph.nodes.find((node) => node.name === `fnin:${fn.id}`);
  if (legacyIn) {
    const outgoing = graph.connections.filter((conn) => conn.fromNodeId === legacyIn.id);
    for (const conn of outgoing) {
      if (!conn.fromNodePinName.startsWith('i_')) continue;
      const entryId = conn.fromNodePinName.slice(2);
      const target = graph.nodes.find(
        (node) => node.name === functionArgDefName(fn.id, entryId)
      );
      if (target) {
        graph.connections.push({
          id: generateId('c'),
          fromNodeId: target.id,
          fromNodePinName: 'value',
          toNodeId: conn.toNodeId,
          toNodePinName: conn.toNodePinName,
        });
      }
    }
    graph.nodes = graph.nodes.filter((node) => node.id !== legacyIn.id);
    graph.connections = graph.connections.filter(
      (conn) => conn.fromNodeId !== legacyIn.id && conn.toNodeId !== legacyIn.id
    );
  }

  // 迁移旧版聚合输出节点
  const legacyOut = graph.nodes.find((node) => node.name === `fnout:${fn.id}`);
  if (legacyOut) {
    const incoming = graph.connections.filter((conn) => conn.toNodeId === legacyOut.id);
    for (const conn of incoming) {
      if (!conn.toNodePinName.startsWith('o_')) continue;
      const entryId = conn.toNodePinName.slice(2);
      const target = graph.nodes.find(
        (node) => node.name === functionRetDefName(fn.id, entryId)
      );
      if (target) {
        graph.connections.push({
          id: generateId('c'),
          fromNodeId: conn.fromNodeId,
          fromNodePinName: conn.fromNodePinName,
          toNodeId: target.id,
          toNodePinName: 'value',
        });
      }
    }
    graph.nodes = graph.nodes.filter((node) => node.id !== legacyOut.id);
    graph.connections = graph.connections.filter(
      (conn) => conn.fromNodeId !== legacyOut.id && conn.toNodeId !== legacyOut.id
    );
  }

  // 删除签名中已移除的参数节点
  const validNames = new Set([
    ...(fn.inputs || []).map((entry) => functionArgDefName(fn.id, entry.id)),
    ...(fn.outputs || []).map((entry) => functionRetDefName(fn.id, entry.id)),
  ]);
  graph.nodes = graph.nodes.filter((node) => {
    if (
      node.name.startsWith(`fnarg:${fn.id}:`) ||
      node.name.startsWith(`fnret:${fn.id}:`)
    ) {
      return validNames.has(node.name);
    }
    return true;
  });
}

/** 根据方法签名自动补齐/清理方法内部的参数与返回节点 */
function syncMethodSignatureNodes(cls, method) {
  if (!cls || !method) return;
  if (!method.graph) method.graph = { nodes: [], connections: [], variables: [] };
  const graph = method.graph;
  graph.nodes = graph.nodes || [];
  graph.connections = graph.connections || [];

  const minX = graph.nodes.length ? Math.min(...graph.nodes.map((node) => node.position.x)) : 40;
  const minY = graph.nodes.length ? Math.min(...graph.nodes.map((node) => node.position.y)) : 60;
  const maxX = graph.nodes.length
    ? Math.max(
        ...graph.nodes.map(
          (node) => node.position.x + (getNodeLayout(node)?.width || 180)
        )
      )
    : 260;

  (method.inputs || []).forEach((entry, index) => {
    const name = classArgDefName(cls.id, method.id, entry.id);
    if (!graph.nodes.some((node) => node.name === name)) {
      graph.nodes.push({
        id: generateId('n'),
        name,
        position: { x: minX - 260, y: minY + 40 + index * 110 },
        data: {},
      });
    }
  });

  (method.outputs || []).forEach((entry, index) => {
    const name = classRetDefName(cls.id, method.id, entry.id);
    if (!graph.nodes.some((node) => node.name === name)) {
      graph.nodes.push({
        id: generateId('n'),
        name,
        position: { x: maxX + 80, y: minY + 40 + index * 110 },
        data: {},
      });
    }
  });

  const validNames = new Set([
    ...(method.inputs || []).map((entry) => classArgDefName(cls.id, method.id, entry.id)),
    ...(method.outputs || []).map((entry) => classRetDefName(cls.id, method.id, entry.id)),
  ]);
  graph.nodes = graph.nodes.filter((node) => {
    if (
      node.name.startsWith(`clsarg:${cls.id}:${method.id}:`) ||
      node.name.startsWith(`clsret:${cls.id}:${method.id}:`)
    ) {
      return validNames.has(node.name);
    }
    return true;
  });
}

function saveSignature() {
  if (!signatureTarget) {
    closeSheet('signature');
    return;
  }
  const name = $('signature-name').value.trim();
  if (!name) {
    toast(signatureTarget.kind === 'method' ? '请输入方法名' : '请输入函数名');
    return;
  }

  const inputs = signatureDraft.inputs.map((entry, index) => ({
    id: entry.id,
    name: (entry.name || '').trim() || `输入${index + 1}`,
    type: entry.type || 'string',
  }));
  const outputs = signatureDraft.outputs.map((entry, index) => ({
    id: entry.id,
    name: (entry.name || '').trim() || `输出${index + 1}`,
    type: entry.type || 'string',
  }));

  syncCurrentScope();

  if (signatureTarget.kind === 'function') {
    const fn = workspace.functions.find((item) => item.id === signatureTarget.id);
    if (!fn) {
      closeSheet('signature');
      return;
    }
    if (workspace.functions.some((item) => item.id !== fn.id && item.name === name)) {
      toast('函数名已存在');
      return;
    }
    fn.name = name;
    fn.inputs = inputs;
    fn.outputs = outputs;
    applyDynamicDefs();
    syncSignatureNodes(fn);
  } else {
    const cls = workspace.classes.find((item) => item.id === signatureTarget.classId);
    const method = cls?.methods?.find((item) => item.id === signatureTarget.methodId);
    if (!cls || !method) {
      closeSheet('signature');
      return;
    }
    if ((cls.methods || []).some((item) => item.id !== method.id && item.name === name)) {
      toast('方法名已存在');
      return;
    }
    method.name = name;
    method.inputs = inputs;
    method.outputs = outputs;
    applyDynamicDefs();
    syncMethodSignatureNodes(cls, method);
  }

  pruneAllConnections();

  const target = getScopeGraph(currentScope) || workspace.main;
  editor.setGraph(target, { fit: false, recordHistory: false });
  editor.clearHistory();

  markDirty();
  renderFunctions();
  renderClasses();
  renderPalette();
  updateScopeBar();
  updateStats();
  refreshHistoryButtons();
  closeSheet('signature');
  toast(signatureTarget.kind === 'method' ? '方法设置已保存' : '函数设置已保存');
}

function pruneAllConnections() {
  const pruneScope = (scope) => {
    const nodeMap = new Map(scope.nodes.map((node) => [node.id, node]));
    scope.connections = scope.connections.filter((conn) => {
      const fromNode = nodeMap.get(conn.fromNodeId);
      const toNode = nodeMap.get(conn.toNodeId);
      if (!fromNode || !toNode) return false;
      return (
        Boolean(getPinLayout(fromNode, 'out', conn.fromNodePinName)) &&
        Boolean(getPinLayout(toNode, 'in', conn.toNodePinName))
      );
    });
  };
  pruneScope(workspace.main);
  for (const fn of workspace.functions) pruneScope(fn.graph);
  for (const cls of workspace.classes) {
    for (const method of cls.methods || []) pruneScope(method.graph);
  }
}

function refreshSelectionBar() {
  const bar = $('selection-bar');
  const node = editor.getSelectedNode();
  if (!node || openSheetName || editor.selectionMode) {
    bar.hidden = true;
    return;
  }
  const def = getNodeDef(node.name);
  if (!def) {
    bar.hidden = true;
    return;
  }
  const suffix =
    (node.name === 'varget' || node.name === 'varset') && node.data?.name
      ? ` · ${node.data.name}`
      : '';
  $('selection-title').textContent = def.label + suffix;
  $('selection-dot').style.background = NODE_TYPE_COLORS[def.type] || '#4da3ff';
  $('selection-delete').style.display = canDeleteNode(node, def) ? '' : 'none';
  bar.hidden = false;
}

function handleHint(text, tone) {
  const bar = $('hintbar');
  clearTimeout(hintTimer);
  if (!text) {
    bar.hidden = true;
    bar.classList.remove('error');
    return;
  }
  $('hint-text').textContent = text;
  bar.classList.toggle('error', tone === 'error');
  bar.hidden = false;
  if (tone === 'error') {
    hintTimer = setTimeout(() => {
      bar.hidden = true;
      bar.classList.remove('error');
    }, 3200);
  }
}

function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => {
      el.hidden = true;
    }, 220);
  }, 2100);
}

function askConfirm({ title, message, confirmText = '确定', onConfirm }) {
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = message || '';
  $('confirm-ok').textContent = confirmText;
  confirmCallback = onConfirm;
  openSheet('confirm');
}

/* ---------------- 保存 ---------------- */

function readAutoSaveSetting() {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (raw === null) return AUTOSAVE_DEFAULT;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : AUTOSAVE_DEFAULT;
  } catch {
    return AUTOSAVE_DEFAULT;
  }
}

function formatAutoSave(ms) {
  if (!ms) return '已关闭';
  if (ms < 60000) return `每 ${ms / 1000} 秒`;
  return `每 ${ms / 60000} 分钟`;
}

function setSaveState(text, className = '') {
  const el = $('save-state');
  el.textContent = text;
  el.className = className;
}

/** 改动只标记为未保存，由定时器统一写入 */
function markDirty() {
  pendingChanges = true;
  changeRevision += 1;
  setSaveState(autoSaveMs > 0 ? '未保存' : '未保存 · 自动保存已关闭', 'pending');
}

function setupAutoSave() {
  clearInterval(autoSaveTimer);
  autoSaveTimer = null;
  if (autoSaveMs > 0) {
    autoSaveTimer = setInterval(() => {
      if (pendingChanges) saveNow();
    }, autoSaveMs);
  }
  const select = $('autosave-interval');
  if (select) select.value = String(autoSaveMs);
}

async function saveNow({ manual = false } = {}) {
  if (saving) {
    if (manual) toast('正在保存，请稍候');
    return;
  }
  if (!pendingChanges && !manual) return;

  saving = true;
  const revision = changeRevision;
  setSaveState('保存中…', 'saving');
  try {
    await api.saveState({ name: currentName, graph: getWorkspaceGraph() });
    if (revision === changeRevision) {
      pendingChanges = false;
      setSaveState('已保存');
    } else {
      setSaveState(autoSaveMs > 0 ? '未保存' : '未保存 · 自动保存已关闭', 'pending');
    }
    updateStats();
    if (manual) toast('已保存');
  } catch (error) {
    setSaveState('保存失败', 'error');
    if (manual) toast(`保存失败：${error.message}`);
  } finally {
    saving = false;
  }
}

/** 页面隐藏 / 关闭时用 keepalive 请求兜底保存 */
function handlePageHidden() {
  if (!pendingChanges || hiddenSaveInFlight) return;
  hiddenSaveInFlight = true;
  const revision = changeRevision;
  const body = JSON.stringify({ name: currentName, graph: getWorkspaceGraph() });
  fetch('/api/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  })
    .then((response) => {
      if (response.ok && revision === changeRevision) pendingChanges = false;
    })
    .catch(() => {})
    .finally(() => {
      hiddenSaveInFlight = false;
    });
}

/* ---------------- 节点面板 ---------------- */

function renderPalette() {
  const defs = getPaletteDefs();
  const categories = ['all', ...new Set(defs.map((def) => def.category))];

  const chips = $('palette-cats');
  chips.replaceChildren();
  for (const category of categories) {
    const button = document.createElement('button');
    button.className = `chip${paletteState.category === category ? ' active' : ''}`;
    button.textContent = category === 'all' ? '全部' : CATEGORY_LABELS[category] || category;
    button.addEventListener('click', () => {
      paletteState.category = category;
      renderPalette();
    });
    chips.append(button);
  }

  const query = paletteState.query.trim().toLowerCase();
  const list = defs.filter((def) => {
    if (paletteState.category !== 'all' && def.category !== paletteState.category) return false;
    if (!query) return true;
    return (
      def.label.toLowerCase().includes(query) ||
      def.name.toLowerCase().includes(query) ||
      (def.description || '').toLowerCase().includes(query)
    );
  });

  const container = $('palette-list');
  container.replaceChildren();
  if (!list.length) {
    container.append(div('empty', '没有匹配的节点'));
    return;
  }

  for (const def of list) {
    const item = document.createElement('button');
    item.className = 'node-item';
    item.type = 'button';

    const dot = document.createElement('span');
    dot.className = 'cat-dot';
    dot.style.background = CATEGORY_COLORS[def.category] || '#4da3ff';

    const meta = document.createElement('span');
    meta.className = 'meta';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = def.label;
    const desc = document.createElement('span');
    desc.className = 'desc';
    desc.textContent = def.description || '';
    meta.append(name, desc);

    const plus = document.createElement('span');
    plus.className = 'plus';
    plus.textContent = '＋';

    item.append(dot, meta, plus);
    item.addEventListener('click', () => {
      const node = editor.addNode(def.name);
      if (node) toast(`已添加 ${def.label}`);
    });
    container.append(item);
  }
}

/* ---------------- 属性检查器 ---------------- */

function openInspector(nodeId, options = {}) {
  editor.selectNode(nodeId);
  renderInspector();
  openSheet('inspector');
  if (options.fullscreen) {
    $('sheet-inspector').classList.add('fullscreen');
    $('inspector-fullscreen').textContent = '退出全屏';
  }
}

function refreshInspector() {
  if (openSheetName === 'inspector') renderInspector();
  else if (!$('node-card').hidden) renderNodeCard();
}

/* ---------------- 节点浮窗编辑卡片 ---------------- */

function hideNodeCard() {
  const card = $('node-card');
  if (card) card.hidden = true;
  nodeCardNodeId = null;
  nodeCardDrag = null;
}

function readNodeCardPosition() {
  try {
    const raw = JSON.parse(localStorage.getItem(NODE_CARD_POS_KEY) || 'null');
    if (raw && Number.isFinite(raw.left) && Number.isFinite(raw.top)) {
      return { left: raw.left, top: raw.top };
    }
  } catch {
    /* ignore */
  }
  return null;
}

function saveNodeCardPosition(position) {
  nodeCardPosition = position;
  try {
    localStorage.setItem(NODE_CARD_POS_KEY, JSON.stringify(position));
  } catch {
    /* ignore */
  }
}

function clampNodeCardPosition(left, top) {
  const card = $('node-card');
  const stageRect = $('stage').getBoundingClientRect();
  const maxLeft = Math.max(8, stageRect.width - card.offsetWidth - 8);
  const maxTop = Math.max(8, stageRect.height - card.offsetHeight - 8);
  return {
    left: Math.max(8, Math.min(left, maxLeft)),
    top: Math.max(8, Math.min(top, maxTop)),
  };
}

function showNodeCard(nodeId) {
  const node = editor.getNode(nodeId);
  if (!node) {
    hideNodeCard();
    return;
  }
  if (openSheetName === 'palette') closeSheet('palette');
  if (openSheetName) return;

  nodeCardNodeId = node.id;
  const card = $('node-card');
  card.hidden = false;
  renderNodeCard();
}

function renderNodeCard() {
  const node = editor.getSelectedNode();
  if (!node) {
    hideNodeCard();
    return;
  }
  const def = getNodeDef(node.name);
  if (!def) {
    hideNodeCard();
    return;
  }

  const suffix =
    (node.name === 'varget' || node.name === 'varset') && node.data?.name
      ? ` · ${node.data.name}`
      : '';
  $('node-card-title').textContent = def.label + suffix;
  $('node-card-dot').style.background = NODE_TYPE_COLORS[def.type] || '#4da3ff';

  const body = $('node-card-body');
  body.replaceChildren();

  if (node.name.startsWith('fncall:')) {
    body.append(buildFunctionCallActions(node));
  }
  if (isClassNodeName(node.name)) {
    const actions = buildClassNodeActions(node);
    if (actions) body.append(actions);
  }
  if (node.name === 'varget' || node.name === 'varset') {
    body.append(buildVariablePicker(node));
  }

  const fields = def.pins.filter(
    (pin) => pin.kind === 'port' && pin.dir === 'in' && pin.editor
  );
  if (!fields.length && node.name !== 'varget' && node.name !== 'varset') {
    body.append(div('empty', '该节点没有可编辑参数，通过端点连线使用。'));
  }
  for (const pin of fields) {
    if (editor.isPinConnected(node.id, pin.name, 'in')) {
      body.append(buildConnectedRow(pin));
    } else {
      body.append(buildField(node, pin));
    }
  }

  if (!canDeleteNode(node, def)) {
    body.append(div('empty', '至少保留一个触发节点。'));
  } else {
    const actions = div('inspector-actions');
    const remove = document.createElement('button');
    remove.className = 'danger-outline';
    remove.textContent = '删除此节点';
    remove.addEventListener('click', () => askDeleteNode(node.id));
    actions.append(remove);
    body.append(actions);
  }

  positionNodeCard(node);
}

function positionNodeCard(node) {
  const card = $('node-card');
  requestAnimationFrame(() => {
    if (!card || card.hidden) return;
    const stage = $('stage');
    const stageRect = stage.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();

    // 用户拖动过浮窗后，后续所有节点都使用记住的位置
    if (nodeCardPosition) {
      const position = clampNodeCardPosition(nodeCardPosition.left, nodeCardPosition.top);
      card.style.left = `${position.left}px`;
      card.style.top = `${position.top}px`;
      return;
    }

    const screen = editor.worldToScreen(node.position.x, node.position.y);
    const layout = getNodeLayout(node);
    const width = (layout?.width || 200) * editor.view.scale;

    let left = screen.x + width + 12;
    let top = screen.y;
    if (left + cardRect.width > stageRect.width - 8) {
      left = screen.x - cardRect.width - 12;
    }
    left = Math.max(8, Math.min(left, stageRect.width - cardRect.width - 8));
    top = Math.max(8, Math.min(top, stageRect.height - cardRect.height - 8));

    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  });
}

function renderInspector() {
  const node = editor.getSelectedNode();
  if (!node) {
    closeSheet('inspector');
    return;
  }
  const def = getNodeDef(node.name);
  if (!def) return;

  $('inspector-title').textContent = def.label;
  $('inspector-sub').textContent = def.description || '';
  const body = $('inspector-body');
  body.replaceChildren();

  const typeRow = document.createElement('div');
  typeRow.className = 'inspector-type';
  const dot = document.createElement('span');
  dot.className = 'cat-dot';
  dot.style.background = NODE_TYPE_COLORS[def.type] || '#4da3ff';
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent =
    def.label +
    ((node.name === 'varget' || node.name === 'varset') && node.data?.name
      ? ` · ${node.data.name}`
      : '');
  const idEl = document.createElement('span');
  idEl.className = 'node-id';
  idEl.textContent = node.id;
  typeRow.append(dot, label, idEl);
  body.append(typeRow);

  if (node.name.startsWith('fncall:')) {
    body.append(buildFunctionCallActions(node));
  }
  if (isClassNodeName(node.name)) {
    const classActions = buildClassNodeActions(node);
    if (classActions) body.append(classActions);
  }

  if (node.name === 'varget' || node.name === 'varset') {
    body.append(buildVariablePicker(node));
  }

  const fields = def.pins.filter(
    (pin) => pin.kind === 'port' && pin.dir === 'in' && pin.editor
  );

  if (!fields.length && node.name !== 'varget' && node.name !== 'varset') {
    body.append(div('empty', '该节点没有可编辑参数，主要通过网络端点连线使用。'));
  }

  for (const pin of fields) {
    if (editor.isPinConnected(node.id, pin.name, 'in')) {
      body.append(buildConnectedRow(pin));
    } else {
      body.append(buildField(node, pin));
    }
  }

  const actions = document.createElement('div');
  actions.className = 'inspector-actions';
  if (!canDeleteNode(node, def)) {
    actions.append(div('empty', '至少保留一个触发节点。'));
  } else {
    const remove = document.createElement('button');
    remove.className = 'danger-outline';
    remove.textContent = '删除此节点';
    remove.addEventListener('click', () => askDeleteNode(node.id));
    actions.append(remove);
  }
  body.append(actions);
}

function canDeleteNode(node, def) {
  if (!def || def.type !== 'begin') return true;
  const triggerCount = editor.graph.nodes.filter(
    (item) => getNodeDef(item.name)?.type === 'begin'
  ).length;
  return triggerCount > 1;
}

function buildFunctionCallActions(node) {
  const fnId = node.name.slice('fncall:'.length);
  const fn = workspace.functions.find((item) => item.id === fnId);

  const wrap = div('fn-quick');
  const info = div('fn-quick-info');
  info.append(
    span('fn-quick-name', fn ? fn.name : '函数不存在'),
    span(
      'var-type',
      fn ? `入 ${(fn.inputs || []).length} · 出 ${(fn.outputs || []).length}` : ''
    )
  );

  const ops = div('fn-ops');
  const enter = makeMiniButton('进入函数', () => {
    if (fn) enterScope(fn.id);
  });
  const settings = makeMiniButton('函数设置', () => {
    if (fn) {
      closeSheet('inspector');
      openSignature(fn.id);
    }
  });
  enter.disabled = !fn;
  settings.disabled = !fn;
  ops.append(enter, settings);

  wrap.append(info, ops);
  return wrap;
}

function buildClassNodeActions(node) {
  const parts = String(node.name).split(':');
  const classId = parts[1];
  const cls = workspace.classes.find((item) => item.id === classId);
  if (!cls) return null;

  const wrap = div('fn-quick');
  const info = div('fn-quick-info');
  info.append(
    span('fn-quick-name', cls.name),
    span(
      'var-type',
      `属性 ${(cls.properties || []).length} · 方法 ${(cls.methods || []).length}`
    )
  );

  const ops = div('fn-ops');
  if (parts[0] === 'clscall' && parts[2]) {
    const method = (cls.methods || []).find((item) => item.id === parts[2]);
    ops.append(
      makeMiniButton('进入方法', () => {
        if (method) enterScope(methodScopeId(cls.id, method.id));
      }),
      makeMiniButton('方法设置', () => {
        if (method) {
          closeSheet('inspector');
          openMethodSignature(cls.id, method.id);
        }
      })
    );
  }
  ops.append(
    makeMiniButton('类设置', () => {
      closeSheet('inspector');
      openClassSettings(cls.id);
    })
  );

  wrap.append(info, ops);
  return wrap;
}

function isClassNodeName(name) {
  return (
    typeof name === 'string' &&
    (name.startsWith('clsnew:') ||
      name.startsWith('clsget:') ||
      name.startsWith('clsset:') ||
      name.startsWith('clscall:') ||
      name.startsWith('clsselfget:') ||
      name.startsWith('clsselfset:'))
  );
}

function buildConnectedRow(pin) {
  const row = document.createElement('div');
  row.className = 'connected-row';
  const text = document.createElement('span');
  text.textContent = '已连接 · 数据由上游节点传入';
  const name = document.createElement('span');
  name.className = 'pin-name';
  name.textContent = pin.name;
  row.append(text, name);
  return row;
}

function buildVariablePicker(node) {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const title = document.createElement('span');
  title.textContent = '绑定变量';
  const select = document.createElement('select');

  const emptyOption = document.createElement('option');
  emptyOption.value = '';
  emptyOption.textContent = editor.graph.variables.length ? '请选择变量…' : '还没有变量';
  select.append(emptyOption);

  for (const variable of editor.graph.variables) {
    const option = document.createElement('option');
    option.value = variable.name;
    option.textContent = `${variable.name}（${variable.type}）`;
    select.append(option);
  }
  select.value = node.data?.name || '';
  select.addEventListener('change', () => {
    editor.updateNodeData(node.id, 'name', select.value);
    refreshInspector();
    refreshSelectionBar();
  });
  wrap.append(title, select);

  if (!editor.graph.variables.length) {
    const button = document.createElement('button');
    button.className = 'text-btn';
    button.textContent = '去创建变量 →';
    button.addEventListener('click', () => {
      closeSheet('inspector');
      openVariables();
    });
    wrap.append(button);
  }
  return wrap;
}

function buildField(node, pin) {
  const wrap = document.createElement('div');
  wrap.className = 'field';

  const title = document.createElement('span');
  title.textContent = pin.label && pin.label !== pin.name ? `${pin.name} · ${pin.label}` : pin.name;
  wrap.append(title);

  const value = node.data?.[pin.name];

  if (pin.editor === 'boolean') {
    const row = document.createElement('div');
    row.className = 'switch-row';
    const text = document.createElement('span');
    text.className = 'text';
    const isOn = value === true || value === 'true';
    text.textContent = isOn ? '开启' : '关闭';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = `switch${isOn ? ' on' : ''}`;
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', String(isOn));
    toggle.addEventListener('click', () => {
      const next = !(node.data?.[pin.name] === true || node.data?.[pin.name] === 'true');
      editor.updateNodeData(node.id, pin.name, next);
      toggle.classList.toggle('on', next);
      toggle.setAttribute('aria-checked', String(next));
      text.textContent = next ? '开启' : '关闭';
    });

    row.append(text, toggle);
    wrap.append(row);
    return wrap;
  }

  if (pin.editor === 'select') {
    const select = document.createElement('select');
    for (const option of pin.options || []) {
      const el = document.createElement('option');
      el.value = option.value;
      el.textContent = option.label;
      select.append(el);
    }
    select.value = String(value ?? pin.options?.[0]?.value ?? '');
    select.addEventListener('change', () => editor.updateNodeData(node.id, pin.name, select.value));
    wrap.append(select);
    return wrap;
  }

  if (pin.editor === 'json' || pin.editor === 'code') {
    const textarea = document.createElement('textarea');
    textarea.value = value ?? '';
    textarea.spellcheck = false;
    textarea.rows = pin.editor === 'code' ? 5 : 3;
    textarea.placeholder = pin.editor === 'json' ? 'JSON，例如 {"a": 1}' : '';
    textarea.addEventListener('input', () =>
      editor.updateNodeData(node.id, pin.name, textarea.value)
    );
    wrap.append(textarea);

    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent =
      pin.editor === 'json'
        ? '支持 JSON；无效 JSON 会按普通文本处理。'
        : '函数体，使用 return 返回结果，参数 ctx 为上游数据。';
    wrap.append(hint);
    return wrap;
  }

  const input = document.createElement('input');
  if (pin.editor === 'number') {
    input.type = 'number';
    input.inputMode = 'decimal';
  } else {
    input.type = 'text';
  }
  input.value = value ?? '';
  input.addEventListener('input', () => editor.updateNodeData(node.id, pin.name, input.value));
  wrap.append(input);
  return wrap;
}

/* ---------------- 删除操作（不再二次确认，可撤销） ---------------- */

function askDeleteNode(nodeId) {
  const node = editor.getNode(nodeId);
  if (!node) return;
  const def = getNodeDef(node.name);
  if (!def) return;
  if (def.type === 'begin') {
    const triggerCount = editor.graph.nodes.filter(
      (item) => getNodeDef(item.name)?.type === 'begin'
    ).length;
    if (triggerCount <= 1) {
      toast('至少保留一个触发节点');
      return;
    }
  }
  if (!editor.deleteNode(nodeId)) {
    toast('无法删除该节点');
    return;
  }
  if (openSheetName === 'inspector') closeSheet('inspector');
  toast('已删除节点，可撤销');
}

function askDeleteConnection(connectionId) {
  if (!editor.graph.connections.some((conn) => conn.id === connectionId)) return;
  editor.removeConnection(connectionId);
  toast('已删除连线，可撤销');
}

/* ---------------- 变量 ---------------- */

function openVariables() {
  renderVariables();
  openSheet('variables');
}

function renderVariables() {
  const container = $('variable-list');
  container.replaceChildren();
  const variables = editor.graph.variables;

  if (!variables.length) {
    container.append(div('empty', '还没有变量。变量可以被多个节点共享读写。'));
  }

  for (const variable of variables) {
    const item = document.createElement('div');
    item.className = 'var-item';

    const name = document.createElement('span');
    name.className = 'var-name';
    name.textContent = variable.name;

    const type = document.createElement('span');
    type.className = 'var-type';
    type.textContent = variable.type;

    const ops = document.createElement('span');
    ops.className = 'var-ops';

    const getButton = document.createElement('button');
    getButton.textContent = '取值';
    getButton.addEventListener('click', () => {
      const node = editor.addNode('varget', { name: variable.name });
      closeSheet('variables');
      if (node) showNodeCard(node.id);
    });

    const setButton = document.createElement('button');
    setButton.textContent = '赋值';
    setButton.addEventListener('click', () => {
      const node = editor.addNode('varset', { name: variable.name });
      closeSheet('variables');
      if (node) showNodeCard(node.id);
    });

    const removeButton = document.createElement('button');
    removeButton.className = 'danger';
    removeButton.textContent = '删除';
    removeButton.addEventListener('click', () => {
      editor.setVariables(variables.filter((item) => item.name !== variable.name));
      renderVariables();
      updateStats();
      toast('已删除变量，可撤销');
    });

    ops.append(getButton, setButton, removeButton);
    item.append(name, type, ops);
    container.append(item);
  }
}

function addVariable() {
  const nameInput = $('var-name');
  const name = nameInput.value.trim();
  const type = $('var-type').value;
  const raw = $('var-value').value.trim();

  if (!isValidIdentifier(name)) {
    toast('变量名需以字母、下划线或 $ 开头');
    return;
  }
  if (editor.graph.variables.some((variable) => variable.name === name)) {
    toast('变量已存在');
    return;
  }

  let value = raw;
  if (type === 'number') {
    const num = Number(raw);
    if (raw !== '' && !Number.isFinite(num)) {
      toast('默认值需为数字');
      return;
    }
    value = raw === '' ? 0 : num;
  } else if (type === 'boolean') {
    value = raw === 'true';
  } else if (type === 'object' || type === 'array') {
    if (raw) {
      try {
        JSON.parse(raw);
      } catch {
        toast('默认值需为合法 JSON');
        return;
      }
    } else {
      value = type === 'array' ? '[]' : '{}';
    }
  }

  editor.setVariables([...editor.graph.variables, { name, type, value }]);
  nameInput.value = '';
  $('var-value').value = '';
  renderVariables();
  updateStats();
  toast(`已添加变量 ${name}`);
}

/* ---------------- 示例 / 菜单 ---------------- */

function renderExamples() {
  const container = $('example-list');
  container.replaceChildren();
  if (!examples.length) {
    container.append(div('empty', '暂无示例'));
    return;
  }
  for (const example of examples) {
    const item = document.createElement('button');
    item.className = 'node-item';
    item.type = 'button';

    const dot = document.createElement('span');
    dot.className = 'cat-dot';
    dot.style.background = '#4da3ff';

    const meta = document.createElement('span');
    meta.className = 'meta';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = example.name;
    const desc = document.createElement('span');
    desc.className = 'desc';
    desc.textContent = example.description || '';
    meta.append(name, desc);

    item.append(dot, meta);
    item.addEventListener('click', () => {
      askConfirm({
        title: `加载「${example.name}」`,
        message: '当前画布会被替换，未导出的内容将丢失。',
        confirmText: '加载',
        onConfirm: () => {
          currentName = example.name;
          $('blueprint-name').value = currentName;
          loadWorkspace(example.graph);
          closeSheet('menu');
          updateStats();
          markDirty();
          toast('已加载示例');
        },
      });
    });
    container.append(item);
  }
}

/* ---------------- 通用名称输入 ---------------- */

function openPrompt({
  title,
  hint = '',
  value = '',
  confirmText = '确定',
  reopen = null,
  onConfirm,
}) {
  promptCallback = onConfirm;
  promptReopen = reopen;
  $('prompt-title').textContent = title;
  $('prompt-hint').textContent = hint;
  $('prompt-input').value = value;
  $('prompt-ok').textContent = confirmText;
  openSheet('prompt');
  setTimeout(() => {
    const input = $('prompt-input');
    input.focus();
    input.select();
  }, 260);
}

async function confirmPrompt() {
  const value = $('prompt-input').value.trim();
  if (!value) {
    toast('请输入名称');
    return;
  }
  const callback = promptCallback;
  const reopen = promptReopen;
  promptCallback = null;
  promptReopen = null;
  closeSheet('prompt');
  try {
    await callback?.(value);
  } catch (error) {
    toast(error.message || '操作失败');
  }
  if (reopen) reopen();
}

/* ---------------- 蓝图库 ---------------- */

function formatBlueprintTime(value) {
  if (!value) return '';
  try {
    return new Date(value).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

async function refreshBlueprintBadge() {
  try {
    const data = await api.listBlueprints();
    const list = data.blueprints || [];
    const badge = $('blueprint-count');
    if (badge) badge.textContent = String(list.length);
    return list;
  } catch {
    return [];
  }
}

function makeMiniButton(label, handler, className = '') {
  const button = document.createElement('button');
  button.textContent = label;
  if (className) button.className = className;
  button.addEventListener('click', handler);
  return button;
}

function renderBlueprintList(items) {
  const container = $('blueprint-list');
  container.replaceChildren();

  if (!items.length) {
    container.append(div('empty', '还没有保存的蓝图。点击上方按钮保存当前蓝图。'));
    return;
  }

  for (const item of items) {
    const card = div('fn-card');
    const head = div('fn-head');
    head.append(
      span('fn-name', item.name),
      span('var-type', formatBlueprintTime(item.updatedAt))
    );

    const meta = div('bp-meta');
    meta.textContent = `${item.nodeCount} 节点 · ${item.functionCount} 函数 · ${item.variableCount} 变量`;

    const ops = div('fn-ops');
    ops.append(
      makeMiniButton('加载', () => loadBlueprintById(item.id)),
      makeMiniButton('覆盖', () => overwriteBlueprint(item)),
      makeMiniButton('重命名', () => renameBlueprint(item)),
      makeMiniButton('删除', () => deleteBlueprintById(item), 'danger')
    );

    card.append(head, meta, ops);
    container.append(card);
  }
}

async function openBlueprints() {
  const items = await refreshBlueprintBadge();
  renderBlueprintList(items);
  openSheet('blueprints');
}

async function loadBlueprintById(id) {
  try {
    const blueprint = await api.getBlueprint(id);
    currentName = blueprint.name;
    $('blueprint-name').value = currentName;
    loadWorkspace(blueprint.graph);
    closeSheet('blueprints');
    markDirty();
    await saveNow();
    await refreshBlueprintBadge();
    toast(`已加载蓝图「${blueprint.name}」`);
  } catch (error) {
    toast(`加载失败：${error.message}`);
  }
}

async function overwriteBlueprint(item) {
  try {
    await api.updateBlueprint(item.id, { name: item.name, graph: getWorkspaceGraph() });
    const items = await refreshBlueprintBadge();
    renderBlueprintList(items);
    toast(`已覆盖「${item.name}」`);
  } catch (error) {
    toast(`覆盖失败：${error.message}`);
  }
}

function renameBlueprint(item) {
  openPrompt({
    title: '重命名蓝图',
    hint: `当前名称：${item.name}`,
    value: item.name,
    reopen: openBlueprints,
    onConfirm: async (name) => {
      await api.updateBlueprint(item.id, { name });
      toast('已重命名');
    },
  });
}

function deleteBlueprintById(item) {
  askConfirm({
    title: '删除蓝图',
    message: `删除蓝图「${item.name}」？此操作不可恢复。`,
    confirmText: '删除',
    onConfirm: async () => {
      try {
        await api.deleteBlueprint(item.id);
        await refreshBlueprintBadge();
        await openBlueprints();
        toast('已删除蓝图');
      } catch (error) {
        toast(`删除失败：${error.message}`);
      }
    },
  });
}

function saveCurrentBlueprint({ reopen = null } = {}) {
  openPrompt({
    title: '保存蓝图',
    hint: '保存当前主图、函数和变量到蓝图库',
    value: currentName,
    reopen,
    onConfirm: async (name) => {
      await api.createBlueprint({ name, graph: getWorkspaceGraph() });
      currentName = name;
      $('blueprint-name').value = name;
      markDirty();
      await saveNow();
      await refreshBlueprintBadge();
      toast(`蓝图「${name}」已保存`);
    },
  });
}

function updateStats() {
  const graph = editor.graph;
  const triggerCount = graph.nodes.filter(
    (node) => getNodeDef(node.name)?.type === 'begin'
  ).length;
  $('stats').textContent = `${graph.nodes.length} 个节点 · ${triggerCount} 个触发 · ${graph.connections.length} 条连线 · ${graph.variables.length} 个变量 · ${workspace.functions.length} 个函数 · ${workspace.classes.length} 个类`;
  $('variable-count').textContent = String(graph.variables.length);
  const functionCount = $('function-count');
  if (functionCount) functionCount.textContent = String(workspace.functions.length);
  const classCount = $('class-count');
  if (classCount) classCount.textContent = String(workspace.classes.length);
}

function exportGraph() {
  const payload = {
    version: 1,
    name: currentName,
    exportedAt: new Date().toISOString(),
    graph: getWorkspaceGraph(),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${currentName || 'blueprint'}.codeck.json`;
  link.click();
  URL.revokeObjectURL(url);
  toast('已导出 JSON');
}

async function importGraphFile(file) {
  const text = await file.text();
  const data = JSON.parse(text);
  const graph =
    data && typeof data === 'object' && data.graph && typeof data.graph === 'object'
      ? data.graph
      : data;

  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.connections)) {
    throw new Error('文件内容不是有效的蓝图 JSON');
  }

  currentName =
    (typeof data.name === 'string' && data.name.trim()) ||
    file.name.replace(/\.json$/i, '') ||
    '导入的蓝图';
  $('blueprint-name').value = currentName;
  loadWorkspace(graph);
  closeSheet('menu');
  markDirty();
  await saveNow();
  toast(`已导入 ${file.name}`);
}

/**
 * 合并模块（外部子图）到当前作用域。
 * - 模块自带触发节点：保留触发，作为独立入口并发运行
 * - 纯数据模块：仅合并节点/连线，由用户继续连线传值
 */
async function applyModule(payload, options = {}) {
  const result = mergeModuleGraph(editor.getGraph(), payload, {
    targetScope: currentScope,
    takenFunctionNames: workspace.functions.map((fn) => fn.name),
    takenClassNames: workspace.classes.map((cls) => cls.name),
  });

  if (result.functions.length > 0) {
    workspace.functions.push(...result.functions);
  }
  if ((result.classes || []).length > 0) {
    workspace.classes.push(...result.classes);
  }
  if (result.functions.length > 0 || (result.classes || []).length > 0) {
    applyDynamicDefs();
    for (const fn of result.functions) syncSignatureNodes(fn);
    for (const cls of result.classes || []) {
      for (const method of cls.methods || []) syncMethodSignatureNodes(cls, method);
    }
  }

  editor.setGraph(result.graph, { fit: options.fit !== false });
  syncCurrentScope();
  refreshSelectionBar();
  refreshMultiToolbar();
  updateStats();
  refreshInspector();
  updateScopeBar();
  markDirty();
  if (options.save !== false) await saveNow();

  const { summary } = result;
  const triggerText = summary.triggers > 0 ? ` · ${summary.triggers} 个独立触发` : '';
  const modeText =
    summary.triggers > 0
      ? '（自带触发，将作为独立入口运行）'
      : summary.hasTrigger
        ? '（函数子图内已移除触发节点）'
        : '（纯数据模块，请连线传值）';
  toast(`已合并模块「${summary.name}」：${summary.nodes} 个节点${triggerText}${modeText}`);
  return summary;
}

async function importModuleFile(file) {
  const text = await file.text();
  await applyModule(JSON.parse(text));
  closeSheet('menu');
}

/* ---------------- 代码 / 运行 ---------------- */

async function showCode() {
  openSheet('code');
  const pre = $('code-body');
  pre.textContent = '编译中…';
  try {
    const result = await api.compile(getWorkspaceGraph());
    lastCode = result.code || '';
    pre.textContent = lastCode || '// 没有生成任何代码';
  } catch (error) {
    lastCode = '';
    pre.textContent = `// 编译失败：${error.message}`;
  }
}

async function runBlueprint() {
  openSheet('output');
  const body = $('output-body');
  body.replaceChildren(loadingEl('正在编译并运行…'));
  $('output-sub').textContent = '在 Node.js 沙箱中执行';

  try {
    const result = await api.run(getWorkspaceGraph(), 8000);
    renderRunResult(result);
  } catch (error) {
    body.replaceChildren();
    $('output-sub').textContent = '执行中断';
    body.append(errorBlock('运行失败', error.message));
    lastOutputText = `[error] ${error.message}`;
  }
}

function renderRunResult(result) {
  const body = $('output-body');
  body.replaceChildren();

  const meta = document.createElement('div');
  meta.className = 'run-meta';
  const status = span(`pill ${result.ok ? 'ok' : 'bad'}`, result.ok ? '执行成功' : '执行出错');
  const duration = span('pill', `${result.durationMs} ms`);
  const count = span('pill', `${result.logs.length} 条输出`);
  meta.append(status, duration, count);
  body.append(meta);

  if (result.logs.length) {
    const list = document.createElement('div');
    result.logs.forEach((log, index) => {
      const row = document.createElement('div');
      row.className = `log-row ${log.level}`;
      const indexEl = span('log-index', String(index + 1).padStart(2, '0'));
      const text = document.createElement('div');
      text.className = 'log-text';
      text.textContent = log.text;
      row.append(indexEl, text);
      list.append(row);
    });
    body.append(list);
  } else {
    body.append(div('empty', '本次运行没有任何日志输出'));
  }

  if (result.error) {
    body.append(errorBlock(result.error.message, result.error.stack));
  }

  $('output-sub').textContent = result.ok ? 'Node.js 沙箱执行完成' : '执行中断';
  lastOutputText =
    result.logs.map((log) => `[${log.level}] ${log.text}`).join('\n') +
    (result.error ? `\n[error] ${result.error.message}` : '');
}

/* ---------------- 复制 ---------------- */

async function copyText(text, successText = '已复制') {
  if (!text) {
    toast('没有可复制的内容');
    return;
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.append(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
    toast(successText);
  } catch {
    toast('复制失败，请长按选择文本');
  }
}

/* ---------------- DOM 小工具 ---------------- */

function div(className, text) {
  const el = document.createElement('div');
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function span(className, text) {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  return el;
}

function loadingEl(text) {
  const el = div('loading');
  const spinner = document.createElement('span');
  spinner.className = 'spinner';
  el.append(spinner, document.createTextNode(text));
  return el;
}

function errorBlock(title, detail) {
  const el = div('run-error');
  el.append(div('title', title));
  if (detail) {
    const pre = document.createElement('pre');
    pre.textContent = detail;
    el.append(pre);
  }
  return el;
}

/* ---------------- 事件绑定 ---------------- */

function bindUI() {
  $('btn-menu').addEventListener('click', () => {
    updateStats();
    renderExamples();
    refreshBlueprintBadge();
    $('blueprint-name').value = currentName;
    openSheet('menu');
  });

  $('btn-add').addEventListener('click', () => {
    renderPalette();
    openSheet('palette');
  });

  $('btn-code').addEventListener('click', showCode);
  $('btn-run').addEventListener('click', runBlueprint);

  $('zoom-in').addEventListener('click', () => editor.zoomBy(1.25));
  $('zoom-out').addEventListener('click', () => editor.zoomBy(0.8));
  $('zoom-fit').addEventListener('click', () => editor.fitView());

  $('btn-undo').addEventListener('click', () => editor.undo());
  $('btn-redo').addEventListener('click', () => editor.redo());
  $('btn-marquee').addEventListener('click', () => editor.setSelectionMode(!editor.selectionMode));

  $('multi-drag').addEventListener('click', () => {
    const next = !editor.multiDrag;
    editor.setMultiDrag(next);
    refreshMultiToolbar();
    toast(next ? '整体拖拽已开启：按住选中节点拖动' : '整体拖拽已关闭');
  });
  $('multi-copy').addEventListener('click', () => {
    const count = editor.getSelectedNodes().length;
    if (editor.copySelection()) {
      toast(`已复制 ${count} 个节点`);
      refreshMultiToolbar();
    }
  });
  $('multi-paste').addEventListener('click', () => {
    if (editor.pasteClipboard()) {
      toast('已粘贴');
      refreshMultiToolbar();
    } else {
      toast('剪贴板为空');
    }
  });
  $('multi-delete').addEventListener('click', () => {
    if (editor.deleteSelection()) toast('已删除，可撤销');
  });
  $('multi-clear').addEventListener('click', () => editor.clearSelection());

  $('selection-wrap').addEventListener('click', startWrap);
  $('multi-wrap').addEventListener('click', startWrap);

  $('scope-back').addEventListener('click', () => goBackScope());
  $('btn-function-settings').addEventListener('click', () => {
    if (currentScope === 'main') return;
    const methodScope = parseMethodScopeId(currentScope);
    if (methodScope) {
      openMethodSignature(methodScope.classId, methodScope.methodId);
      return;
    }
    openSignature(currentScope);
  });
  $('inspector-fullscreen').addEventListener('click', () => {
    const sheet = $('sheet-inspector');
    const next = !sheet.classList.contains('fullscreen');
    sheet.classList.toggle('fullscreen', next);
    $('inspector-fullscreen').textContent = next ? '退出全屏' : '全屏';
  });

  $('node-card-close').addEventListener('click', () => hideNodeCard());
  $('node-card-fullscreen').addEventListener('click', () => {
    const node = editor.getSelectedNode();
    if (node) openInspector(node.id, { fullscreen: true });
  });

  const cardHead = $('node-card-head');
  cardHead.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button')) return;
    const stage = $('stage');
    const card = $('node-card');
    const cardRect = card.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    nodeCardDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: cardRect.left - stageRect.left,
      top: cardRect.top - stageRect.top,
      moved: 0,
    };
    cardHead.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });

  cardHead.addEventListener('pointermove', (event) => {
    if (!nodeCardDrag || nodeCardDrag.pointerId !== event.pointerId) return;
    const stageRect = $('stage').getBoundingClientRect();
    const card = $('node-card');
    nodeCardDrag.moved = Math.max(
      nodeCardDrag.moved,
      Math.hypot(event.clientX - nodeCardDrag.startX, event.clientY - nodeCardDrag.startY)
    );
    const left = Math.max(
      8,
      Math.min(
        nodeCardDrag.left + (event.clientX - nodeCardDrag.startX),
        stageRect.width - card.offsetWidth - 8
      )
    );
    const top = Math.max(
      8,
      Math.min(
        nodeCardDrag.top + (event.clientY - nodeCardDrag.startY),
        stageRect.height - card.offsetHeight - 8
      )
    );
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  });

  const endCardDrag = () => {
    if (nodeCardDrag && nodeCardDrag.moved > 4) {
      const card = $('node-card');
      const position = clampNodeCardPosition(
        Number.parseFloat(card.style.left) || 0,
        Number.parseFloat(card.style.top) || 0
      );
      card.style.left = `${position.left}px`;
      card.style.top = `${position.top}px`;
      saveNodeCardPosition(position);
    }
    nodeCardDrag = null;
  };
  cardHead.addEventListener('pointerup', endCardDrag);
  cardHead.addEventListener('pointercancel', endCardDrag);
  $('open-functions').addEventListener('click', () => {
    closeSheet('menu');
    openFunctions();
  });
  $('open-classes').addEventListener('click', () => {
    closeSheet('menu');
    openClasses();
  });
  $('create-class').addEventListener('click', () => {
    let index = workspace.classes.length + 1;
    let name = `类${index}`;
    while (workspace.classes.some((cls) => cls.name === name)) {
      index += 1;
      name = `类${index}`;
    }
    openPrompt({
      title: '新建类',
      hint: '创建后可添加属性与方法',
      value: name,
      reopen: openClasses,
      onConfirm: (value) => createClass(value),
    });
  });
  $('class-prop-add').addEventListener('click', addClassProperty);
  $('class-settings-save').addEventListener('click', saveClassSettings);
  $('save-blueprint').addEventListener('click', () => saveCurrentBlueprint());
  $('manage-blueprints').addEventListener('click', () => {
    closeSheet('menu');
    openBlueprints();
  });
  $('save-current-blueprint').addEventListener('click', () =>
    saveCurrentBlueprint({ reopen: openBlueprints })
  );
  $('prompt-ok').addEventListener('click', confirmPrompt);
  $('prompt-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      confirmPrompt();
    }
  });
  $('create-function').addEventListener('click', () => {
    closeSheet('functions');
    openFunctionNameSheet('create');
  });
  $('fn-name-ok').addEventListener('click', confirmFunctionName);
  $('signature-add-input').addEventListener('click', () => addSignatureEntry('inputs'));
  $('signature-add-output').addEventListener('click', () => addSignatureEntry('outputs'));
  $('signature-save').addEventListener('click', saveSignature);

  $('palette-height').addEventListener('click', () => {
    paletteCompact = !paletteCompact;
    writeFlag(PALETTE_COMPACT_KEY, paletteCompact);
    applyPaletteLayout();
  });
  $('palette-columns').addEventListener('click', () => {
    paletteTwoCols = !paletteTwoCols;
    writeFlag(PALETTE_COLUMNS_KEY, paletteTwoCols);
    applyPaletteLayout();
  });

  $('scrim').addEventListener('click', () => closeSheet());

  for (const button of document.querySelectorAll('[data-close]')) {
    button.addEventListener('click', () => {
      const sheet = button.closest('.sheet');
      if (sheet) closeSheet(sheet.id.replace('sheet-', ''));
    });
  }

  $('hint-cancel').addEventListener('click', () => editor.cancelPending());

  $('selection-edit').addEventListener('click', () => {
    const node = editor.getSelectedNode();
    if (node) showNodeCard(node.id);
  });
  $('selection-delete').addEventListener('click', () => {
    const node = editor.getSelectedNode();
    if (node) askDeleteNode(node.id);
  });
  $('selection-close').addEventListener('click', () => editor.selectNode(null));

  $('palette-search').addEventListener('input', (event) => {
    paletteState.query = event.target.value;
    renderPalette();
  });

  $('blueprint-name').addEventListener('input', (event) => {
    currentName = event.target.value.trim() || '我的蓝图';
    markDirty();
  });

  $('autosave-interval').addEventListener('change', (event) => {
    autoSaveMs = Number(event.target.value) || 0;
    try {
      localStorage.setItem(AUTOSAVE_KEY, String(autoSaveMs));
    } catch {
      /* 隐私模式可能禁用 localStorage */
    }
    setupAutoSave();
    toast(`自动保存：${formatAutoSave(autoSaveMs)}`);
  });

  $('save-now').addEventListener('click', () => saveNow({ manual: true }));

  window.addEventListener('pagehide', handlePageHidden);
  window.addEventListener('resize', updatePaletteInset);
  window.addEventListener('resize', () => {
    if (!nodeCardPosition) return;
    const card = $('node-card');
    if (!card || card.hidden) return;
    const position = clampNodeCardPosition(nodeCardPosition.left, nodeCardPosition.top);
    card.style.left = `${position.left}px`;
    card.style.top = `${position.top}px`;
  });

  $('open-variables').addEventListener('click', () => {
    closeSheet('menu');
    openVariables();
  });

  $('export-json').addEventListener('click', exportGraph);

  $('import-json').addEventListener('click', () => $('import-json-file').click());

  $('import-json-file').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      await importGraphFile(file);
    } catch (error) {
      toast(`导入失败：${error.message}`);
    }
  });

  $('import-module').addEventListener('click', () => $('import-module-file').click());

  $('import-module-file').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      await importModuleFile(file);
    } catch (error) {
      toast(`模块导入失败：${error.message}`);
    }
  });

  $('clear-graph').addEventListener('click', () => {
    askConfirm({
      title: '清空画布',
      message: '将删除所有节点、连线与变量，仅保留开始节点。',
      confirmText: '清空',
      onConfirm: () => {
        editor.setGraph({ nodes: [], connections: [], variables: [] });
        closeSheet('menu');
        updateStats();
        markDirty();
        toast('画布已清空');
      },
    });
  });

  $('var-add').addEventListener('click', addVariable);

  $('copy-code').addEventListener('click', () => copyText(lastCode));
  $('copy-output').addEventListener('click', () => copyText(lastOutputText));

  $('confirm-ok').addEventListener('click', () => {
    const callback = confirmCallback;
    confirmCallback = null;
    closeSheet('confirm');
    callback?.();
  });

  $('var-type').addEventListener('change', (event) => {
    const type = event.target.value;
    $('var-value').placeholder =
      type === 'object' || type === 'array'
        ? '默认值（JSON，例如 {"a":1}）'
        : type === 'boolean'
          ? '默认值 true / false'
          : '默认值';
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (openSheetName) closeSheet();
      else if (editor.selectionMode) editor.setSelectionMode(false);
      else editor.cancelPending();
      return;
    }

    const target = event.target;
    if (openSheetName) return;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

    const meta = event.ctrlKey || event.metaKey;
    if (meta && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) editor.redo();
      else editor.undo();
      return;
    }
    if (meta && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      editor.redo();
      return;
    }
    if (meta && event.key.toLowerCase() === 'c') {
      const count = editor.getSelectedNodes().length;
      if (editor.copySelection()) {
        toast(`已复制 ${count} 个节点`);
        refreshMultiToolbar();
      }
      return;
    }
    if (meta && event.key.toLowerCase() === 'v') {
      if (editor.pasteClipboard()) {
        toast('已粘贴');
        refreshMultiToolbar();
      } else {
        toast('剪贴板为空');
      }
      return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && editor.selectedIds.size > 0) {
      event.preventDefault();
      if (editor.deleteSelection()) toast('已删除，可撤销');
    }
  });
}

boot();
