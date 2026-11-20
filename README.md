# even-discord-bridge

**Even Realities G2 안경이나 iPhone Siri에서 말로 물으면, Discord 채널에서 이미 돌고 있는 AI 비서(“Chris”, OpenClaw 세션)에게 전달하고 그 답을 안경 렌즈에 보여주는(원하면 iPhone으로 읽어 주는) 중계 서비스.**

A small relay that lets you talk to an existing Discord-based AI assistant session from Even Realities G2 smart glasses (or an iPhone Siri Shortcut): speech → text on your own Mac → a dedicated Discord relay bot posts it → the assistant's reply is correlated back and shown on the lens, and optionally read aloud on the iPhone.

- 새 AI 세션을 만들지 않는다. Discord 채널의 **기존 대화 맥락**을 그대로 이어 쓴다.
- 음성 인식은 **자기 Mac**(whisper.cpp)에서 한다. 오디오는 저장하지 않는다.
- 외부 공개 포트 없음. iPhone → Mac 접속은 **Tailscale Serve**(tailnet 안에서만)로만 한다.

```
 G2 안경 마이크 ──► Even Hub 앱(WebView, app/) ─┐
                                                 │ HTTPS (Tailscale Serve, tailnet 신원 헤더 + 기기 토큰)
 iPhone Siri 단축어 (받아쓰기) ──────────────────┤
                                                 ▼
                                  중계 서비스 (Node, 127.0.0.1:8787)
                                  ├─ /v1/transcriptions  whisper.cpp (한국어) ─ 오디오 미보관
                                  ├─ /v1/ask             문장 → Discord 게시, 답 대기
                                  └─ SQLite: 요청·상태·답 대응·기기
                                                 │ Discord REST 게시 (전용 중계 봇, 무음)
                                                 ▼          ▲ Gateway MESSAGE_CREATE + 재연결 catch-up
                                  Discord 채널 ──► 기존 AI 비서 세션 ──► 같은 채널에 답

 답 → 렌즈 표시 + (켜 두면) iPhone 내장 음성으로 읽기 → iPhone 스피커 / 연결된 이어폰  (G2에는 스피커 없음)
```

## 상태

| 단계 | 내용 | 결과 |
|---|---|---|
| P0 | 인증된 요청 → 중계 봇 게시 → 기존 세션의 답 회수 (모의시험 AT-01~15, 실연결 AT-16~22) | PASS |
| P1 경로 S | iPhone Siri 단축어 → `POST /v1/ask` → 답을 Siri가 읽음 | 동작 (실사용 중) |
| P1 G2 앱 | 기기 등록 → 안경 마이크 녹음 → Mac 인식 → 확인 후 전송 → 답을 렌즈에 페이지로 표시 | 실기기 왕복 PASS (Even Hub Private build) |
| 답 음성 읽기 | 답을 iPhone(스피커·이어폰)으로 읽기, 켬/끔 ([docs/p1/tts-design.md](docs/p1/tts-design.md)) | 스파이크 PASS(안경 입력·잠금 상태에서 시작, 읽은 뒤 마이크 정상). 0.4.1: 끔 상태 두 번 누르기 읽기 확인, 나머지 인수(자동 읽기·잠금·무음 스위치) 미실시. AirPods 착용 중 가끔 스피커로 나오는 현상 조사 중 |
| P1 인수시험 | AT-23(구간 지연)·AT-24(5분 잠금 복귀) 정식 실행 | 미실시 |

실측 예 (G2, 2026-11-20): 음성 인식 1.1 s, Discord 게시 0.5 s, 비서 답 10.4 s, 답 → 렌즈 0.34 s. 지연의 대부분은 비서가 답을 만드는 시간이다. 자세한 기록: [docs/p1/device-test-plan.md](docs/p1/device-test-plan.md), [docs/test-report.md](docs/test-report.md).

## 보안 모델

- **두 겹의 접근 제어:** Tailscale Serve가 붙이는 tailnet 신원(`Tailscale-User-Login`)이 허용 목록에 있어야 하고, 그 위에 Bearer 토큰이 필요하다. CORS는 보조 수단일 뿐 인증이 아니다.
- **토큰 종류별 범위:** CLI(정해진 템플릿만), 음성(`/v1/ask` 자유 문장만), G2 기기(서버가 인식한 `transcript_id`만 보낼 수 있고 임의 문장은 거절). 기기 토큰은 6자리 코드 페어링(Mac에서 운영자 승인, 5분·1회용)으로만 발급되며 서버에는 SHA-256만 저장한다. `admin revoke-device`로 즉시 폐기.
- **음성 읽기는 휴대폰 안에서:** 답 문장은 이미 휴대폰에 온 것을 iPhone 내장 음성으로 읽는다. 새로 밖으로 나가는 데이터와 서버 변경은 없다.
- **앱에 비밀 없음:** Even Hub 패키지(.ehpk)는 Even 서버에 올라가므로 토큰을 넣지 않는다. 기기 토큰은 페어링 후 Even 앱 저장소에만 있다.
- **비밀은 macOS 키체인에서만** 읽어 환경변수로 넘긴다(`scripts/start-live.sh`). 로그에 토큰·질문 문장·답 본문을 남기지 않는다(글자 수·지연만).
- **Discord 쪽:** 전용 중계 봇은 대상 채널 하나에만 보기/쓰기 권한. 게시물의 멘션은 무력화하고, 게시는 무음(`SUPPRESS_NOTIFICATIONS`)이다. 사용자 계정 토큰은 쓰지 않는다.
- **답 대응:** 채널당 한 번에 한 요청. 비서에게 요청 ID를 마지막 줄에 쓰게 하고, 대상 봇·채널·요청 ID가 맞는 글만 답으로 받는다. 모호하면 `ambiguous_response`로 남기고 추측하지 않는다.

