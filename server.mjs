// 대시보드 서버 — 아이디·비밀번호 + OTP(TOTP) 2단계 로그인. 외부 패키지 없음.
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const BRAND = 'JEFF AGENTS';
const SESSION_TTL = 12 * 3600;  // 초
const PENDING_TTL = 5 * 60 * 1000; // 비밀번호 통과 후 OTP 입력까지 허용 시간
const MAX_FAILS = 5;
const FAIL_WINDOW = 15 * 60 * 1000;
const PRIVATE = { '/': ['index.html', 'text/html; charset=utf-8'], '/bg.jpg': ['bg.jpg', 'image/jpeg'] };
const PUBLIC = { '/favicon-16.png': 'favicon-16.png', '/favicon-32.png': 'favicon-32.png', '/apple-touch-icon.png': 'apple-touch-icon.png' };

export function loadEnv(file) {
  const env = {};
  if (!existsSync(file)) return env;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    env[m[1]] = v;
  }
  return env;
}

// 길이가 달라도 시간 차이가 안 나게 해시끼리 비교한다
const same = (a, b) => timingSafeEqual(createHash('sha256').update(String(a)).digest(), createHash('sha256').update(String(b)).digest());

/* ---------- TOTP (RFC 6238, SHA1 · 6자리 · 30초) ---------- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function b32encode(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
export function b32decode(s) {
  s = s.replace(/=+$/, '').replace(/\s/g, '').toUpperCase();
  let bits = 0, val = 0; const out = [];
  for (const c of s) {
    const i = B32.indexOf(c); if (i < 0) throw new Error('bad base32');
    val = (val << 5) | i; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export function totp(secret, counter) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', b32decode(secret)).update(msg).digest();
  const o = h[19] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1e6).padStart(6, '0');
}
// 맞으면 사용한 counter, 틀리면 -1. 앞뒤 30초(±1) 허용, 이미 쓴 코드는 재사용 불가.
export function verifyTotp(secret, code, now = Date.now(), lastUsed = -1) {
  if (!/^\d{6}$/.test(String(code))) return -1;
  const c = Math.floor(now / 30000);
  for (const k of [c - 1, c, c + 1]) if (k > lastUsed && same(totp(secret, k), code)) return k;
  return -1;
}

export function createApp(cfg) {
  const sessions = new Map(); // token -> 만료 시각(ms)
  const pending = new Map();  // 비밀번호 통과 토큰 -> { exp, tries, secret? }
  const fails = new Map();    // ip -> { n, first }
  const secure = cfg.COOKIE_SECURE === '1';
  const trustProxy = cfg.TRUST_PROXY === '1';
  const secretFile = cfg.TOTP_FILE || join(ROOT, '.totp-secret');
  let lastUsed = -1;
  const getSecret = () => cfg.DASH_TOTP_SECRET || (existsSync(secretFile) ? readFileSync(secretFile, 'utf8').trim() : '');

  const ipOf = req => (trustProxy && (req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim())) || req.socket.remoteAddress;
  const cookies = req => Object.fromEntries(String(req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(p => p[0]));
  const cookieStr = (name, val, age) => `${name}=${val}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`;
  const authed = req => {
    const t = cookies(req).dash_sid, exp = t && sessions.get(t);
    if (!exp) return false;
    if (exp < Date.now()) { sessions.delete(t); return false; }
    return true;
  };
  const pendingOf = req => {
    const t = cookies(req).dash_pre, p = t && pending.get(t);
    if (!p) return null;
    if (p.exp < Date.now()) { pending.delete(t); return null; }
    return { t, p };
  };
  const blocked = ip => { const f = fails.get(ip); if (!f) return false; if (Date.now() - f.first > FAIL_WINDOW) { fails.delete(ip); return false; } return f.n >= MAX_FAILS; };
  const fail = ip => { const f = fails.get(ip); if (!f || Date.now() - f.first > FAIL_WINDOW) fails.set(ip, { n: 1, first: Date.now() }); else f.n++; };
  // 다른 사이트에서 보낸 POST 차단
  const sameOrigin = req => {
    const o = req.headers.origin; if (!o) return true;
    const host = (trustProxy && req.headers['x-forwarded-host']) || req.headers.host;
    try { return new URL(o).host === host; } catch { return false; }
  };
  const send = (res, code, body = '', headers = {}) => {
    res.writeHead(code, { 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Cache-Control': 'no-store', ...headers });
    res.end(body);
  };
  const go = (res, to, headers = {}) => send(res, 303, '', { Location: to, ...headers });
  const file = name => { const p = join(ROOT, name); return existsSync(p) ? readFileSync(p) : null; };
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const page = (res, mode, extra = {}) => {
    const vars = { MODE: mode, BRAND, SECRET: '', URI: '', ...extra };
    const html = String(file('login.html')).replace(/\{\{(\w+)\}\}/g, (_, k) => esc(vars[k] ?? ''));
    return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8' });
  };
  const readBody = req => new Promise((ok, no) => {
    let b = ''; req.on('data', c => { b += c; if (b.length > 4096) { no(new Error('too large')); req.destroy(); } });
    req.on('end', () => ok(new URLSearchParams(b))); req.on('error', no);
  });
  const slow = () => new Promise(r => setTimeout(r, 400)); // 무차별 대입 속도 늦추기
  const startSession = (res, req, preToken) => {
    if (preToken) pending.delete(preToken);
    fails.delete(ipOf(req));
    const t = randomBytes(32).toString('hex');
    sessions.set(t, Date.now() + SESSION_TTL * 1000);
    console.log(`[login] 성공 ip=${ipOf(req)}`);
    res.setHeader('Set-Cookie', [cookieStr('dash_sid', t, SESSION_TTL), cookieStr('dash_pre', '', 0)]);
    return go(res, '/');
  };
  // OTP 단계 공통 실패 처리: IP 카운트 + 이 토큰 시도 5번 넘으면 비밀번호부터 다시
  const otpFail = async (res, req, pre, back) => {
    fail(ipOf(req)); pre.p.tries++;
    console.log(`[login] OTP 실패 ip=${ipOf(req)}`);
    await slow();
    if (blocked(ipOf(req)) || pre.p.tries >= MAX_FAILS) { pending.delete(pre.t); return go(res, '/login?e=' + (blocked(ipOf(req)) ? 'locked' : 'retry'), { 'Set-Cookie': cookieStr('dash_pre', '', 0) }); }
    return go(res, back + '?e=1');
  };

  return http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    const isGet = req.method === 'GET' || req.method === 'HEAD';
    try {
      if (path === '/healthz') return send(res, 200, 'ok');
      if (isGet && PUBLIC[path]) { const b = file(PUBLIC[path]); return b ? send(res, 200, b, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' }) : send(res, 404, 'not found'); }
      if (req.method === 'POST' && !sameOrigin(req)) return send(res, 403, 'forbidden');

      // 1단계: 아이디·비밀번호
      if (path === '/login' && isGet) return authed(req) ? go(res, '/') : page(res, 'password');
      if (path === '/login' && req.method === 'POST') {
        const ip = ipOf(req);
        if (blocked(ip)) return go(res, '/login?e=locked');
        const p = await readBody(req);
        const ok = same(p.get('user') || '', cfg.DASH_USER) & same(p.get('password') || '', cfg.DASH_PASSWORD);
        if (!ok) { fail(ip); console.log(`[login] 실패 ip=${ip}`); await slow(); return go(res, blocked(ip) ? '/login?e=locked' : '/login?e=1'); }
        const t = randomBytes(32).toString('hex');
        const enrolled = !!getSecret();
        pending.set(t, { exp: Date.now() + PENDING_TTL, tries: 0, secret: enrolled ? null : b32encode(randomBytes(20)) });
        return go(res, enrolled ? '/login/otp' : '/login/setup', { 'Set-Cookie': cookieStr('dash_pre', t, PENDING_TTL / 1000) });
      }

      // 2단계: OTP 코드
      if (path === '/login/otp') {
        const pre = pendingOf(req);
        if (!pre || !getSecret()) return go(res, '/login');
        if (isGet) return page(res, 'otp');
        if (req.method === 'POST') {
          if (blocked(ipOf(req))) return go(res, '/login?e=locked');
          const k = verifyTotp(getSecret(), ((await readBody(req)).get('code') || '').trim(), Date.now(), lastUsed);
          if (k < 0) return otpFail(res, req, pre, '/login/otp');
          lastUsed = k;
          return startSession(res, req, pre.t);
        }
      }

      // 최초 1회: QR 등록 (등록된 시크릿이 없을 때만)
      if (path === '/login/setup') {
        const pre = pendingOf(req);
        if (getSecret()) return go(res, pre ? '/login/otp' : '/login');
        if (!pre || !pre.p.secret) return go(res, '/login');
        const s = pre.p.secret;
        if (isGet) return page(res, 'setup', { SECRET: s.replace(/(.{4})/g, '$1 ').trim(), URI: `otpauth://totp/${encodeURIComponent(BRAND + ':' + cfg.DASH_USER)}?secret=${s}&issuer=${encodeURIComponent(BRAND)}&algorithm=SHA1&digits=6&period=30` });
        if (req.method === 'POST') {
          if (blocked(ipOf(req))) return go(res, '/login?e=locked');
          const k = verifyTotp(s, ((await readBody(req)).get('code') || '').trim());
          if (k < 0) return otpFail(res, req, pre, '/login/setup');
          writeFileSync(secretFile, s + '\n', { mode: 0o600 });
          lastUsed = k;
          console.log('[login] OTP 등록 완료');
          return startSession(res, req, pre.t);
        }
      }

      if (path === '/logout' && req.method === 'POST') {
        sessions.delete(cookies(req).dash_sid);
        return go(res, '/login', { 'Set-Cookie': cookieStr('dash_sid', '', 0) });
      }

      if (!authed(req)) return isGet && path === '/' ? go(res, '/login') : send(res, 401, 'login required');

      const s = isGet && PRIVATE[path];
      const body = s && file(s[0]);
      if (!body) return send(res, 404, 'not found');
      return send(res, 200, body, { 'Content-Type': s[1] });
    } catch (e) {
      console.error('[error]', e.message);
      return send(res, 400, 'bad request');
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cfg = { ...loadEnv(join(ROOT, '.env')), ...process.env };
  if (!cfg.DASH_USER || !cfg.DASH_PASSWORD) { console.error('.env 에 DASH_USER, DASH_PASSWORD 를 넣어 주세요 (.env.example 참고)'); process.exit(1); }
  if (cfg.DASH_PASSWORD.length < 12) { console.error('DASH_PASSWORD 는 12자 이상이어야 합니다'); process.exit(1); }
  const port = +(cfg.PORT || 4545), host = cfg.HOST || '127.0.0.1';
  createApp(cfg).listen(port, host, () => console.log(`dak-dash-board → http://${host}:${port}`));
}
