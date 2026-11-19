# Siri 단축어로 Chris에게 묻기 (P1 경로 S)

상태: **서버 구현·모의시험 완료(tests/p1-ask.test.ts 9건). 실기기(iPhone·Siri·G2) 미시험.**
흐름: “Siri야, 크리스에게 물어봐” → Apple 받아쓰기(한국어) → (확인 없이) `POST /v1/ask`(Tailscale Serve) → Chris 채널 → Chris 기존 세션 → 답을 Siri가 읽고 화면·알림에 표시.
G2 마이크·R1은 쓰지 않는다(iPhone/AirPods 마이크). 렌즈 표시는 G2의 iPhone 알림 미러링에 달려 있으며 미확인.

## 1. Mac 준비 (1회)

음성용 토큰은 P0 CLI 토큰과 **별도**이고 `/v1/ask`만 쓸 수 있다(템플릿 요청 불가, CLI 요청 조회 불가).

```sh
# 토큰 생성 → Keychain 저장 (화면에 출력되지 않음)
security add-generic-password -a "$USER" -s even-relay-voice-token -w "$(openssl rand -hex 24)"
# 상시 실행 (2026-11-19부터): 사용자 LaunchAgent local.even-relay
#   로그인하면 시작, 비정상 종료·시작 실패(Tailscale 미연결 등) 시 30초 안에 다시 시작, stop 후에는 꺼진 채 유지
scripts/relay-service.sh install     # 1회 등록 + 시작
scripts/relay-service.sh status      # 상태 + /healthz
scripts/relay-service.sh restart     # 코드 변경 후
scripts/relay-service.sh stop | start
scripts/relay-service.sh uninstall   # 등록 해제
# 시험용 포그라운드 실행 (서비스를 stop한 뒤): scripts/start-live.sh  (Ctrl-C로 중지)
```
LaunchAgent는 **이 사용자가 로그인해야** 시작한다. 정전 등으로 재부팅되면 로그인(또는 자동 로그인)이 필요하다. 로그는 그대로 `data/relay-live.log`.

iPhone으로 토큰 옮기기 (같은 Apple ID, Handoff 켜짐 — 범용 클립보드):
```sh
security find-generic-password -a "$USER" -s even-relay-voice-token -w | tr -d '\n' | pbcopy
# iPhone 단축어에 붙여넣은 뒤 Mac 클립보드 비우기
pbcopy < /dev/null
```

폐기: `RELAY_VOICE_DISABLED=1`로 재시작(즉시 403), 교체는 Keychain 항목을 지우고 다시 생성.

## 2. iPhone 단축어 만들기

단축어 앱 → `+` → 이름 **크리스에게 물어봐** (이 이름이 Siri 호출어). 동작을 차례로 추가:

| # | 동작 (한국어 / English) | 설정 |
|---|---|---|
| 1 | 텍스트 받아쓰기 / Dictate Text | 언어 **한국어**, 듣기 중단 **일시 정지 후** |
| 2 | (선택) 경고 보기 / Show Alert | 전송 전 확인용. 사용자 결정(2026-11-19)으로 **쓰지 않음** — 현재 단축어의 2번은 `알림 보기`(기다리지 않음)라 받아쓰기 직후 바로 전송된다. 확인이 다시 필요하면 경고 보기(취소 버튼 보기 켬)로 교체 |
| 3 | URL 콘텐츠 가져오기 / Get Contents of URL | URL `https://<mac>.<tailnet>.ts.net:8443/v1/ask` · 방법 **POST** · 헤더 `Authorization` = `Bearer ` + 붙여넣은 토큰 · 요청 본문 **JSON**: `text`(텍스트) = 받아쓴 텍스트, `wait_seconds`(숫자) = `25` |
| 4 | 사전 값 가져오기 / Get Dictionary Value | 키 `reply`, 사전 = URL 콘텐츠 |
| 5 | 텍스트 말하기 / Speak Text | 사전 값 |
| 6 | 알림 보이기 / Show Notification | 사전 값 (G2 미러링 확인용) |

메뉴(메뉴에서 선택)는 쓰지 않는다: `단축어 중단`이 `메뉴 끝` 아래에 놓이면 `보내기`를 눌러도 조용히 끝나 요청이 나가지 않는다(2026-11-18 실기기: 보내기 후 요청 0건, 원인 추정). 토큰 복사(§1)는 3번의 헤더 값 칸까지 만든 뒤에 한다(범용 클립보드는 약 2분 유지). 보낸 뒤 답을 최대 25초 기다리므로 그동안은 화면 변화가 거의 없다.

