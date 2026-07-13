// content.js —— 运行在小红书页面内：网络拦截(主) + DOM 读取(兜底)
(function () {
  'use strict';

  // 防止重复注入（manifest 注入 + 按需 executeScript 注入 共存时只注册一次）
  if (window.__xhsContentReady) return;
  window.__xhsContentReady = true;

  const SELECTORS = {
    inputs: [
      '#search-input',
      'input[type="search"]',
      '.search-input input',
      'input[placeholder*="搜索"]',
      'input[placeholder*="小红书"]',
      '.header-search input',
      '#search-input input'
    ],
    containers: [
      '.sug-container-wrapper',
      '.search-suggest-container',
      '[class*="sug-container"]',
      '[class*="suggest-container"]',
      '[class*="search-suggest"]',
      '[class*="associat"]'
    ],
    items: [
      '.sug-item',
      '[class*="sug-item"]',
      '.suggest-item',
      '[class*="suggest-item"]',
      '[class*="associat"] .item',
      '[class*="associat"] li'
    ]
  };

  const WORD_KEYS = ['name', 'word', 'text', 'keyword', 'title', 'query', 'suggest', 'content', 'value', 'label', 'term'];

  let lastCapture = null; // { url, data, ts }

  // 接收主世界 inject.js 截到的联想响应
  window.addEventListener('xhs-sug-captured', function (e) {
    lastCapture = { url: e.detail.url, data: e.detail.data, ts: Date.now() };
  });

  function sleep(ms) {
    return new Promise((r) => window.setTimeout(r, ms));
  }

  function isVisible(el) {
    if (!el) return false;
    try {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    } catch (e) {
      return true; // 取不到样式时不据此判否
    }
    return true;
  }

  // 把容器归一成真正的 <input>/<textarea>：选择器可能命中 div 容器
  function asInput(el) {
    if (!el) return null;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return el;
    try { return el.querySelector('input, textarea') || null; } catch (e) { return null; }
  }

  function findInput() {
    const candidates = [];
    const seen = new Set();
    const push = (el) => {
      const inp = asInput(el);
      if (inp && !seen.has(inp)) { seen.add(inp); candidates.push(inp); }
    };
    for (const sel of SELECTORS.inputs) document.querySelectorAll(sel).forEach(push);
    document.querySelectorAll('input[role="searchbox"], input[type="search"]').forEach(push);
    for (const el of candidates) if (isVisible(el)) return el;
    return candidates[0] || null;
  }

  function setInputValue(input, value) {
    // 按元素类型取正确的原生 setter，避免在非 input 元素上调用抛 Illegal invocation
    const proto = (input.tagName === 'TEXTAREA') ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    try {
      if (desc && desc.set) desc.set.call(input, value);
      else input.value = value;
    } catch (e) {
      input.value = value; // 兜底
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function extractSuggestionsDOM() {
    let items = [];
    for (const cSel of SELECTORS.containers) {
      const container = document.querySelector(cSel);
      if (!container) continue;
      for (const iSel of SELECTORS.items) {
        const found = container.querySelectorAll(iSel);
        if (found.length) { items = Array.from(found); break; }
      }
      if (items.length) break;
    }
    if (!items.length) {
      for (const iSel of SELECTORS.items) {
        const found = document.querySelectorAll(iSel);
        if (found.length) { items = Array.from(found); break; }
      }
    }
    const seen = new Set();
    const result = [];
    for (const it of items) {
      const text = (it.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      result.push(text);
    }
    return result;
  }

  // 从联想 API 响应里递归提取词
  function extractWordsFromData(data) {
    const out = [];
    const seen = new Set();
    function walk(node) {
      if (node == null) return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (typeof node === 'object') {
        for (const k of WORD_KEYS) {
          if (typeof node[k] === 'string' && node[k].trim()) {
            const v = node[k].trim();
            if (v.length <= 60 && !seen.has(v)) { seen.add(v); out.push(v); }
          }
        }
        for (const k in node) walk(node[k]);
      }
    }
    walk(data);
    return out;
  }

  async function waitForCapture(prevTs, timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (lastCapture && lastCapture.ts > prevTs) return lastCapture;
      await sleep(150);
    }
    return null;
  }

  async function waitForSuggestionsDOM(timeout) {
    const start = Date.now();
    let lastCount = -1;
    let stable = 0;
    while (Date.now() - start < timeout) {
      const s = extractSuggestionsDOM();
      if (s.length > 0) {
        if (s.length === lastCount) {
          stable++;
          if (stable >= 2) return s;
        } else {
          stable = 0;
          lastCount = s.length;
        }
      }
      await sleep(220);
    }
    return extractSuggestionsDOM();
  }

  async function typeInto(input, keyword) {
    input.focus();
    setInputValue(input, '');
    await sleep(150);
    for (const ch of keyword) {
      const cur = input.value || '';
      setInputValue(input, cur + ch);
      await sleep(60);
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  async function collectFor(keyword) {
    const input = findInput();
    if (!input) return { ok: false, error: '未找到搜索框，请确认在小红书页面并已登录' };
    const prevTs = lastCapture ? lastCapture.ts : 0;
    await typeInto(input, keyword);
    // 主路径：等网络截获
    const cap = await waitForCapture(prevTs, 5000);
    let words = [];
    let source = 'none';
    let rawSample = '';
    if (cap) {
      words = extractWordsFromData(cap.data);
      source = words.length ? 'network' : 'network-empty';
      try { rawSample = JSON.stringify(cap.data).slice(0, 1500); } catch (e) { rawSample = String(cap.data).slice(0, 1500); }
    }
    // 兜底：DOM 读取
    const domWords = await waitForSuggestionsDOM(2500);
    const merged = [];
    const seen = new Set();
    for (const w of words) if (!seen.has(w)) { seen.add(w); merged.push(w); }
    for (const w of domWords) if (!seen.has(w)) { seen.add(w); merged.push(w); }
    if (!merged.length && domWords.length) { for (const w of domWords) merged.push(w); }
    if (source === 'none' && domWords.length) source = 'dom';

    const kw = keyword.trim().toLowerCase();
    const filtered = merged.filter((s) => s.trim().toLowerCase() !== kw);
    setInputValue(input, '');
    return { ok: true, keyword, suggestions: filtered, source, rawSample, captureUrl: cap ? cap.url : '' };
  }

  async function collectCurrent(keyword) {
    // 主路径：直接读已展开的下拉（用户在页面已输入）
    let dom = await waitForSuggestionsDOM(2000);
    // 兜底：页面无下拉时，自动用页面已有输入或种子词触发联想，再读，降低手动门槛
    if (!dom.length) {
      const input = findInput();
      const cur = input ? (input.value || '').trim() : '';
      const kw = cur || keyword;
      if (kw && input) {
        await typeInto(input, kw);
        dom = await waitForSuggestionsDOM(3000);
      }
    }
    return { ok: true, suggestions: dom };
  }

  async function diagnose(testKeyword) {
    const input = findInput();
    const info = { hasInput: !!input, inputHtml: '', domSnippets: [], captureUrl: '', words: [], rawSample: '', source: 'none' };
    if (!input) return { ok: true, ...info, note: '未找到搜索框（选择器未命中或未登录）' };
    info.inputHtml = input.outerHTML.slice(0, 400);
    const prevTs = lastCapture ? lastCapture.ts : 0;
    await typeInto(input, testKeyword || '虾仁');
    const cap = await waitForCapture(prevTs, 5000);
    if (cap) {
      info.captureUrl = cap.url;
      info.words = extractWordsFromData(cap.data);
      info.source = info.words.length ? 'network' : 'network-empty';
      try { info.rawSample = JSON.stringify(cap.data).slice(0, 1500); } catch (e) { info.rawSample = String(cap.data).slice(0, 1500); }
    }
    const dom = await waitForSuggestionsDOM(2000);
    if (dom.length) {
      const seen = new Set(info.words);
      for (const w of dom) if (!seen.has(w)) { info.words.push(w); }
      if (info.source === 'none') info.source = 'dom';
    }
    // 采集下拉相关 DOM 片段，便于定位真实选择器
    const snipSeen = new Set();
    document.querySelectorAll('[class*="sug"],[class*="suggest"],[class*="recommend"],[class*="associat"],[class*="search-panel"]').forEach(function (el) {
      const key = el.className || el.tagName;
      if (snipSeen.has(key)) return;
      snipSeen.add(key);
      if (info.domSnippets.length < 6) info.domSnippets.push('[' + (el.className || el.tagName) + '] ' + el.outerHTML.slice(0, 220));
    });
    setInputValue(input, '');
    return { ok: true, ...info };
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'collectFor') {
      collectFor(request.keyword)
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      return true;
    }
    if (request.action === 'collectCurrent') {
      collectCurrent(request.keyword)
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      return true;
    }
    if (request.action === 'ping') {
      sendResponse({ ok: true, hasInput: !!findInput() });
      return;
    }
    if (request.action === 'diagnose') {
      diagnose(request.keyword)
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      return true;
    }
  });
})();
