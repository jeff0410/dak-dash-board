// 대시보드 서버 — 로그인한 사용자만 화면에 들어올 수 있다. 외부 패키지 없음.
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SESSION_TTL = 12 * 3600; // 초
const MAX_FAILS = 5;
const FAIL_WINDOW = 15 * 60 * 1000;
const STATIC = { '/': ['index.html', 'text/html; charset=utf-8'], '/bg.jpg': ['bg.jpg', 'image/jpeg'] };

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

export function createApp(cfg) {
  const sessions = new Map(); // token -> 만료 시각(ms)
  const fails = new Map();    // ip -> { n, first }
  const secure = cfg.COOKIE_SECURE === '1';
  const trustProxy = cfg.TRUST_PROXY === '1';

  const ipOf = req => (trustProxy && (req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim())) || req.socket.remoteAddress;
  const cookie = req => Object.fromEntries(String(req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(p => p[0]));
  const authed = req => {
    const t = cookie(req).dash_sid, exp = t && sessions.get(t);
    if (!exp) return false;
    if (exp < Date.now()) { sessions.delete(t); return false; }
    return true;
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
  const readBody = req => new Promise((ok, no) => {
    let b = ''; req.on('data', c => { b += c; if (b.length > 4096) { no(new Error('too large')); req.destroy(); } });
    req.on('end', () => ok(b)); req.on('error', no);
  });

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    try {
      if (path === '/healthz') return send(res, 200, 'ok');

      if (path === '/login' && req.method === 'GET') {
        if (authed(req)) return go(res, '/');
        return send(res, 200, file('login.html'), { 'Content-Type': 'text/html; charset=utf-8' });
      }
      if (path === '/login' && req.method === 'POST') {
        const ip = ipOf(req);
        if (!sameOrigin(req)) return send(res, 403, 'forbidden');
        if (blocked(ip)) return go(res, '/login?e=locked');
        const p = new URLSearchParams(await readBody(req));
        const ok = same(p.get('user') || '', cfg.DASH_USER) & same(p.get('password') || '', cfg.DASH_PASSWORD);
        if (!ok) {
          fail(ip);
          console.log(`[login] 실패 ip=${ip}`);
          await new Promise(r => setTimeout(r, 400)); // 무차별 대입 속도 늦추기
          return go(res, blocked(ip) ? '/login?e=locked' : '/login?e=1');
        }
        fails.delete(ip);
        const t = randomBytes(32).toString('hex');
        sessions.set(t, Date.now() + SESSION_TTL * 1000);
        console.log(`[login] 성공 ip=${ip}`);
        return go(res, '/', { 'Set-Cookie': `dash_sid=${t}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL}${secure ? '; Secure' : ''}` });
      }
      if (path === '/logout' && req.method === 'POST') {
        if (!sameOrigin(req)) return send(res, 403, 'forbidden');
        sessions.delete(cookie(req).dash_sid);
        return go(res, '/login', { 'Set-Cookie': `dash_sid=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}` });
      }

      if (!authed(req)) return req.method === 'GET' && path === '/' ? go(res, '/login') : send(res, 401, 'login required');

      const s = req.method === 'GET' && STATIC[path];
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