## 요구 환경

- macOS (상시 켜진 Mac), Node.js ≥ 24 (개발: v26, TypeScript 타입 제거 실행, `node:sqlite`) — 서버 런타임 의존성 없음
- Tailscale (Mac과 iPhone이 같은 tailnet, Serve + HTTPS 인증서)
- Discord 봇 1개 (Message Content Intent), 대상 채널에 답하는 AI 비서
- G2 경로: `whisper-cli`(whisper.cpp, Homebrew) + `~/.cache/whisper/ggml-small.bin`, Even Realities 앱 + Even Hub 개발자 계정

## 빠른 시작 (모의, Discord 없음)

```sh
npm ci
npm run typecheck && npm test          # 모의시험 (FakeDiscord, FakeTranscriber)
export RELAY_CLIENT_TOKEN="$(openssl rand -hex 24)" RELAY_PRINCIPAL_ID=owner
npm run start:mock                     # 127.0.0.1:8787
npm run client -- send connection_check --wait   # 다른 터미널
```

## 실제 연결 설정

1. **Discord 중계 봇**: [docs/relay-bot-setup.md](docs/relay-bot-setup.md). 비서가 이 봇의 글에 답하도록 비서 쪽 채널 설정에 봇을 추가해야 할 수 있다([docs/config-diff.md](docs/config-diff.md), OpenClaw 예).
2. **서버 설정 파일** (저장소 밖, 직접 만든다):
   ```sh
   cp config/live.env.example config/live.env     # guild·채널·중계 봇·비서 봇 ID, (선택) RELAY_OWNER_TITLE = 게시문에서 부를 호칭
   security add-generic-password -a "$USER" -s even-relay-discord-bot-token -w   # 봇 토큰
   security add-generic-password -a "$USER" -s even-relay-voice-token -w "$(openssl rand -hex 24)"
   ```
3. **Tailscale Serve**: `tailscale serve --bg --https=8443 http://127.0.0.1:8787` — [docs/access-tailscale-serve.md](docs/access-tailscale-serve.md)
4. **상시 실행** (사용자 LaunchAgent, 로그인 시 시작·비정상 종료 시 재시작):
   ```sh
   scripts/relay-service.sh install      # start | stop | restart | status
   ```
   로그: `data/relay-live.log` (JSON 줄, 비밀·본문 없음)
5. **Siri 단축어** (선택): [docs/p1/siri-shortcut.md](docs/p1/siri-shortcut.md)

## G2 앱 (`app/`)

```sh
cd app && npm ci
cp app.json.example app.json                       # network whitelist에 자기 relay 주소
echo 'VITE_RELAY_ORIGIN=https://<mac>.<tailnet>.ts.net:8443' > .env.local
```

- **개발**: `scripts/app-dev.sh start` → `scripts/app-dev.sh qr [index.html|spike.html|tts-spike.html]` → Even 앱 Even Hub에서 QR 스캔 (Mac의 tailnet IP로만 서빙). `start`는 tts-spike의 비교용 음성 파일도 `say`로 만든다
- **설치형**: `npm run pack` → `app/build/g2-chris.ehpk` → `npx evenhub login`(한 번) → `npx evenhub create …`(처음) / `npx evenhub upload … -m "…"`(이후) → Even 앱 Me → Apps → Private builds → Install
- 설치형 앱의 WebView origin은 `http://127.0.0.1:<실행마다 바뀌는 포트>`라서, relay는 이 루프백 origin만 포트 와일드카드로 허용한다(`data/allowed-origins.txt`에 `http://127.0.0.1:*`).
- **첫 실행**: 렌즈에 6자리 번호 → Mac에서 `npm run admin -- pair <번호>` (5분 안)
- **사용**: 누르기 → “● 듣는 중”에 말하기 → 누르기 → “보낼까요?”에서 누르기(전송)/두 번(취소) → 답은 위·아래로 쓸어 페이지 넘김
- **음성 읽기**: 첫 화면에서 아래로 쓸기(또는 휴대폰 화면 버튼)로 켬/끔, 기본 꺼짐. 켜 두면 새 답을 iPhone 음성(`speechSynthesis`)으로 끝까지 읽는다. 답 화면에서 두 번 = 멈춤/처음부터 다시, 누르기 = 닫기(읽기도 멈춤). 지난 답 다시 보기(위로 쓸기)는 자동으로 읽지 않는다. G2에는 스피커가 없어 소리는 iPhone 스피커나 연결된 이어폰으로 나오고, 경로는 iOS·Even 앱이 정한다.
  - 휴대폰 화면 **“오디오 playback 고정”**(기본 끔): 읽는 동안만 Web Audio Session을 `playback`으로 요청한다. AirPods를 끼고도 스피커로 나올 때 시험용이며, 다른 앱 음악이 멈출 수 있다. 읽을 때마다 휴대폰 로그에 녹음 끝 후 경과·오디오 상태를 남긴다([docs/p1/tts-design.md §9](docs/p1/tts-design.md)).

