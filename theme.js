'use strict';
/*
 * 主题系统（第一性原理重构）
 * 不变量：applyTheme 是设置 data-theme 的唯一出口；initialized 标记防止异步回调覆盖用户切换；
 * chrome.storage 优先（扩展环境跨窗口同步），localStorage 兜底（独立预览文件持久化）。
 *
 * 必须作为外部脚本引入（<script src="theme.js"></script>）——
 * Chrome MV3 CSP 默认禁止内联脚本 'unsafe-inline'。
 */
(function () {
  var root = document.documentElement;
  var KEY = 'xhsTheme';
  var initialized = false;

  function resolveSystem() {
    return (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  }

  // 唯一应用函数：写属性 + 同步按钮图标
  function applyTheme(t) {
    if (t === 'dark') root.setAttribute('data-theme', 'dark');
    else root.removeAttribute('data-theme'); // 移除属性 = 回到 :root 浅色默认
    var btn = document.getElementById('themeToggle');
    if (btn) btn.textContent = (t === 'dark') ? '☀️' : '🌙';
  }

  function persist(t) {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ [KEY]: t });
      } else if (typeof localStorage !== 'undefined') {
        localStorage.setItem(KEY, t);
      }
    } catch (e) {}
  }

  function readStored(cb) {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get([KEY], function (s) { cb(s && s[KEY] ? s[KEY] : null); });
        return;
      }
    } catch (e) {}
    try { cb(localStorage.getItem(KEY) || null); }
    catch (e) { cb(null); }
  }

  // 切换：取反当前态，立即应用 + 持久化，并标记已初始化（防异步回调覆盖）
  function toggleTheme() {
    initialized = true;
    var now = root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    var next = now === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    persist(next);
  }

  // 1) 同步初始化（防 FOUC 闪烁）：先用系统偏好立即上色
  applyTheme(resolveSystem());

  // 2) 异步校正：读存储覆盖系统偏好；若用户已手动切换则跳过
  readStored(function (stored) {
    if (initialized) return;
    applyTheme(stored || resolveSystem());
    initialized = true;
  });

  // 3) DOM 就绪后绑定点击（脚本在 head，此时按钮可能尚未解析）
  function bindToggle() {
    var btn = document.getElementById('themeToggle');
    if (btn) btn.addEventListener('click', toggleTheme);
  }
  if (document.readyState !== 'loading') bindToggle();
  else document.addEventListener('DOMContentLoaded', bindToggle);

  // 4) 跟随系统偏好变化（仅当用户未手动设置时）
  if (window.matchMedia) {
    try {
      matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function (e) {
        readStored(function (stored) { if (!stored) applyTheme(e.matches ? 'dark' : 'light'); });
      });
    } catch (e) {}
  }
})();
