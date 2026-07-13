'use strict';

const $ = (id) => document.getElementById(id);
const seedsEl = $('seeds');
const depthEl = $('depth');
const delayEl = $('delay');
const statusEl = $('status');
const barEl = $('bar');
const resultsBox = $('resultsBox');
const startBtn = $('start');
const stopBtn = $('stop');
const currentBtn = $('current');

let running = false;
let results = []; // {seed, level, word}
let wordsSet = new Set(); // 全局去重，防止"本地恢复 + 实时推送"重复
let port = null;

const SOURCE_ZH = { network: '网络请求', 'network-empty': '网络请求(空响应)', dom: '页面DOM', none: '无' };

const RENDER_CAP = 500; // 仅渲染最近 N 条，避免大数据卡顿

function setRunning(state) {
  running = state;
  startBtn.style.display = state ? 'none' : 'flex';
  stopBtn.style.display = state ? 'flex' : 'none';
  currentBtn.disabled = state;
}

function setStatus(html) {
  statusEl.innerHTML = html;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function renderResults() {
  if (!results.length) {
    resultsBox.innerHTML = '<div class="empty">暂无数据</div>';
    return;
  }
  const shown = results.slice(-RENDER_CAP);
  let rows = '';
  for (const r of shown) {
    rows += `<tr><td class="lv">${r.level}</td><td>${escapeHtml(r.seed)}</td><td>${escapeHtml(r.word)}</td></tr>`;
  }
  const folded = results.length - shown.length;
  const note = folded > 0
    ? `<div class="empty">（已折叠前 ${folded} 条，完整数据见导出）</div>`
    : '';
  resultsBox.innerHTML =
    `<table><thead><tr><th>层</th><th>种子词</th><th>下拉词</th></tr></thead><tbody>${rows}</tbody></table>${note}`;
}

function pushResults(list) {
  let added = false;
  for (const r of list) {
    if (!wordsSet.has(r.word)) {
      wordsSet.add(r.word);
      results.push(r);
      added = true;
    }
  }
  if (added) {
    renderResults();
    chrome.storage.local.set({ results });
  }
}

function openKeepalive() {
  try {
    port = chrome.runtime.connect({ name: 'keepalive' });
  } catch (e) {
    port = null;
  }
}

function closeKeepalive() {
  if (port) {
    try { port.disconnect(); } catch (e) {}
    port = null;
  }
}

// 恢复上次状态
chrome.storage.local.get(['results', 'settings', 'job'], (s) => {
  if (s.results) {
    results = s.results;
    wordsSet = new Set(results.map((r) => r.word));
    renderResults();
  }
  if (s.settings) {
    if (s.settings.seeds) seedsEl.value = s.settings.seeds;
    if (s.settings.depth) depthEl.value = String(s.settings.depth);
    if (s.settings.delay) delayEl.value = String(s.settings.delay);
  }
  // 后台仍在跑：恢复运行态并保活
  if (s.job && s.job.running) {
    setRunning(true);
    const collected = s.job.results ? s.job.results.length : (s.job.collected || 0);
    setStatus(`检测到后台任务进行中…已采集 <span class="k">${collected}</span> 词`);
    openKeepalive();
  }
});

function saveSettings() {
  chrome.storage.local.set({
    settings: { seeds: seedsEl.value, depth: depthEl.value, delay: delayEl.value }
  });
}

// 接收后台进度
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'started') {
    setRunning(true);
    openKeepalive();
    setStatus('任务已开始…');
    barEl.style.width = '0%';
  } else if (msg.type === 'progress') {
    if (msg.items && msg.items.length) pushResults(msg.items);
    setStatus(
      `采集中：<span class="k">${escapeHtml(msg.current)}</span>（第 ${msg.level} 层） · 已得 ` +
      `<span class="k">${msg.collected}</span> 词 · 队列 ${msg.remaining}`
    );
    barEl.style.width = (msg.pct || 0) + '%';
  } else if (msg.type === 'warn') {
    setStatus('⚠️ ' + escapeHtml(msg.message));
  } else if (msg.type === 'finished') {
    setRunning(false);
    closeKeepalive();
    barEl.style.width = '100%';
    setStatus(`✅ 完成！共采集 <span class="k">${results.length}</span> 条下拉词。`);
  } else if (msg.type === 'radarProgress') {
    setTrendStatus('快照采集中：<span class="k">' + escapeHtml(msg.current) + '</span>…');
  } else if (msg.type === 'radarDone') {
    handleRadarDone(msg);
  } else if (msg.type === 'historyUpdate') {
    if (document.querySelector('#panelHistory.active')) loadHistory();
  }
});

