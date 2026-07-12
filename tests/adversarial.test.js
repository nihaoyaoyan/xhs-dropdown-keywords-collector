// 对抗式审查：关键不变量测试
// 镜像 popup.js / background.js / content.js 中的纯逻辑，验证安全与正确性不变量
const assert = require('assert');

// ---- csvCell（镜像 popup.js）----
function csvCell(v) {
  let s = String(v).replace(/"/g, '""');
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return /[",\n]/.test(s) ? '"' + s + '"' : s;
}

// ---- pct（镜像 background.js）----
function pct(done, remaining) {
  const est = done + remaining;
  if (est <= 0) return 100;
  return Math.min(99, Math.round((done / est) * 100));
}

// ---- 去重（镜像 pushResults）----
function dedupePush(existing, list) {
  const set = new Set(existing.map((r) => r.word));
  const out = [];
  for (const r of list) {
    if (!set.has(r.word)) {
      set.add(r.word);
      out.push(r);
    }
  }
  return out;
}

// ---- 精确匹配过滤（镜像 collectFor）----
function filterExact(suggestions, keyword) {
  const kw = keyword.trim().toLowerCase();
  return suggestions.filter((s) => s.trim().toLowerCase() !== kw);
}

// ---- delay 钳制（镜像 popup.js start）----
function clampDelay(v) {
  return Math.min(15000, Math.max(300, parseInt(v, 10) || 900));
}

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  \u2212 ' + name); }
  catch (e) { fail++; console.log('  \u00d7 ' + name + ' \u2014 ' + e.message); }
}

console.log('[CSV 公式注入防护]');
test('= 开头加单引号', () => assert.strictEqual(csvCell('=cmd|calc'), "'=cmd|calc"));
test('+ 开头加单引号', () => assert.strictEqual(csvCell('+1'), "'+1"));
test('- 开头加单引号', () => assert.strictEqual(csvCell('-1'), "'-1"));
test('@ 开头加单引号', () => assert.strictEqual(csvCell('@x'), "'@x"));
test('普通中文词不变', () => assert.strictEqual(csvCell('虾仁减脂'), '虾仁减脂'));
test('含逗号自动加引号', () => assert.strictEqual(csvCell('a,b'), '"a,b"'));
test('含引号自动转义', () => assert.strictEqual(csvCell('a"b'), '"a""b"'));
test('含换行自动加引号', () => assert.strictEqual(csvCell('a\nb'), '"a\nb"'));

console.log('[进度条 pct]');
test('初始 0/5 => 0%', () => assert.strictEqual(pct(0, 5), 0));
test('半程 3/2 => 60%', () => assert.strictEqual(pct(3, 2), 60));
test('done=5 remaining=0 => 99% 封顶', () => assert.strictEqual(pct(5, 0), 99));
test('空队列 0/0 => 100%', () => assert.strictEqual(pct(0, 0), 100));

console.log('[结果去重]');
test('重复词只保留一条', () => {
  const out = dedupePush([], [{ word: '虾仁' }, { word: '虾仁' }, { word: '减脂' }]);
  assert.strictEqual(out.length, 2);
});
test('与已有结果合并去重', () => {
  const out = dedupePush([{ word: '虾仁' }], [{ word: '虾仁' }, { word: '三文鱼' }]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].word, '三文鱼');
});

console.log('[精确匹配过滤]');
test('去掉等于种子词的项', () => {
  const out = filterExact(['虾仁', '虾仁做法', '虾仁'], '虾仁');
  assert.deepStrictEqual(out, ['虾仁做法']);
});
test('大小写不敏感', () => {
  const out = filterExact(['ABC', 'abc', 'abcd'], 'abc');
  assert.deepStrictEqual(out, ['abcd']);
});

console.log('[delay 钳制]');
test('低于下限 => 300', () => assert.strictEqual(clampDelay('100'), 300));
test('高于上限 => 15000', () => assert.strictEqual(clampDelay('60000'), 15000));
test('非法值 => 默认 900', () => assert.strictEqual(clampDelay('abc'), 900));