## API 요약

```
POST /v1/requests            CLI 토큰. 정해진 템플릿만 (P0)
GET  /v1/requests/{id}
POST /v1/ask                 음성 토큰 {"text"} | 기기 토큰 {"transcript_id"}; Idempotency-Key; wait_seconds ≤ 25
GET  /v1/ask/{id}?wait=25    대기형 조회
POST /v1/ask/{id}/displayed  기기: 첫 페이지가 렌즈에 그려진 시각(지연 기록)
POST /v1/transcriptions      기기: PCM s16le 16 kHz mono, 0.3–30 s → {transcript_id, text, no_speech, max_rms}
POST /v1/pairing/start       tailnet 신원만 → {pairing_id, code, claim_secret}
POST /v1/pairing/claim       202 대기 | 200 {device_token} 1회
GET  /healthz                {ready, connected}
```

## 운영 도구

```sh
npm run admin -- list | show <request_id>          # 요청 메타데이터·타임라인 (본문 없음)
npm run admin -- pair <code> | devices | revoke-device <id>
npm run admin -- rms [n]                           # 최근 녹음 소리 크기와 추천 무음 기준
npm run admin -- set-rms <n>                       # 무음 기준 저장 + relay 재시작
npm run admin -- resolve-failed <id> | confirm-posted <id> <message_id> | purge
```
실행·중지·복구·롤백: [OPERATIONS.md](OPERATIONS.md)

## 구성

| 경로 | 내용 |
|---|---|
| `src/api/` | HTTP API, 인증(토큰 범위·tailnet 신원·기기), CORS |
| `src/store/` | SQLite 스키마·마이그레이션, idempotency, 채널당 1건 잠금, 보존 기간 정리 |
| `src/discord/` | 어댑터 인터페이스, `real.ts`(REST + Gateway), `fake.ts`(장애 주입·모의 비서) |
| `src/service.ts`, `src/correlation.ts` | 상태 전이, 답 대응, timeout, 재시작 복구, catch-up |
| `src/voice.ts`, `src/stt.ts`, `src/devices.ts`, `src/calibrate.ts` | 음성 문장 정리, whisper.cpp, 기기 페어링, 무음 기준 보정 |
| `src/cli.ts`, `src/admin.ts` | 시험 클라이언트, 운영자 도구 |
| `app/` | Even Hub 앱 (Vite + `@evenrealities/even_hub_sdk`). `spike.html`·`tts-spike.html`은 실기기 점검용(빌드 제외) |
| `scripts/` | `start-live.sh`(키체인 → 환경변수), `relay-service.sh`(LaunchAgent), `app-dev.sh` |
| `tests/` | `node:test` 모의시험 69개 (실제 Discord·Even·whisper 정확도의 증거는 아님) |
| `docs/` | 상태 전이, 접속 경로, 봇 설정, P1 설계·실기기 시험 기록, 음성 읽기 설계(`docs/p1/tts-design.md`) |

## 저장소에 넣지 않은 것

실제 서버 ID·tailnet 주소·Discord/OpenClaw 기록이 담긴 파일은 이 Mac에만 둔다(`.gitignore`): `config/live.env`, `app/.env.local`, `app/app.json`, `app/spike-assets/`(시험용 합성 음성), `data/`(DB·로그), 작업 일지, 실연결 증거, 원 요구 명세 패키지. 문서 속 `<GUILD_ID>`, `<mac>.<tailnet>.ts.net` 같은 꺾쇠 표기는 자기 값으로 바꿔 읽으면 된다.

## 라이선스

[MIT](LICENSE). Even Realities SDK·Discord·Tailscale·whisper.cpp는 각자의 약관을 따른다. 이 프로젝트는 Even Realities, Discord, Tailscale, OpenClaw와 관계없는 개인 프로젝트다.
