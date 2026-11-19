# P1 설계 — G2/R1 음성으로 Chris와 대화 (I-08)

작성 2026-11-17 · 상태: **설계 초안. 구현·실기기 시험 미실시.** P0 G2 실연결 통과 후 착수.
범위(PRD §3 P1): G2/R1 앱, 음성 인식, 짧은 한국어 답변 표시, 휴대폰 잠금/복귀, 연결 복원. 기본 상대 Chris. “첫 유용한 문장”까지 지연 측정.
비범위: 여러 비서·채널 선택, 분할/수정 응답 완전 지원, 검색, 운동·프롬프터(P2/후속).

## 1. 확인된 플랫폼 사실 (2026-11-17, Even Hub 문서 + SDK 0.0.16 타입 정의)

| 항목 | 사실 | 출처 |
|---|---|---|
| 실행 위치 | 앱 로직은 iPhone의 Even Realities 앱 안 WebView(iOS: WKWebView). G2는 표시·입력만 | Architecture |
| 마이크 | `bridge.audioControl(true, AudioInputSource.Glasses \| Phone)` → `onEvenHubEvent`의 `event.audioEvent.audioPcm`(Uint8Array). **PCM 16 kHz, s16le, mono.** G2 마이크는 `createStartUpPageContainer` 이후만. 권한 `g2-microphone` / `phone-microphone` | Device APIs, `index.d.ts` |
| 음성 인식 | **SDK에 없음.** 원시 PCM만 제공 → 인식은 앱 또는 서버가 해야 함 | Device APIs, FAQ, `index.d.ts` |
| 입력 | G2 터치패드·R1 공통: `CLICK`(0), `DOUBLE_CLICK`(3), `SCROLL_TOP`(1), `SCROLL_BOTTOM`(2), `LONG_PRESS`(9)/`LONG_PRESS_RELEASE`(10, SDK 0.0.14+). 길게 누르기는 OS 메뉴와 겹칠 수 있어 “보조 수단”으로 권장 | Device APIs |
| 화면 | 576×288, 4-bit 녹색 계조. 컨테이너: 텍스트/리스트/이미지(이미지 최대 4개, 각 20–288 × 20–144). 텍스트 갱신 `textContainerUpgrade`(최대 2,000자, 깜빡임 없음). 전체 화면 텍스트 약 400–500자. 넘치면 펌웨어가 스크롤 | Display, `index.d.ts` |
| 글꼴 | 펌웨어 고정 LVGL 글꼴 1개. **글리프 없는 문자는 조용히 사라짐. 한글 지원 여부 문서에 없음** | Display, Design guidelines, FAQ |
| 수명주기 | `FOREGROUND_ENTER`(4), `FOREGROUND_EXIT`(5), `ABNORMAL_EXIT`(6), `SYSTEM_EXIT`(7). 종료는 루트에서 `shutDownPageContainer(1)` | `index.d.ts`, Page lifecycle |
| 잠금/백그라운드 | **문서끼리 다름:** “iOS WebView는 계속 실행, JS 상태 유지” vs “백그라운드 시 WebView 일시정지, 진행 중 요청 멈춤”(FAQ), “private build는 5분 잠금 시험을 통과하지 못함”. 마이크는 일시정지 시 멈추며 복귀 시 다시 켜야 함 | Background & Lifecycle, FAQ, Private testing |
| 네트워크 | `app.json` `permissions[].name="network"`의 `whitelist`에 **전체 origin**(와일드카드 불가). 화이트리스트 + 서버 CORS 둘 다 필요. 운영은 HTTPS. WebSocket 가능, SSE 언급 없음. WebView의 `Origin` 값 문서에 없음 | Networking |
| 저장 | `bridge.setLocalStorage/getLocalStorage` | Device APIs |
| 배포 | 개발: Vite dev server + `evenhub qr --url http://<ip>:5173`(Developer Mode, LAN/Tailscale). 개인 설치: `evenhub pack` → 개발자 포털 Private build → 앱에서 설치(**.ehpk가 Even 포털로 업로드됨**) | Local/Private testing, Packaging |
| 패키지 | `@evenrealities/even_hub_sdk` 0.0.16, `@evenrealities/evenhub-cli` 0.2.0, `@evenrealities/evenhub-simulator` 0.9.5 (npm) | npm |

