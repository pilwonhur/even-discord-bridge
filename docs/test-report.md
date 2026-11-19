# 시험 결과 보고 — G1 모의시험 (I-06)

**범위: 모의시험만. 실제 Discord·실제 Chris·OpenClaw는 사용하지 않았다. 이 결과는 Discord 실연결 성공이 아니다.**

| 공통 필드 | 값 |
|---|---|
| 실행 시각 | 2026-11-16 KST |
| commit/build | git 저장소 없음 — 작업 트리 그대로. typecheck `tsc 7.0.2` 통과 |
| 환경 | macOS (Darwin 27.0.0), Node v26.12.1, `node:sqlite`, FakeDiscord |
| 재현 | `npm ci && npm run typecheck && npm test` |
| request/Discord ID | 시험마다 생성되는 UUID / 가짜 snowflake(16000…) — 실제 ID 아님 |
| 증거 | `tests/*.test.ts`(절차·기대값) |

## 결과

| test_id | 결과 | 절차 요약 (테스트 위치) | expected | actual |
|---|---|---|---|---|
| AT-01 | PASS | 인증 없음/틀린 토큰/본문 user_id·“사용자 승인” (g1-api) | 401/403, 게시 0 | 401; 인증 후 user_id 필드는 400 `unsupported_field`; 게시·전송시도 0 |
| AT-02 | PASS | 다른 target, channel_id, agent_id, text, mentions, 미허용 template, arguments (g1-api) | 거절, 게시 0 | 403 `target_not_allowed` / 400; 게시 0. 렌더링 멘션은 Chris ID 1개뿐 |
| AT-03 | PASS | 같은 key 순차 + 동시 8건 (g1-api) | 같은 request_id, 게시 ≤1 | 202 1건 + 200 7건, 같은 ID, key당 게시 1 |
| AT-04 | PASS | 같은 key 다른 template (g1-api) | 409, 원 요청 불변 | 409 `idempotency_conflict`, template 불변 |
| AT-05 | PASS | 대기 중 새 key + 사람/타 봇 발언 (g1-api) | busy, 섞임 없음 | 409 `channel_busy`; 발언 2건은 `non_target_author`로 별도 기록, 요청 part 0 |
| AT-06 | PASS | 전송 전 연결 거부 / 예외 (g1-discord) | 실패 구분, 성공 오표시 없음 | `failed` + `fake_connection_refused` / `pre_send_exception`; 자동 재시도 없음; 잠금 해제 |
| AT-07 | PASS | 게시 후 응답 유실 / 결과 불명+미게시 (g1-discord) | delivery_unknown, 재게시 없음 | 유실: 자기 게시 스캔으로 awaiting_reply 복구, 게시 1. 미게시: delivery_unknown 유지(재시작 후도), 게시 0, 운영자 해제 |
| AT-08 | PASS | awaiting/sending(게시 전·후)/accepted 상태에서 재시작 (g1-discord) | 상태/ID 보존, 재생성 없음 | 모두 기대대로. accepted는 정확히 1회 게시, sending은 재게시 없음 |
| AT-09 | PASS | 429 두 번(1500/2750ms), 429 6번, Gateway 끊김 중 답 (g1-discord) | Retry-After 준수, catch-up, 중복 없음 | 대기 [1500, 2750]ms 기록 후 게시 1; 6회는 `rate_limit_retries_exhausted`; 끊김 중 POST 503, 재연결 catch-up으로 part 1개 |
| AT-10 | PASS | Message Content Intent 없음 / 권한 문제 / 시작 후 본문 상실 (g1-discord) | 명시적 준비 실패, 빈 응답 성공 처리 금지 | healthz ready=false, POST 503, 게시 0; 빈 본문 대응 → `failed / reply_content_unavailable` |
| AT-11 | PASS | 타 봇·타 채널·참조 없는 글·위조 ID·참조/ID 충돌 (g1-correlation) | 오답 회수 0, 불명확 시 ambiguous | part 0; 시간 경과 후 `ambiguous_response`; 충돌 글은 어느 요청에도 붙지 않음 |
| AT-12 | PASS | A 시간초과 → B 전송 → A 답 도착 (g1-correlation) | A에만 늦은 답, B 불변 | A `timed_out` + late part; B awaiting, 이후 B 자신의 답으로 completed |
| AT-13 | PASS | 같은 이벤트 3회 재전달, 자기 글/Chris 글 재수신, 편집 (g1-correlation) | 한 번만 저장, 루프 없음 | part 1, 요청 1, 게시 1; 편집은 같은 part 갱신 |
| AT-14 | PASS | 다른 주체 조회, 권한 취소 후 조회, 로그 검사 (g1-api) | 무단 조회 거절, 토큰 노출 0 | 404(존재 여부 비노출), 취소 후 GET/POST 403; 로그에 토큰·요청/응답 본문 0 |
| AT-15 | PASS | 임시 폴더 복사본을 자식 프로세스로 실행→왕복→SIGTERM→재시작 (g1-ops) | 문서대로 실행, 외부 영향 없음 | exit 0 두 번, 재시작 후 같은 결과 조회·idempotent 200. 임시 폴더 외 파일 쓰기 없음 |
| AT-16~22 | **PASS** (AT-19는 한계 있음) | 실연결 2026-11-17 | — | 로컬 실연결 증거(저장소 제외: Discord·OpenClaw ID 포함) |
| AT-23~26 | **NOT_RUN** | P1/P2 | — | 범위 밖 |

추가 단위시험: 설정 fail-fast(live 필수값, loopback 강제), 실제 어댑터 권한 계산.

## 한계 (반드시 함께 읽을 것)

1. **FakeDiscord는 Discord가 아니다.** 실제 REST/Gateway 어댑터(`src/discord/real.ts`)는 권한 계산 단위시험 외에는 **실행된 적이 없다.** Gateway 재개(resume), nonce/enforce_nonce 동작, 429 헤더 형식, MESSAGE_UPDATE 부분 페이로드는 실연결에서 확인해야 한다.
2. **Chris 응답 형식은 가정이다.** 현재 OpenClaw 설정에서 `replyToMode` 기본값은 `off`라 답글 참조가 붙지 않을 것으로 보인다(preflight §3-2). 따라서 실제 대응은 “답변 첫 줄에 요청 ID” 지시를 Chris가 따르는지에 달려 있다. 따르지 않으면 모든 요청이 `ambiguous_response`가 된다 — 안전하지만 쓸모없는 결과. AT-16에서 실측 필요.
3. **완료 판정은 미확인.** `completed` = 첫 대응 메시지 수신. 기본 `progress` 스트리밍에서 이 메시지가 진행 중 문구일 수 있다. run 완료는 `openclaw audit --run`으로 수동 대조해야 한다.
4. 시험 시각은 주입한 가짜 시계 기준이다. 120초 timeout·429 대기는 실제로 기다리지 않았다. 지연 수치는 측정하지 않았다.
5. 동시성은 단일 프로세스 + SQLite 트랜잭션/부분 유일 인덱스로 검증했다. 다중 프로세스 배포는 지원하지 않는다.
