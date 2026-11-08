/**
 * 移动端优先的蓝图画布编辑器。
 * Canvas 2D 渲染 + Pointer Events：
 * - 单指拖空白平移，拖节点移动
 * - 双指捏合缩放
 * - 点击端点开始连接，再点另一端完成（也可拖拽）
 */

import {
  NODE_HEADER_HEIGHT,
  NODE_TYPE_COLORS,
  getNodeDef,
} from '/shared/node-defs.js';
import {
  buildConnection,
  generateId,
  getNodeLayout,
  getPinAbs,
  isPinConnected,
  normalizeGraph,
} from '/shared/graph-utils.js';

const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif';
const MIN_SCALE = 0.3;
const MAX_SCALE = 2.4;
const PIN_HIT_RADIUS = 22;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function shadeColor(hex, amount) {
  const value = hex.replace('#', '');
  const num = parseInt(value.length === 3 ? value.split('').map((c) => c + c).join('') : value, 16);
  const r = clamp((num >> 16) + amount, 0, 255);
  const g = clamp(((num >> 8) & 0xff) + amount, 0, 255);
  const b = clamp((num & 0xff) + amount, 0, 255);
  return `rgb(${r}, ${g}, ${b})`;
}

export class BlueprintEditor {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    // alpha:false 减少合成开销；不使用 desynchronized，避免移动端重绘时文字闪烁/消失
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.options = options;

    this.graph = normalizeGraph({ nodes: [], connections: [], variables: [] });
    this.view = { x: 40, y: 60, scale: 1 };
    this.size = { w: 1, h: 1 };
    this.dpr = 1;
    this._rect = { left: 0, top: 0 };

    this.selectedId = null;
    this.pending = null;
    this.pointers = new Map();
    this.down = null;
    this.pinch = null;
    this.pointerWorld = null;
    this.dirty = true;
    this._addCount = 0;
    // 底部被悬浮面板遮挡的高度，用于把新节点放在可见区域中央
    this.bottomInset = 0;
    this._raf = null;

    // 性能相关缓存
    this._textCache = new Map();
    this._gridPattern = null;
    this._gridStep = 0;
    this._connectedPins = new Set();
    this._connIndexDirty = true;

