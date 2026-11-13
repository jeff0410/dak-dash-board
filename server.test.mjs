// node --test — 로그인 문이 제대로 잠기는지만 확인한다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './server.mjs';

const cfg = { DASH_USER: 'admin', DASH_PASSWORD: 'correct-horse-battery' };

async function withServer(fn) {
  const srv = createApp(cfg);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try { await fn(base); } finally { srv.close(); }
}
const login = (base, user, password, headers = {}) => fetch(base + '/login', {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
  body: new URLSearchParams({ user, password }),
});

test('로그인 전에는 화면이 잠겨 있다', () => withServer(async base => {
  const r = await fetch(base + '/', { redirect: 'manual' });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/login');
  assert.equal((await fetch(base + '/bg.jpg', { redirect: 'manual' })).status, 401);
  assert.equal((await fetch(base + '/server.mjs', { redirect: 'manual' })).status, 401);
}));

test('틀린 비밀번호는 쿠키를 주지 않는다', () => withServer(async base => {
  const r = await login(base, 'admin', 'wrong');
  assert.equal(r.headers.get('location'), '/login?e=1');
  assert.equal(r.headers.get('set-cookie'), null);
}));

test('맞으면 들어가고, 로그아웃하면 다시 잠긴다', () => withServer(async base => {
  const r = await login(base, 'admin', cfg.DASH_PASSWORD);
  assert.equal(r.headers.get('location'), '/');
  const c = r.headers.get('set-cookie');
  assert.match(c, /HttpOnly/); assert.match(c, /SameSite=Strict/);
  const sid = c.split(';')[0];
  const page = await fetch(base + '/', { headers: { cookie: sid } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /RTMC AGENTS/);
  assert.equal((await fetch(base + '/server.mjs', { headers: { cookie: sid } })).status, 404); // 소스·.env 는 로그인해도 안 나간다
  assert.equal((await fetch(base + '/.env', { headers: { cookie: sid } })).status, 404);
  await fetch(base + '/logout', { method: 'POST', redirect: 'manual', headers: { cookie: sid } });
  assert.equal((await fetch(base + '/', { redirect: 'manual', headers: { cookie: sid } })).status, 303);
}));

test('5번 틀리면 맞는 비밀번호도 15분간 막힌다', () => withServer(async base => {
  for (let i = 0; i < 5; i++) await login(base, 'admin', 'nope' + i);
  const r = await login(base, 'admin', cfg.DASH_PASSWORD);
  assert.equal(r.headers.get('location'), '/login?e=locked');
  assert.equal(r.headers.get('set-cookie'), null);
}));

test('브라우저가 Origin 을 null 로 보내지 않게 Referrer-Policy 는 same-origin 이다', () => withServer(async base => {
  assert.equal((await fetch(base + '/login')).headers.get('referrer-policy'), 'same-origin');
}));

test('같은 주소에서 보낸 로그인은 통과한다', () => withServer(async base => {
  const r = await login(base, 'admin', cfg.DASH_PASSWORD, { Origin: base });
  assert.equal(r.headers.get('location'), '/');
}));

test('다른 사이트에서 보낸 로그인 요청은 거절한다', () => withServer(async base => {
  const r = await login(base, 'admin', cfg.DASH_PASSWORD, { Origin: 'https://evil.example' });
  assert.equal(r.status, 403);
}));