응답이 25초 안에 오지 않으면 `reply`는 “아직 Chris 답을 기다리는 중…”이다. 선택 사항으로 3번 뒤에 `done`이 거짓이면 `request_id`로 `GET …/v1/ask/<request_id>?wait=25`를 한 번 더 부르는 분기를 넣을 수 있다.
오류(토큰·Tailscale·중복 진행 등)도 `reply`에 한국어 문장으로 오므로 그대로 읽어 주면 된다.

## 3. 서버 동작 요약 (`POST /v1/ask`)

| 항목 | 동작 |
|---|---|
| 인증 | Bearer 음성 토큰 + Tailscale Serve의 `Tailscale-User-Login` 일치 |
| 본문 | `{"text": "...", "wait_seconds": 0–55}` (+ 선택 `target: "chris-primary"`). 그 밖의 필드 400 |
| 문장 정리 | 한 줄로 합침, 500자 제한, 보이지 않는 문자 제거, `<`·`>`·`@` 무력화(멘션·@everyone 불가), UUID 포함 시 거절 |
| Discord 게시 | **무음 메시지**(`SUPPRESS_NOTIFICATIONS`, 휴대폰 알림 없음). 헤더 `[G2 음성 중계 · 인증된 사용자 요청 · 대화 전용]`, 요청 ID, `<@Chris> 문장`, “한 메시지 · 300자 이내 · 답 문장으로 시작하고 요청 ID는 맨 마지막 줄 · 실행이 필요하면 Discord에서 사용자 확인” 지시 |
| 중복 | Idempotency-Key가 없으면 같은 문장을 30초 안에 다시 보내면 같은 요청으로 처리(게시 1회) |
| 대기 | 답이 오거나 `wait_seconds`가 지나면 응답. `reply` = 요청 ID 줄·마크다운을 뺀 답, 또는 상태 문장 |
| 기록 | 로그에 문장·답·토큰 없음. DB 문장 보존 7일(P0와 동일) |

## 4. 실기기 시험

SS-1 서버 측 결과 (2026-11-18): 받아쓴 문장 “오늘 무슨 요일이야” → `POST /v1/ask` 201 (9.9초) · 작성자 `owner.voice` · Discord 게시 1건 · Chris 답 1건(요청 ID 일치, 늦은 답 아님) · OpenClaw `agent_run` 1건 기존 세션(`agent:main:discord:channel:…`, 시작 6초 뒤 succeeded, 직전 run과 같은 sessionId). Siri가 답을 읽음(사용자 확인) → **SS-1 PASS**.
SS-5 (같은 실행): 단축어 `알림 보이기` 알림은 G2 렌즈에 **표시되지 않음**. Even 앱 알림에서 Discord를 선택하자 Discord 글은 렌즈에 표시됨(단축어 알림과 별개). Even 앱 알림 목록에 단축어 앱이 없음(사용자 확인) → 단축어 알림으로는 렌즈 표시 불가. SS-2·3·4·6·7 NOT_RUN.

렌즈 표시 경로 변경 (2026-11-18 재시작부터): 단축어 알림 대신 **Chris 답의 Discord 알림**을 G2로 미러링한다. 질문 글은 무음으로 게시하고, Chris에게 요청 ID를 마지막 줄에 쓰도록 지시해 알림 첫 줄이 답 문장이 되게 한다. iPhone 쪽 조건: Even 앱 알림 대상에 Discord 선택, Discord 앱에서 Chris 채널 알림 “모든 메시지”, Mac Discord 사용 중에는 휴대폰 알림이 늦거나 안 올 수 있음. 미확인: (1) 무음 게시를 OpenClaw/Chris가 평소처럼 처리하는지 (2) 렌즈에 질문 글 알림이 뜨지 않는지 (3) 렌즈 첫 줄이 답 문장인지. → SS-5 재시험.

SS-5 재시험 서버 측 (2026-11-18): `POST /v1/ask` 201 (8.5초). 질문 글 `flags=4096`(무음) 확인, Chris 답은 첫 줄이 답 문장·마지막 줄이 요청 ID, 요청 ID로 연결. OpenClaw `agent_run` 1건 기존 세션 succeeded(7초) → 무음 게시도 Chris가 평소처럼 처리 (1) 확인. 렌즈(사용자 확인): 질문 글 알림은 뜨지 않고 Chris 답만 표시됨 → **SS-5 PASS (Discord 알림 미러링 경로)**. 렌즈에 보인 첫 줄 문구는 따로 기록하지 않음. Siri 읽기도 정상(사용자 확인).