startBtn.addEventListener('click', () => {
  const seeds = seedsEl.value.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!seeds.length) {
    setStatus('⚠️ 请先填入至少一个种子词');
    return;
  }
  const depth = parseInt(depthEl.value, 10);
  const delay = Math.min(15000, Math.max(300, parseInt(delayEl.value, 10) || 900));
  results = [];
  wordsSet = new Set();
  renderResults();
  saveSettings();
  setRunning(true);
  barEl.style.width = '0%';
  openKeepalive();
  setStatus(`准备采集 <span class="k">${seeds.length}</span> 个种子词…`);
  chrome.runtime.sendMessage({ action: 'startBatch', seeds, depth, delay }, (resp) => {
    if (chrome.runtime.lastError || !resp || !resp.ok) {
      setStatus('⚠️ 启动失败：' + ((resp && resp.error) || '后台无响应'));
      setRunning(false);
      closeKeepalive();
    }
  });
});

stopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'stopBatch' });
  setStatus('已发送停止信号…');
});

currentBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/xiaohongshu\.com/.test(tab.url || '')) {
    setStatus('⚠️ 请先切到小红书页面，并在搜索框输入、展开下拉');
    return;
  }
  const firstSeed = (seedsEl.value.split('\n').map((s) => s.trim()).find(Boolean)) || '';
  setStatus('正在读取当前下拉框…' + (firstSeed ? '（页面无下拉时会自动输入「' + firstSeed + '」触发）' : ''));
  chrome.tabs.sendMessage(tab.id, { action: 'collectCurrent', keyword: firstSeed }, (resp) => {
    if (chrome.runtime.lastError || !resp || !resp.ok) {
      setStatus('⚠️ 读取失败：' + ((resp && resp.error) || '页面未就绪'));
      return;
    }
    if (!resp.suggestions.length) {
      setStatus('未检测到下拉词，请先在搜索框输入并展开下拉');
      return;
    }
    pushResults(resp.suggestions.map((w) => ({ seed: '(当前)', level: 0, word: w })));
    setStatus(`✅ 已采集当前下拉 <span class="k">${resp.suggestions.length}</span> 词`);
  });
});

$('diagnose').addEventListener('click', () => {
  const kw = (seedsEl.value.split('\n').map((s) => s.trim()).find(Boolean)) || '虾仁';
  setStatus('诊断中：输入「' + escapeHtml(kw) + '」并截获联想请求…');
  chrome.runtime.sendMessage({ action: 'diagnose', keyword: kw }, (resp) => {
    if (chrome.runtime.lastError || !resp || !resp.ok) {
      setStatus('⚠️ 诊断失败：' + ((resp && resp.error) || '无响应'));
      return;
    }
    // 完整诊断信息复制到剪贴板
    const full = JSON.stringify(resp, null, 2);
    try { navigator.clipboard.writeText(full).then(() => {}, () => {}); } catch (e) {}

    const lines = [];
    lines.push('拦截器：' + (resp.patched ? '✅ 已注入' : '❌ 未注入（请刷新小红书页面）'));
    lines.push('搜索框：' + (resp.hasInput ? '✅ 已找到' : '❌ 未找到'));
    lines.push('数据源：' + (SOURCE_ZH[resp.source] || '无'));
    if (resp.captureUrl) lines.push('接口：' + escapeHtml(resp.captureUrl.slice(0, 90)));
    lines.push('词数：' + ((resp.words && resp.words.length) || 0));
    if (resp.note) lines.push(escapeHtml(resp.note));
    if (resp.netLog && resp.netLog.length) {
      const interesting = resp.netLog.filter((u) => /search|suggest|recommend|keyword|input|hot|associat|autocomplete/i.test(u)).slice(-10);
      lines.push('相关请求(' + interesting.length + ')：');
      interesting.forEach((u) => lines.push(' · ' + escapeHtml(u.slice(0, 110))));
      if (!interesting.length) lines.push('⚠️ 输入期间无搜索/联想类请求 → 合成输入未触发联想');
    } else {
      lines.push('网络日志：空');
    }
    if (resp.words && resp.words.length) {
      pushResults(resp.words.slice(0, 20).map((w) => ({ seed: '(诊断)', level: 0, word: w })));
    }
    lines.push('<br><b>📋 已复制完整诊断到剪贴板，请粘贴给我</b>');
    setStatus(lines.join('<br>'));
  });
});

