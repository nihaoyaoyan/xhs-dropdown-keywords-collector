// supabase.js —— 真正的登录注册 + 云同步（Supabase Auth + PostgREST），被 background.js importScripts
// URL 与 anon key 已内置，无需用户配置；未登录时所有云功能优雅降级为本地模式
const SB = {
  url: 'https://hkdggccmjxcvgudakurf.supabase.co',
  anon: 'sb_publishable_ybY-n58ujkm35MloBCecEw_WnrmUtAd',
  session: null
};

// Supabase 返回的英文报错 → 中文（覆盖高频场景，未命中则原样返回）
const SB_ERR_MAP = [
  [/invalid login credentials/i, '邮箱或密码错误'],
  [/email not confirmed/i, '邮箱尚未验证，请先查收验证邮件并点击链接激活'],
  [/user already registered/i, '该邮箱已注册，请直接登录'],
  [/email rate limit exceeded/i, '操作过于频繁，请约 60 秒后再试'],
  [/for security purposes.*request this after/i, '操作过于频繁，请约 60 秒后再试'],
  [/only request this after/i, '操作过于频繁，请稍候再试'],
  [/signup requires a valid password/i, '请输入有效密码（至少 6 位）'],
  [/password should be at least (\d+) characters/i, '密码至少需 $1 位'],
  [/unable to validate email address/i, '邮箱格式不正确'],
  [/invalid format/i, '邮箱格式不正确'],
  [/user not found/i, '用户不存在'],
  [/email logins are not enabled/i, '该登录方式未开启（请在 Supabase 后台 → Auth → Providers 开启 Email 登录）'],
  [/for security purposes/i, '操作过于频繁，请稍候再试']
];
function sbErrZh(msg) {
  if (!msg || typeof msg !== 'string') return msg;
  for (const [re, zh] of SB_ERR_MAP) {
    if (re.test(msg)) return zh;
  }
  return msg;
}

async function sbLoad() {
  // URL 与 anon key 已内置，仅从本地恢复登录会话
  return new Promise((resolve) => {
    chrome.storage.local.get(['sb.session'], (s) => {
      SB.session = s['sb.session'] || null;
      resolve();
    });
  });
}
async function sbSaveSession(s) {
  SB.session = s;
  await chrome.storage.local.set({ 'sb.session': s });
}

function sbConfigured() { return true; } // URL 与 key 已内置，始终可用

async function sbRefresh() {
  if (!SB.session || !SB.session.refresh_token) return false;
  try {
    const resp = await fetch(SB.url + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      headers: { apikey: SB.anon, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: SB.session.refresh_token })
    });
    if (!resp.ok) { await sbSaveSession(null); return false; }
    const data = await resp.json();
    await sbSaveSession({ access_token: data.access_token, refresh_token: data.refresh_token, expires_at: data.expires_at || 0, user: data.user });
    return true;
  } catch (e) { return false; }
}

async function sbFetch(path, opts) {
  opts = opts || {};
  if (!sbConfigured()) throw new Error('云服务未就绪');
  if (SB.session && SB.session.expires_at && Date.now() / 1000 > SB.session.expires_at - 60) {
    await sbRefresh();
  }
  const headers = Object.assign({ apikey: SB.anon, 'Content-Type': 'application/json' }, opts.headers || {});
  if (SB.session && SB.session.access_token) headers['Authorization'] = 'Bearer ' + SB.session.access_token;
  return fetch(SB.url + path, Object.assign({}, opts, { headers }));
}

async function sbSignup(email, password) {
  await sbLoad();
  const resp = await fetch(SB.url + '/auth/v1/signup', {
    method: 'POST',
    headers: { apikey: SB.anon, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(sbErrZh(data.message || data.error_description || data.msg || '注册失败'));
  if (data.access_token) {
    await sbSaveSession({ access_token: data.access_token, refresh_token: data.refresh_token, expires_at: data.expires_at || 0, user: data.user });
  }
  return data;
}

async function sbLogin(email, password) {
  await sbLoad();
  if (!sbConfigured()) throw new Error('未配置 Supabase');
  const resp = await fetch(SB.url + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { apikey: SB.anon, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(sbErrZh(data.message || data.error_description || data.msg || '登录失败'));
  await sbSaveSession({ access_token: data.access_token, refresh_token: data.refresh_token, expires_at: data.expires_at || 0, user: data.user });
  return data;
}

async function sbLogout() {
  await sbLoad();
  try { if (SB.session) await sbFetch('/auth/v1/logout', { method: 'POST' }); } catch (e) {}
  await sbSaveSession(null);
}

async function sbGetUser() {
  await sbLoad();
  if (!SB.session || !SB.session.access_token) return null;
  if (SB.session.expires_at && Date.now() / 1000 > SB.session.expires_at - 60) {
    const ok = await sbRefresh();
    if (!ok) return null;
  }
  return SB.session.user || { email: '已登录' };
}

async function sbPushHistory(entry) {
  if (!sbConfigured()) return;
  await sbLoad();
  if (!SB.session) return;
  try {
    await sbFetch('/rest/v1/history', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({ id: entry.id, ts: entry.ts, kind: entry.kind, title: entry.title, detail: entry.detail, payload: entry.payload })
    });
  } catch (e) {}
}

async function sbPullHistory() {
  if (!sbConfigured()) return [];
  await sbLoad();
  if (!SB.session) return [];
  try {
    const resp = await sbFetch('/rest/v1/history?order=ts.desc&limit=200', { method: 'GET' });
    if (!resp.ok) return [];
    return await resp.json();
  } catch (e) { return []; }
}

// 按 id 删除云端单条历史；未登录或失败返回 false（不影响本地删除）
async function sbDeleteHistory(id) {
  if (!sbConfigured() || !id) return false;
  await sbLoad();
  if (!SB.session) return false;
  try {
    const resp = await sbFetch('/rest/v1/history?id=eq.' + encodeURIComponent(id), { method: 'DELETE' });
    return resp.ok;
  } catch (e) { return false; }
}
