# 중계 봇 생성 안내 (G0 준비 — 사용자 직접 수행)

Claude Code는 Discord 계정 로그인이 필요한 이 작업을 대신하지 않습니다. 개인 계정 토큰은 쓰지 않으며, 공식 봇 방식만 사용합니다.

## 1. 앱·봇 생성

1. https://discord.com/developers/applications → **New Application** (이름 예: `G2 Relay`)
2. **Bot** 탭
   - **Reset Token** → 표시된 토큰을 **바로 비밀 저장소**(예: macOS 키체인)에 저장. 채팅·파일·Discord에 붙여 넣지 않기
   - **Privileged Gateway Intents → MESSAGE CONTENT INTENT 켜기** (Chris 답 본문을 읽는 데 필요)
   - Presence / Server Members intent는 끈 상태 유지
   - **Public Bot 끄기** (다른 사람이 서버에 초대하지 못하게). **먼저** **Installation** 탭에서:
     - **Install Link → None** 으로 바꾸고 저장 (기본값 “Discord Provided Link”가 있으면 “Private application cannot have a default authorization link” 오류가 남)
     - **Installation Contexts**: **User Install 해제**, **Guild Install만** 유지
     - 그다음 Bot 탭으로 돌아와 Public Bot 끄고 저장
     - Install Link가 None이어도 아래 2단계의 초대 URL은 앱 소유자가 직접 쓸 수 있음
3. **General Information**의 **Application ID** = 중계 봇 user ID → `DISCORD_RELAY_BOT_ID`

키체인 저장 예 (토큰은 프롬프트에 입력, 셸 기록에 남지 않음):
```sh
security add-generic-password -a "$USER" -s even-relay-discord-bot-token -w
# 실행 시: export DISCORD_BOT_TOKEN="$(security find-generic-password -a "$USER" -s even-relay-discord-bot-token -w)"
```

## 2. 서버 초대 (최소 권한)

초대 URL (`<APP_ID>`만 교체):
```
https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot&permissions=68608
```
- `68608` = View Channel + Send Messages + Read Message History. **Administrator 없음.**
- 초대 후 가능하면 서버 설정에서 이 봇의 역할이 **Chris 기본 채널에서만** 보기/쓰기가 되도록 채널 권한을 조정. 다른 채널·스레드에는 접근 불필요.

## 3. 확인할 ID (Discord 설정 → 고급 → 개발자 모드 켠 뒤 우클릭 → ID 복사)

| 항목 | 값 (`config/live.env`) | 확인 |
|---|---|---|
| 서버(guild) | `<GUILD_ID>` | ☐ |
| Chris 기본 채널 | `<CHANNEL_ID>` | ☐ |
| Chris 봇 user | `<CHRIS_BOT_ID>` | ☐ |
| 사용자 user | `<OWNER_USER_ID>` | ☐ |
| 중계 봇 user | (생성 후) | ☐ |

## 4. 그다음 (Claude Code가 진행, 승인 후)

1. live 모드로 **게시 없이** 준비 점검만 실행 → `problems` 비어 있는지 확인
2. config-diff.md 변경 1 적용 (승인 시점에 dry-run 결과 제시)
3. AT-16 첫 시험: `connection_check` 1회 → 결과 보고 → 이후 순차 진행