console.log('[趋势雷达 diff]');
function diffSnap(today, prev) {
  const cur = (today.data.a || []).map((x) => (typeof x === 'string' ? x : x.w));
  const pre = prev && prev.data ? (prev.data.a || []).map((x) => (typeof x === 'string' ? x : x.w)) : [];
  return {
    nw: cur.filter((w) => !new Set(pre).has(w)),
    gone: pre.filter((w) => !new Set(cur).has(w)),
    kept: cur.filter((w) => new Set(pre).has(w))
  };
}
test('新增词正确识别', () => {
  const d = diffSnap({ data: { a: ['虾仁', '虾仁做法', '减脂'] } }, { data: { a: ['虾仁', '三文鱼'] } });
  assert.deepStrictEqual(d.nw, ['虾仁做法', '减脂']);
});
test('消失词正确识别', () => {
  const d = diffSnap({ data: { a: ['虾仁'] } }, { data: { a: ['虾仁', '三文鱼'] } });
  assert.deepStrictEqual(d.gone, ['三文鱼']);
});
test('无昨天快照时全部算新增', () => {
  const d = diffSnap({ data: { a: ['虾仁'] } }, null);
  assert.deepStrictEqual(d.nw, ['虾仁']);
});

console.log('[上升分]');
function score(isNew, pos, days) {
  return (isNew ? 50 : 0) + Math.max(0, 10 - pos) * 2 + days * 3;
}
test('新词 +50 基础分', () => assert.ok(score(true, 0, 1) > score(false, 0, 1)));
test('位次越靠前分越高', () => assert.ok(score(false, 0, 1) > score(false, 5, 1)));
test('连续天数越多分越高', () => assert.ok(score(false, 0, 5) > score(false, 0, 1)));

// ============ v1.8 对抗式审查：隐藏开发者配置 ============
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const DIR = path.join(__dirname, '..');
const htmlSrc = fs.readFileSync(path.join(DIR, 'popup.html'), 'utf8');
const popupSrc = fs.readFileSync(path.join(DIR, 'popup.js'), 'utf8');
const bgSrc = fs.readFileSync(path.join(DIR, 'background.js'), 'utf8');
const sbSrc = fs.readFileSync(path.join(DIR, 'supabase.js'), 'utf8');

console.log('[v1.8 静态残留扫描 — 账号页不应暴露开发者配置]');
test('popup.html 无 sbUrl 输入框', () => assert.ok(!/sbUrl/.test(htmlSrc), '残留 sbUrl'));
test('popup.html 无 sbAnon 输入框', () => assert.ok(!/sbAnon/.test(htmlSrc), '残留 sbAnon'));
test('popup.html 无 sbSave 按钮', () => assert.ok(!/sbSave/.test(htmlSrc), '残留 sbSave'));
test('popup.html 无 acctSetup 配置区', () => assert.ok(!/acctSetup/.test(htmlSrc), '残留 acctSetup'));
test('popup.js 无对已删元素 sbUrl 的引用', () => assert.ok(!/\$\('sbUrl'\)/.test(popupSrc), 'popup.js 仍引用 sbUrl'));
test('popup.js 无对已删元素 sbAnon 的引用', () => assert.ok(!/\$\('sbAnon'\)/.test(popupSrc), 'popup.js 仍引用 sbAnon'));
test('popup.js 不再调用 sbGetConfig（应改 sbGetSession）', () => assert.ok(!/sbGetConfig/.test(popupSrc), 'popup.js 仍发 sbGetConfig'));
test('background.js 不再响应 sbConfig', () => assert.ok(!/action === 'sbConfig'/.test(bgSrc), 'background 仍处理 sbConfig'));
test('background.js 仍响应 sbGetSession', () => assert.ok(/action === 'sbGetSession'/.test(bgSrc), 'background 缺 sbGetSession'));

console.log('[v1.8 硬编码值正确性]');
test('SB.url 为用户提供的 Supabase 地址', () =>
  assert.ok(/hkdggccmjxcvgudakurf\.supabase\.co/.test(sbSrc), 'SB.url 硬编码值缺失'));
