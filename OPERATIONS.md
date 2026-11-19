# OPERATIONS — 실행·중지·복구·롤백 (P0)

P0 당시에는 수동 포그라운드 실행만 했다. 지금은 `scripts/relay-service.sh`(사용자 LaunchAgent, 키체인 비밀 → `scripts/start-live.sh`)로 상시 실행한다.

## 0. 요구 환경

- Node.js ≥ 24 (개발 확인: v26.12.1). 런타임 의존성 없음(`node:sqlite`, 내장 `fetch`/`WebSocket`).
- 개발 도구만 설치: `npm ci` (typescript, @types/node — 실행에는 불필요).

## 1. 모의 실행 (실제 Discord 없음)

```sh
export RELAY_CLIENT_TOKEN="$(openssl rand -hex 24)"   # 셸에만. 파일에 저장하지 않음
export RELAY_PRINCIPAL_ID=owner
npm run start:mock                                     # 127.0.0.1:8787, data/relay.sqlite
# 다른 터미널 (같은 RELAY_CLIENT_TOKEN)
npm run client -- health
npm run client -- send connection_check --wait
```
모의 응답은 `[MOCK Chris]`로 표시되며 실제 Chris 근거가 아니다.

## 2. 실연결 실행 (G2 — 준비 완료 전 금지)

선행 조건(전부 충족 전에는 live 모드 실행 금지):
1. `config/live.env`의 Discord ID(guild·채널·봇)를 Discord 개발자 모드로 확인
2. 중계 봇 생성, Message Content Intent 활성화, 대상 채널에만 View/Send/Read History 권한
3. config-diff.md 변경 1을 승인된 절차로 적용, 적용 전 값 기록
4. 비밀은 비밀 저장소에서 환경변수로만 주입. `.env`에 토큰을 쓰지 않는다

```sh
export RELAY_MODE=live
export DISCORD_BOT_TOKEN="$(<비밀 저장소 조회 명령>)"
export RELAY_CLIENT_TOKEN="$(<비밀 저장소 조회 명령>)"
export RELAY_PRINCIPAL_ID=owner
export DISCORD_GUILD_ID=… DISCORD_CHANNEL_ID=… DISCORD_RELAY_BOT_ID=… DISCORD_CHRIS_BOT_ID=…
npm start
```
- 시작 시 Discord에 **아무것도 게시하지 않고** 봇 ID·채널·guild·Chris 멤버 여부·권한·Message Content Intent를 점검한다. 문제가 있으면 `listening` 로그의 `problems`에 나오고 POST는 503.
- 바인드는 loopback 전용. iPhone/G2 접속은 Tailscale Serve로만 한다(docs/access-tailscale-serve.md). Funnel·포트 개방 금지.

## 3. 중지

`Ctrl-C` 또는 `kill -TERM <pid>`. 진행 중 dispatch를 기다린 뒤 Gateway를 닫고 DB를 닫는다. 진행 중 요청 상태는 DB에 남는다.

## 4. 재시작 복구

같은 `RELAY_DB_PATH`로 다시 시작하면 자동으로:
| 재시작 시 상태 | 처리 |
|---|---|
| accepted | 한 번도 시도 안 함이 확정 → 1회 게시 |
| sending | 게시 여부 불명 → `delivery_unknown`, 최근 50개 메시지에서 자기 게시(요청 ID 표식) 탐색. 찾으면 awaiting_reply, 못 찾으면 **운영자 확인** |
| awaiting_reply | 유지. Gateway 연결 후 요청 메시지 이후 최대 100개를 REST로 catch-up |
| delivery_unknown | 자기 게시 재탐색 |

재게시는 어떤 경우에도 자동으로 하지 않는다.

## 5. 운영자 도구

```sh
npm run admin -- list 20
npm run admin -- show <request_id>                     # 상태 타임라인, 메시지 ID (본문 제외)
npm run admin -- confirm-posted <request_id> <discord_message_id>   # Discord에서 게시 확인한 경우
npm run admin -- resolve-failed <request_id>           # 게시 안 된 것을 확인한 경우. 채널 잠금 해제
npm run admin -- purge                                 # 보존 정책 즉시 적용 (텍스트 7일, 메타 30일)
```
Discord의 메시지는 어떤 도구로도 삭제하지 않는다. 시험 글은 증거로 남긴다.

## 6. 상태 저장소 복구

- DB 파일: `RELAY_DB_PATH` (+ `-wal`, `-shm`). 백업은 **서비스 중지 후** `sqlite3 relay.sqlite ".backup relay-YYYYMMDD.sqlite"`.
- 손상 시: 중지 → 백업본으로 교체 → 시작. 백업 이후 생성된 요청은 Discord 채널의 중계 봇 게시(요청 ID 표식)로 수동 대조.
- 스키마는 `schema_migrations`로 버전 관리. 적용된 마이그레이션은 수정하지 않는다.

## 7. 롤백 (AT-22)

순서대로, 각 단계 결과를 기록:
1. 중계 서비스 중지 (§3)
2. 중계 endpoint 비활성화: 프로세스를 다시 띄우지 않는다. (필요 시 `RELAY_PRINCIPAL_DISABLED=1`로 띄우면 모든 요청 403)
3. OpenClaw 채널 변경 역적용: config-diff.md “롤백” 절차 — **해당 채널의 relay 항목만** 제거. 전체 config 백업으로 덮어쓰지 않는다
4. 확인: `openclaw config get channels.discord.accounts.main.guilds.<guild>.channels.<channel>`이 적용 전 값과 같은지, 사용자가 기본 채널에 직접 쓴 메시지에 Chris가 평소처럼 답하는지
5. 중계 봇의 서버 권한 제거 또는 봇 추방(Discord 서버 설정). 봇 토큰 폐기는 Developer Portal에서

## 8. 하지 않는 것

전역 allowlist 완화, 개인 Discord 계정 토큰 사용, OpenClaw Gateway 재시작·doctor, 다른 비서 설정 변경, 상시 데몬 등록.
