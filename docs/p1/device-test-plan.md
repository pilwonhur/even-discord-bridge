# P1 실기기 시험 계획 (I-08)

상태: **계획. 전부 NOT_RUN.** 기기: iPhone, Even G2, R1. 서버: 상시 켜진 Mac, Tailscale Serve `https://<mac>.ts.net:8443`.
결과 필드는 P0와 같다: test_id, PASS/FAIL/BLOCKED/NOT_RUN, 시각, build(앱 버전·SDK·Even 앱 버전), 재현 절차, expected/actual, request/Discord/run ID, 증거 경로, 한계. 모의·시뮬레이터 결과와 실기기 결과를 섞지 않는다.

## 0. 공통 준비

- iPhone Tailscale 켬, Even 앱 Developer Mode, Even 앱 버전 ≥ 2.2.9 기록
- 개발 단계: Mac에서 Vite dev server, `evenhub qr --url http://<Mac tailnet IP>:5173`
- 중계 서비스 live 모드, OpenClaw 설정은 P0 상태 그대로(변경 없음)
- 시험 문장은 무해한 질문만(작업 지시 금지 — D1 결정 전까지)

## 1. 스파이크 (P1-01) — 구현 전

| ID | 확인할 것 | 방법 | 판정 |
|---|---|---|---|
| S1 | 한글 표시 | 텍스트 컨테이너에 `가나다 한글 테스트 ㄱㄴ 뷁 123 ABC …` 및 실제 Chris 답 예문 표시, 사진 기록 | 한글 전부 보임 / 일부 누락 / 전부 누락 |
| S2 | 네트워크 경계 | 앱에서 `fetch(https://<mac>.ts.net:8443/healthz)` 및 인증 POST; 서버가 받은 `Origin`, `Tailscale-User-Login` 존재 여부 기록 | whitelist(포트 포함) 통과, CORS 통과, 신원 헤더 존재 |
| S3 | G2 마이크 | `audioControl(true, Glasses)` 10초 → PCM 바이트 수 ≈ 320,000, 서버로 보내 whisper 인식 | 바이트 수·인식 결과 |
| S4 | 잠금/복귀 | 요청 대기 중 잠금 1분/5분, 다른 앱 전환 → 복귀 시 JS 상태·`FOREGROUND_ENTER` 수신·fetch 재개 여부 | 관찰 기록(문서 간 상충 해소) |
| S5 | 입력 | R1·터치패드 각각 누르기/두 번/위/아래/길게 → 수신 이벤트·source 기록 | 이벤트 표 |

### 1.1 스파이크 앱 (`app/`, 2026-11-19)

토큰 없음, Discord 게시 없음, 녹음은 메모리에서만 계산 후 버림. 렌즈 6줄:
`G2 시험 … 다람쥐 헌 쳇바퀴에 타고파`(S1) · `서버:` healthz 결과(S2) · `마이크:` 5초 녹음 길이·프레임·rms(S3) · `입력:` 최근 이벤트(종류(출처 R/L/링)) (S5) · `경과 … 멈춤 n회 최대 s`(S4, 1초 타이머 공백) · 조작 안내.
조작: **누르기 = 5초 녹음**, **두 번 = 서버 확인**. 휴대폰 화면에도 같은 내용과 상세 기록이 보인다.
서버 기록: `data/relay-live.log`의 `http` 줄에 `origin`, `ts_login`(Serve 신원 헤더 유무, 값은 기록 안 함).

실행: `scripts/app-dev.sh start`(Vite, Mac Tailscale IP:5173에서만) → `scripts/app-dev.sh qr` → Even 앱 Even Hub 탭 오른쪽 위 **Scan QR**. 개발자 메뉴는 hub.evenrealities.com에 같은 계정으로 로그인 후 Even 앱을 완전히 종료·재실행해야 나타난다(공식 문서 Local testing).

시뮬레이터 결과 (evenhub-simulator 0.9.5, **실기기 아님**): 페이지 생성 성공, 한글 렌더링됨(시뮬레이터 글꼴), healthz 200(origin `http://127.0.0.1:5173`, Serve 경유 `ts_login` 있음), 두 번=sysEvent(eventSource R), 위/아래=textEvent, 길게/뗌=sysEvent(eventSource 없음). 누르기(마이크 열기) 시 시뮬레이터가 응답 없음 → 강제 종료(원인 미확인, macOS 마이크 권한 창 가능성).

실기기 1차 (2026-11-19, spike 0.1, SDK 0.0.16, Even 앱 개발자 모드 QR, 사용자 육안 보고 + 중계 로그; 사진 없음):

