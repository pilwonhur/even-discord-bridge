# 채널 한정 설정 변경안 (미적용)

상태: **제안만. 적용하지 않았다.** 실제 패치/롤백 파일과 dry-run 기록은 로컬에만 둔다(저장소 제외, 서버 ID 포함). 적용은 사용자 승인과 기존 운영 절차를 따른다. 재시작·doctor로 확인하지 않는다.

## 전제 (실연결 전 확인)

- `RELAY_BOT_ID` = `<RELAY_BOT_ID>` (G2 Relay, 2026-11-17 확인)
- 대상 채널 = `<CHANNEL_ID>` (Chris 채널, 2026-11-17 API로 이름 확인)
- 사용자 ID = `<OWNER_USER_ID>` (확인 필요)

## 변경 1 — 중계 봇을 기본 채널 sender allowlist에 추가 (필수)

현재값 (정적):
```json5
// channels.discord.accounts.main.guilds["<GUILD_ID>"].channels["<CHANNEL_ID>"]
{ enabled: true, requireMention: false }
```

제안값:
```json5
{ enabled: true, requireMention: false, users: ["<OWNER_USER_ID>", "<RELAY_BOT_ID>"] }
```

- 사용자 ID를 명시하는 이유: 채널 `users`가 guild 목록을 대체하는지 병합하는지 문서상 미확인이므로, 대체되더라도 사용자 접근이 유지되게 한다.
- 영향 범위: Chris 계정의 이 채널 하나. 다른 비서·채널·guild 기본값·`allowBots` 변경 없음. 전역 allowlist 완화 없음.

적용 명령(검토용, 실행 안 함):
```sh
openclaw config get channels.discord.accounts.main.guilds.<GUILD_ID>.channels.<CHANNEL_ID>   # 적용 직전 현재값 기록
openclaw config patch --dry-run --stdin <<'EOF'
{ channels: { discord: { accounts: { main: { guilds: { "<GUILD_ID>": { channels: { "<CHANNEL_ID>": { users: ["<OWNER_USER_ID>", "<RELAY_BOT_ID>"] } } } } } } } }
EOF
```
`--dry-run` 결과를 사용자에게 보인 뒤 같은 패치를 `--dry-run` 없이 적용한다. 런타임 반영 여부(핫 리로드)는 문서상 `guilds`가 런타임 변경 가능 항목으로 나열되어 있으나 실제 반영은 첫 시험 메시지로만 확인한다.

## 롤백

```sh
openclaw config patch --stdin <<'EOF'
{ channels: { discord: { accounts: { main: { guilds: { "<GUILD_ID>": { channels: { "<CHANNEL_ID>": { users: null } } } } } } } } }
EOF
openclaw config get channels.discord.accounts.main.guilds.<GUILD_ID>.channels.<CHANNEL_ID>
# 기대: { enabled: true, requireMention: false }
```
- 그사이 다른 사람이 같은 키를 바꿨다면 `null`로 지우지 말고 `RELAY_BOT_ID`만 뺀 배열을 적용한다.
- 전체 config 백업으로 덮어쓰지 않는다.

## 변경하지 않는 것 (명시)

- `replyToMode`: 채널 단위 키가 없어 계정 전체에 영향 → 변경 안 함. 대응은 request_id 본문 일치로 시험.
- `allowBots`, `groupPolicy`, `botLoopProtection`, `streaming`, 다른 비서 계정, 다른 플러그인.

## 별도 필요 (OpenClaw 밖)

- Discord Developer Portal에서 중계 앱/봇 생성, **Message Content Intent** 활성화.
- 봇 초대 권한: View Channel, Send Messages, Read Message History (permissions 정수 `68608`). Administrator 금지. 가능하면 대상 채널에만 권한 오버라이드.
