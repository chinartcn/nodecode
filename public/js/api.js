/** 与 Node.js 服务端通信的轻量封装 */

async function request(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    throw new Error(data?.error || `请求失败（${response.status}）`);
  }
  return data;
}

export const api = {
  getState: () => request('/api/state'),
  saveState: (payload) =>
    request('/api/state', { method: 'POST', body: JSON.stringify(payload) }),
  getExamples: () => request('/api/examples'),
  compile: (graph) => request('/api/compile', { method: 'POST', body: JSON.stringify({ graph }) }),
  run: (graph, timeoutMs = 8000) =>
    request('/api/run', { method: 'POST', body: JSON.stringify({ graph, timeoutMs }) }),
};
