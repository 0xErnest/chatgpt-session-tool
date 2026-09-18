// ChatGPT Session 工具 —— 零依赖本地代理服务（Node 18+，用内置 fetch/http）
// 只做两件事的后端代理：查询订阅、取官方取消续费的管理链接。
// Session→Cookie 转换是纯前端，在 index.html 里完成，不经过这里。
// ponytail: 单文件 http 服务，不引 express；本地跑=住宅 IP，最不容易被 Cloudflare 拦。

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '127.0.0.1'; // 默认只绑本机，凭证不外泄
const BASE = 'https://chatgpt.com';
const TIMEOUT_MS = 15000;
const MAX_BODY = 64 * 1024; // accessToken 只有几 KB，防内存被打满
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

// route 是 /backend-api/... 路径；accountId 可选（team/多账号时定位账号）
function oaiHeaders(token, route, accountId) {
  const h = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': UA,
    Origin: BASE,
    Referer: BASE + '/',
    'OAI-Device-Id': crypto.randomUUID(),
    'OAI-Language': 'en-US',
    'x-openai-target-path': route,
    'x-openai-target-route': route,
  };
  if (accountId) h['ChatGPT-Account-Id'] = accountId;
  return h;
}

async function callOpenAI(url, opts) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, signal: ac.signal });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { /* 非 JSON（多半是 Cloudflare 拦截页） */ }
    return { status: res.status, ok: res.ok, json, text };
  } catch (e) {
    // 网络错误 / 超时：与上游返回区分开（status 0 = 没拿到响应）
    return { status: 0, ok: false, json: null, text: (e && e.name === 'AbortError') ? 'upstream timeout' : String((e && e.message) || e) };
  } finally {
    clearTimeout(t);
  }
}

function upstreamError(r) {
  return {
    error: r.status ? `上游返回 ${r.status}` : '网络请求失败或超时',
    hint: r.status === 401 ? 'accessToken 已过期，请重新获取 Session'
        : r.status === 403 ? 'Cloudflare 拦截，换干净网络/住宅 IP 再试'
        : r.status === 0 ? '代理访问 chatgpt.com 失败，检查本机网络'
        : undefined,
    raw: (r.text || '').slice(0, 500),
  };
}

// 把 accounts/check 的响应压成账号列表。字段会漂移，全部可选读取 + 保底。
function summarize(check) {
  const accounts = (check && check.accounts) || {};
  const seen = new Set();
  const list = [];
  for (const key of Object.keys(accounts)) {
    const a = accounts[key] || {};
    const acc = a.account || {};
    const ent = a.entitlement || {};
    const last = a.last_active_subscription || {};
    const id = acc.account_id || key;
    if (seen.has(id)) continue; // 响应里 'default' 会和真实 id 重复
    seen.add(id);
    list.push({
      account_id: id,
      name: acc.name || acc.structure || null,
      plan_type: acc.plan_type || ent.subscription_plan || 'unknown',
      is_active: ent.has_active_subscription ?? null,
      expires_at: ent.expires_at || null,
      will_renew: last.will_renew ?? null,
      origin: last.purchase_origin_platform || null, // chatgpt_web / chatgpt_mobile_ios / ...
      is_deactivated: acc.is_deactivated ?? null,
    });
  }
  return list;
}

// 查询：先 accounts/check 拿账号列表，再对每个账号拉 /subscriptions 拿 active_until / will_renew（最准）
async function querySubscription(accessToken) {
  const checkRoute = '/backend-api/accounts/check/v4-2023-04-27';
  const r = await callOpenAI(`${BASE}${checkRoute}?timezone_offset_min=-480`, {
    method: 'GET', headers: oaiHeaders(accessToken, checkRoute),
  });
  if (!r.ok) return { err: r };

  const list = summarize(r.json);
  const subRoute = '/backend-api/subscriptions';
  for (const a of list) {
    const s = await callOpenAI(
      `${BASE}${subRoute}?account_id=${encodeURIComponent(a.account_id)}`,
      { method: 'GET', headers: oaiHeaders(accessToken, subRoute, a.account_id) }
    );
    if (s.ok && s.json && typeof s.json === 'object') {
      a.plan_type = s.json.plan_type || s.json.subscription_plan || a.plan_type;
      a.expires_at = s.json.active_until || s.json.expires_at || a.expires_at;
      if (typeof s.json.will_renew === 'boolean') a.will_renew = s.json.will_renew;
      a.subscription_id = s.json.id || null;
      a.subscription = s.json;
    }
    // 免费账号 /subscriptions 常 404，忽略即可
  }
  return { list, raw: r.json };
}

// 取官方订阅管理链接。已验证是 GET；万一哪天改成 POST（405）就重试一次。
async function customerPortal(accessToken) {
  const route = '/backend-api/payments/customer_portal';
  let r = await callOpenAI(`${BASE}${route}`, { method: 'GET', headers: oaiHeaders(accessToken, route) });
  if (r.status === 405) {
    r = await callOpenAI(`${BASE}${route}`, { method: 'POST', headers: oaiHeaders(accessToken, route), body: '{}' });
  }
  return r;
}

const STATIC = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/app.js': 'app.js',
  '/style.css': 'style.css',
};
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
// 严格 CSP：页面只有一个内联 <script> 也没有 —— 脚本/样式都在独立文件里
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'",
};

function sendJSON(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { req.destroy(); reject(new Error('body too large')); return; }
      data += c;
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const staticFile = STATIC[req.url];
  if (req.method === 'GET' && staticFile) {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(staticFile)], ...SECURITY_HEADERS });
    return res.end(fs.readFileSync(path.join(__dirname, staticFile)));
  }

  if (req.method === 'POST' && req.url === '/api/query') {
    let body;
    try { body = await readBody(req); } catch { return sendJSON(res, 413, { error: '请求体过大' }); }
    const { accessToken } = body;
    if (!accessToken) return sendJSON(res, 400, { error: '缺少 accessToken' });
    try {
      const q = await querySubscription(accessToken);
      if (q.err) return sendJSON(res, 502, upstreamError(q.err));
      return sendJSON(res, 200, { accounts: q.list, raw: q.raw });
    } catch (e) {
      return sendJSON(res, 500, { error: String((e && e.message) || e) });
    }
  }

  if (req.method === 'POST' && req.url === '/api/portal') {
    let body;
    try { body = await readBody(req); } catch { return sendJSON(res, 413, { error: '请求体过大' }); }
    const { accessToken } = body;
    if (!accessToken) return sendJSON(res, 400, { error: '缺少 accessToken' });
    try {
      const r = await customerPortal(accessToken);
      if (!r.ok || !(r.json && r.json.url)) return sendJSON(res, 502, upstreamError(r));
      return sendJSON(res, 200, { url: r.json.url });
    } catch (e) {
      return sendJSON(res, 500, { error: String((e && e.message) || e) });
    }
  }

  res.writeHead(404, SECURITY_HEADERS); res.end('not found');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，换个端口再试：PORT=8788 node server.js`);
    process.exit(1);
  }
  throw e;
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`ChatGPT Session 工具已启动 → http://${HOST}:${PORT}`);
  });
}

module.exports = { summarize, upstreamError }; // 供 node --test 使用