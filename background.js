// background.js —— MV3 service worker，负责编排批量采集任务
importScripts('radar.js');
importScripts('supabase.js');

let keepalivePort = null;
let pumpLock = false; // 防止 alarm 与 setTimeout 并发处理同一批任务
const QUEUE_CAP = 3000; // 递归队列硬上限，避免 depth=3 指数爆炸拖垮浏览器
const HIST_RESULT_CAP = 1500; // 历史每条存词上限（100条×1500词×50B≈7.5MB < 10MB 限额）
const JOB_KEY = 'job';
const JOB_RESULTS_KEY = 'jobResults'; // 采集结果集独立存储，避免每步全量序列化大数组

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

// ============ job 状态：以 chrome.storage 为唯一事实源 ============
// 第一性原理：MV3 SW 易失，任何只活在内存里的任务状态都会随 SW 回收而丢失。
// 因此 job 全程序列化存 storage（不含 Set/Map），SW 死后从 storage 重建即可续跑。
async function loadJob() {
  return new Promise((resolve) => chrome.storage.local.get([JOB_KEY, JOB_RESULTS_KEY], (s) => {
    const job = s[JOB_KEY] || null;
    if (job) job.results = s[JOB_RESULTS_KEY] || []; // 恢复时把结果集合并回 job
    resolve(job);
  }));
}
async function saveJob(job) {
// 第一性原理：调度态(小：queue/visited/added/done)每步必存，保证 SW 死后可恢复；
// results(大) 由 flushResults 节流落盘，避免每步全量序列化大数组拖慢 service worker。
const { results, ...state } = job;
await chrome.storage.local.set({ [JOB_KEY]: state });
}
async function flushResults(job) {
  await chrome.storage.local.set({ [JOB_RESULTS_KEY]: job.results });
}
function pct(job) {
  const est = job.done + job.queue.length;
  const raw = est <= 0 ? (job.pctShown || 0) : Math.min(99, Math.round((job.done / est) * 100));
  // 第一性原理：递归采集的总工作量（队列长度）先验未知，下钻会持续向队列注入新词，
  // 任何基于「done/(done+remaining)」的估算在数学上都会随分母增大而倒退。
  // 不变量：展示给用户的进度只增不降——用单调上限兜住可见的倒退。
  job.pctShown = Math.max(job.pctShown || 0, raw);
  return job.pctShown;
}

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
  return { ok: false, error: '内容脚本无响应（页面未就绪？）' };
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

// 调度下一步：setTimeout 提供"SW 存活时"的快速节奏；alarm 是 SW 死后复活的安全网
function scheduleTick(delay) {
  ensurePumpAlarm();
  setTimeout(() => pumpJob(), delay);
}
function ensurePumpAlarm() {
  // 最小周期 0.5min=30s；正常由 setTimeout 驱动，alarm 仅在 SW 被回收后兜底唤醒
  chrome.alarms.create('job-pump', { periodInMinutes: 0.5 });
}