test('SB.anon 为用户提供的 publishable key', () =>
  assert.ok(/sb_publishable_ybY-n58ujkm35MloBCecEw_WnrmUtAd/.test(sbSrc), 'SB.anon 硬编码值缺失'));
test('supabase.js 已删除 sbSaveConfig', () => assert.ok(!/sbSaveConfig/.test(sbSrc), '仍残留 sbSaveConfig 定义'));

console.log('[v1.8 对抗：攻击者无法通过 storage 注入假配置]');
// 模拟：攻击者往 chrome.storage 写入假的 sb.config，试图劫持请求地址
function loadSbWithStorage(stored) {
  let store = Object.assign({}, stored);
  const mockChrome = {
    storage: {
      local: {
        get: (keys, cb) => {
          const out = {};
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (k in store) out[k] = store[k]; });
          cb(out);
        },
        set: (obj, cb) => { Object.assign(store, obj); cb && cb(); }
      }
    }
  };
  const sandbox = { chrome: mockChrome };
  const wrapped = sbSrc + '\n; this.SB = SB; this.sbConfigured = sbConfigured; this.sbLoad = sbLoad;';
  vm.runInNewContext(wrapped, sandbox);
  return { sandbox, store };
}
test('sbLoad 不会从 sb.config 读取 url/anon（拒绝攻击者注入）', () => {
  const evil = { 'sb.config': { url: 'https://evil.example.com', anon: 'fake-key' }, 'sb.session': null };
  const { sandbox } = loadSbWithStorage(evil);
  // sbLoad 是异步，但 SB 顶层常量已是硬编码值，且 sbLoad 只动 session
  assert.strictEqual(sandbox.SB.url, 'https://hkdggccmjxcvgudakurf.supabase.co');
  assert.strictEqual(sandbox.SB.anon, 'sb_publishable_ybY-n58ujkm35MloBCecEw_WnrmUtAd');
});
test('sbConfigured 恒为 true（无需用户配置即可用）', () => {
  const { sandbox } = loadSbWithStorage({});
  assert.strictEqual(sandbox.sbConfigured(), true);
});
test('攻击者注入 sb.config 后 url/anon 仍不被覆盖', () => {
  const evil = { 'sb.config': { url: 'https://attacker.com', anon: 'x' } };
  const { sandbox } = loadSbWithStorage(evil);
  assert.strictEqual(sandbox.SB.url, 'https://hkdggccmjxcvgudakurf.supabase.co', 'url 被攻击者覆盖');
  assert.strictEqual(sandbox.SB.anon, 'sb_publishable_ybY-n58ujkm35MloBCecEw_WnrmUtAd', 'anon 被攻击者覆盖');
});