function csvCell(v) {
  let s = String(v).replace(/"/g, '""');
  // 防 Excel 公式注入（= + - @ 开头）
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return /[",\n]/.test(s) ? '"' + s + '"' : s;
}

function buildCsv() {
  let csv = '种子词,层级,下拉词\n';
  for (const r of results) {
    csv += `${csvCell(r.seed)},${r.level},${csvCell(r.word)}\n`;
  }
  return '\uFEFF' + csv; // BOM 保证 Excel 中文不乱码
}

function uniqueWords() {
  return Array.from(new Set(results.map((r) => r.word)));
}

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function download(filename, content, mime) {
  // 优先用 Blob URL：避免数万行 CSV 时 data: URI 长度上限导致导出失败
  try {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename, saveAs: true }, () => {
      if (chrome.runtime.lastError) setStatus('⚠️ 导出失败：' + chrome.runtime.lastError.message);
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    });
  } catch (e) {
    // 兜底：Blob 不可用时退回 data URI
    const url = 'data:' + mime + ',' + encodeURIComponent(content);
    chrome.downloads.download({ url, filename, saveAs: true }, () => {
      if (chrome.runtime.lastError) setStatus('⚠️ 导出失败：' + chrome.runtime.lastError.message);
    });
  }
}

$('exportCsv').addEventListener('click', () => {
  if (!results.length) {
    setStatus('暂无数据可导出');
    return;
  }
  download('xhs_dropdown_' + ts() + '.csv', buildCsv(), 'text/csv;charset=utf-8');
});

$('exportTxt').addEventListener('click', () => {
  if (!results.length) {
    setStatus('暂无数据可导出');
    return;
  }
  download('xhs_dropdown_' + ts() + '.txt', uniqueWords().join('\n'), 'text/plain;charset=utf-8');
});

$('copyWords').addEventListener('click', () => {
  if (!results.length) {
    setStatus('暂无数据可复制');
    return;
  }
  const words = uniqueWords();
  const text = words.join('\n');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(
      () => setStatus('✅ 已复制 ' + words.length + ' 个去重词到剪贴板'),
      () => setStatus('⚠️ 复制失败，请检查浏览器剪贴板权限')
    );
  } else {
    setStatus('⚠️ 当前环境不支持剪贴板，请改用「导出 TXT」');
  }
});

$('clear').addEventListener('click', () => {
  results = [];
  wordsSet = new Set();
  renderResults();
  chrome.storage.local.remove(['results']);
  barEl.style.width = '0%';
  setStatus('已清空结果');
});

// ============ 趋势雷达 ============
const trendStatusEl = $('trendStatus');
const newBox = $('newBox');
const trendBox = $('trendBox');
const newCountEl = $('newCount');
const histEl = $('hist');
let lastTrend = null; // { summary, scored, diff }

function setTrendStatus(html) { trendStatusEl.innerHTML = html; }

// 标签切换
document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    $('panel' + t.dataset.tab.charAt(0).toUpperCase() + t.dataset.tab.slice(1)).classList.add('active');
    if (t.dataset.tab === 'trend') loadTrend();
    if (t.dataset.tab === 'history') loadHistory();
    if (t.dataset.tab === 'account') loadAccount();
  });
});

