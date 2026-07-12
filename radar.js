// radar.js —— 上升趋势雷达：每日快照 + 差分 + 上升分（被 background.js importScripts）
function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function wOf(x) { return typeof x === 'string' ? x : x.w; }

async function radarLoadSnapshots() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['radar.snapshots'], (s) => resolve(s['radar.snapshots'] || []));
  });
}
async function radarSaveSnapshots(snaps) {
  await chrome.storage.local.set({ 'radar.snapshots': snaps });
}
async function radarLoadSchedule() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['radar.schedule'], (s) =>
      resolve(s['radar.schedule'] || { enabled: false, hour: 9, minute: 0, delay: 900, seeds: [] }));
  });
}
async function radarSaveSchedule(sch) {
  await chrome.storage.local.set({ 'radar.schedule': sch });
}

// 差分：今天 vs 昨天
function diffSnapshots(today, prev) {
  const result = { newWords: [], goneWords: [], keptWords: [], bySeed: {} };
  if (!today || !today.data) return result;
  for (const seed of Object.keys(today.data)) {
    const cur = (today.data[seed] || []).map(wOf);
    const prevArr = prev && prev.data ? (prev.data[seed] || []).map(wOf) : [];
    const prevSet = new Set(prevArr);
    const curSet = new Set(cur);
    const nw = cur.filter((w) => !prevSet.has(w));
    const gone = prevArr.filter((w) => !curSet.has(w));
    const kept = cur.filter((w) => prevSet.has(w));
    result.bySeed[seed] = { nw: nw.length, gone: gone.length, kept: kept.length };
    nw.forEach((w) => result.newWords.push({ seed, word: w, pos: cur.indexOf(w) }));
    gone.forEach((w) => result.goneWords.push({ seed, word: w }));
    kept.forEach((w) => result.keptWords.push({ seed, word: w }));
  }
  return result;
}

// 上升分：新词 +50，位次分 (10-pos)*2，连续天数 *3
function scoreWords(snaps) {
  const today = snaps[snaps.length - 1];
  if (!today || !today.data) return [];
  const yesterday = snaps.length >= 2 ? snaps[snaps.length - 2] : null;
  const ySet = new Set();
  if (yesterday) for (const seed of Object.keys(yesterday.data || {})) (yesterday.data[seed] || []).forEach((x) => ySet.add(wOf(x)));

  const todayWords = [];
  for (const seed of Object.keys(today.data || {})) {
    (today.data[seed] || []).forEach((x, idx) => todayWords.push({ word: wOf(x), pos: idx, seed }));
  }

  // 预计算每天的词集合，用于连续天数
  const daySets = [];
  for (let i = 0; i < snaps.length - 1; i++) {
    const set = new Set();
    for (const seed of Object.keys(snaps[i].data || {})) (snaps[i].data[seed] || []).forEach((x) => set.add(wOf(x)));
    daySets.push(set);
  }

  const out = todayWords.map((e) => {
    let days = 1;
    for (let i = daySets.length - 1; i >= 0; i--) {
      if (daySets[i].has(e.word)) days++;
      else break;
    }
    const isNew = !ySet.has(e.word);
    const posScore = Math.max(0, 10 - e.pos);
    const score = (isNew ? 50 : 0) + posScore * 2 + days * 3;
    return { word: e.word, seed: e.seed, pos: e.pos, days, isNew, score };
  });
  out.sort((a, b) => b.score - a.score);
  return out;
}

// 执行一次快照采集（depth=1，复用 background 的 ensureTab/injectMain/sendToContent/sleep）
async function runSnapshot(seeds, delay, onProgress) {
  const tabId = await ensureTab();
  await injectMain(tabId);
  // 等就绪
  let ready = false;
  for (let i = 0; i < 20; i++) {
    const r = await sendToContent(tabId, { action: 'ping' }, 2);
    if (r && r.ok && r.hasInput) { ready = true; break; }
    await sleep(500);
  }
  if (!ready) return { ok: false, error: '小红书页面未就绪（未登录或搜索框未出现）' };

  const data = {};
  for (const seed of seeds) {
    if (onProgress) onProgress(seed);
    const resp = await sendToContent(tabId, { action: 'collectFor', keyword: seed });
    if (resp && resp.ok) data[seed] = resp.suggestions.slice(0, 15);
    else data[seed] = [];
    await sleep(delay || 900);
  }

  const snap = { date: todayStr(), ts: Date.now(), data };
  let snaps = await radarLoadSnapshots();
  snaps = snaps.filter((s) => s.date !== snap.date);
  snaps.push(snap);
  snaps.sort((a, b) => a.ts - b.ts);
  if (snaps.length > 30) snaps = snaps.slice(snaps.length - 30);
  await radarSaveSnapshots(snaps);

  const prev = snaps.length >= 2 ? snaps[snaps.length - 2] : null;
  const diff = diffSnapshots(snap, prev);
  const scored = scoreWords(snaps);
  return { ok: true, snap, diff, scored };
}