로컬 환경: Apple Silicon Mac, `whisper-cli`(whisper.cpp) + `ggml-small`/`ggml-base` 설치됨. 합성 한국어 음성(macOS TTS, 3초) 시험: small 0.75초 정확, base 0.35초(“크리스”→“그리스”). **합성 음성이라 실제 정확도 근거 아님.**

## 2. 구성

```
[G2 4-mic / R1]
   │ BLE (Even 앱)
[iPhone · Even 앱 WebView — P1 앱 (TS+Vite, SDK 0.0.16)]
   │ HTTPS, Tailscale Serve (tailnet 전용) — Bearer(기기 토큰) + Tailscale-User-Login
[상시 켜진 Mac · 중계 서비스]
   ├─ /v1/pairing/*        기기 등록 (신규)
   ├─ /v1/transcriptions   PCM → whisper.cpp(로컬) → 문자열 (신규)
   ├─ /v1/requests         kind=voice_text 추가, 대기형 조회(long-poll) 추가
   └─ Discord 어댑터 (P0 그대로) → Chris 채널 → OpenClaw(Chris 기존 세션)
```

원칙: **서버가 진실의 원천.** 앱은 잠금·종료로 언제든 사라질 수 있으므로 현재 request_id만 기기 저장소에 두고, 상태·답은 항상 서버에서 다시 받는다. P0의 대응·중복 억제·채널당 1건·재시작 복구는 그대로 쓴다.

## 3. 음성 인식 위치 — 제안: Mac 로컬 whisper.cpp

| 안 | 장점 | 단점 |
|---|---|---|
| **A. Mac 로컬 whisper.cpp (권장)** | 음성이 tailnet 밖으로 안 나감. 이미 설치됨. 비용 0 | 정확도는 모델 의존(small/turbo). 실측 필요 |
| B. 클라우드 STT | 정확도·속도 높을 수 있음 | 사용자 음성이 외부 서비스로 전송. 별도 계정/키 |
| C. iPhone 측 (Web Speech 등) | 서버 왕복 없음 | WKWebView 지원 불확실, G2 마이크가 아니라 폰 마이크만 가능할 가능성 |

모델: 기본 `ggml-small`, 실측 후 필요하면 `large-v3-turbo`(다운로드 필요)로 교체. 오디오는 인식 직후 삭제(디스크 미보관). 문자열은 P0 보존 정책(7일)을 따른다.

## 4. 서버 변경 (P0 코드 확장)

### 4.1 기기 등록 (토큰을 앱 패키지에 넣지 않음)
private build의 `.ehpk`는 Even 개발자 포털로 업로드되므로 토큰을 번들에 넣지 않는다.
1. 앱 첫 실행 → `POST /v1/pairing/start` (Tailscale 신원 필수, Bearer 없음) → 서버가 6자리 코드 발급, G2에 표시
2. 사용자가 Mac에서 `npm run admin -- pair <코드>` 승인 (5분 내, 1회용)
3. 앱이 `POST /v1/pairing/claim`으로 기기 토큰 수령 → `bridge.setLocalStorage` 저장
4. 서버는 토큰 해시만 저장, `admin -- revoke-device`로 즉시 폐기. P0 CLI 토큰과 별도 principal 레코드(같은 사용자 주체)

### 4.2 `POST /v1/transcriptions`
- 본문: `application/octet-stream` PCM s16le 16 kHz mono, 최대 30초(960 KB). 헤더 `Idempotency-Key`.
- 응답: `{transcript_id, text, duration_ms, stt_ms, model}`. 빈 인식·잡음은 `no_speech`.
- 동시 1건, 분당 제한. 오디오 파일은 처리 후 즉시 삭제.

### 4.3 `POST /v1/requests` — `kind: "voice_text"`
```json
{"target":"chris-primary","kind":"voice_text","transcript_id":"…","arguments":{}}
```
- 본문 텍스트는 **서버가 인식해 저장한 transcript**만 사용(클라이언트 임의 문자열 불가) → 음성→문자→Discord 경로가 한 줄로 추적됨.
- 길이 제한(예: 500자), 멘션 무력화(`<@…>`, `<#…>`, `@everyone/@here`를 표시용 문자로 치환; allowed_mentions는 P0처럼 Chris만).
- Discord 게시 형식(작성자는 계속 G2 Relay):
  ```
  [G2 음성 중계 · 인증된 사용자 · 음성 인식 텍스트]
  요청 ID: <uuid>
  <@Chris> <인식된 문장>
  답변 첫 줄에 위 요청 ID를 그대로 적고, G2 화면용으로 짧게(300자 이내) 답해 주세요.
  ```