| ID | 결과 | 관찰 |
|---|---|---|
| S1 | PASS | 첫 줄 `다람쥐 헌 쳇바퀴에 타고파` "아주 잘 보임"(육안). 사진·긴 Chris 답 예문은 미실시 |
| S2 | PASS (healthz만) | 렌즈 `OK 200 20ms ready=Y`. 중계 로그: healthz 6회 모두 200, origin `http://<mac-tailnet-ip>:5173`, `ts_login:true`(Serve 경유 신원 헤더 있음). 인증 POST·CORS 사전요청은 미실시 |
| S3 | 부분 | `4.5s/4.9s 90프레임 rms 2590 최대 10670`(말하는 중). 프레임당 50 ms(1,600 B) → 5초 창 중 약 0.4–0.5 s 오디오 없음(마이크 시작 지연 추정, 미검증). wall 4.9 s가 5 s 대기보다 짧게 나온 점은 설명 안 됨. 조용할 때 비교·whisper 인식은 미실시 |
| S4 | PASS (잠금 1분만) | iPhone 1분 잠금 후 해제: `멈춤 0회 최대 0s` → 잠금 중에도 WebView 1초 타이머가 3 s 이상 멈추지 않음. 잠금 중 fetch·5분 잠금·다른 앱 전환·FOREGROUND_ENTER는 미실시 |
| S5 | 부분 | "다 잘됨"(육안). 오른쪽 안경다리 두 번 → `두번(R)` 확인. 왼쪽 안경다리(L)·R1 반지(링)의 출처 표시는 미기록 |

### 1.2 Chris 음성 앱 (`app/index.html`, P1-05 0.2.0, 2026-11-19)

같은 QR(`scripts/app-dev.sh qr`)로 연다. 시험 앱은 `http://<tailnet IP>:5173/spike.html`로 옮겼다.

1. **처음 실행:** 렌즈에 6자리 등록 번호가 뜬다. Mac에서 `npm run admin -- pair <번호>`를 실행한다(5분 안). 약 2초 뒤 "등록 완료"가 뜨고, 기기 토큰은 Even 앱 저장소에 들어간다.
2. **누르기:** "마이크 준비 중…"이 뜨고, 첫 오디오가 들어오면 "● 듣는 중"으로 바뀐다. 다시 누르면 끝, 두 번 누르면 취소. 30초가 되면 자동으로 끝난다.
3. **인식 결과 "보낼까요?":** 누르면 전송, 두 번 누르면 취소(D4 확인 단계는 이 경로에서 켜짐). **전송하면 Chris 채널에 실제로 게시된다**(조용한 게시, Siri 경로와 같은 형식).
4. **답:** 위·아래로 쓸어 페이지를 넘기고(약 180자), 누르면 닫는다. 대기 중 두 번 누르면 화면만 닫히고, idle에서 위로 쓸면 지난 답을 다시 본다.
5. **휴대폰 페이지:** 렌즈와 같은 글, 같은 기능의 버튼, "이 휴대폰 등록 지우기"가 있다. 서버 쪽 폐기는 `admin revoke-device <id>`로 한다.

시뮬레이터 결과 (0.9.5, **실기기 아님**, 2026-11-19):
- 등록 번호 화면 표시, admin pair 후 "등록 완료" → idle, idle에서 위로 쓸기 → "지난 질문 없음".
- 시뮬레이터의 등록 확인 요청 간격이 2 s가 아니라 최대 22 s로 벌어졌다. 시뮬레이터의 타이머 지연으로 보이며, 실기기 S4에서는 타이머가 멈추지 않았다.
- 페이지 재로드 시 `createStartUpPageContainer`가 invalid(1)를 반환한다 → `rebuildPageContainer`로 대체하도록 수정.
- 마이크·전송·답 화면은 시뮬레이터에서 시험하지 않았다(마이크 클릭 시 시뮬레이터가 멈춘 이력).
- 시험용 기기 7ec9b0a9는 폐기했다.

**실기기 첫 실행 (G2, 2026-11-19, 사용자 확인):**

| 단계 | 결과 | 근거(relay 로그) |
|---|---|---|
| 등록 | PASS. 6자리 번호 표시, `admin pair` 후 등록 완료(기기 1444c13e) | claim 202가 2.0 s 간격(시뮬레이터의 22 s 지연은 실기기에서 없음), 승인 후 첫 claim 200 |
| 녹음·인식 | PASS. "안녕. 넌 누구야?"가 맞게 인식됨 | 음성 5.8 s, max_rms 8474, whisper small 1.26 s(HTTP 1.29 s), 10자 |
| 확인·전송 | PASS. "보낼까요?"에서 누름 → Chris 채널 조용한 게시 | 인식 후 확인까지 약 4.5 s(사람), 게시 0.65 s |
| 답 | PASS. Chris 답이 렌즈에 깨짐 없이 다 보임 | 게시 → 답 연결 8.4 s, `/v1/ask` 전체 9.1 s |