function renderTrend(data) {
  lastTrend = data;
  // 新增词
  const nw = (data.diff && data.diff.newWords) || [];
  newCountEl.textContent = nw.length;
  if (!nw.length) {
    newBox.innerHTML = '<div class="empty">今日无新增（或尚无昨天快照）</div>';
  } else {
    newBox.innerHTML = nw.slice(0, 40).map((w) =>
      `<span class="chip">${escapeHtml(w.word)}</span>`).join('') ;
  }
  // 上升分排序
  const scored = data.scored || [];
  if (!scored.length) {
    trendBox.innerHTML = '<div class="empty">暂无快照，先点「立即快照」</div>';
  } else {
    let rows = '';
    for (const s of scored.slice(0, 80)) {
      const tag = s.isNew ? '<span class="tag-new">新</span>' : '<span class="tag-keep">·</span>';
      rows += `<tr><td class="tag">${tag}</td><td>${escapeHtml(s.seed)}</td><td>${escapeHtml(s.word)}</td><td class="sc">${s.score}</td></tr>`;
    }
    trendBox.innerHTML = `<table><thead><tr><th></th><th>种子</th><th>下拉词</th><th>分</th></tr></thead><tbody>${rows}</tbody></table>`;
  }
  // 近7日词量柱图
  const sm = data.summary || [];
  const last7 = sm.slice(-7);
  if (!last7.length) {
    histEl.innerHTML = '<span style="font-size:10px;color:var(--muted);">无历史</span>';
  } else {
    const max = Math.max(1, ...last7.map((x) => x.total));
    histEl.innerHTML = last7.map((x) => {
      const h = Math.round((x.total / max) * 30);
      return `<div style="display:flex;flex-direction:column;flex:1;align-items:center;">
        <i style="height:${h}px;"></i>
        <span>${String(x.date).slice(5)}</span>
      </div>`;
    }).join('');
  }
}

function loadTrend() {
  setTrendStatus('加载趋势…');
  chrome.runtime.sendMessage({ action: 'getTrend' }, (resp) => {
    if (chrome.runtime.lastError || !resp || !resp.ok) {
      setTrendStatus('⚠️ ' + ((resp && resp.error) || '无响应'));
      return;
    }
    renderTrend(resp);
    const nw = (resp.diff && resp.diff.newWords && resp.diff.newWords.length) || 0;
    setTrendStatus(nw ? `今日新增 <span class="k">${nw}</span> 个下拉词` : '已加载。点「立即快照」采集今天数据。');
  });
}

function handleRadarDone(msg) {
  if (msg.res && msg.res.ok) {
    setTrendStatus('✅ 快照完成：新增 <span class="k">' + (msg.res.diff.newWords.length) + '</span> 词');
    loadTrend();
  } else if (msg.newCount != null) {
    setTrendStatus('定时快照完成：新增 <span class="k">' + msg.newCount + '</span> 词');
    loadTrend();
  } else {
    setTrendStatus('⚠️ 快照失败：' + ((msg.res && msg.res.error) || '未知'));
  }
}

$('snapNow').addEventListener('click', () => {
  setTrendStatus('快照采集中…（保持弹窗打开）');
  openKeepalive();
  chrome.runtime.sendMessage({ action: 'snapshotNow' }, (resp) => {
    if (chrome.runtime.lastError || !resp || !resp.ok) {
      setTrendStatus('⚠️ ' + ((resp && resp.error) || '启动失败'));
      closeKeepalive();
    }
  });
});

// 定时设置
chrome.runtime.sendMessage({ action: 'getSchedule' }, (resp) => {
  if (resp && resp.ok && resp.schedule) {
    $('schOn').checked = !!resp.schedule.enabled;
    const h = String(resp.schedule.hour || 9).padStart(2, '0');
    const m = String(resp.schedule.minute || 0).padStart(2, '0');
    $('schTime').value = h + ':' + m;
  }
});

$('schSave').addEventListener('click', () => {
  const on = $('schOn').checked;
  const [h, m] = $('schTime').value.split(':').map((x) => parseInt(x, 10));
  const schedule = { enabled: on, hour: isNaN(h) ? 9 : h, minute: isNaN(m) ? 0 : m, delay: 900 };
  chrome.runtime.sendMessage({ action: 'setSchedule', schedule }, (resp) => {
    setTrendStatus(resp && resp.ok ? '✅ 已保存定时：' + (on ? $('schTime').value + ' 每日' : '已关闭定时') : '⚠️ 保存失败');
  });
});