- P0 템플릿 3종은 그대로 유지(시험용).

### 4.4 대기형 조회
`GET /v1/requests/{id}?wait=25` — 상태가 바뀌거나 25초가 지나면 응답. 폴링 부하·지연을 줄이고 Tailscale Serve/HTTP만으로 동작. (WebSocket은 잠금 시 끊김 처리 부담이 커서 P1에선 쓰지 않음.)

### 4.5 표시 확인 기록 (지연 측정용)
`POST /v1/requests/{id}/displayed {page:1, at}` — 앱이 첫 페이지를 그린 시각. AT-23 구간별 지연 계산에 사용.

## 5. 앱 동작 (G2 화면·입력)

상태: `idle → listening → transcribing → confirm → sending → awaiting → reply(page n/N) → idle`, 각 단계 `error(code)`.

| 상태 | G2 표시 (예) | 입력 |
|---|---|---|
| idle | `Chris · Chris 채널` / `누르면 말하기` | 누르기: 녹음 시작 · 길게 누르기(보조): 누르는 동안 녹음 |
| listening | `● 듣는 중… 12초` | 누르기: 끝 · 두 번: 취소 · 30초 자동 종료 |
| transcribing | `인식 중…` | — |
| confirm | `보낼까요?` / `“세미나 준비 상황 알려줘”` | 누르기: 전송 · 두 번: 취소 |
| awaiting | `전송됨 · Chris 응답 대기 8초` | 두 번: 화면만 닫기(요청은 서버에서 계속) |
| reply | 답 본문 1/3 | 위/아래 쓸기: 페이지 · 누르기: 처음 화면 |
| error | `연결 안 됨 — Tailscale 확인` 등 코드별 문구 | 누르기: 처음 화면 |

- **확인 단계(confirm)를 둔다.** 오인식된 문장이 그대로 Chris에게 가는 것을 막기 위함. 사용자가 원하면 끌 수 있게 설정값으로 둔다.
- 답 원문은 서버의 `reply_parts[].text` 그대로 보관, 화면용은 앱에서 요청 ID 첫 줄 제거 → 약 350자 단위(줄바꿈 경계) 페이지 분할(FR-15).
- 다른 요청이 진행 중(409 busy)이면 `Chris 응답 대기 중인 요청이 있음` 표시 후 그 요청 화면으로 이동.
- 마이크는 사용자 입력이 있을 때만 켠다. `FOREGROUND_EXIT` 시 녹음 중이면 취소, `FOREGROUND_ENTER` 시 저장된 request_id로 서버 조회 후 화면 복원.

## 6. 한글 표시 위험과 대안

펌웨어 글꼴에 한글이 없으면 **글자가 경고 없이 사라진다.** 구현 전에 실기기 스파이크(S1)로 먼저 확인한다.
- 한글 표시됨 → 텍스트 컨테이너 사용(기본안).
- 표시 안 됨 → 대안: WebView canvas에서 시스템 한글 글꼴로 그려 4-bit 회색조로 변환 → 이미지 컨테이너 4개(288×144 각) 타일링. 페이지 갱신 약 0.8초 이상, 이미지 동시 전송 불가 → 페이지 넘김이 느려짐. 이 경우 P1 범위·일정 재협의.

## 7. 보안·정책

- **자유 문장 허용은 P0와 다른 정책 결정이다.** P0는 무해한 고정 문장만 보냈다. P1부터 사용자가 말한 문장이 그대로 Chris에게 가며, Chris는 운영 도구를 가진 비서다. 중계 메시지를 사용자 지시로 받아 실행할지는 **Chris 쪽 정책**(AGENTS/SOUL의 봇 보고 vs 사용자 지시 구분)에 달려 있고, 중계 서비스가 기술적으로 막을 수 없다(FR-10). → §9 결정 D1.
- 접근: Tailscale Serve(tailnet 전용) + 기기 토큰 + `Tailscale-User-Login` 일치. 토큰은 Even 포털에 올라가는 번들에 넣지 않음.
- `app.json` network whitelist: `https://<mac>.<tailnet>.ts.net:8443` 하나. 포트 포함 origin 허용 여부는 S2에서 확인.
- CORS: WebView 실제 `Origin` 값을 S2에서 관찰한 뒤 그 값만 허용(`*` 사용 안 함).
- 로그: 음성·인식 문자열·답 본문은 로그에 남기지 않음(P0 규칙 유지).

