// Claude Code 훅 이벤트 → 세션 상태. tmux 로 지시·승인·멈추기를 보낸다.
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';

const run = (cmd, args) => new Promise((ok, no) => execFile(cmd, args, { timeout: 3000 }, (e, out) => e ? no(e) : ok(out)));
export const tmux = (...a) => run('tmux', a);
const PANE = /^%\d+$/;

// 훅 스크립트와 서버가 나눠 쓰는 토큰 (~/.agent-dash/hook-token, 600)
export function hookToken(dir = join(homedir(), '.agent-dash')) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const f = join(dir, 'hook-token');
  if (!existsSync(f)) writeFileSync(f, randomBytes(24).toString('hex') + '\n', { mode: 0o600 });
  return readFileSync(f, 'utf8').trim();
}

const cut = (s, n = 200) => { s = typeof s === 'string' ? s : JSON.stringify(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; };
const argOf = (tool, i = {}) => tool === 'Agent' || tool === 'Task'
  ? `${i.subagent_type || 'agent'} · ${i.description || ''}`
  : i.command ?? i.file_path ?? i.pattern ?? i.path ?? i.url ?? i.query ?? i.description ?? cut(i, 120);
const push = (arr, x, max = 80) => { arr.push(x); if (arr.length > max) arr.splice(0, arr.length - max); };
const lines = s => String(s ?? '').split('\n');

// 작업 폴더의 실제 git 변경 (서브에이전트 · Bash 수정까지 포함). 폴더가 레포가 아니면 바로 아래 레포들을 본다.
const git = (dir, ...a) => new Promise(ok => execFile('git', ['-C', dir, ...a], { timeout: 4000, maxBuffer: 8 << 20 }, (e, out) => ok(e ? null : out)));
export function parseDiff(out, pre = '') {
  const files = []; let f = null;
  for (const l of String(out).split('\n')) {
    if (l.startsWith('diff --git ')) files.push(f = { path: pre + l.replace(/^diff --git a\/.* b\//, ''), a: 0, r: 0, diff: [] });
    else if (!f || /^(index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode|Binary)/.test(l)) continue;
    else if (l.startsWith('@@')) f.diff.push(['c', '⋯ ' + l.replace(/^@@[^@]*@@ ?/, '')]);
    else if (l[0] === '+') { f.a++; f.diff.push(['a', l.slice(1)]); }
    else if (l[0] === '-') { f.r++; f.diff.push(['r', l.slice(1)]); }
    else if (l[0] === ' ') f.diff.push(['c', l.slice(1)]);
  }
  for (const x of files) if (x.diff.length > 400) x.diff.splice(400, x.diff.length, ['c', '⋯ 이하 생략']);
  return files;
}
async function repoList(cwd) {
  let repos = [];
  if (await git(cwd, 'rev-parse', '--git-dir') !== null) repos = [[cwd, '']];
  else try { repos = readdirSync(cwd, { withFileTypes: true }).filter(d => d.isDirectory() && existsSync(join(cwd, d.name, '.git'))).map(d => [join(cwd, d.name), d.name + '/']); } catch {}
  return repos;
}
// 지시를 받은 순간의 레포별 커밋. 이후 커밋한 것까지 '이번 지시의 변경' 으로 보인다.
export async function gitHeads(cwd) {
  const h = {};
  if (cwd) for (const [dir] of await repoList(cwd)) { const x = await git(dir, 'rev-parse', 'HEAD'); if (x) h[dir] = x.trim(); }
  return h;
}
export async function gitChanges(cwd, base = {}) {
  if (!cwd) return null;
  const repos = await repoList(cwd);
  if (!repos.length) return null;
  const out = [];
  for (const [dir, pre] of repos) {
    const d = a => git(dir, 'diff', a, '--no-color', '--no-ext-diff', '-U2', '--');
    out.push(...parseDiff((base?.[dir] && await d(base[dir])) ?? await d('HEAD') ?? '', pre));
    const nu = String(await git(dir, 'ls-files', '--others', '--exclude-standard', '-z') || '').split('\0').filter(p => p && !p.startsWith(".serena/"));
    for (const p of nu.slice(0, 20)) {
      let t = ''; try { if (statSync(join(dir, p)).size < 200000) t = readFileSync(join(dir, p), 'utf8'); } catch {}
      if (t.includes('\0')) t = '';
      const n = t ? lines(t.replace(/\n$/, "")) : [];
      out.push({ path: pre + p, a: n.length, r: 0, diff: [['c', '⋯ 새 파일'], ...n.slice(0, 400).map(x => ['a', x])] });
    }
  }
  return out.slice(0, 40);
}

function addFile(target, tool, i = {}) {
  const path = i.file_path; if (!path) return;
  let f = target.files.find(x => x.path === path);
  if (!f) { f = { path, a: 0, r: 0, diff: [] }; target.files.push(f); }
  const edits = tool === 'MultiEdit' ? (i.edits || []) : tool === 'Edit' ? [i] : [];
  for (const e of edits) {
    const o = lines(e.old_string), n = lines(e.new_string);
    f.r += o.length; f.a += n.length;
    f.diff.push(...o.map(t => ['r', t]), ...n.map(t => ['a', t]), ['c', '⋯']);
  }
  if (tool === 'Write') { const n = lines(i.content); f.a += n.length; f.diff.push(...n.slice(0, 40).map(t => ['a', t]), ...(n.length > 40 ? [['c', `⋯ ${n.length - 40}줄 더`]] : [])); }
  if (f.diff.length > 300) f.diff.splice(0, f.diff.length - 300);
}

export function createStore({ onChange = () => {}, capture = pane => tmux('capture-pane', '-p', '-t', pane, '-S', '-40'), initial = null } = {}) {
  const S = new Map((initial?.sessions || []).map(s => [s.id, s])); // session_id -> 세션 (재시작 시 저장본에서 복원)
  const log = initial?.log || [];
  const now = () => Date.now();
  const L = (s, text) => { push(log, { t: now(), sid: s?.id, text }, 120); };

  function session(e, pane) {
    let s = S.get(e.session_id);
    if (!s) {
      s = { id: e.session_id, pane: '', tmux: '', cwd: e.cwd || '', dir: basename(e.cwd || ''), model: '', mode: '',
        status: 'idle', since: now(), last: now(), tool: '', arg: '', prompt: '', answer: '', approval: null,
        feed: [], files: [], agents: {}, dispatch: {}, known: [] };
      try { s.known = readdirSync(join(s.cwd, '.claude', 'agents')).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3)); } catch {}
      S.set(e.session_id, s);
    }
    if (PANE.test(pane || '')) s.pane = pane;
    s.last = now();
    return s;
  }
  // 수정 · 명령 · 완료 뒤 1.5초 모아서 git 변경을 다시 읽는다
  const gt = new Map();
  const refreshGit = s => { clearTimeout(gt.get(s.id)); const t = setTimeout(async () => {
    const g = await gitChanges(s.cwd, s.base);
    if (S.has(s.id) && JSON.stringify(g) !== JSON.stringify(s.git ?? null)) { s.git = g; onChange(); }
  }, 1500); t.unref?.(); gt.set(s.id, t); };
  const settleRunning = t => t.feed.forEach(x => { if (x.st === 'run' && x.tool !== 'Agent') x.st = 'ok'; });

  function ingest(e, pane) {
    if (!e || !e.session_id || !e.hook_event_name) return;
    const ev = e.hook_event_name;
    // 종류 없는 서브에이전트 = Claude 내부 보조 작업(다음 질문 추천 등). 화면에 안 보인다.
    if (e.agent_id && !e.agent_type) return;
    if (ev === 'SessionEnd') { const s = S.get(e.session_id); if (s) { L(s, `세션 종료`); S.delete(e.session_id); } return onChange(); }
    const s = session(e, pane), t = now();
    if (e.permission_mode) s.mode = e.permission_mode;
    let ag = null;
    if (e.agent_id) {
      ag = s.agents[e.agent_id] ||= { id: e.agent_id, type: e.agent_type || 'agent', status: 'run', since: t, last: t, tool: '', arg: '', feed: [], files: [], task: '', result: '' };
      ag.last = t;
    }
    const tg = ag || s;

    if (['SessionStart', 'PostToolUse', 'Stop', 'SubagentStop'].includes(ev)) refreshGit(s);
    if (ev === 'SessionStart') { if (e.model) s.model = e.model; L(s, '세션 시작'); }
    else if (ev === 'UserPromptSubmit' && /^\s*<task-notification>/.test(e.prompt || '')) {
      s.status = 'run'; // 백그라운드 에이전트 완료 알림 — 사용자 지시가 아니다
    }
    else if (ev === 'UserPromptSubmit') {
      gitHeads(s.cwd).then(h => { s.base = h; refreshGit(s); });
      s.prompt = cut(e.prompt, 4000); s.answer = ''; s.status = 'run'; s.since = t; s.approval = null; s.files = []; s.tool = ''; s.arg = '';
      L(s, `지시: ${cut(e.prompt, 80)}`);
    }
    else if (ev === 'PreToolUse') {
      const i = e.tool_input || {}, arg = cut(argOf(e.tool_name, i), 300);
      tg.status = 'run'; tg.tool = e.tool_name; tg.arg = arg;
      push(tg.feed, { t, tool: e.tool_name, arg, st: 'run', id: e.tool_use_id, input: e.tool_name === 'Bash' ? { command: i.command, description: i.description } : undefined });
      if (!ag) { s.status = 'run'; s.approval = null; }
      if (!ag && (e.tool_name === 'Agent' || e.tool_name === 'Task') && i.subagent_type) {
        s.dispatch[i.subagent_type] = (s.dispatch[i.subagent_type] || 0) + 1;
        L(s, `→ ${i.subagent_type}: ${cut(i.description, 60)}`);
        s.pendingTask = { type: i.subagent_type, task: cut(i.prompt, 2000) };
      }
      if (ag && !ag.task && s.pendingTask?.type === ag.type) { ag.task = s.pendingTask.task; s.pendingTask = null; }
    }
    else if (ev === 'PostToolUse') {
      const f = [...tg.feed].reverse().find(x => x.st === 'run' && (e.tool_use_id ? x.id === e.tool_use_id : x.tool === e.tool_name));
      const r = e.tool_response;
      if (f) {
        f.st = r && r.interrupted ? 'fail' : 'ok'; f.ms = e.duration_ms;
        if (e.tool_name === 'Bash' && r && typeof r === 'object') f.out = cut([r.stdout, r.stderr].filter(Boolean).join('\n'), 2000);
        if (e.tool_name === 'Agent' || e.tool_name === 'Task') f.st = r && r.isAsync ? 'run' : 'ok';
      }
      if (['Edit', 'Write', 'MultiEdit'].includes(e.tool_name)) addFile(tg, e.tool_name, e.tool_input);
      if (!ag && s.approval) s.approval = null;
      if (!ag && s.status === 'appr') s.status = 'run';
    }
    else if (ev === 'Notification') {
      if (e.notification_type === 'permission_prompt') {
        const p = [...s.feed, ...Object.values(s.agents).flatMap(a => a.feed)].filter(x => x.st === 'run' && x.tool !== 'Agent').sort((a, b) => b.t - a.t)[0];
        s.status = 'appr';
        s.approval = { since: t, msg: e.message || '', tool: p?.tool || '', cmd: p?.input?.command || p?.arg || '', why: p?.input?.description || '', screen: '' };
        L(s, `승인 요청: ${cut(s.approval.cmd || e.message, 80)}`);
        if (s.pane) capture(s.pane).then(out => { if (s.approval) { s.approval.screen = String(out).replace(/\s+$/, '').split('\n').slice(-28).join('\n'); onChange(); } }).catch(() => {});
      } else if (e.notification_type === 'idle_prompt' && s.status !== 'appr') s.status = s.status === 'run' ? 'done' : s.status;
    }
    else if (ev === 'Stop') {
      s.answer = cut(e.last_assistant_message, 6000); s.tool = ''; s.arg = ''; s.approval = null;
      const bg = Array.isArray(e.background_tasks) && e.background_tasks.length > 0;
      s.status = bg ? 'run' : 'done';
      if (!bg) { settleRunning(s); L(s, '완료'); }
    }
    else if (ev === 'SubagentStop' && ag) {
      ag.status = 'done'; ag.tool = ''; ag.arg = ''; ag.result = cut(e.last_assistant_message, 4000); settleRunning(ag);
      const f = [...s.feed].reverse().find(x => x.tool === 'Agent' && x.st === 'run' && x.arg.startsWith(ag.type));
      if (f) f.st = 'ok';
      L(s, `${ag.type} 완료`);
      // 끝난 인스턴스는 타입별 최근 것만 남긴다
      const same = Object.values(s.agents).filter(a => a.type === ag.type && a.status === 'done').sort((a, b) => b.last - a.last);
      same.slice(3).forEach(a => delete s.agents[a.id]);
    }
    onChange();
  }

  // tmux 창이 사라진 세션 정리 + tmux 세션 이름 갱신
  async function sync() {
    let out = '';
    try { out = await tmux('list-panes', '-a', '-F', '#{pane_id}\t#{session_name}'); } catch { out = ''; }
    const panes = new Map(String(out).trim().split('\n').filter(Boolean).map(l => l.split('\t')));
    let ch = false;
    for (const s of S.values()) {
      refreshGit(s); // 훅 밖에서 바뀐 것도 10초 안에 보인다
      if (!s.pane) continue;
      if (!panes.has(s.pane)) { L(s, 'tmux 창 닫힘'); S.delete(s.id); ch = true; }
      else if (s.tmux !== panes.get(s.pane)) { s.tmux = panes.get(s.pane); ch = true; }
    }
    if (ch) onChange();
  }

  const find = id => { const s = S.get(id); if (!s || !PANE.test(s.pane)) throw new Error('세션이 없거나 tmux 창을 모릅니다'); return s; };
  async function send(id, text) {
    const s = find(id); text = String(text || '').replace(/\r/g, '').trim();
    if (!text) throw new Error('빈 메시지'); if (text.length > 8000) throw new Error('너무 깁니다');
    await tmux('send-keys', '-t', s.pane, '-l', text.replace(/\n/g, ' '));
    await new Promise(r => setTimeout(r, 120));
    await tmux('send-keys', '-t', s.pane, 'Enter');
  }
  async function approve(id, choice, reason) {
    const s = find(id); if (s.status !== 'appr') throw new Error('승인 대기 중이 아닙니다');
    if (choice === 'yes') await tmux('send-keys', '-t', s.pane, '1');
    else if (choice === 'always') await tmux('send-keys', '-t', s.pane, '2');
    else {
      await tmux('send-keys', '-t', s.pane, 'Escape');
      if (reason) { await new Promise(r => setTimeout(r, 500)); await send(id, reason); }
    }
    L(s, choice === 'no' ? `거절${reason ? `: ${cut(reason, 60)}` : ''}` : choice === 'always' ? '항상 허용' : '허용');
    s.approval = null; s.status = 'run'; onChange();
  }
  async function stop(id) { const s = find(id); await tmux('send-keys', '-t', s.pane, 'Escape'); L(s, '멈춤 요청'); }

  const snapshot = () => ({ now: now(), sessions: [...S.values()].map(({ pendingTask, ...s }) => s), log: log.slice(-60) });
  return { ingest, sync, send, approve, stop, snapshot, _S: S };
}