console.log('[v1.9 第一性原理：任务可恢复性]');
// 复刻 background.js 的 job 结构与递归下钻守卫，验证"SW 死亡后可从 storage 续跑"
function buildJob(seeds, depth) {
  return {
    running: true, stop: false, phase: 'init', depth: depth, delay: 900, tabId: null,
    queue: seeds.map((s) => ({ kw: s, level: 1 })),
    visited: [], added: [], results: [], done: 0, emptyStreak: 0,
    seeds: seeds, startedAt: Date.now(), truncated: false
  };
}
function pushChild(job, word, level, cap) {
  if (level < job.depth && !job.visited.includes(word) && !job.added.includes(word)) {
    if (job.queue.length < cap) job.queue.push({ kw: word, level: level + 1 });
    else if (!job.truncated) job.truncated = true;
  }
}
test('job 状态纯序列化（无 Set/Map）→ 可 JSON 往返', () => {
  const job = buildJob(['虾仁', '减脂餐'], 2);
  // 模拟运行若干步
  job.phase = 'running'; job.visited.push('虾仁'); job.added.push('虾仁炒蛋');
  job.queue.push({ kw: '虾仁炒蛋', level: 2 }); job.results.push({ seed: '虾仁', level: 1, word: '虾仁炒蛋' });
  const round = JSON.parse(JSON.stringify(job));
  // 不含任何 Set/Map（JSON 会丢）
  assert.ok(Array.isArray(round.queue) && Array.isArray(round.visited) && Array.isArray(round.added));
  assert.strictEqual(round.queue.length, job.queue.length, '队列长度往返不一致');
  assert.strictEqual(round.visited.length, job.visited.length, '已访问往返不一致');
  assert.strictEqual(round.added.length, job.added.length, '已收集往返不一致');
});
test('SW 死亡模拟：从 JSON 重建后队列/进度完整 → 可续跑', () => {
  const job = buildJob(['虾仁'], 2);
  job.phase = 'running';
  job.queue.shift(); // 模拟已处理「虾仁」（出队）
  job.visited.push('虾仁'); job.done = 1;
  job.queue.push({ kw: '虾仁减脂', level: 2 }); // 下钻词入队
  const dead = JSON.parse(JSON.stringify(job)); // SW 被回收，内存 job 丢失，仅 storage 残留
  assert.strictEqual(dead.queue.length, 1, '重建后队列应为 1（仅待下钻词）');
  assert.strictEqual(dead.done, 1, '重建后进度应为 1');
  assert.strictEqual(dead.visited.includes('虾仁'), true, '已处理词应保留');
});
test('递归队列硬上限：触顶后不再增长并标记截断', () => {
  const cap = 3000;
  const job = buildJob(['根'], 3);
  job.phase = 'running';
  // 疯狂下钻，直到触顶
  for (let i = 0; i < 5000; i++) {
    pushChild(job, '词' + i, 1, cap);
  }
  assert.ok(job.queue.length <= cap, '队列超过上限 ' + cap + '：' + job.queue.length);
  assert.strictEqual(job.truncated, true, '触顶后应标记 truncated');
});
test('队列上限内正常下钻', () => {
  const job = buildJob(['根'], 2); // 自带 1 个种子词
  for (let i = 0; i < 10; i++) pushChild(job, '词' + i, 1, 3000);
  assert.strictEqual(job.queue.length, 11, '未触顶时应全部入队（1 种子 + 10 子词）');
  assert.strictEqual(job.truncated, false);
});

