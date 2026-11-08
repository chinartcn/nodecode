/**
 * 动态节点定义注册：函数节点 + 类节点。
 * setDynamicNodeDefs 会清空旧注册，因此两者必须一起构建。
 */

import { setDynamicNodeDefs } from './node-defs.js';
import { buildFunctionNodeDefs } from './function-defs.js';
import { buildClassNodeDefs } from './class-defs.js';

export function buildDynamicNodeDefs(functions, classes) {
  return [
    ...buildFunctionNodeDefs(functions || []),
    ...buildClassNodeDefs(classes || []),
  ];
}

export function applyDynamicNodeDefs(functions, classes) {
  setDynamicNodeDefs(buildDynamicNodeDefs(functions, classes));
}