// 步进式处理：每次只处理一个词，处理完立刻落盘，再决定下一步
async function pumpJob() {
  if (pumpLock) return; // 防止 alarm 与 setTimeout 并发
  pumpLock = true;
  try {
    let job = await loadJob();
    if (!job || !job.running || job.stop) {
      // 对抗式审查修复：job 已 finalize（phase==='done'）时不再重复 finalize，
      // 否则 stray alarm 会在任务结束后重复广播 'finished'，弹窗出现重复完成提示
      if (job && job.phase !== 'done' && (job.stop || job.queue.length === 0)) await finalizeJob(job);
      return;
    }
    if (job.queue.length === 0) { await finalizeJob(job); return; }

    // —— 初始化阶段（一次性）：准备标签页 + 登录预检 ——
    if (job.phase === 'init') {
      let tabId;
      try { tabId = await ensureTab(); }
      catch (e) {
        broadcast({ type: 'warn', message: '无法打开小红书页面：' + (e && e.message || e) });
        job.stop = true; job.running = false; await saveJob(job);
        await finalizeJob(job);
        return;
      }
      const ready = await waitReady(tabId);
      if (!ready) {
        broadcast({ type: 'warn', message: '小红书页面未就绪：可能未登录或搜索框未出现。请打开小红书登录后重试' });
        job.stop = true; job.running = false; await saveJob(job);
        await finalizeJob(job);
        return;
      }
      await injectMain(tabId);
      job.tabId = tabId;
      job.phase = 'running';
      await saveJob(job);
      broadcast({ type: 'started', total: job.queue.length });
      scheduleTick(job.delay);
      return;
    }

    // —— 运行阶段：处理队列头一个词 ——
    const item = job.queue.shift();
    if (job.visited.includes(item.kw)) {
      job.done++;
      await saveJob(job);
      if (job.queue.length === 0 || job.stop) { await finalizeJob(job); return; }
      scheduleTick(job.delay);
      return;
    }
    job.visited.push(item.kw);

    broadcast({
      type: 'progress',
      current: item.kw,
      level: item.level,
      done: job.done,
      remaining: job.queue.length,
      collected: job.results.length,
      pct: pct(job)
    });

    const resp = await sendToContent(job.tabId, { action: 'collectFor', keyword: item.kw });
    const stepItems = [];

    if (resp && resp.ok) {
      if (!resp.suggestions || resp.suggestions.length === 0) {
        job.emptyStreak++;
      } else {
        job.emptyStreak = 0;
        for (const w of resp.suggestions) {
          if (!job.added.includes(w)) {
            job.added.push(w);
            const entry = { seed: item.kw, level: item.level, word: w };
            job.results.push(entry);
            stepItems.push(entry);
          }
          // 递归下钻（第一性原理修复 v1.13）：
          // 旧逻辑误用 job.added 作为「是否已入队」判断，但 w 已在上方收集块 push 进 added，
          // 导致条件恒 false、下钻从不触发、只能采到种子层（"只采集1层"）。
          // 现改用独立字段 job.queued 记录「已入队待下钻」词，与 added/visited 职责分离。
          if (item.level < job.depth && !job.queued.includes(w)) {
            if (job.queue.length < QUEUE_CAP) {
              job.queue.push({ kw: w, level: item.level + 1 });
              job.queued.push(w);
            } else if (!job.truncated) {
              job.truncated = true; // 标记截断，finalize 时提示
            }
          }
        }
      }
    } else {
      job.emptyStreak++;
      if (resp && resp.error) {
        broadcast({ type: 'warn', message: `「${item.kw}」失败：${resp.error}` });
      }
      // 标签页被用户关闭 → 终止
      if (!(await tabExists(job.tabId))) {
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
    await saveJob(job);
    // 第一性原理：每步落盘结果集，SW 死亡时零丢失。
    // saveJob 只序列化调度态(小)，flushResults 只写 results 一个 key，开销 < 5ms
    await flushResults(job);
    broadcast({
      type: 'progress',
      current: item.kw,
      level: item.level,
      done: job.done,
      remaining: job.queue.length,
      collected: job.results.length,
      pct: pct(job),
      items: stepItems
    });

    if (job.stop || job.queue.length === 0) { await finalizeJob(job); return; }
    scheduleTick(job.delay);
  } catch (e) {
    // 任意意外错误：暂停而非无限空转，避免 SW 反复崩溃
    try {
      const j = await loadJob();
      if (j) { j.stop = true; await saveJob(j); }
    } catch (_) {}
  } finally {
    pumpLock = false;
  }
}

async function finalizeJob(job) {
  await flushResults(job); // 强制全量落盘结果集，确保历史完整
  job.running = false;
  job.phase = 'done';
  await saveJob(job);
  chrome.alarms.clear('job-pump');
  broadcast({ type: 'finished', total: job.results.length });
  // 存入历史（results 上限 HIST_RESULT_CAP，超出时标注截断）
  const histResults = job.results.slice(0, HIST_RESULT_CAP);
  const histTruncated = job.results.length > HIST_RESULT_CAP;
  historyPush({
    id: 'b' + (job.startedAt || Date.now()),
    ts: Date.now(),
    kind: '采集',
    title: (job.seeds || []).length + '种子词·depth' + job.depth,
    detail: job.results.length + '词' + (job.truncated ? '（队列超限已截断）' : '') + (histTruncated ? '（历史存前' + HIST_RESULT_CAP + '）' : ''),
    payload: { type: 'batch', seeds: job.seeds, depth: job.depth, results: histResults }
  });
}

async function startBatch(seeds, depth, delay) {
  const existing = await loadJob();
  if (existing && existing.running) {
    broadcast({ type: 'warn', message: '已有任务在运行，请先停止' });
    return;
  }
  const job = {
    running: true,
    stop: false,
    phase: 'init',
    depth: depth,
    delay: delay,
    tabId: null,
    queue: seeds.map((s) => ({ kw: s, level: 1 })),
    queued: [...new Set(seeds)], // 已入队待下钻词集合：与 added(已收集)/visited(已处理) 职责分离，防重复入队撑爆队列
    visited: [],
    added: [],
    results: [],
    done: 0,
    emptyStreak: 0,
    seeds: seeds,
    startedAt: Date.now(),
    truncated: false,
    pctShown: 0
  };
  ensurePumpAlarm();
  await saveJob(job);
  pumpJob();
}

async function stopBatch() {
  const job = await loadJob();
  if (job) { job.stop = true; await saveJob(job); }
  chrome.alarms.clear('job-pump');
  pumpJob(); // 尽快进入 finalize
}

function loadSettingsSeeds() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['settings'], (s) => {
      const t = (s.settings && s.settings.seeds) || '';
      const seeds = t.split('\n').map((x) => x.trim()).filter(Boolean);
      resolve(seeds);
    });
  });
}

