# dak-dash-board

여러 Claude Code 세션(rtmc-project 총괄 + 저장소별 에이전트)을 웹에서 관리하는 대시보드. 지금은 `index.html` 단일 파일 샘플(예시 데이터)이다.

## 보안 — 공개 저장소

- 키·토큰·비밀번호·`.env`·인증서·세션 기록(`~/.claude`)을 **절대 커밋하지 않는다.**
- 서버 IP·계정·내부 주소를 코드에 하드코딩하지 않는다. 필요하면 `.env`(git 제외)에서 읽고 `.env.example` 에는 키 이름만 둔다.
- 커밋 전 `git diff --cached` 로 비밀값·내부 정보가 섞이지 않았는지 확인한다.
- 개인 배경 이미지(`bg.jpg`)는 저작권 문제로 커밋하지 않는다.

## Git 규칙 (rtmc-project 저장소들과 동일)

### 커밋 메시지

- 형식은 **`Type: 요약`** 하나로 고정한다. prefix 는 대문자로 시작하고 요약은 한글로 쓴다.
- type 은 7개뿐이다: `Feat:` 기능 추가 · `Fix:` 버그 수정 · `Refactor:` 동작 변화 없는 구조 개선 · `Chore:` 버전·설정·빌드·의존성 · `Docs:` 문서 · `Style:` 서식(로직 변화 없음) · `Test:` 테스트 코드
- 한 커밋 = 하나의 논리적 변경. 구조 변경과 구현을 섞지 않는다.
- 본문은 큰 변경에만 붙이고 `-` 불릿으로 무엇을 왜 바꿨는지 적는다.
- 금지: 소문자 prefix(`fix:`), 대괄호(`[수정]`)·스코프(`fix(scope):`) 표기, prefix 없는 문장, `misc` `update` `wip` `수정` `저장` 같은 모호한 메시지.

### AI · 도구 흔적 금지

커밋 메시지(제목·본문·트레일러), PR 제목·본문, 태그·릴리스 노트, 코드 주석, author/committer 에 사람 계정만 보이게 한다.

- author/committer 는 저장소 `git config` 의 사람 계정만 쓴다. AI·봇 이름·이메일을 넣지 않는다.
- 도구명·모델명(`Cursor` `Claude` `Codex` `Copilot` `ChatGPT` `Gemini` `agent` `AI`)을 커밋·PR 에 쓰지 않는다.
  단, 이 프로젝트가 관리하는 대상인 "Claude Code 세션"을 화면·문서에서 가리키는 것은 기능 설명이므로 괜찮다.
- 서명·배지·세션 트레일러(`Co-Authored-By`, `Generated with`, `Made-with`, `Claude-Session`, `🤖`)를 넣지 않는다.

### 커밋 전

- `git status` 로 변경 파일을 확인하고 의도하지 않은 파일은 제외한다.

### 브랜치 · 푸시

- `main` 직접 push 금지. 작업 브랜치(`feat/*`, `fix/*`, `refactor/*`, `chore/*`, `docs/*`)에서 작업하고 PR 로 머지한다.
- 이미 push 한 커밋은 `--amend` / rebase 하지 않는다. push 전에만 정리한다.
- **커밋 · 푸시 · PR 생성은 사용자가 명시적으로 요청할 때만 수행한다.**
