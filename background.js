// background.js —— MV3 service worker，负责编排批量采集任务
let job = null;
let keepalivePort = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// 弹窗长连接：连接存在期间可阻止 SW 被回收（MV3 保活关键）
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'keepalive') {
    keepalivePort = port;
    port.onDisconnect.addListener(() => {
      keepalivePort = null;
    });
  }
});

async function ensureTab() {
  const existing = await chrome.tabs.query({ url: '*://*.xiaohongshu.com/*' });
  if (existing.length) return existing[0].id;
  const tab = await chrome.tabs.create({
    url: 'https://www.xiaohongshu.com/explore',
    active: false
  });
  await waitTabComplete(tab.id);
  return tab.id;
}

function waitTabComplete(tabId, timeout = 20000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = async () => {
      try {
        const t = await chrome.tabs.get(tabId);
        if (t.status === 'complete' || Date.now() - start > timeout) {
          resolve(tabId);
          return;
        }
      } catch (e) {
        resolve(tabId);
        return;
      }
      setTimeout(check, 300);
    };
    check();
  });
}

async function tabExists(tabId) {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch (e) {
    return false;
  }
}

// 按需把 inject.js 注入主世界（覆盖"扩展重载前已打开"的标签页；有幂等保护）
async function injectMain(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: 'MAIN',
      files: ['inject.js']
    });
  } catch (e) {
    // 忽略：可能已由 manifest 自动注入
  }
}

async function sendToContent(tabId, msg, retries) {
  const n = retries || 5;
  let injected = false;
  for (let i = 0; i < n; i++) {
    try {
      return await chrome.tabs.sendMessage(tabId, msg);
    } catch (e) {
      // 扩展重载后旧标签页没有 content script：按需注入再重试
      if (!injected) {
        injected = true;
        try {
          await chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['content.js'] });
          await sleep(300);
        } catch (e2) {}
      }
      await sleep(700);
    }
  }
  return { ok: false, error: 'content script 无响应（页面未就绪？）' };
}

// 等待页面 + 搜索框就绪（区分"未登录"与"DOM 未渲染"）
async function waitReady(tabId, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const resp = await sendToContent(tabId, { action: 'ping' }, 2);
    if (resp && resp.ok && resp.hasInput) return true;
    await sleep(500);
  }
  return false;
}

function saveState() {
  if (!job) return;
  chrome.storage.local.set({
    job: {
      running: job.running,
      done: job.done,
      remaining: job.queue.length,
      collected: job.results.length
    },
    results: job.results
  });
}

function pct() {
  if (!job) return 0;
  const est = job.done + job.queue.length;
  if (est <= 0) return 100;
  return Math.min(99, Math.round((job.done / est) * 100));
}

async function startBatch(seeds, depth, delay) {
  let tabId;
  try {
    tabId = await ensureTab();
  } catch (e) {
    broadcast({ type: 'warn', message: '无法打开小红书页面：' + (e && e.message || e) });
    broadcast({ type: 'finished', total: 0 });
    return;
  }

  const ready = await waitReady(tabId);
  if (!ready) {
    broadcast({
      type: 'warn',
      message: '小红书页面未就绪：可能未登录或搜索框未出现。请打开小红书登录后重试'
    });
    broadcast({ type: 'finished', total: 0 });
    return;
  }

  // 确保联想请求拦截器已注入
  await injectMain(tabId);

  job = {
    running: true,
    stop: false,
    depth: depth,
    delay: delay,
    queue: seeds.map((s) => ({ kw: s, level: 1 })),
    visited: new Set(),
    added: new Set(),
    results: [],
    done: 0,
    emptyStreak: 0
  };

  broadcast({ type: 'started', total: job.queue.length });
  saveState();

  while (job.running && job.queue.length && !job.stop) {
    const item = job.queue.shift();
    if (job.visited.has(item.kw)) {
      job.done++;
      continue;
    }
    job.visited.add(item.kw);

    broadcast({
      type: 'progress',
      current: item.kw,
      level: item.level,
      done: job.done,
      remaining: job.queue.length,
      collected: job.results.length,
      pct: pct()
    });

    const resp = await sendToContent(tabId, { action: 'collectFor', keyword: item.kw });
    const stepItems = [];

    if (resp && resp.ok) {
      if (resp.suggestions.length === 0) {
        job.emptyStreak++;
      } else {
        job.emptyStreak = 0;
        for (const w of resp.suggestions) {
          if (!job.added.has(w)) {
            job.added.add(w);
            const entry = { seed: item.kw, level: item.level, word: w };
            job.results.push(entry);
            stepItems.push(entry);
          }
          if (item.level < job.depth && !job.visited.has(w)) {
            job.queue.push({ kw: w, level: item.level + 1 });
          }
        }
      }
    } else {
      job.emptyStreak++;
      if (resp && resp.error) {
        broadcast({ type: 'warn', message: `「${item.kw}」失败：${resp.error}` });
      }
      // 标签页被用户关闭 → 终止
      if (!(await tabExists(tabId))) {
        broadcast({ type: 'warn', message: '小红书标签页已关闭，任务终止' });
        job.stop = true;
      }
    }

    // 连续空结果 → 疑似风控/验证码，自动暂停
    if (job.emptyStreak >= 5) {
      broadcast({
        type: 'warn',
        message: '连续 5 次无下拉词，疑似触发风控/验证码，已自动暂停。请稍后调大间隔重试'
      });
      job.stop = true;
    }

    job.done++;
    saveState();
    broadcast({
      type: 'progress',
      current: item.kw,
      level: item.level,
      done: job.done,
      remaining: job.queue.length,
      collected: job.results.length,
      pct: pct(),
      items: stepItems
    });

    if (job.stop) break;
    await sleep(job.delay);
  }

  job.running = false;
  saveState();
  broadcast({ type: 'finished', total: job.results.length });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'startBatch') {
    if (job && job.running) {
      sendResponse({ ok: false, error: '已有任务在运行，请先停止' });
      return;
    }
    startBatch(request.seeds, request.depth, request.delay);
    sendResponse({ ok: true });
    return;
  }
  if (request.action === 'stopBatch') {
    if (job) job.stop = true;
    sendResponse({ ok: true });
    return;
  }
  if (request.action === 'getState') {
    if (job) {
      sendResponse({
        running: job.running,
        done: job.done,
        remaining: job.queue.length,
        collected: job.results.length
      });
    } else {
      sendResponse({ running: false });
    }
    return true;
  }
  if (request.action === 'diagnose') {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !/xiaohongshu\.com/.test(tab.url || '')) {
          sendResponse({ ok: false, error: '请先切到小红书页面' });
          return;
        }
        await injectMain(tab.id);
        const resp = await sendToContent(tab.id, { action: 'diagnose', keyword: request.keyword }, 3);
        // 读主世界网络日志，看输入期间到底发了哪些请求
        let mainInfo = { patched: false, netLog: [] };
        try {
          const res = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'MAIN',
            func: function () {
              return { patched: !!window.__xhsSugPatched, netLog: (window.__xhsNetLog || []).slice(-80) };
            }
          });
          if (res && res[0]) mainInfo = res[0].result;
        } catch (e) {}
        sendResponse(Object.assign({}, resp, { patched: mainInfo.patched, netLog: mainInfo.netLog }));
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }
});