## 8. 작업 순서 (P1 Issue 초안)

| ID | 내용 | 완료 조건 |
|---|---|---|
| P1-01 | **실기기 스파이크** S1 한글 글리프, S2 whitelist·Origin·CORS·Tailscale 신원 헤더(Even WebView→ts.net:8443), S3 G2 마이크 PCM 캡처, S4 잠금/복귀 시 WebView·fetch 동작, S5 R1/터치패드 이벤트 | 각 항목 관찰 결과 기록. S1 실패 시 §6 대안으로 범위 재협의 |
| P1-02 | 서버: 기기 등록·폐기 | 모의시험 + 등록 후 P0 CLI 토큰과 독립 폐기 |
| P1-03 | 서버: `/v1/transcriptions` (whisper.cpp) | 녹음 샘플로 인식률·소요시간 기록, 오디오 미보관 확인 |
| P1-04 | 서버: `voice_text`, 멘션 무력화, 대기형 조회, displayed 기록 | 모의시험(주입 시도·길이 초과·busy 포함) |
| P1-05 | 앱: 상태기계·화면·입력·페이지·수명주기 | 시뮬레이터 시험 |
| P1-06 | 실기기 인수: AT-23, AT-24 (device-test-plan.md) | 결과·구간 지연 기록, 실패·미실시 구분 |

P1-02~05는 S1·S2 결과를 본 뒤 확정한다. 특히 S1(한글)이 실패하면 P1-05 화면 설계가 바뀐다.

**진행 (2026-11-19):**
- P1-01: 실기기 1차 완료. S1 한글·S2 healthz·S4 잠금 1분 PASS. S3 마이크는 동작하지만 시작 약 0.5 s가 녹음되지 않음. S5는 R만 확인 (device-test-plan §1.1).
- P1-02 기기 등록 구현 (`src/devices.ts`, `admin pair|devices|revoke-device`):
  - 코드는 6자리, 5분 안에 1회만 쓸 수 있고, 대기 중인 등록은 최대 3건.
  - 서버에는 claim secret·기기 토큰의 SHA-256만 저장.
  - 기기 principal은 `owner.g2.<id>`, scope `device`. P0 템플릿은 쓸 수 없고, 폐기하면 다음 요청부터 막힘.
- P1-03 `/v1/transcriptions` 구현 (`src/stt.ts`):
  - whisper-cli + ggml-small, `-l ko`. 0700 임시 폴더의 WAV는 처리 직후 삭제.
  - 가장 큰 50 ms 구간 RMS가 500 미만이면 whisper를 돌리지 않고 `no_speech`. 무음에서 whisper가 "감사합니다"를 지어내는 것을 실측함.
  - 인식 문장은 로그에 남기지 않음.
- P1-04 일부: 기기는 `/v1/ask`에 `transcript_id`만 보낼 수 있다. 직접 쓴 문장은 거절하고, 인식 후 10분이 지난 transcript도 거절한다. 대기형 조회와 Discord 조용한 게시는 기존 경로를 그대로 쓴다. `displayed`는 2026-11-20 구현: `POST /v1/ask/{id}/displayed {page:1, since_speech_end_ms?}` (§4의 `/v1/requests/{id}/displayed` 대신 ask 경로 아래). 기기 토큰·소유 principal·답이 있을 때만, 요청당 처음 1회만 `request_events`에 기록(`reply_to_display_ms`는 서버 시계, `since_speech_end_ms`는 휴대폰 시계 차이). 앱 0.3.0은 렌즈 갱신(textContainerUpgrade) 성공 뒤 보고.
- 실서버 확인 (Mac에서 ts.net:8443 경유, Discord 게시 없음):
  - 등록 start 201 → claim 202 → admin pair → claim 200.
  - TTS 한국어 5.5 s 문장: 인식 845 ms, 문장 정확 일치.
  - 무음 5 s: `no_speech`, 23 ms.
  - 폐기 후 403 `device_revoked`.
  - CORS 허용 origin은 `http://<Mac tailnet IP>:5173` (start-live.sh). 패키지(.ehpk) 앱의 origin은 미확인.