// —— 全历史记录（采集批次 + 快照） ——
async function historyLoad() {
  return new Promise((resolve) => chrome.storage.local.get(['history'], (s) => resolve(s.history || [])));
}
async function historySave(h) {
  await chrome.storage.local.set({ history: h });
}
async function historyPush(entry) {
  let h = await historyLoad();
  h = h.filter((e) => e.id !== entry.id);
  h.push(entry);
  h.sort((a, b) => b.ts - a.ts);
  if (h.length > 100) h = h.slice(0, 100);
  await historySave(h);
  sbPushHistory(entry); // 已登录则云同步，未登录 no-op
  broadcast({ type: 'historyUpdate' });
}

// 删除单条历史：本地按 id 过滤；已登录则同步删除云端（未登录 no-op）
async function deleteHistory(id) {
  if (!id) return false;
  let h = await historyLoad();
  const before = h.length;
  h = h.filter((e) => e.id !== id);
  const deleted = h.length !== before;
  if (deleted) await historySave(h);
  try { await sbDeleteHistory(id); } catch (e) {}
  broadcast({ type: 'historyUpdate' });
  return deleted;
}

// —— 上升趋势雷达：每日定时快照 ——
function nextRunTime(h, m) {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

async function ensureRadarAlarm() {
  const sch = await radarLoadSchedule();
  if (sch.enabled) {
    chrome.alarms.create('radar-daily', {
      when: nextRunTime(sch.hour || 9, sch.minute || 0),
      periodInMinutes: 1440
    });
  } else {
    chrome.alarms.clear('radar-daily');
  }
}

chrome.runtime.onInstalled.addListener(() => { ensureRadarAlarm(); sbLoad(); resumeIfNeeded(); });
chrome.runtime.onStartup.addListener(() => { ensureRadarAlarm(); sbLoad(); resumeIfNeeded(); });

// SW 复活（非浏览器启动，onInstalled/onStartup 不触发）时，靠 alarm 兜底唤醒；
// 这里额外做一次主动检查，确保存储里"running"的任务被续上
function resumeIfNeeded() {
  loadJob().then((j) => {
    if (j && j.running && j.queue.length) { ensurePumpAlarm(); pumpJob(); }
  });
}

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === 'job-pump') { pumpJob(); return; }
  if (a.name !== 'radar-daily') return;
  const sch = await radarLoadSchedule();
  const seeds = (sch.seeds && sch.seeds.length) ? sch.seeds : await loadSettingsSeeds();
  if (!seeds.length) return;
  try {
    const res = await runSnapshot(seeds, sch.delay || 900);
    if (res.ok && res.snap) {
      const data = res.snap.data || {};
      await historyPush({
        id: 's' + res.snap.ts,
        ts: Date.now(),
        kind: '快照',
        title: Object.keys(data).length + '种子·' + res.snap.date,
        detail: Object.values(data).reduce((a, v) => a + (v ? v.length : 0), 0) + '词',
        payload: { type: 'snapshot', data }
      });
    }
    if (res.ok && res.diff && res.diff.newWords.length) {
      broadcast({ type: 'radarDone', newCount: res.diff.newWords.length });
    }
  } catch (e) {}
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'startBatch') {
    if (request.depth > 3) request.depth = 3; // 防御：深度封顶，避免队列失控
    startBatch(request.seeds, request.depth, request.delay);
    sendResponse({ ok: true });
    return;
  }
  if (request.action === 'stopBatch') {
    stopBatch();
    sendResponse({ ok: true });
    return;
  }
  if (request.action === 'getState') {
    loadJob().then((job) => {
      if (job && job.running) {
        sendResponse({
          running: true,
          done: job.done,
          remaining: job.queue.length,
          collected: job.results.length
        });
      } else {
        sendResponse({ running: false });
      }
    });
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
  if (request.action === 'snapshotNow') {
    (async () => {
      const seeds = await loadSettingsSeeds();
      if (!seeds.length) { sendResponse({ ok: false, error: '请先在采集页填种子词' }); return; }
      sendResponse({ ok: true, started: true });
      try {
        const res = await runSnapshot(seeds, 900, (kw) => broadcast({ type: 'radarProgress', current: kw }));
        if (res.ok && res.snap) {
          const data = res.snap.data || {};
          historyPush({
            id: 's' + res.snap.ts,
            ts: Date.now(),
            kind: '快照',
            title: Object.keys(data).length + '种子·' + res.snap.date,
            detail: Object.values(data).reduce((a, v) => a + (v ? v.length : 0), 0) + '词',
            payload: { type: 'snapshot', data }
          });
        }
        broadcast({ type: 'radarDone', res });
      } catch (e) {
        broadcast({ type: 'radarDone', res: { ok: false, error: String((e && e.message) || e) } });
      }
    })();
    return true;
  }
  if (request.action === 'getTrend') {
    (async () => {
      const snaps = await radarLoadSnapshots();
      const scored = scoreWords(snaps);
      const today = snaps[snaps.length - 1];
      const prev = snaps.length >= 2 ? snaps[snaps.length - 2] : null;
      const diff = diffSnapshots(today, prev);
      const summary = snaps.map((s) => ({
        date: s.date,
        total: Object.values(s.data || {}).reduce((a, v) => a + (v ? v.length : 0), 0)
      }));
      sendResponse({ ok: true, summary, scored, diff });
    })();
    return true;
  }
  if (request.action === 'getSchedule') {
    (async () => { sendResponse({ ok: true, schedule: await radarLoadSchedule() }); })();
    return true;
  }
  if (request.action === 'setSchedule') {
    (async () => {
      await radarSaveSchedule(request.schedule);
      await ensureRadarAlarm();
      sendResponse({ ok: true });
    })();
    return true;
  }
  // —— 账号登录 / 云同步 ——
  if (request.action === 'sbGetSession') {
    (async () => {
      await sbLoad();
      sendResponse({ ok: true, session: !!SB.session, user: SB.session ? (SB.session.user || { email: '已登录' }) : null });
    })();
    return true;
  }
  if (request.action === 'sbSignup') {
    (async () => {
      try { const d = await sbSignup(request.email, request.password); sendResponse({ ok: true, user: d.user || { email: request.email } }); }
      catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
    })();
    return true;
  }
  if (request.action === 'sbLogin') {
    (async () => {
      try { const d = await sbLogin(request.email, request.password); sendResponse({ ok: true, user: d.user || { email: request.email } }); }
      catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
    })();
    return true;
  }
  if (request.action === 'sbLogout') {
    (async () => { await sbLogout(); sendResponse({ ok: true }); })();
    return true;
  }
  // —— 历史记录 ——
  if (request.action === 'getHistory') {
    (async () => { sendResponse({ ok: true, history: await historyLoad() }); })();
    return true;
  }
  if (request.action === 'syncHistory') {
    (async () => {
      const cloud = await sbPullHistory();
      if (cloud && cloud.length) {
        let local = await historyLoad();
        const map = new Map(local.map((e) => [e.id, e]));
        for (const c of cloud) {
          if (!map.has(c.id)) local.push(c);
        }
        local.sort((a, b) => b.ts - a.ts);
        if (local.length > 100) local = local.slice(0, 100);
        await historySave(local);
      }
      sendResponse({ ok: true, pulled: cloud ? cloud.length : 0, history: await historyLoad() });
    })();
    return true;
  }
  if (request.action === 'clearHistory') {
    (async () => { await historySave([]); sendResponse({ ok: true }); })();
    return true;
  }
  if (request.action === 'deleteHistory') {
    (async () => {
      const deleted = await deleteHistory(request.id);
      sendResponse({ ok: true, deleted });
    })();
    return true;
  }
});