$('exportTrend').addEventListener('click', () => {
  if (!lastTrend || !(lastTrend.scored || []).length) { setTrendStatus('暂无趋势数据，先快照'); return; }
  let csv = '下拉词,种子,位次,连续天数,是否新增,上升分\n';
  for (const s of lastTrend.scored) {
    csv += `${csvCell(s.word)},${csvCell(s.seed)},${s.pos},${s.days},${s.isNew ? '是' : '否'},${s.score}\n`;
  }
  download('xhs_trend_' + ts() + '.csv', '\uFEFF' + csv, 'text/csv;charset=utf-8');
});

$('clearTrend').addEventListener('click', () => {
  if (!confirm('清空所有快照历史？')) return;
  chrome.storage.local.remove(['radar.snapshots'], () => {
    lastTrend = null;
    newBox.innerHTML = '<div class="empty">—</div>';
    trendBox.innerHTML = '<div class="empty">暂无快照</div>';
    histEl.innerHTML = '<span style="font-size:10px;color:var(--muted);">无历史</span>';
    newCountEl.textContent = '0';
    setTrendStatus('已清空快照历史');
  });
});

// ============ 历史记录 ============
const histBox = $('histBox');
const histDetail = $('histDetail');
const histStatus = $('histStatus');
let histList = [];

function fmtTs(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function loadHistory() {
  chrome.runtime.sendMessage({ action: 'getHistory' }, (resp) => {
    if (chrome.runtime.lastError || !resp || !resp.ok) { histStatus.textContent = '⚠️ 读取失败'; return; }
    histList = resp.history || [];
    if (!histList.length) { histBox.innerHTML = '<div class="empty">暂无历史，采集或快照后自动记录</div>'; return; }
    let rows = '';
    for (const e of histList) {
      rows += `<tr data-id="${e.id}"><td>${escapeHtml(fmtTs(e.ts))}</td><td>${escapeHtml(e.kind)}</td><td>${escapeHtml(e.title)}</td><td>${escapeHtml(e.detail)}</td></tr>`;
    }
    histBox.innerHTML = `<table><thead><tr><th>时间</th><th>类型</th><th>概要</th><th>结果</th></tr></thead><tbody>${rows}</tbody></table>`;
    histBox.querySelectorAll('tr[data-id]').forEach((tr) => {
      tr.addEventListener('click', () => showHistDetail(tr.dataset.id));
    });
  });
}

function showHistDetail(id) {
  const e = histList.find((x) => x.id === id);
  if (!e) return;
  let html = `<div style="padding:8px 10px;font-size:12px;"><b>${escapeHtml(e.kind)} · ${escapeHtml(e.title)}</b>（${fmtTs(e.ts)}）`;
  const p = e.payload || {};
  if (p.type === 'batch' && p.results) {
    const words = p.results.slice(0, 100);
    html += `<br>共 ${p.results.length} 词：<br>` + words.map((r) => `<span class="chip">${escapeHtml(r.word)}</span>`).join('');
  } else if (p.newWords) {
    html += `<br>新增 ${p.newWords.length} 词：<br>` + p.newWords.slice(0, 50).map((w) => `<span class="chip">${escapeHtml(w.word || w)}</span>`).join('');
  }
  html += `<div style="margin-top:10px;"><button id="delHistBtn" class="btn-line" data-id="${escapeHtml(e.id)}">🗑 删除这条</button></div>`;
  html += '</div>';
  histDetail.style.display = 'block';
  histDetail.innerHTML = html;
  const delBtn = $('delHistBtn');
  if (delBtn) delBtn.addEventListener('click', () => {
    if (!confirm('删除这条历史（已登录则同步删除云端）？')) return;
    chrome.runtime.sendMessage({ action: 'deleteHistory', id: e.id }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.ok) { histStatus.textContent = '⚠️ 删除失败'; return; }
      histDetail.style.display = 'none';
      loadHistory();
      histStatus.textContent = resp.deleted ? '已删除该条历史' : '未找到该条记录';
    });
  });
}

// 把历史记录展开为 CSV 行：兼容 采集批次(batch.results) 与 每日快照(snapshot.data)
function expandHistoryRows(hist) {
  const rows = [];
  for (const e of hist) {
    const t = fmtTs(e.ts);
    const p = e.payload || {};
    let added = false;
    if (p.type === 'batch' && Array.isArray(p.results)) {
      for (const r of p.results) { rows.push([t, e.kind, e.title, r.seed, r.level, r.word]); added = true; }
    } else if (p.type === 'snapshot' && p.data && typeof p.data === 'object') {
      for (const seed of Object.keys(p.data)) {
        const arr = p.data[seed] || [];
        for (const x of arr) {
          rows.push([t, e.kind, e.title, seed, '', typeof x === 'string' ? x : ((x && x.w) || '')]);
          added = true;
        }
      }
    }
    if (!added) rows.push([t, e.kind, e.title, '', '', '']); // 无明细的条目退化为单行
  }
  return rows;
}

