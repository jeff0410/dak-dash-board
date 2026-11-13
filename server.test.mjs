// node --test — 로그인 문(비밀번호 + OTP)이 제대로 잠기는지 확인한다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, totp, verifyTotp, b32encode, b32decode } from './server.mjs';

const PW = 'correct-horse-battery';
const newCfg = () => ({ DASH_USER: 'admin', DASH_PASSWORD: PW, HOOK_TOKEN: 't', NO_SYNC: '1', TOTP_FILE: join(mkdtempSync(join(tmpdir(), 'dash-')), '.totp-secret') });

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

test('훅 이벤트로 세션 · 서브에이전트 · 승인 상태가 바뀐다', async () => {
  const { createStore } = await import('./agents.mjs');
  const st = createStore({ capture: async () => 'Do you want to proceed?\n❯ 1. Yes' });
  const base = { session_id: 'S1', cwd: '/home/dev/project/rtmc-project', permission_mode: 'bypassPermissions' };
  const ev = (name, x = {}) => st.ingest({ ...base, hook_event_name: name, ...x }, '%7');
  ev('UserPromptSubmit', { prompt: '공지 API 확인' });
  ev('PreToolUse', { tool_name: 'Agent', tool_use_id: 't1', tool_input: { subagent_type: 'backend', description: '스펙 조회', prompt: 'GET /notice 찾기' } });
  ev('PostToolUse', { tool_name: 'Agent', tool_use_id: 't1', tool_response: { isAsync: true } });
  ev('PreToolUse', { tool_name: 'Grep', tool_use_id: 't2', agent_id: 'A1', agent_type: 'backend', tool_input: { pattern: 'notice' } });
  let s = st.snapshot().sessions[0];
  assert.equal(s.pane, '%7'); assert.equal(s.status, 'run'); assert.equal(s.dispatch.backend, 1);
  assert.equal(s.agents.A1.status, 'run'); assert.equal(s.agents.A1.tool, 'Grep'); assert.equal(s.agents.A1.task, 'GET /notice 찾기');
  ev('SubagentStop', { agent_id: 'A1', agent_type: 'backend', last_assistant_message: 'src/notice.controller.ts:18' });
  s = st.snapshot().sessions[0];
  assert.equal(s.agents.A1.status, 'done'); assert.equal(s.agents.A1.result, 'src/notice.controller.ts:18');
  ev('PreToolUse', { tool_name: 'Bash', tool_use_id: 't3', tool_input: { command: 'rm -rf /tmp/x', description: '정리' } });
  ev('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission' });
  await new Promise(r => setTimeout(r, 10));
  s = st.snapshot().sessions[0];
  assert.equal(s.status, 'appr'); assert.equal(s.approval.cmd, 'rm -rf /tmp/x'); assert.match(s.approval.screen, /proceed/);
  ev('PostToolUse', { tool_name: 'Bash', tool_use_id: 't3', tool_response: { stdout: 'ok', stderr: '' } });
  ev('PreToolUse', { tool_name: 'Edit', tool_use_id: 't4', tool_input: { file_path: '/a/b.ts', old_string: 'x', new_string: 'y\nz' } });
  ev('PostToolUse', { tool_name: 'Edit', tool_use_id: 't4', tool_input: { file_path: '/a/b.ts', old_string: 'x', new_string: 'y\nz' } });
  ev('Stop', { last_assistant_message: '끝', background_tasks: [] });
  s = st.snapshot().sessions[0];
  assert.equal(s.status, 'done'); assert.equal(s.answer, '끝'); assert.equal(s.approval, null);
  assert.deepEqual([s.files[0].a, s.files[0].r], [2, 1]);
  ev('UserPromptSubmit', { prompt: '<task-notification>\n<task-id>x</task-id>' });
  assert.equal(st.snapshot().sessions[0].prompt, '공지 API 확인');          // 완료 알림은 지시가 아니다
  ev('SubagentStop', { agent_id: 'INTERNAL', last_assistant_message: '추천 질문' });
  assert.equal(st.snapshot().sessions[0].agents.INTERNAL, undefined);     // 종류 없는 내부 에이전트는 숨긴다
  ev('SessionEnd'); assert.equal(st.snapshot().sessions.length, 0);
});

test('훅은 토큰이 맞고 애수기 안에서 온 것만 받는다', () => withServer({ ...newCfg(), HOOK_TOKEN: 'tok', NO_SYNC: '1' }, async base => {
  const hook = (h, b = { session_id: 'Z', hook_event_name: 'UserPromptSubmit', prompt: 'hi', cwd: '/x' }) =>
    fetch(base + '/hook', { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(b) });
  assert.equal((await hook({ 'X-Hook-Token': 'nope' })).status, 403);
  assert.equal((await hook({ 'X-Hook-Token': 'tok', 'X-Real-IP': '1.2.3.4' })).status, 403); // 10번 nginx 경유
  assert.equal((await hook({ 'X-Hook-Token': 'tok' })).status, 204);
  assert.equal((await fetch(base + '/api/state')).status, 401);       // 상태는 로그인해야 보인다
  assert.equal((await fetch(base + '/events')).status, 401);
  assert.equal((await fetch(base + '/api/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
}));

test('git diff 를 파일별 +/- 와 줄로 바꾼다', async () => {
  const { parseDiff } = await import('./agents.mjs');
  const f = parseDiff('diff --git a/src/a.ts b/src/a.ts\nindex 1..2 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@ fn\n keep\n-old\n+new\n+more', 'home/');
  assert.equal(f.length, 1); assert.equal(f[0].path, 'home/src/a.ts');
  assert.deepEqual([f[0].a, f[0].r], [2, 1]);
  assert.deepEqual(f[0].diff, [['c', '⋯ fn'], ['c', 'keep'], ['r', 'old'], ['a', 'new'], ['a', 'more']]);
});