- 말 끝 → 답 표시: 약 1.3 s(인식) + 확인 시간 + 9.1 s.
- 로그에는 문장 대신 글자 수만 남았다(전사문 미기록 확인).
- 한 번의 짧은 질문만 시험했다. 긴 답의 여러 페이지 넘김, 조용한 방 RMS(500 문턱 보정), 오인식 시 취소, 잠금·복귀(AT-24)는 아직 실시하지 않았다.

### 1.3 설치형 앱 (.ehpk Private build, 0.2.1)

- 만들기: `cd app && npm run pack` → `app/build/g2-chris.ehpk` (빌드에는 index.html만, spike 제외, 상대 경로 `./assets`). 2026-11-19 빌드 39,005 B; 번들에서 토큰·이메일·tailnet IP 문자열 없음 확인, relay 주소(ts.net:8443)만 들어 있음.
- 올리기: `evenhub login`(사용자가 터미널에서 직접, 비밀번호 입력) → `evenhub create build/g2-chris.ehpk --name "G2 Chris" --tagline … --icon assets/icon.png`. 다음 버전부터는 `app.json` version을 올리고 `evenhub upload … -m …`. **.ehpk는 Even 서버에 올라간다**(Private build는 본인 계정에만 보임).
- 설치: Even 앱 → Even Hub → Me → Apps → Private builds → Install. 휴대폰에서 실행해야 한다(안경 메뉴에는 Private build가 안 보임).
- 첫 실행에서 확인할 것: WebView origin(문서에 값 없음). relay가 모르는 origin이면 사전요청이 403이 되고 로그 `http` 줄에 origin이 찍힌다 → `data/allowed-origins.txt`에 한 줄 넣고 `scripts/relay-service.sh restart`. `http(s)://host` 꼴이 아니면(`null`, 사용자 정의 scheme) 설정 검증이 거절하므로 따로 판단한다.
- 기기 토큰은 dev 앱과 저장소가 다를 수 있어 다시 등록이 필요할 수 있다.
- **실측 (2026-11-20):** 업로드(`evenhub create`, Private 0.2.1) → 설치 → 실행. WebView origin은 `http://127.0.0.1:<포트>`이고 포트가 실행마다 바뀜(65024, 65075). 기기 토큰은 dev 앱과 공유되어 재등록 없이 바로 녹음 요청이 나갔으나, 사전요청이 403. → relay에 `http://127.0.0.1:*`(루프백 한정 포트 와일드카드, 다른 와일드카드는 설정 검증이 거절)를 추가, `data/allowed-origins.txt`에 기록하고 재시작. 재시작 후 ts.net 경유 사전요청: 127.0.0.1 임의 포트 204, dev origin 204, 다른 origin 403.
- **설치형 앱 왕복 PASS (2026-11-20, relay 로그):** origin `http://127.0.0.1:65088`, 사전요청 204 → 음성 12.1 s·48자 인식 0.99 s → 확인 후 게시 0.41 s → Chris 답 연결 6.2 s, `/v1/ask` 201 6.7 s(답 포함). 같은 기기 1444c13e, 재등록 없음. 사용자 확인: 렌즈에 답이 잘 보이고, 위·아래 쓸기로 페이지 넘김 정상. 잠금 화면 상태에서도 동작한다고 사용자 보고(2026-11-20, 잠금 시간은 측정 안 함 — 5분 잠금 AT-24는 별도).
  - 보안 판단: CORS는 인증이 아니다. 실제 경계는 tailnet 신원 헤더 + 기기 토큰(Even 앱 저장소에만 있음). 휴대폰의 다른 앱이 127.0.0.1 웹페이지를 띄워도 기기 토큰이 없으면 401.
- Even 문서: Private build는 백그라운드에서 오래 살지 못해 5분 잠금 시험을 통과하지 못한다(AT-24는 Beta 채널에서 해야 할 수 있음).

- **0.3.0 displayed 실기기 확인 (2026-11-20):** 요청 d0bd53b8. 음성 8.9 s·39자 → 인식 1.1 s → (사용자 확인 약 5.7 s) → 게시 0.5 s → Chris 답 10.4 s → 렌즈 표시 0.34 s. `since_speech_end_ms` 18,308(사람 확인 시간 포함; 빼면 약 12.6 s). displayed 200, 요청당 1회 기록.

