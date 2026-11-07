/**
 * 在 Node.js vm 中运行由蓝图生成的代码，并收集 console 输出。
 *
 * 说明：vm 不是严格的安全边界，本项目定位为本地可视化脚本工具，
 * 不要将服务暴露到不可信网络。
 */

import vm from 'node:vm';
import util from 'node:util';

const MAX_LOG_COUNT = 300;
const MAX_LOG_LENGTH = 4000;

function formatArg(value) {
  if (typeof value === 'string') return value;
  return util.inspect(value, {
    depth: 4,
    breakLength: 100,
    maxArrayLength: 50,
    maxStringLength: 2000,
    colors: false,
  });
}

function normalizeError(error) {
  if (!error) return null;
  const message = error.message || String(error);
  const stack = typeof error.stack === 'string' ? error.stack.split('\n').slice(0, 6).join('\n') : '';
  return {
    name: error.name || 'Error',
    message,
    stack,
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runInSandbox(code, options = {}) {
  const timeoutMs = Math.min(Math.max(Number(options.timeoutMs) || 8000, 500), 30000);
  const started = Date.now();
  const logs = [];

  let pending = 0;
  let lastActivity = Date.now();
  const timers = new Set();

  const pushLog = (level) => {
    return (...args) => {
      if (logs.length >= MAX_LOG_COUNT) logs.shift();
      const text = args.map(formatArg).join(' ');
      logs.push({
        level,
        text: text.length > MAX_LOG_LENGTH ? `${text.slice(0, MAX_LOG_LENGTH)}…` : text,
      });
      lastActivity = Date.now();
    };
  };

  const safeSetTimeout = (fn, ms, ...args) => {
    pending += 1;
    lastActivity = Date.now();
    const id = setTimeout(() => {
      timers.delete(id);
      try {
        if (typeof fn === 'function') fn(...args);
      } catch (error) {
        logs.push({ level: 'error', text: `定时器回调异常: ${error.message}` });
      } finally {
        pending -= 1;
        lastActivity = Date.now();
      }
    }, Math.max(0, Number(ms) || 0));
    timers.add(id);
    return id;
  };

  const safeClearTimeout = (id) => {
    if (timers.has(id)) {
      clearTimeout(id);
      timers.delete(id);
      pending -= 1;
    }
  };

  // 记录未 await 的 fetch（例如用户在 raw-js 中直接调用），确保运行结束前等待其完成
  const safeFetch = (...args) => {
    pending += 1;
    lastActivity = Date.now();
    const promise = fetch(...args);
    const done = () => {
      pending -= 1;
      lastActivity = Date.now();
    };
    promise.then(done, done);
    return promise;
  };

  const sandbox = {
    console: {
      log: pushLog('log'),
      info: pushLog('info'),
      warn: pushLog('warn'),
      error: pushLog('error'),
      debug: pushLog('debug'),
    },
    setTimeout: safeSetTimeout,
    clearTimeout: safeClearTimeout,
    fetch: safeFetch,
  };

  const context = vm.createContext(sandbox);
  // 兼容浏览器风格代码：window.setTimeout(...)
  sandbox.window = sandbox;

  let error = null;
  const deadline = started + timeoutMs;
  let hardTimer = null;

  try {
    const script = new vm.Script(`(async () => {\n${code}\n})()`, {
      filename: 'blueprint.js',
      displayErrors: true,
    });

    const hardTimeout = new Promise((resolve) => {
      hardTimer = setTimeout(() => resolve('__TIMEOUT__'), timeoutMs);
    });

    const result = script.runInContext(context, {
      timeout: Math.min(timeoutMs, 2000),
      displayErrors: true,
    });

    const outcome = await Promise.race([result.then(() => null, (err) => err), hardTimeout]);
    if (outcome === '__TIMEOUT__') {
      error = new Error(`执行超时（${timeoutMs}ms）`);
    } else if (outcome instanceof Error) {
      error = outcome;
    }
  } catch (err) {
    error = err;
  } finally {
    if (hardTimer) clearTimeout(hardTimer);
  }

  // 等待未完成的定时器 / 未 await 的异步任务
  if (!error) {
    while (pending > 0) {
      if (Date.now() > deadline) {
        error = new Error(`执行超时（${timeoutMs}ms）`);
        break;
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(30);
    }
    // 留一点时间让链式异步任务继续入队
    if (!error) {
      const settleUntil = Date.now() + 120;
      while (Date.now() < settleUntil) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(20);
        if (pending > 0) break;
      }
      while (pending > 0 && Date.now() <= deadline) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(30);
      }
      if (pending > 0 && !error) error = new Error(`执行超时（${timeoutMs}ms）`);
    }
  }

  // 清理残留定时器，避免响应返回后继续写日志
  for (const id of timers) clearTimeout(id);
  timers.clear();

  return {
    ok: !error,
    logs,
    error: normalizeError(error),
    durationMs: Date.now() - started,
  };
}

export { normalizeError };
