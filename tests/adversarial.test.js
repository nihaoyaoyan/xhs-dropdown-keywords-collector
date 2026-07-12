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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
