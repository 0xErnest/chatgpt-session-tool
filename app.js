'use strict';

const $ = (id) => document.getElementById(id);
let tokens = { accessToken: '', sessionToken: '' };

// 所有上游 / 动态内容进 innerHTML 前必须转义，防 XSS
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function parseSession() {
  const raw = $('sess').value.trim();
  if (!raw) { tokens = { accessToken: '', sessionToken: '' }; $('sessStatus').textContent = ''; return; }
  try {
    const j = JSON.parse(raw);
    tokens.accessToken = j.accessToken || '';
    tokens.sessionToken = j.sessionToken || '';
    const email = (j.user && j.user.email) || '';
    const bits = [];
    bits.push(tokens.sessionToken ? '<span class="ok">✓ sessionToken</span>' : '<span class="err">✗ 缺 sessionToken</span>');
    bits.push(tokens.accessToken ? '<span class="ok">✓ accessToken</span>' : '<span class="err">✗ 缺 accessToken</span>');
    if (email) bits.push('<span class="muted">' + esc(email) + '</span>');
    $('sessStatus').innerHTML = bits.join(' &nbsp; ');
  } catch (e) {
    tokens = { accessToken: '', sessionToken: '' };
    $('sessStatus').innerHTML = '<span class="err">JSON 解析失败：' + esc(e.message) + '</span>';
  }
}
$('sess').addEventListener('input', parseSession);

// ① Cookie-Editor 格式
function buildCookie(token) {
  const exp = Math.floor(Date.now() / 1000) + 30 * 24 * 3600; // next-auth 默认 30 天
  return [{
    name: '__Secure-next-auth.session-token',
    value: token,
    domain: 'chatgpt.com',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
    hostOnly: true,
    session: false,
    expirationDate: exp,
    storeId: null,
  }];
}
$('genCookie').onclick = () => {
  parseSession();
  if (!tokens.sessionToken) { $('cookieOut').value = ''; alert('未检测到 sessionToken，请先粘贴完整 Session JSON'); return; }
  $('cookieOut').value = JSON.stringify(buildCookie(tokens.sessionToken), null, 2);
  $('copyCookie').disabled = false; $('dlCookie').disabled = false;
};
$('copyCookie').onclick = async () => {
  await navigator.clipboard.writeText($('cookieOut').value);
  $('copyCookie').textContent = '已复制'; setTimeout(() => ($('copyCookie').textContent = '复制'), 1200);
};
$('dlCookie').onclick = () => {
  const blob = new Blob([$('cookieOut').value], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'chatgpt-cookie.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

// ② 查询 / 取消
const PLAN = { chatgptplusplan:'Plus', plus:'Plus', chatgptproplan:'Pro', pro:'Pro',
               chatgptteamplan:'Team', team:'Team', free:'免费', unknown:'未知' };
const ORIGIN = { chatgpt_web:'网页/官网', chatgpt_mobile_ios:'iOS 内购', chatgpt_mobile_android:'安卓内购' };

$('query').onclick = async () => {
  parseSession();
  if (!tokens.accessToken) { alert('未检测到 accessToken，请先粘贴完整 Session JSON'); return; }
  $('qStatus').textContent = '查询中…'; $('qResult').innerHTML = ''; $('cancel').disabled = true;
  try {
    const r = await fetch('/api/query', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ accessToken: tokens.accessToken }) });
    const d = await r.json();
    if (!r.ok) { $('qStatus').innerHTML = '<span class="err">' + esc(d.error || '查询失败') + (d.hint ? ' — ' + esc(d.hint) : '') + '</span>'; return; }
    $('qStatus').innerHTML = '<span class="ok">查询成功</span>';
    renderAccounts(d);
  } catch (e) { $('qStatus').innerHTML = '<span class="err">' + esc(e.message) + '</span>'; }
};

function renderAccounts(d) {
  // 隐藏纯免费账号；括号写清楚，is_active 只认布尔
  const accts = (d.accounts || []).filter(a => ((a.plan_type && a.plan_type !== 'free') || a.is_active === true));
  const show = accts.length ? accts : (d.accounts || []);
  let hasMobile = false;
  const html = show.map(a => {
    if (a.origin && a.origin !== 'chatgpt_web') hasMobile = true;
    const plan = PLAN[a.plan_type] || esc(a.plan_type);
    const active = a.is_active === true ? '<span class="pill on">有效</span>'
                 : a.is_active === false ? '<span class="pill off">无有效订阅</span>' : '<span class="muted">—</span>';
    const renew = a.will_renew === true ? '<span class="pill on">开启中</span>'
                : a.will_renew === false ? '<span class="pill off">已关闭</span>' : '<span class="muted">未知</span>';
    const exp = a.expires_at ? esc(new Date(a.expires_at).toLocaleString('zh-CN')) : '—';
    const origin = ORIGIN[a.origin] || esc(a.origin) || '—';
    return '<table>'
      + '<tr><th>套餐</th><td>' + plan + '</td></tr>'
      + '<tr><th>状态</th><td>' + active + '</td></tr>'
      + '<tr><th>到期</th><td>' + exp + '</td></tr>'
      + '<tr><th>自动续费</th><td>' + renew + '</td></tr>'
      + '<tr><th>来源</th><td>' + origin + '</td></tr>'
      + '</table>';
  }).join('');
  let extra = '';
  if (hasMobile) extra = '<div class="warn">检测到手机内购订阅（App Store / Google Play）。这类订阅必须在对应商店里取消，官方管理页无法关闭。</div>';
  $('qResult').innerHTML = html + extra
    + '<details><summary>原始响应</summary><textarea readonly style="min-height:160px;margin-top:8px">'
    + esc(JSON.stringify(d.raw, null, 2)) + '</textarea></details>';
  $('cancel').disabled = false;
}

$('cancel').onclick = async () => {
  parseSession();
  if (!tokens.accessToken) { alert('缺少 accessToken'); return; }
  $('qStatus').innerHTML = '获取官方管理链接中…';
  try {
    const r = await fetch('/api/portal', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ accessToken: tokens.accessToken }) });
    const d = await r.json();
    if (!r.ok || !d.url) { $('qStatus').innerHTML = '<span class="err">' + esc(d.error || '获取失败') + (d.hint ? ' — ' + esc(d.hint) : '') + '</span>'; return; }
    if (!/^https:\/\//.test(d.url)) { $('qStatus').innerHTML = '<span class="err">上游返回了非法链接，已拦截</span>'; return; }
    window.open(d.url, '_blank');
    $('qStatus').innerHTML = '<span class="ok">已打开官方订阅管理页</span> — 在页面里点 Cancel plan 关闭续费，权益保留到到期日。';
  } catch (e) { $('qStatus').innerHTML = '<span class="err">' + esc(e.message) + '</span>'; }
};