| ID | 절차 | 합격 |
|---|---|---|
| SS-1 | 단축어 실행 → “오늘 날짜 알려줘” → 보내기 | Discord에 1건 게시(작성자 G2 Relay), Chris 답 1건, OpenClaw run 1건(기존 세션), Siri가 답을 읽음 |
| SS-2 | 받아쓰기 후 `취소` | 게시 0 |
| SS-3 | 한국어 인식 5문장(고유명사 포함) | 받아쓴 문장 vs 의도 문장 기록 |
| SS-4 | Tailscale 끄고 실행 | 연결 오류, 게시 0 |
| SS-5 | 알림 보이기 → G2 렌즈 | 한국어 답이 렌즈에 보이는지(미러링 설정 포함) 기록 |
| SS-6 | 잠금 화면에서 Siri로 실행 | 동작/거부 여부 기록 |
| SS-7 | 지연 | 받아쓰기 끝 → 답 읽기 시작까지 초, 서버 `sent_at`·`completed_at`과 대조 |

Siri 호출 (2026-11-19 이후): “Siri야, 크리스에게 물어봐”로 실행하면 문장을 받기는 하지만 중계에 요청 0건(사용자 보고 + 서버 기록). 추정 원인: “○○에게 물어봐/보내”가 Siri 기본 메시지 명령으로 해석되어 단축어 대신 메시지 앱이 실행됨. 조치: 단축어 이름을 “에게” 없는 이름으로 변경 후 재시험(미확인).

2026-11-19: 사용자가 Even 앱 알림 대상에 단축어를 지정함(앞서 목록에 없다고 보고했으나 지정 가능했음) → 단축어 알림이 G2 렌즈에 표시됨. 같은 시간대에 Discord 알림은 렌즈에 표시되지 않음. 서버 측은 8건 모두 completed, Chris 답 각 1건(Discord 게시는 정상). Discord 알림이 iPhone 자체에 왔는지, Even 쪽에서 빠졌는지는 미확인.

SS-7 서버 측 지연 (2026-11-17~19 음성 요청 39건, 모두 completed): Discord 게시까지 중앙값 0.46초(최대 0.87). Chris 답까지 중앙값 9.0초, 90% 27.9초, 최대 40.0초. 25초 초과 6건(15%). 이런 늦은 답은 Siri가 “기다리는 중”을 읽고, 답 자체는 Discord 알림으로 렌즈에 온다(사용자 결정 2026-11-19: 단축어·Discord 알림 둘 다 켬, 25초 안의 답은 렌즈에 두 번 표시될 수 있음). 받아쓰기 끝→Siri 읽기 시작 체감 시간은 미측정.
SS-2(취소)는 확인 단계를 없앴으므로(D4 끔) 해당 없음.

## 5. 문제 해결

서버 기록 확인: `grep '"event":"http"' data/relay-live.log | tail` (문장·토큰은 기록되지 않음)

| 기록 | 원인 | 고칠 곳 |
|---|---|---|
| 요청이 아예 없음 | 중계 서비스 꺼짐 또는 iPhone Tailscale 꺼짐 | `curl …/healthz`, iPhone Tailscale |
| `GET /healthz`(Safari)는 있는데 `POST /v1/ask` 없음 | 단축어가 URL 동작 전에 끝남(`단축어 중단` 위치, 메뉴 분기) | 메뉴 대신 2번 경고 보기 |
| `GET /` 또는 `GET /v1/ask` | URL 끝 `/v1/ask` 누락 또는 방법이 GET | 3번 URL·방법(POST) |
| `POST /v1/ask` 401 | 헤더 없음/오타, `Bearer` 뒤 공백 누락, 토큰 일부만 붙여넣음 | 3번 헤더 키 `Authorization`, 값 `Bearer `+48자 |
| `POST /v1/ask` 415 | 요청 본문이 JSON이 아님 | 3번 요청 본문 **JSON** |
| `POST /v1/ask` 400 | 본문 필드 이름 오류(`text`) 또는 받아쓴 텍스트가 비어 있음 | 3번 필드 키 |
