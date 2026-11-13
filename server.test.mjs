// node --test — 로그인 문(비밀번호 + OTP)이 제대로 잠기는지 확인한다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, totp, verifyTotp, b32encode, b32decode } from './server.mjs';

const PW = 'correct-horse-battery';
const newCfg = () => ({ DASH_USER: 'admin', DASH_PASSWORD: PW, TOTP_FILE: join(mkdtempSync(join(tmpdir(), 'dash-')), '.totp-secret') });

async function withServer(cfg, fn) {
  const srv = createApp(cfg);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${srv.address().port}`); } finally { srv.close(); }
}
const post = (base, path, body, headers = {}) => fetch(base + path, {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
  body: new URLSearchParams(body),
});
const ck = (r, name) => (r.headers.getSetCookie().find(c => c.startsWith(name + '=')) || '').split(';')[0];
const nowCode = s => totp(s, Math.floor(Date.now() / 30000));

test('TOTP 는 RFC 6238 테스트 값과 같다', () => {
  const s = b32encode(Buffer.from('12345678901234567890'));
  assert.equal(b32decode(s).toString(), '12345678901234567890');
  assert.equal(totp(s, 1), '287082');              // T=59
  assert.equal(totp(s, 37037036), '081804');       // T=1111111109
  const t = 59 * 1000;
  assert.equal(verifyTotp(s, '287082', t), 1);
  assert.equal(verifyTotp(s, '287082', t + 30000), 1);   // 30초 뒤(±1)까지 허용
  assert.equal(verifyTotp(s, '287082', t + 60000), -1);  // 60초 뒤는 거절
  assert.equal(verifyTotp(s, '287082', t, 1), -1);       // 이미 쓴 코드 재사용 거절
});

test('로그인 전에는 화면이 잠겨 있고 파비콘만 열린다', () => withServer(newCfg(), async base => {
  const r = await fetch(base + '/', { redirect: 'manual' });
  assert.equal(r.headers.get('location'), '/login');
  assert.equal((await fetch(base + '/bg.jpg', { redirect: 'manual' })).status, 401);
  assert.equal((await fetch(base + '/login/otp', { redirect: 'manual' })).headers.get('location'), '/login');
  assert.equal((await fetch(base + '/login/setup', { redirect: 'manual' })).headers.get('location'), '/login');
  assert.notEqual((await fetch(base + '/favicon-32.png')).status, 401);
}));

test('비밀번호만으로는 세션을 주지 않는다', () => withServer(newCfg(), async base => {
  const r = await post(base, '/login', { user: 'admin', password: PW });
  assert.equal(r.headers.get('location'), '/login/setup');
  assert.equal(ck(r, 'dash_sid'), '');
  assert.equal((await fetch(base + '/', { redirect: 'manual', headers: { cookie: ck(r, 'dash_pre') } })).status, 303);
}));

test('최초 등록 → 로그아웃 → 다시 로그인은 OTP 를 묻는다', async () => {
  const cfg = newCfg();
  await withServer(cfg, async base => {
    const r1 = await post(base, '/login', { user: 'admin', password: PW });
    const pre = ck(r1, 'dash_pre');
    const html = await (await fetch(base + '/login/setup', { headers: { cookie: pre } })).text();
    assert.match(html, /JEFF AGENTS/);
    const secret = html.match(/secret=([A-Z2-7]+)/)[1];
    assert.equal((await post(base, '/login/setup', { code: '000000' }, { cookie: pre })).headers.get('location'), '/login/setup?e=1');
    const r2 = await post(base, '/login/setup', { code: nowCode(secret) }, { cookie: pre });
    assert.equal(r2.headers.get('location'), '/');
    assert.ok(existsSync(cfg.TOTP_FILE));
    assert.equal(statSync(cfg.TOTP_FILE).mode & 0o777, 0o600);
    const sid = ck(r2, 'dash_sid');
    const pg = await fetch(base + '/', { headers: { cookie: sid } });
    assert.equal(pg.status, 200);
    assert.equal((await fetch(base + '/server.mjs', { headers: { cookie: sid } })).status, 404);
    assert.equal((await fetch(base + '/.totp-secret', { headers: { cookie: sid } })).status, 404);
    await post(base, '/logout', {}, { cookie: sid });
    assert.equal((await fetch(base + '/', { redirect: 'manual', headers: { cookie: sid } })).status, 303);

    // 등록 후에는 setup 으로 갈 수 없고 OTP 를 묻는다
    const r3 = await post(base, '/login', { user: 'admin', password: PW });
    assert.equal(r3.headers.get('location'), '/login/otp');
    const pre3 = ck(r3, 'dash_pre');
    assert.equal((await fetch(base + '/login/setup', { redirect: 'manual', headers: { cookie: pre3 } })).headers.get('location'), '/login/otp');
    // 등록 때 쓴 코드는 다시 못 쓴다
    const c = nowCode(secret);
    const ok = await post(base, '/login/otp', { code: c }, { cookie: pre3 });
    assert.notEqual(ok.headers.get('location'), '/');
  });
});

test('OTP 를 5번 틀리면 처음부터, IP 는 잠긴다', async () => {
  const cfg = newCfg();
  const secret = b32encode(Buffer.from('abcdefghijabcdefghij'));
  cfg.DASH_TOTP_SECRET = secret;
  await withServer(cfg, async base => {
    const pre = ck(await post(base, '/login', { user: 'admin', password: PW }), 'dash_pre');
    let r;
    for (let i = 0; i < 5; i++) r = await post(base, '/login/otp', { code: '000000' }, { cookie: pre });
    assert.equal(r.headers.get('location'), '/login?e=locked');
    const again = await post(base, '/login', { user: 'admin', password: PW });
    assert.equal(again.headers.get('location'), '/login?e=locked');
  });
});

test('같은 주소에서 보낸 로그인은 통과하고, 다른 사이트에서 보낸 건 거절한다', () => withServer(newCfg(), async base => {
  assert.equal((await post(base, '/login', { user: 'admin', password: PW }, { Origin: base })).headers.get('location'), '/login/setup');
  assert.equal((await post(base, '/login', { user: 'admin', password: PW }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await fetch(base + '/login')).headers.get('referrer-policy'), 'same-origin');
}));