    this._bindEvents();
    this._resize();
    this._loop();
  }

  /* ---------------- 对外方法 ---------------- */

  setGraph(graph, options = {}) {
    this.graph = normalizeGraph(graph);
    this.selectedId = null;
    this.pending = null;
    this.down = null;
    this.pointers.clear();
    this._connIndexDirty = true;
    this.dirty = true;
    this.options.onHint?.(null);
    if (options.fit !== false) this.fitView();
    this.options.onSelect?.(null);
  }

  getGraph() {
    return JSON.parse(JSON.stringify(this.graph));
  }

  getSelectedNode() {
    return this.graph.nodes.find((node) => node.id === this.selectedId) || null;
  }

  getNode(nodeId) {
    return this.graph.nodes.find((node) => node.id === nodeId) || null;
  }

  selectNode(nodeId) {
    this.selectedId = nodeId;
    this.dirty = true;
    this.options.onSelect?.(this.getSelectedNode());
  }

  isPinConnected(nodeId, pinName, dir) {
    return isPinConnected(this.graph, nodeId, pinName, dir);
  }

  notifyChange() {
    this.options.onChange?.();
  }

  setVariables(variables) {
    this.graph.variables = Array.isArray(variables) ? variables : [];
    this.dirty = true;
    this.notifyChange();
    this.options.onStructure?.();
  }

  setBottomInset(px) {
    this.bottomInset = Math.max(0, Number(px) || 0);
  }

  addNode(name, extraData = {}) {
    const def = getNodeDef(name);
    if (!def) return null;
    const layout = getNodeLayout({ name });
    const height = layout ? layout.height : 120;
    // 在未被底部悬浮面板遮挡的区域中央添加节点
    const usableHeight = Math.max(160, this.size.h - this.bottomInset);
    const center = this.screenToWorld(this.size.w / 2, usableHeight / 2);
    const offset = (this._addCount % 6) * 26;
    this._addCount += 1;
    const node = {
      id: generateId('n'),
      name,
      position: {
        x: Math.round(center.x - def.width / 2 + offset),
        y: Math.round(center.y - height / 2 + offset),
      },
      data: { ...(def.defaults || {}), ...extraData },
    };
    this.graph.nodes.push(node);
    this.selectedId = node.id;
    this.dirty = true;
    this.notifyChange();
    this.options.onStructure?.();
    this.options.onSelect?.(node);
    return node;
  }

  deleteNode(nodeId) {
    const node = this.getNode(nodeId);
    if (!node) return false;
    if (getNodeDef(node.name)?.type === 'begin') return false;
    this.graph.nodes = this.graph.nodes.filter((item) => item.id !== nodeId);
    this.graph.connections = this.graph.connections.filter(
      (conn) => conn.fromNodeId !== nodeId && conn.toNodeId !== nodeId
    );
    if (this.selectedId === nodeId) this.selectedId = null;
    this._connIndexDirty = true;
    this.dirty = true;
    this.notifyChange();
    this.options.onStructure?.();
    this.options.onSelect?.(null);
    return true;
  }

  updateNodeData(nodeId, key, value) {
    const node = this.getNode(nodeId);
    if (!node) return;
    node.data = { ...(node.data || {}), [key]: value };
    this.dirty = true;
    this.notifyChange();
  }

  connect(from, to) {
    const result = buildConnection(this.graph, from, to);
    if (result.error) return { error: result.error };
    this.graph.connections = result.connections;
    this._connIndexDirty = true;
    this.dirty = true;
    this.notifyChange();
    this.options.onStructure?.();
    return { ok: true, connection: result.connection };
  }

  removeConnection(connectionId) {
    this.graph.connections = this.graph.connections.filter((conn) => conn.id !== connectionId);
    this._connIndexDirty = true;
    this.dirty = true;
    this.notifyChange();
    this.options.onStructure?.();
  }

  cancelPending() {
    this.pending = null;
    this.dirty = true;
    this.options.onHint?.(null);
  }

  fitView() {
    const nodes = this.graph.nodes;
    if (!nodes.length) {
      this.view = { x: 40, y: 60, scale: 1 };
      this.dirty = true;
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of nodes) {
      const layout = getNodeLayout(node);
      if (!layout) continue;
      minX = Math.min(minX, node.position.x);
      minY = Math.min(minY, node.position.y);
      maxX = Math.max(maxX, node.position.x + layout.width);
      maxY = Math.max(maxY, node.position.y + layout.height);
    }
    if (!Number.isFinite(minX)) return;
    const padX = 56;
    const padY = 90;
    const width = Math.max(1, maxX - minX);
    const height = Math.max(1, maxY - minY);
    const scale = clamp(
      Math.min((this.size.w - padX * 2) / width, (this.size.h - padY * 2) / height),
      MIN_SCALE,
      1.1
    );
    this.view.scale = scale;
    this.view.x = this.size.w / 2 - ((minX + maxX) / 2) * scale;
    this.view.y = this.size.h / 2 - ((minY + maxY) / 2) * scale;
    this.dirty = true;
  }

  zoomBy(factor) {
    this._zoomAt({ x: this.size.w / 2, y: this.size.h / 2 }, factor);
  }

  screenToWorld(x, y) {
    return {
      x: (x - this.view.x) / this.view.scale,
      y: (y - this.view.y) / this.view.scale,
    };
  }

  worldToScreen(x, y) {
    return {
      x: x * this.view.scale + this.view.x,
      y: y * this.view.scale + this.view.y,
    };
  }

  /* ---------------- 内部：事件 ---------------- */

  _bindEvents() {
    this.canvas.addEventListener('pointerdown', (event) => this._onPointerDown(event));
    this.canvas.addEventListener('pointermove', (event) => this._onPointerMove(event));
    this.canvas.addEventListener('pointerup', (event) => this._onPointerUp(event));
    this.canvas.addEventListener('pointercancel', (event) => this._onPointerCancel(event));
    this.canvas.addEventListener('wheel', (event) => this._onWheel(event), { passive: false });
    this.canvas.addEventListener('contextmenu', (event) => event.preventDefault());

    this._onResize = () => this._resize();
    window.addEventListener('resize', this._onResize);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', this._onResize);
    }

    window.addEventListener('keydown', (event) => {
      if (event.key === 'Delete' && this.selectedId) {
        const node = this.getNode(this.selectedId);
        if (node && getNodeDef(node.name)?.type !== 'begin') {
          this.deleteNode(this.selectedId);
        }
      }
    });

    // 后台挂起后 canvas 缓冲区可能被浏览器丢弃，回到前台必须强制重绘
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        this._resumeFromBackground();
      } else {
        this.options.onHidden?.();
      }
    });
    window.addEventListener('pageshow', () => this._resumeFromBackground());
    this.canvas.addEventListener('contextlost', (event) => {
      event.preventDefault();
      this._gridPattern = null;
    });
    this.canvas.addEventListener('contextrestored', () => {
      this._gridPattern = null;
      this._textCache.clear();
      this.dirty = true;
    });
  }

  _resumeFromBackground() {
    // 尺寸重设会清空 canvas，同时重建网格图案，确保恢复后不会黑屏
    this._resize();
    this.dirty = true;
    // 部分浏览器在 visibilitychange 之后才丢弃缓冲区，补一次延迟重绘
    setTimeout(() => {
      this.dirty = true;
    }, 220);
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.size = { w: rect.width, h: rect.height };
    // canvas 相对视口的位置固定，缓存后避免每次 pointermove 触发重排
    this._rect = { left: rect.left, top: rect.top };
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);
    this._gridPattern = null;
    this.dirty = true;
  }

  _screen(event) {
    return { x: event.clientX - this._rect.left, y: event.clientY - this._rect.top };
  }

  _onPointerDown(event) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    try {
      this.canvas.setPointerCapture(event.pointerId);
    } catch {
      /* 某些浏览器不支持 */
    }
    const point = this._screen(event);
    this.pointers.set(event.pointerId, point);

    if (this.pointers.size === 2) {
      this.down = null;
      this._startPinch();
      return;
    }
    if (this.pointers.size > 2) return;

    const hit = this._hitTest(point.x, point.y);

    if (this.pending) {
      if (hit.type === 'pin') {
        this._completePending(hit);
        this.down = null;
        return;
      }
      this.cancelPending();
    }

    if (hit.type === 'pin') {
      this._beginPending(hit);
      this.down = { pointerId: event.pointerId, mode: 'pin', start: point, last: point, moved: 0 };
    } else if (hit.type === 'node') {
      // 置顶
      const index = this.graph.nodes.findIndex((node) => node.id === hit.nodeId);
      if (index >= 0) {
        const [node] = this.graph.nodes.splice(index, 1);
        this.graph.nodes.push(node);
      }
      this.selectNode(hit.nodeId);
      this.down = {
        pointerId: event.pointerId,
        mode: 'node',
        nodeId: hit.nodeId,
        start: point,
        last: point,
        moved: 0,
      };
    } else if (hit.type === 'connection') {
      this.down = {
        pointerId: event.pointerId,
        mode: 'connection',
        connectionId: hit.connectionId,
        start: point,
        last: point,
        moved: 0,
      };
    } else {
      this.down = {
        pointerId: event.pointerId,
        mode: 'pan',
        start: point,
        last: point,
        moved: 0,
      };
    }
    this.dirty = true;
  }

  _onPointerMove(event) {
    if (!this.pointers.has(event.pointerId)) return;
    event.preventDefault();
    const point = this._screen(event);
    this.pointers.set(event.pointerId, point);
    this.pointerWorld = this.screenToWorld(point.x, point.y);

    if (this.pinch && this.pointers.size >= 2) {
      this._movePinch();
      return;
    }

    const drag = this.down;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const dx = point.x - drag.last.x;
    const dy = point.y - drag.last.y;
    drag.moved += Math.hypot(dx, dy);
    drag.last = point;

    if (drag.mode === 'pan') {
      this.view.x += dx;
      this.view.y += dy;
    } else if (drag.mode === 'node') {
      const node = this.getNode(drag.nodeId);
      if (node) {
        node.position.x += dx / this.view.scale;
        node.position.y += dy / this.view.scale;
      }
    } else if (drag.mode === 'pin' && this.pending) {
      this.pending.pointer = { ...this.pointerWorld };
    }
    this.dirty = true;
  }

  _onPointerUp(event) {
    this.pointers.delete(event.pointerId);

    if (this.pinch) {
      if (this.pointers.size < 2) {
        this.pinch = null;
        this.down = null;
      }
      return;
    }

    const drag = this.down;
    if (!drag || drag.pointerId !== event.pointerId) return;
    this.down = null;

    const point = this._screen(event);
    const isTap = drag.moved < 8;

    if (drag.mode === 'pin') {
      const hit = this._hitTest(point.x, point.y);
      if (!isTap && hit.type === 'pin') {
        this._completePending(hit);
      } else if (isTap) {
        // 保留待连接状态，等待点击另一端
        if (this.pending) this.pending.pointer = null;
        this._emitHint();
      } else {
        this.cancelPending();
      }
    } else if (drag.mode === 'node') {
      if (!isTap) this.notifyChange();
    } else if (drag.mode === 'connection') {
      if (isTap) this.options.onConnectionTap?.(drag.connectionId);
    } else if (drag.mode === 'pan') {
      if (isTap) {
        this.cancelPending();
        this.selectNode(null);
      }
    }
    this.dirty = true;
  }

  _onPointerCancel(event) {
    this.pointers.delete(event.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (this.down && this.down.pointerId === event.pointerId) this.down = null;
    this.dirty = true;
  }

  _onWheel(event) {
    event.preventDefault();
    const point = this._screen(event);
    const factor = Math.exp(-event.deltaY * 0.0015);
    this._zoomAt(point, factor);
  }

  _zoomAt(point, factor) {
    const world = this.screenToWorld(point.x, point.y);
    const scale = clamp(this.view.scale * factor, MIN_SCALE, MAX_SCALE);
    this.view.scale = scale;
    this.view.x = point.x - world.x * scale;
    this.view.y = point.y - world.y * scale;
    this.dirty = true;
  }

  _startPinch() {
    const points = [...this.pointers.values()];
    if (points.length < 2) return;
    const mid = {
      x: (points[0].x + points[1].x) / 2,
      y: (points[0].y + points[1].y) / 2,
    };
    this.pinch = {
      startDistance: Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) || 1,
      startScale: this.view.scale,
      worldMid: this.screenToWorld(mid.x, mid.y),
    };
    this.cancelPending();
  }

  _movePinch() {
    const points = [...this.pointers.values()];
    if (points.length < 2 || !this.pinch) return;
    const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) || 1;
    const mid = {
      x: (points[0].x + points[1].x) / 2,
      y: (points[0].y + points[1].y) / 2,
    };
    const scale = clamp(
      this.pinch.startScale * (distance / this.pinch.startDistance),
      MIN_SCALE,
      MAX_SCALE
    );
    this.view.scale = scale;
    this.view.x = mid.x - this.pinch.worldMid.x * scale;
    this.view.y = mid.y - this.pinch.worldMid.y * scale;
    this.dirty = true;
  }

  /* ---------------- 内部：连接 ---------------- */

  _beginPending(pin) {
    this.pending = {
      nodeId: pin.nodeId,
      pinName: pin.pinName,
      dir: pin.dir,
      kind: pin.kind,
      pointer: null,
    };
    this._emitHint();
    this.dirty = true;
  }

  _emitHint() {
    if (!this.pending) {
      this.options.onHint?.(null);
      return;
    }
    const kindText = this.pending.kind === 'exec' ? '执行端点' : '数据端点';
    this.options.onHint?.(`点击另一端的${kindText}完成连接`, 'info');
  }

  _completePending(target) {
    const pending = this.pending;
    if (!pending) return;
    if (pending.dir === target.dir) {
      this.pending = null;
      this.dirty = true;
      this.options.onHint?.('两端方向相同，无法连接', 'error');
      return;
    }
    const from =
      pending.dir === 'out'
        ? { nodeId: pending.nodeId, pinName: pending.pinName }
        : { nodeId: target.nodeId, pinName: target.pinName };
    const to =
      pending.dir === 'out'
        ? { nodeId: target.nodeId, pinName: target.pinName }
        : { nodeId: pending.nodeId, pinName: pending.pinName };

    const result = this.connect(from, to);
    this.pending = null;
    this.dirty = true;
    if (result.error) this.options.onHint?.(result.error, 'error');
    else this.options.onHint?.(null);
  }

  /* ---------------- 内部：命中检测 ---------------- */

  _hitTest(screenX, screenY) {
    const nodes = this.graph.nodes;
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const node = nodes[index];
      const layout = getNodeLayout(node);
      if (!layout) continue;

      let closest = null;
      let closestDistance = Infinity;
      for (const pin of layout.pins) {
        const screen = this.worldToScreen(node.position.x + pin.x, node.position.y + pin.y);
        const distance = Math.hypot(screen.x - screenX, screen.y - screenY);
        if (distance <= PIN_HIT_RADIUS && distance < closestDistance) {
          closestDistance = distance;
          closest = pin;
        }
      }
      if (closest) {
        return {
          type: 'pin',
          nodeId: node.id,
          pinName: closest.name,
          dir: closest.dir,
          kind: closest.kind,
        };
      }

      const point = this.screenToWorld(screenX, screenY);
      if (
        point.x >= node.position.x &&
        point.x <= node.position.x + layout.width &&
        point.y >= node.position.y &&
        point.y <= node.position.y + layout.height
      ) {
        return { type: 'node', nodeId: node.id };
      }
    }

    // 连线命中
    for (const conn of this.graph.connections) {
      const fromNode = this.getNode(conn.fromNodeId);
      const toNode = this.getNode(conn.toNodeId);
      if (!fromNode || !toNode) continue;
      const from = getPinAbs(fromNode, 'out', conn.fromNodePinName);
      const to = getPinAbs(toNode, 'in', conn.toNodePinName);
      if (!from || !to) continue;
      if (this._distanceToCurve(screenX, screenY, from, to) * this.view.scale <= 16) {
        return { type: 'connection', connectionId: conn.id };
      }
    }

    return { type: 'empty' };
  }

  _distanceToCurve(screenX, screenY, from, to) {
    const fromScreen = this.worldToScreen(from.x, from.y);
    const toScreen = this.worldToScreen(to.x, to.y);
    const control = Math.max(40, Math.abs(toScreen.x - fromScreen.x) * 0.5);
    let minDistance = Infinity;
    let previous = fromScreen;
    for (let i = 1; i <= 24; i += 1) {
      const t = i / 24;
      const point = this._bezierPoint(
        fromScreen,
        { x: fromScreen.x + control, y: fromScreen.y },
        { x: toScreen.x - control, y: toScreen.y },
        toScreen,
        t
      );
      minDistance = Math.min(minDistance, this._distanceToSegment(screenX, screenY, previous, point));
      previous = point;
    }
    return minDistance / this.view.scale;
  }

  _bezierPoint(p0, p1, p2, p3, t) {
    const mt = 1 - t;
    return {
      x: mt * mt * mt * p0.x + 3 * mt * mt * t * p1.x + 3 * mt * t * t * p2.x + t * t * t * p3.x,
      y: mt * mt * mt * p0.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t * t * t * p3.y,
    };
  }

  _distanceToSegment(px, py, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;
    if (lengthSq === 0) return Math.hypot(px - a.x, py - a.y);
    let t = ((px - a.x) * dx + (py - a.y) * dy) / lengthSq;
    t = clamp(t, 0, 1);
    return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
  }

  /* ---------------- 内部：渲染 ---------------- */

  _loop() {
    if (this.pending) this.dirty = true;
    if (this.dirty) {
      this.dirty = false;
      this._draw();
    }
    this._raf = requestAnimationFrame(() => this._loop());
  }

  _draw() {
    const ctx = this.ctx;
    const dpr = this.dpr;

    if (this._connIndexDirty) this._rebuildConnectionIndex();

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0c1117';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    this._drawGrid(ctx);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.save();
    ctx.translate(this.view.x, this.view.y);
    ctx.scale(this.view.scale, this.view.scale);

    this._drawConnections(ctx);
    this._drawPending(ctx);

    const visible = this._visibleWorldRect();
    for (const node of this.graph.nodes) {
      const layout = getNodeLayout(node);
      if (!layout) continue;
      if (
        node.position.x + layout.width < visible.x ||
        node.position.x > visible.x + visible.w ||
        node.position.y + layout.height < visible.y ||
        node.position.y > visible.y + visible.h
      ) {
        continue;
      }
      this._drawNode(ctx, node, layout);
    }

    ctx.restore();
  }

  _rebuildConnectionIndex() {
    const set = this._connectedPins;
    set.clear();
    for (const conn of this.graph.connections) {
      set.add(`${conn.fromNodeId}|out|${conn.fromNodePinName}`);
      set.add(`${conn.toNodeId}|in|${conn.toNodePinName}`);
    }
    this._connIndexDirty = false;
  }

  _isPinConnected(nodeId, pinName, dir) {
    return this._connectedPins.has(`${nodeId}|${dir}|${pinName}`);
  }

  _visibleWorldRect() {
    return {
      x: -this.view.x / this.view.scale,
      y: -this.view.y / this.view.scale,
      w: this.size.w / this.view.scale,
      h: this.size.h / this.view.scale,
    };
  }

  /** 使用离屏图案一次性绘制网格，避免每帧上千次 fillRect */
  _drawGrid(ctx) {
    const step = Math.max(8, Math.round(26 * this.view.scale * this.dpr));
    if (!this._gridPattern || this._gridStep !== step) {
      const tile = document.createElement('canvas');
      tile.width = step;
      tile.height = step;
      const tileCtx = tile.getContext('2d');
      tileCtx.fillStyle = 'rgba(148, 170, 196, 0.16)';
      tileCtx.beginPath();
      tileCtx.arc(step / 2, step / 2, Math.max(1, this.dpr * 0.7), 0, Math.PI * 2);
      tileCtx.fill();
      this._gridPattern = ctx.createPattern(tile, 'repeat');
      this._gridStep = step;
    }

    const offsetX = (((this.view.x * this.dpr) % step) + step) % step;
    const offsetY = (((this.view.y * this.dpr) % step) + step) % step;

    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.fillStyle = this._gridPattern;
    ctx.fillRect(-step, -step, this.canvas.width + step * 2, this.canvas.height + step * 2);
    ctx.restore();
  }

  _drawConnections(ctx) {
    ctx.lineCap = 'round';
    for (const conn of this.graph.connections) {
      const fromNode = this.getNode(conn.fromNodeId);
      const toNode = this.getNode(conn.toNodeId);
      if (!fromNode || !toNode) continue;
      const fromLayout = getNodeLayout(fromNode);
      const toLayout = getNodeLayout(toNode);
      if (!fromLayout || !toLayout) continue;
      const fromPin = fromLayout.pinMap.get(`out:${conn.fromNodePinName}`);
      const toPin = toLayout.pinMap.get(`in:${conn.toNodePinName}`);
      if (!fromPin || !toPin) continue;

      const fromX = fromNode.position.x + fromPin.x;
      const fromY = fromNode.position.y + fromPin.y;
      const toX = toNode.position.x + toPin.x;
      const toY = toNode.position.y + toPin.y;

      const isExec = fromPin.kind === 'exec';
      const active =
        this.selectedId &&
        (conn.fromNodeId === this.selectedId || conn.toNodeId === this.selectedId);

      ctx.beginPath();
      const control = Math.max(40, Math.abs(toX - fromX) * 0.5);
      ctx.moveTo(fromX, fromY);
      ctx.bezierCurveTo(fromX + control, fromY, toX - control, toY, toX, toY);
      ctx.strokeStyle = isExec
        ? active
          ? 'rgba(255, 210, 148, 1)'
          : 'rgba(246, 193, 119, 0.85)'
        : active
          ? 'rgba(104, 232, 216, 1)'
          : 'rgba(77, 208, 193, 0.8)';
      ctx.lineWidth = active ? 2.6 : 2;
      ctx.stroke();

      // 终点圆点
      ctx.beginPath();
      ctx.arc(toX, toY, 2.6, 0, Math.PI * 2);
      ctx.fillStyle = isExec ? 'rgba(246, 193, 119, 0.9)' : 'rgba(77, 208, 193, 0.9)';
      ctx.fill();
    }
  }

  _drawPending(ctx) {
    if (!this.pending) return;
    const node = this.getNode(this.pending.nodeId);
    if (!node) return;
    const from = getPinAbs(node, this.pending.dir, this.pending.pinName);
    if (!from) return;

    const color = this.pending.kind === 'exec' ? 'rgba(246, 193, 119, 1)' : 'rgba(77, 208, 193, 1)';
    const target = this.pending.pointer;

    ctx.save();
    if (target) {
      const fromScreen = this.worldToScreen(from.x, from.y);
      const toScreen = this.worldToScreen(target.x, target.y);
      const control = Math.max(40, Math.abs(toScreen.x - fromScreen.x) * 0.5);
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.bezierCurveTo(
        from.x + control / this.view.scale,
        from.y,
        target.x - control / this.view.scale,
        target.y,
        target.x,
        target.y
      );
      ctx.setLineDash([8, 6]);
      ctx.lineWidth = 2.4;
      ctx.strokeStyle = color;
      ctx.stroke();
    } else {
      const pulse = 9 + Math.sin(Date.now() / 220) * 3;
      ctx.beginPath();
      ctx.arc(from.x, from.y, pulse + 6, 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawNode(ctx, node, layout) {
    const { x, y } = node.position;
    const { width, height, def } = layout;
    const selected = node.id === this.selectedId;

    // 选中光晕用描边代替 shadowBlur（后者在移动端开销很高）
    if (selected) {
      this._roundRectPath(ctx, x - 2, y - 2, width + 4, height + 4, 12);
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(77, 163, 255, 0.18)';
      ctx.stroke();
    }

    this._roundRectPath(ctx, x, y, width, height, 10);
    ctx.fillStyle = '#1a222c';
    ctx.fill();

    // 头部
    ctx.save();
    this._roundRectPath(ctx, x, y, width, height, 10);
    ctx.clip();
    const headerColor = NODE_TYPE_COLORS[def.type] || NODE_TYPE_COLORS.function;
    const gradient = ctx.createLinearGradient(x, y, x + width, y + NODE_HEADER_HEIGHT);
    gradient.addColorStop(0, headerColor);
    gradient.addColorStop(1, shadeColor(headerColor, -26));
    ctx.fillStyle = gradient;
    ctx.fillRect(x, y, width, NODE_HEADER_HEIGHT);
    ctx.restore();

    // 边框
    this._roundRectPath(ctx, x + 0.5, y + 0.5, width - 1, height - 1, 10);
    ctx.lineWidth = selected ? 2 : 1;
    ctx.strokeStyle = selected ? '#4da3ff' : 'rgba(255,255,255,0.10)';
    ctx.stroke();

    // 标题
    ctx.font = `600 13px ${FONT_STACK}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    let suffix = '';
    if (node.name === 'varget' || node.name === 'varset') {
      suffix = node.data?.name ? ` · ${node.data.name}` : ' · 未选择变量';
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillText(this._fitText(ctx, def.label + suffix, width - 24), x + 12, y + NODE_HEADER_HEIGHT / 2 + 1);

    for (const pin of layout.pins) {
      this._drawPin(ctx, node, pin, layout);
    }
  }

  _drawPin(ctx, node, pin, layout) {
    const px = node.position.x + pin.x;
    const py = node.position.y + pin.y;
    const connected = this._isPinConnected(node.id, pin.name, pin.dir);
    const isPendingSource =
      this.pending && this.pending.nodeId === node.id && this.pending.pinName === pin.name;
    const color = pin.kind === 'exec' ? '#f6c177' : '#4dd0c1';

    ctx.save();
    ctx.translate(px, py);
    if (pin.kind === 'exec') {
      const size = 5;
      ctx.beginPath();
      ctx.moveTo(0, -size);
      ctx.lineTo(size, 0);
      ctx.lineTo(0, size);
      ctx.lineTo(-size, 0);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 1;
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(0, 0, 4.6, 0, Math.PI * 2);
      ctx.fillStyle = connected ? color : '#151c25';
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.restore();

    if (isPendingSource) {
      const pulse = 11 + Math.sin(Date.now() / 200) * 3;
      ctx.beginPath();
      ctx.arc(px, py, pulse, 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    if (!pin.label) return;

    ctx.font = `500 11.5px ${FONT_STACK}`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle =
      pin.kind === 'exec' ? 'rgba(246, 193, 119, 0.95)' : 'rgba(206, 221, 237, 0.88)';

    if (pin.dir === 'in') {
      ctx.textAlign = 'left';
      const maxWidth = layout.width / 2 - 20;
      ctx.fillText(this._fitText(ctx, pin.label, maxWidth), node.position.x + pin.x + 16, py);
    } else {
      ctx.textAlign = 'right';
      const maxWidth = layout.width / 2 - 20;
      ctx.fillText(
        this._fitText(ctx, pin.label, maxWidth),
        node.position.x + pin.x - 16,
        py
      );
    }

    // 未连接输入的内联值预览
    if (
      pin.dir === 'in' &&
      pin.kind === 'port' &&
      pin.editor &&
      !connected &&
      this.view.scale >= 0.55
    ) {
      const hasOutputLabel = layout.pins.some(
        (item) => item.dir === 'out' && item.row === pin.row && item.label
      );
      if (!hasOutputLabel) {
        const value = this._formatValue(pin, node.data?.[pin.name]);
        if (value) {
          ctx.font = `400 11px ${FONT_STACK}`;
          ctx.fillStyle = 'rgba(139, 152, 168, 0.9)';
          ctx.textAlign = 'right';
          const labelWidth = ctx.measureText(pin.label).width;
          const startX = node.position.x + pin.x + 16 + labelWidth + 10;
          const endX = node.position.x + layout.width - 26;
          const maxWidth = endX - startX;
          if (maxWidth > 24) {
            ctx.fillText(this._fitText(ctx, value, maxWidth), endX, py);
          }
        }
      }
    }
  }

  _formatValue(pin, value) {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (pin.editor === 'boolean') return value === 'true' ? 'true' : 'false';
    if (pin.editor === 'select') return String(value);
    const text = String(value).replace(/\s+/g, ' ').trim();
    return text.length > 26 ? `${text.slice(0, 26)}…` : text;
  }

  _fitText(ctx, text, maxWidth) {
    if (!maxWidth || maxWidth <= 8) return String(text);
    const str = String(text);
    const key = `${ctx.font}|${Math.round(maxWidth)}|${str}`;
    const cached = this._textCache.get(key);
    if (cached !== undefined) return cached;

    let result = str;
    if (ctx.measureText(str).width > maxWidth) {
      let cut = str;
      while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) {
        cut = cut.slice(0, -1);
      }
      result = `${cut}…`;
    }
    if (this._textCache.size > 800) this._textCache.clear();
    this._textCache.set(key, result);
    return result;
  }

  _roundRectPath(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
  }
}