function buildHistoryCsv(hist) {
  const rows = expandHistoryRows(hist);
  let csv = '记录时间,类型,概要,种子词,层级,下拉词\n';
  for (const row of rows) csv += row.map(csvCell).join(',') + '\n';
  return '﻿' + csv; // BOM 保证 Excel 中文不乱码
}

$('exportHist').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'getHistory' }, (resp) => {
    if (chrome.runtime.lastError || !resp || !resp.ok) { histStatus.textContent = '⚠️ 读取失败'; return; }
    const hist = resp.history || [];
    if (!hist.length) { histStatus.textContent = '暂无历史可导出，先去采集或快照'; return; }
    const rows = expandHistoryRows(hist);
    const wordCount = rows.filter((r) => r[3] !== '' || r[5] !== '').length;
    download('xhs_history_' + ts() + '.csv', buildHistoryCsv(hist), 'text/csv;charset=utf-8');
    histStatus.textContent = `✅ 已导出 ${hist.length} 条历史（展开 ${wordCount} 个下拉词）`;
  });
});

$('refreshHist').addEventListener('click', loadHistory);
$('syncHist').addEventListener('click', () => {
  histStatus.textContent = '从云端同步中…';
  chrome.runtime.sendMessage({ action: 'syncHistory' }, (resp) => {
    if (resp && resp.ok) { histStatus.textContent = `同步完成，拉取 ${resp.pulled} 条`; loadHistory(); }
    else histStatus.textContent = '⚠️ 同步失败（未登录或未配置）';
  });
});
$('clearHist').addEventListener('click', () => {
  if (!confirm('清空本地历史（不影响云端）？')) return;
  chrome.runtime.sendMessage({ action: 'clearHistory' }, () => { loadHistory(); histDetail.style.display = 'none'; histStatus.textContent = '已清空本地历史'; });
});

// ============ 账号登录 ============
function loadAccount() {
  chrome.runtime.sendMessage({ action: 'sbGetSession' }, (resp) => {
    if (!resp || !resp.ok) return;
    refreshAcctUI(resp.session, resp.user);
  });
}
function refreshAcctUI(session, user) {
  $('acctAuth').style.display = session ? 'none' : 'block';
  $('acctInfo').style.display = session ? 'block' : 'none';
  if (session && user) $('acctStatus').innerHTML = '已登录：<span class="k">' + escapeHtml(user.email || '已登录') + '</span>，数据将自动云同步';
}

$('sbSignupBtn').addEventListener('click', () => {
  const email = $('sbEmail').value.trim();
  const password = $('sbPass').value;
  if (!email || !password) { $('acctStatus').textContent = '⚠️ 填邮箱和密码'; $('acctInfo').style.display='block'; return; }
  chrome.runtime.sendMessage({ action: 'sbSignup', email, password }, (resp) => {
    if (resp && resp.ok) { $('acctStatus').textContent = '✅ 注册成功，已登录'; loadAccount(); }
    else { $('acctStatus').textContent = '⚠️ ' + ((resp && resp.error) || '失败'); $('acctInfo').style.display='block'; }
  });
});

$('sbLoginBtn').addEventListener('click', () => {
  const email = $('sbEmail').value.trim();
  const password = $('sbPass').value;
  if (!email || !password) { $('acctStatus').textContent = '⚠️ 填邮箱和密码'; $('acctInfo').style.display='block'; return; }
  chrome.runtime.sendMessage({ action: 'sbLogin', email, password }, (resp) => {
    if (resp && resp.ok) { $('acctStatus').textContent = '✅ 登录成功'; loadAccount(); }
    else { $('acctStatus').textContent = '⚠️ ' + ((resp && resp.error) || '失败'); $('acctInfo').style.display='block'; }
  });
});

$('sbLogoutBtn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'sbLogout' }, () => { loadAccount(); });
});
