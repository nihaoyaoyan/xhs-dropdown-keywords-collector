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
    setStatus(`检测到后台任务进行中…已采集 <span class="k">${s.job.collected || 0}</span> 词`);
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
  setStatus('正在读取当前下拉框…');
  chrome.tabs.sendMessage(tab.id, { action: 'collectCurrent' }, (resp) => {
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
    lines.push('数据源：' + (resp.source || 'none'));
    if (resp.captureUrl) lines.push('接口：' + escapeHtml(resp.captureUrl.slice(0, 90)));
    lines.push('词数：' + ((resp.words && resp.words.length) || 0));
    if (resp.note) lines.push(escapeHtml(resp.note));
    if (resp.netLog && resp.netLog.length) {
      const interesting = resp.netLog.filter((u) => /search|suggest|recommend|keyword|input|hot|associat|autocomplete/i.test(u)).slice(-10);
      lines.push('相关请求(' + interesting.length + ')：');
      interesting.forEach((u) => lines.push(' · ' + escapeHtml(u.slice(0, 110))));
      if (!interesting.length) lines.push('⚠️ 输入期间无 search/recommend 类请求 → 合成输入未触发联想');
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
  const url = 'data:' + mime + ',' + encodeURIComponent(content);
  chrome.downloads.download({ url, filename, saveAs: true }, () => {
    if (chrome.runtime.lastError) {
      setStatus('⚠️ 导出失败：' + chrome.runtime.lastError.message);
    }
  });
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

$('clear').addEventListener('click', () => {
  results = [];
  wordsSet = new Set();
  renderResults();
  chrome.storage.local.remove(['results']);
  barEl.style.width = '0%';
  setStatus('已清空结果');
});