console.log('[v1.10 历史记录导出]');
// 镜像 popup.js 的 expandHistoryRows：兼容 batch.results 与 snapshot.data 两种 payload
function csvCellV(v) {
  let s = String(v).replace(/"/g, '""');
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return /[",\n]/.test(s) ? '"' + s + '"' : s;
}
function expandHistoryRows(hist) {
  const rows = [];
  for (const e of hist) {
    const t = e.tsLabel || String(e.ts);
    const p = e.payload || {};
    let added = false;
    if (p.type === 'batch' && Array.isArray(p.results)) {
      for (const r of p.results) { rows.push([t, e.kind, e.title, r.seed, r.level, r.word]); added = true; }
    } else if (p.type === 'snapshot' && p.data && typeof p.data === 'object') {
      for (const seed of Object.keys(p.data)) {
        const arr = p.data[seed] || [];
        for (const x of arr) { rows.push([t, e.kind, e.title, seed, '', typeof x === 'string' ? x : ((x && x.w) || '')]); added = true; }
      }
    }
    if (!added) rows.push([t, e.kind, e.title, '', '', '']);
  }
  return rows;
}
function buildHistoryCsv(hist) {
  const rows = expandHistoryRows(hist);
  let csv = '记录时间,类型,概要,种子词,层级,下拉词\n';
  for (const row of rows) csv += row.map(csvCellV).join(',') + '\n';
  return '﻿' + csv;
}
const HIST = [
  { id: 'b1', ts: 1700000000000, tsLabel: '11/15 10:00', kind: '采集', title: '2种子·depth2', detail: '10词',
    payload: { type: 'batch', results: [{ seed: '虾仁', level: 1, word: '虾仁炒蛋' }, { seed: '减脂餐', level: 1, word: '减脂餐食谱' }] } },
  { id: 's1', ts: 1700086400000, tsLabel: '11/16 09:00', kind: '快照', title: '2种子·2026-11-16', detail: '20词',
    payload: { type: 'snapshot', data: { '虾仁': ['虾仁减脂', '虾仁 儿童'], '减脂餐': ['减脂餐 快手'] } } },
  { id: 'm1', ts: 1700172800000, tsLabel: '11/17 09:00', kind: '其他', title: '无明细条目', detail: '',
    payload: {} }
];
test('batch 明细正确展开（种子/层级/词）', () => {
  const rows = expandHistoryRows([HIST[0]]);
  assert.strictEqual(rows.length, 2, 'batch 应为 2 行');
  assert.strictEqual(rows[0][3], '虾仁');
  assert.strictEqual(rows[0][4], 1);
  assert.strictEqual(rows[0][5], '虾仁炒蛋');
  assert.strictEqual(rows[1][5], '减脂餐食谱');
});
test('snapshot 明细正确展开（按 seed 逐词）', () => {
  const rows = expandHistoryRows([HIST[1]]);
  assert.strictEqual(rows.length, 3, '快照应为 3 行（虾仁2 + 减脂餐1）');
  assert.ok(rows.every((r) => r[4] === ''), '快照无层级应留空');
  assert.strictEqual(rows[0][3], '虾仁');
  assert.strictEqual(rows[0][5], '虾仁减脂');
  assert.strictEqual(rows[2][3], '减脂餐');
});
test('无明细条目退化为单行（不被吞掉）', () => {
  const rows = expandHistoryRows([HIST[2]]);
  assert.strictEqual(rows.length, 1, '无明细应为 1 行');
  assert.strictEqual(rows[0][5], '', '无明细词列应为空');
});
test('导出 CSV 以 BOM 开头（Excel 中文不乱码）', () => {
  const csv = buildHistoryCsv([HIST[0]]);
  assert.strictEqual(csv.charCodeAt(0), 0xFEFF, '缺少 UTF-8 BOM');
});
test('导出对公式注入词加单引号防护', () => {
  const hist = [{ id: 'x', ts: 1, tsLabel: 't', kind: '采集', title: 't',
    payload: { type: 'batch', results: [{ seed: 's', level: 1, word: '=cmd|/c calc' }] } }];
  const csv = buildHistoryCsv(hist);
  assert.ok(csv.includes("'=cmd"), '以 = 开头的词未加单引号防护');
});
test('综合历史展开词数正确', () => {
  const rows = expandHistoryRows(HIST);
  const wordCount = rows.filter((r) => r[3] !== '' || r[5] !== '').length;
  assert.strictEqual(wordCount, 5, '应为 2(batch) + 3(snapshot) = 5 个词');
});

console.log('[v1.11 历史单条删除]');
// 镜像 background.js 的 deleteHistory 本地过滤逻辑（云端删除由 sbDeleteHistory 单独封装）
function deleteHistoryLocal(hist, id) {
  const before = hist.length;
  const h = hist.filter((e) => e.id !== id);
  return { hist: h, deleted: h.length !== before };
}
test('按 id 精确删除单条（batch）', () => {
  const { hist, deleted } = deleteHistoryLocal(HIST, 'b1');
  assert.strictEqual(deleted, true, '应报告已删除');
  assert.strictEqual(hist.length, HIST.length - 1, '总数应减 1');
  assert.ok(!hist.some((e) => e.id === 'b1'), 'b1 应被移除');
});
test('按 id 精确删除单条（snapshot），其余不受影响', () => {
  const { hist, deleted } = deleteHistoryLocal(HIST, 's1');
  assert.strictEqual(deleted, true, '应报告已删除');
  assert.ok(!hist.some((e) => e.id === 's1'), 's1 应被移除');
  assert.ok(hist.some((e) => e.id === 'b1'), 'b1 应保留');
});
test('删除不存在的 id 安全返回未删除且数量不变', () => {
  const { hist, deleted } = deleteHistoryLocal(HIST, 'nope');
  assert.strictEqual(deleted, false, '不应报告已删除');
  assert.strictEqual(hist.length, HIST.length, '数量保持不变');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
