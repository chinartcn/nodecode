/**
 * 内置示例蓝图
 */

import { EXEC_IN, EXEC_OUT } from '../shared/node-defs.js';

const node = (id, name, x, y, data = {}) => ({
  id,
  name,
  position: { x, y },
  data,
});

const conn = (id, fromNodeId, fromNodePinName, toNodeId, toNodePinName) => ({
  id,
  fromNodeId,
  fromNodePinName,
  toNodeId,
  toNodePinName,
});

export const examples = [
  {
    id: 'hello',
    name: '入门问候',
    description: '最简单的执行链：开始 → 两条日志',
    graph: {
      nodes: [
        node('begin', 'begin', 80, 80),
        node('log1', 'log', 80, 200, { message: 'Hello Codeck Mobile 👋' }),
        node('log2', 'log', 80, 320, { message: '在手机上也能可视化编程' }),
      ],
      connections: [
        conn('c1', 'begin', EXEC_OUT, 'log1', EXEC_IN),
        conn('c2', 'log1', EXEC_OUT, 'log2', EXEC_IN),
      ],
      variables: [],
    },
  },
  {
    id: 'loop',
    name: '循环与索引',
    description: 'Loop 循环 5 次，读取 inc 索引并输出',
    graph: {
      nodes: [
        node('begin', 'begin', 80, 60),
        node('loop', 'loop', 80, 180, { times: 5 }),
        node('raw', 'raw-js', 80, 340, {
          js: "return '第 ' + ctx + ' 次循环';",
        }),
        node('logBody', 'log', 80, 540, { message: '' }),
        node('logEnd', 'log', 420, 340, { message: '循环结束，共 5 次' }),
      ],
      connections: [
        conn('c1', 'begin', EXEC_OUT, 'loop', EXEC_IN),
        conn('c2', 'loop', 'body', 'raw', EXEC_IN),
        conn('c3', 'loop', 'inc', 'raw', 'ctx'),
        conn('c4', 'raw', EXEC_OUT, 'logBody', EXEC_IN),
        conn('c5', 'raw', 'returnValue', 'logBody', 'message'),
        conn('c6', 'loop', EXEC_OUT, 'logEnd', EXEC_IN),
      ],
      variables: [],
    },
  },
  {
    id: 'condition',
    name: '条件分支',
    description: '计算 7 × 6，通过 Greater 判断后走 If 分支',
    graph: {
      nodes: [
        node('begin', 'begin', 60, 60),
        node('raw', 'raw-js', 60, 180, { js: 'return 7 * 6;' }),
        node('gt', 'gt', 380, 180, { input1: 0, input2: 10 }),
        node('if', 'if', 620, 180, { condition: true }),
        node('logTrue', 'log', 620, 360, { message: '结果大于 10' }),
        node('logFalse', 'log', 620, 480, { message: '结果不大于 10' }),
      ],
      connections: [
        conn('c1', 'begin', EXEC_OUT, 'raw', EXEC_IN),
        conn('c2', 'raw', EXEC_OUT, 'if', EXEC_IN),
        conn('c3', 'raw', 'returnValue', 'gt', 'input1'),
        conn('c4', 'gt', 'output', 'if', 'condition'),
        conn('c5', 'if', 'true', 'logTrue', EXEC_IN),
        conn('c6', 'if', 'false', 'logFalse', EXEC_IN),
      ],
      variables: [],
    },
  },
  {
    id: 'fetch',
    name: 'HTTP 请求',
    description: '请求 JSON 接口并输出响应文本（需要网络）',
    graph: {
      nodes: [
        node('begin', 'begin', 60, 60),
        node('fetch', 'fetch', 60, 180, {
          method: 'GET',
          url: 'https://jsonplaceholder.typicode.com/todos/1',
        }),
        node('logSuccess', 'log', 60, 520, { message: '' }),
        node('logFail', 'log', 420, 520, { message: '请求失败，请检查网络或 URL' }),
      ],
      connections: [
        conn('c1', 'begin', EXEC_OUT, 'fetch', EXEC_IN),
        conn('c2', 'fetch', 'onSuccess', 'logSuccess', EXEC_IN),
        conn('c3', 'fetch', 'text', 'logSuccess', 'message'),
        conn('c4', 'fetch', 'onFailed', 'logFail', EXEC_IN),
      ],
      variables: [],
    },
  },
];