### 1.4 무음 기준(RELAY_STT_MIN_RMS) 보정

- 녹음마다 relay 로그 `stt` 줄에 소리 크기(max_rms)·길이·글자 수가 남는다(문장은 남지 않음). 휴대폰 페이지 로그에도 `rms ####`가 보인다.
- `npm run admin -- rms [n]`: 최근 n개(기본 20) 표와 지금 기준, 추천 기준. 폐기된 시험 기기 녹음은 뺀다.
  - 추천 = "말 없음" 녹음 중 가장 큰 값과 글이 나온 녹음 중 가장 작은 값의 기하 중간. 둘이 2배 이상 차이 날 때만 추천한다. 무음에서 whisper가 지어낸 글은 말한 쪽에 들어가 추천을 낮출 뿐 올리지 않는다.
- `npm run admin -- set-rms <50..30000>`: `data/stt-min-rms.txt`에 저장 → relay 재시작 → 시작 기록(`listening`의 `stt_min_rms`)으로 확인. `RELAY_STT_MIN_RMS` 환경변수가 있으면 그쪽이 우선.
- 보정 녹음: (A) 조용한 방에서 말 없이 5초, (B) 평소 쓰는 곳에서 말 없이 5초, (C) 같은 곳에서 작게 말하기. 끝에 "보낼까요?"가 나오면 두 번 눌러 취소.
- 2026-11-20 현재: 말 없음 109·923·967·94, 말한 녹음 최소 6084(보통 목소리) → 추천 2430이 나오지만 작게 말한 녹음(C)이 아직 없어 기준은 500 유지.

## 2. AT-23 P1 한국어 음성 → G2 (FR-15)

절차 (질문 5개, 순차):
1. idle 화면에 `Chris · Chris 채널` 표시 확인
2. 누르기 → 질문 발화(예: “오늘 날짜 알려줘”, “방금 내가 물은 걸 한 문장으로 다시 말해줘”) → 누르기
3. confirm 화면의 인식 문장 확인 → 누르기(전송)
4. 답 표시, 페이지가 둘 이상이면 아래 쓸기로 넘김

합격:
- 5/5 실제 Chris 응답(작성자 Chris bot ID, OpenClaw run 1:1, 기존 세션), 오연결·중복 실행 0
- 한국어 판독 가능(사용자 판정), 원문과 화면 페이지 구분
- 후속 질문이 이전 맥락을 이어받음(2번째 예문)
- 구간별 지연 기록: t0 발화 끝(누르기) → t1 인식 완료 → t2 Discord 게시 → t3 run 시작(audit) → t4 답 수신 → t5 첫 페이지 표시(`POST /v1/ask/{id}/displayed`, 0.3.0부터; `admin show <id>`의 displayed 이벤트에 `since_speech_end_ms`=t5−t0, `reply_to_display_ms`=t5−t4). **“첫 유용한 문장” = t5 − t0.** 수치는 관측치로만 보고, 목표값은 측정 후 사용자와 정함.
- 인식 오류는 confirm 단계에서 취소되어 Discord에 게시되지 않음(1회 고의로 취소해 확인)

## 3. AT-24 P1 잠금·복귀 (FR-06, FR-15)

| 경우 | 절차 | 합격 |
|---|---|---|
| a | 요청 전송 직후 휴대폰 잠금 5분 → 해제 | 같은 요청의 답이 표시됨, 재게시 0, 추가 run 0 |
| b | 녹음 중 잠금 | 녹음 취소, 아무것도 게시 안 됨, 복귀 시 idle |
| c | 응답 대기 중 다른 앱 전환 2분 → 복귀 | 답 표시, 중복 없음 |
| d | 앱 종료(`SYSTEM_EXIT`) 후 재실행 | 저장된 request_id로 마지막 답 복원 또는 idle |
| e | Tailscale 끈 상태에서 요청 | `연결 안 됨` 오류, 게시 0 |

잠금 중 캡처·표시가 되는지는 별도 결과로 적는다(지원 안 되면 FAIL이 아니라 “미지원”으로 기록).

## 4. 증거

로컬 `live-evidence/p1/`(저장소 제외) 아래: 실행별 manifest(요청·Discord·run ID, 시각), G2 화면 사진(사용자 촬영, 개인정보 없는 것만), 서버 로그 비밀 검사 결과. 음성 파일은 저장하지 않는다.
