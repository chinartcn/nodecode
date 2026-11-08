import {
  CATEGORY_COLORS,
  CATEGORY_LABELS,
  NODE_TYPE_COLORS,
  getNodeDef,
  getVisibleNodeDefs,
  isValidIdentifier,
} from '/shared/node-defs.js';
import { BlueprintEditor } from './editor.js';
import { api } from './api.js';

const $ = (id) => document.getElementById(id);
const canvas = $('canvas');

const editor = new BlueprintEditor(canvas, {
  onChange: markDirty,
  onSelect: refreshSelectionBar,
  onStructure: () => {
    refreshSelectionBar();
    updateStats();
    refreshInspector();
  },
  onConnectionTap: (connectionId) => askDeleteConnection(connectionId),
  onHint: handleHint,
  onHidden: handlePageHidden,
});

const AUTOSAVE_KEY = 'codeck.autosaveMs';
const AUTOSAVE_DEFAULT = 30000;

let currentName = '我的蓝图';
let examples = [];
let openSheetName = null;
let confirmCallback = null;
let toastTimer = null;
let hintTimer = null;
let lastOutputText = '';
let lastCode = '';
let paletteState = { category: 'all', query: '' };

let autoSaveMs = readAutoSaveSetting();
let autoSaveTimer = null;
let pendingChanges = false;
let changeRevision = 0;
let saving = false;
let hiddenSaveInFlight = false;

/* ---------------- 启动 ---------------- */

async function boot() {
  bindUI();
  setupAutoSave();
  renderPalette();

  try {
    const [state, exampleList] = await Promise.all([api.getState(), api.getExamples()]);
    examples = Array.isArray(exampleList) ? exampleList : [];
    currentName = state.name || '我的蓝图';
    $('blueprint-name').value = currentName;
    editor.setGraph(state.graph);
    renderExamples();
  } catch (error) {
    toast(`加载失败：${error.message}`);
  }

  updateStats();
  requestAnimationFrame(() => editor.fitView());
  setTimeout(() => $('tip').classList.add('hide'), 5200);
}

/* ---------------- 面板管理 ---------------- */

function openSheet(name) {
  if (openSheetName && openSheetName !== name) closeSheet(openSheetName, true);
  const sheet = $(`sheet-${name}`);
  if (!sheet) return;
  sheet.classList.add('open');
  sheet.setAttribute('aria-hidden', 'false');
  $('scrim').classList.add('show');
  $('selection-bar').hidden = true;
  openSheetName = name;
}

function closeSheet(name = openSheetName, keepScrim = false) {
  if (!name) return;
  const sheet = $(`sheet-${name}`);
  sheet?.classList.remove('open');
  sheet?.setAttribute('aria-hidden', 'true');
  if (name === openSheetName) openSheetName = null;
  if (!keepScrim) $('scrim').classList.remove('show');
  refreshSelectionBar();
}

function refreshSelectionBar() {
  const bar = $('selection-bar');
  const node = editor.getSelectedNode();
  if (!node || openSheetName) {
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
  $('selection-delete').style.display = def.type === 'begin' ? 'none' : '';
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
    await api.saveState({ name: currentName, graph: editor.getGraph() });
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
  const body = JSON.stringify({ name: currentName, graph: editor.getGraph() });
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
  const defs = getVisibleNodeDefs();
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
      closeSheet('palette');
      if (node) openInspector(node.id);
    });
    container.append(item);
  }
}

/* ---------------- 属性检查器 ---------------- */

function openInspector(nodeId) {
  editor.selectNode(nodeId);
  renderInspector();
  openSheet('inspector');
}

function refreshInspector() {
  if (openSheetName === 'inspector') renderInspector();
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
  if (def.type === 'begin') {
    actions.append(div('empty', '开始节点是蓝图入口，不能删除。'));
  } else {
    const remove = document.createElement('button');
    remove.className = 'danger-outline';
    remove.textContent = '删除此节点';
    remove.addEventListener('click', () => askDeleteNode(node.id));
    actions.append(remove);
  }
  body.append(actions);
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
    renderInspector();
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

/* ---------------- 删除操作 ---------------- */

function askDeleteNode(nodeId) {
  const node = editor.getNode(nodeId);
  if (!node) return;
  const def = getNodeDef(node.name);
  if (!def || def.type === 'begin') {
    toast('开始节点不能删除');
    return;
  }
  askConfirm({
    title: '删除节点',
    message: `删除「${def.label}」及其所有连线？此操作不可撤销。`,
    confirmText: '删除',
    onConfirm: () => {
      editor.deleteNode(nodeId);
      if (openSheetName === 'inspector') closeSheet('inspector');
      toast('已删除节点');
    },
  });
}

function askDeleteConnection(connectionId) {
  if (!editor.graph.connections.some((conn) => conn.id === connectionId)) return;
  askConfirm({
    title: '删除连线',
    message: '这条连线将被移除，相关节点会恢复为未连接状态。',
    confirmText: '删除',
    onConfirm: () => {
      editor.removeConnection(connectionId);
      toast('已删除连线');
    },
  });
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
      if (node) openInspector(node.id);
    });

    const setButton = document.createElement('button');
    setButton.textContent = '赋值';
    setButton.addEventListener('click', () => {
      const node = editor.addNode('varset', { name: variable.name });
      closeSheet('variables');
      if (node) openInspector(node.id);
    });

    const removeButton = document.createElement('button');
    removeButton.className = 'danger';
    removeButton.textContent = '删除';
    removeButton.addEventListener('click', () => {
      askConfirm({
        title: '删除变量',
        message: `删除变量「${variable.name}」？引用它的节点将无法编译。`,
        confirmText: '删除',
        onConfirm: () => {
          editor.setVariables(variables.filter((item) => item.name !== variable.name));
          renderVariables();
          updateStats();
          toast('已删除变量');
        },
      });
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
          editor.setGraph(example.graph);
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

function updateStats() {
  const graph = editor.graph;
  $('stats').textContent = `${graph.nodes.length} 个节点 · ${graph.connections.length} 条连线 · ${graph.variables.length} 个变量`;
  $('variable-count').textContent = String(graph.variables.length);
}

function exportGraph() {
  const payload = { name: currentName, graph: editor.getGraph() };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${currentName || 'blueprint'}.codeck.json`;
  link.click();
  URL.revokeObjectURL(url);
  toast('已导出 JSON');
}

/* ---------------- 代码 / 运行 ---------------- */

async function showCode() {
  openSheet('code');
  const pre = $('code-body');
  pre.textContent = '编译中…';
  try {
    const result = await api.compile(editor.getGraph());
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
    const result = await api.run(editor.getGraph(), 8000);
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
    if (node) openInspector(node.id);
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

  $('open-variables').addEventListener('click', () => {
    closeSheet('menu');
    openVariables();
  });

  $('export-json').addEventListener('click', exportGraph);

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
      else editor.cancelPending();
    }
  });
}

boot();