- P1-05 G2 Chris 앱 0.2.0: 실기기 첫 왕복 PASS (2026-11-19). "안녕. 넌 누구야?" 정확 인식(whisper 1.26 s), 확인 후 게시, Chris 답 9.1 s 만에 렌즈 표시, 깨짐 없음 (device-test-plan §1.2).
- 패키징 준비 (0.2.1): `npm run pack`, 아이콘, `data/allowed-origins.txt`로 설치형 앱 origin 추가 (device-test-plan §1.3). Even 계정 로그인·업로드는 사용자 로그인 후.
- 설치형 앱(Private build 0.2.1) 왕복 PASS (2026-11-20). WebView origin은 `http://127.0.0.1:<실행마다 바뀌는 포트>` → relay가 루프백 한정 포트 와일드카드 허용. Private build는 5분 잠금 미지원(Even 문서).
- 미확인: 조용한 환경의 G2 RMS (500 임계값 보정 필요), 다른 문장·환경의 인식률, AT-23/AT-24, 패키지 앱 origin.

## 9. 사용자 결정 (2026-11-17)

| ID | 결정 |
|---|---|
| D1 | **대화·질문 전용.** 게시문에 “실행이 필요한 일은 Discord에서 사용자 확인 후 진행” 문구를 붙인다. 강제력은 Chris 정책에 있음(중계가 기술적으로 막지 못함). |
| D2 | 사용자 질문: Even 앱의 STT를 먼저 쓸 수 있는가? → **확인 결과 없음.** SDK 0.0.16 타입 정의에 음성 인식·전사 API/이벤트가 없고(이벤트는 list/text/sys/audio/menu뿐), 문서 FAQ·Device APIs·Changelog에도 서드파티 앱용 STT 언급 없음. Even 앱 자체 기능(Even AI 등)은 Hub 앱에 노출되지 않음. → **Mac 로컬 whisper.cpp로 진행.** 참고: SDK 0.0.14부터 `audioEvent.speakerRole`(self/other/unknown)이 있어 착용자 음성만 골라 보낼 수 있는지 S3에서 함께 확인. |
| D3 | 질문하지 않음 — 기본안 G2 마이크, S3 결과에 따라 폰 마이크 대체. |
| D4 | **전송 전 확인 단계 켬.** → 2026-11-19 사용자 결정으로 **경로 S(Siri 단축어)에서는 끔**: 받아쓰기 끝나면 바로 전송. 오인식 문장도 그대로 전송되며, D1 “대화 전용” 헤더와 Chris 정책으로만 제한. |
| D5 | 사용자가 Developer Mode·개발자 포털/CLI 로그인을 직접 수행(자격증명은 Claude Code가 다루지 않음). |

### (참고) 결정 전 선택지

- **D1 중계 문장의 성격:** (a) 대화·질문 전용 — 게시문에 “실행이 필요한 일은 Discord에서 사용자 확인 후 진행”을 붙임(권장, P1 시작안) / (b) 사용자 지시로 취급. 어느 쪽이든 Chris 정책과 맞는지 확인 필요.
- **D2 음성 인식 위치:** Mac 로컬 whisper.cpp(권장) / 클라우드.
- **D3 마이크:** G2 마이크(권장, 폰 꺼내지 않음) / 폰 마이크.
- **D4 전송 전 확인 단계:** 켬(권장) / 끔.
- **D5 Even 개발자 계정:** 실기기 개발(QR)·private build에 Developer Mode와 개발자 포털 로그인이 필요. 사용자 계정으로 진행 가능 여부.

## 10. 대안 경로 B — Even AI “Agent Configuration” (2026-11-17 조사, 미검증)

사용자 관찰(Even 앱 대화 모드가 음성을 실시간 문자로 표시)을 계기로 조사. **공식 Even Hub 문서에는 없고 커뮤니티 보고만 있음 → 실기기 확인 전까지 가설.**

| 항목 | 커뮤니티 보고 | 출처 |
|---|---|---|
| 기능 | Even 앱 Settings → Even AI → Agent Configuration → Add agent (Name, URL, Token). 승인된 Even Hub 개발자에게만 보임. 저장 후 별도로 선택해야 함 | jrejaud/even-agent-sample |
| 동작 | Even이 음성을 **문자로 인식**해 사용자 URL로 `POST`(OpenAI chat-completions 형식, `model:"openclaw"`, `messages:[{role:"user",content:<인식 문장>}]`), 응답 `choices[0].message.content`를 렌즈에 표시 | jrejaud, kucau0901, juchunko blog |
| 호출 위치 | **휴대폰의 Even 앱이 직접 호출**(Dart 클라이언트). 공개 URL 불필요, Tailscale 권장 | kucau0901, jrejaud |
| 제약 | 비스트리밍, 시스템 메시지 없음, 헤더 추가 불가(Bearer만), 요청이 ~5ms 간격으로 **두 번** 옴, 25초 넘으면 “Still working on it”, 표시 ~400–500자(실용 350자), 마크다운·이모지 깨짐 | jrejaud, kucau0901 |
| 이전 대화 포함 여부 | 불명 | — |

설계상 의미:
- 앱(WebView) 없이 **Even의 음성 인식·표시를 그대로 쓰고**, 중계 서비스에 `POST /v1/chat/completions`만 추가하면 됨. 그 뒤는 P0 경로(Chris 채널 → 기존 Chris 세션) 그대로.
- OpenClaw Gateway의 chat completions를 직접 연결하는 커뮤니티 방식은 **쓰지 않음**: 별도 세션이 되어 Chris 채널 맥락이 이어지지 않고, P0 원칙(OpenClaw 실행 API 직접 호출 제외)에 어긋남.
- 잃는 것: 전송 전 확인 단계(D4)를 Even UI에서 할 수 없음 → 서버에서 2턴 확인(“보낼까요?” → “응”)으로 구현 가능하나 지연 증가. 화면 페이지 넘김 불가(350자 한도). 현재 비서/채널 표시는 에이전트 이름으로 대신.
- Even 인식이 어디서 돌아가는지(휴대폰/Even 클라우드)는 미확인 — 음성이 Even 서버를 거칠 가능성. D2(로컬 whisper)와의 차이.
- 확인 필요: Agent Configuration 메뉴 노출 여부, 한국어 인식·표시, 중복 요청, Tailscale Serve URL 호출 가능 여부.

## 11. Siri(Apple 음성 인식) 활용 검토 (2026-11-17)

| 방법 | 판단 |
|---|---|
| Even Hub 앱(WebView) 안에서 Web Speech API(`webkitSpeechRecognition`) | WebKit 버그 239816(2022): Safari 밖 WKWebView에서는 노출돼도 동작하지 않는다는 보고. 현재 상태 미확인. 되더라도 **폰 마이크만**(G2 PCM 입력 불가)이고 Even 앱의 iOS 권한 설정에 좌우됨 → 가능성 낮음, S-스파이크에서 감지·시도만 |
| Even AI(경로 B)의 인식기를 Siri로 교체 | 불가 — Even 앱 내부 기능 |
| **Apple 단축어(Shortcuts) + Siri** | “Siri야, 크리스” → `받아쓰기`(Apple 인식, 한국어) → `URL 콘텐츠 가져오기`로 중계 서비스(Tailscale, Bearer) 호출 → 답을 알림/음성으로 표시. G2가 iPhone 알림을 미러링하면 렌즈에도 표시(단축어 알림 미러링은 미확인). G2 마이크·R1은 안 씀(iPhone/AirPods 마이크). 단축어의 `메뉴에서 선택`으로 전송 전 확인 가능 |

경로 B와 단축어는 **같은 서버 엔드포인트**(문장 입력 → Chris 채널 → 답 반환)를 쓰므로 그 엔드포인트를 먼저 만들면 두 경로를 모두 시험할 수 있다.

## 12. 사용자 확인 결과와 진행 (2026-11-17)

- **한글 표시:** Even 앱 대화 모드에서 한국어 음성이 렌즈에 한국어로 표시됨(사용자 관찰) → 펌웨어 글꼴에 한글 있음. §6 위험은 크게 줄었으나 Hub 앱 텍스트 컨테이너에서의 표시는 S1에서 한 번 더 확인.
- **Agent Configuration 메뉴: 보이지 않음.** 커뮤니티 보고상 승인된 Even Hub 개발자에게만 노출. 공식 문서(Sign in)에는 승인 절차 설명 없음 → 경로 B 보류.
- **경로 S(Siri 단축어) 먼저 구현:** `POST /v1/ask`, `GET /v1/ask/{id}` (docs/p1/siri-shortcut.md). 경로 B가 열리면 같은 핵심(`submitText`)에 OpenAI chat-completions 어댑터만 추가.
- §4.3과 다른 점: 인식은 클라이언트(Siri/Even)가 하므로 서버는 **클라이언트가 보낸 문장**을 받는다. 대신 별도 음성 토큰(`free_text` 범위만), 한 줄·500자·멘션 무력화·UUID 거절, “대화 전용” 헤더(D1)로 제한. 전송 전 확인(D4)은 2026-11-19부터 경로 S에서 쓰지 않음(§9 D4).
