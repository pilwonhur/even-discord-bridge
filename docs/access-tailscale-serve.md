# iPhone(Even 앱) → 중계 서비스 접속: Tailscale Serve

결정: 2026-11-16 사용자 — Tailscale Serve 사용 (공개 인터넷 노출 없음, Funnel 사용 안 함).
상태: **적용됨 (2026-11-17).** 사용자가 tailnet Serve/HTTPS 인증서를 켬. `tailscale serve --bg --https=8443 http://127.0.0.1:8787` 설정 중(재부팅 후에도 유지). Mac에서의 확인 결과는 로컬 증거 파일에 있음(저장소에는 넣지 않음). iPhone(Tailscale 켬) healthz 확인 완료(사용자 보고).
중계 서비스가 꺼져 있을 때 이 주소로 접속하면 502가 난다(정상).

```
iPhone (Tailscale 켜짐) ── https://<mac>.<tailnet>.ts.net:8443 ──► tailscaled (TLS 종료, 신원 헤더 추가)
                                                                     │ http
                                                                     ▼
                                                    127.0.0.1:8787 중계 서비스 (loopback 바인드 유지)
```

## 1. 1회 준비 (사용자)

1. `tailscale serve`가 안내하는 동의 페이지(`https://login.tailscale.com/f/serve?node=…`)에서 Serve와 HTTPS 인증서를 켭니다.
   - **공개 기록 주의:** HTTPS 인증서를 켜면 Mac의 `*.ts.net` 이름이 공개 인증서 투명성(CT) 로그에 남습니다. 이름만 공개되고 접속은 여전히 tailnet 기기만 가능합니다.
2. iPhone Tailscale 앱에서 같은 계정으로 로그인하고, 가능하면 필요 시 자동 연결(On Demand)을 켭니다(설정 존재 여부 미확인).

## 2. Serve 켜기/끄기 (Mac)

```sh
tailscale serve --bg --https=8443 http://127.0.0.1:8787   # 켜기 (재부팅 후에도 유지)
tailscale serve status                                    # 확인
tailscale serve --https=8443 off                          # 이 항목만 끄기
```
- 포트 8443을 쓰는 이유: 443은 앞으로 다른 서비스가 쓸 수 있으므로 비워 둠.
- `tailscale serve reset`은 **모든** Serve 설정을 지우므로 쓰지 않습니다.
- Funnel(`tailscale funnel`)은 인터넷 공개이므로 쓰지 않습니다.

## 3. 중계 서비스 설정

```sh
RELAY_BIND_HOST=127.0.0.1          # 그대로. Serve가 loopback으로 프록시
RELAY_PORT=8787
RELAY_TAILSCALE_LOGINS=<사용자 tailnet 로그인>   # 예: tailscale status --json 의 User.LoginName
RELAY_ALLOWED_ORIGIN=<Even 앱 WebView origin>   # P1에서 실측 후 지정 (미확인)
```
- `RELAY_TAILSCALE_LOGINS`가 설정되면 `/v1/*` 요청은 **Bearer 토큰 + Serve가 붙인 `Tailscale-User-Login` 일치**를 모두 요구합니다(403 `tailnet_identity_required`). Serve는 클라이언트가 보낸 같은 이름의 헤더를 제거합니다[Tailscale 문서]. tagged 기기에서 온 요청에는 이 헤더가 없습니다.
- 이 설정을 켜면 Mac에서 `127.0.0.1:8787`로 직접 부르는 CLI는 403이 됩니다. Mac에서 시험할 때는 `RELAY_URL=https://<mac>.<tailnet>.ts.net:8443`로 Serve를 거치게 합니다.
- CORS 헤더는 오류 응답에도 붙습니다(WebView가 오류 코드를 읽을 수 있게).

## 4. 확인 절차

1. Mac: `npm run start:mock` (모의) → `tailscale serve --bg --https=8443 http://127.0.0.1:8787`
2. iPhone Safari(Tailscale 켜짐): `https://<mac>.<tailnet>.ts.net:8443/healthz` → `{"ready":true,...}`
3. iPhone Tailscale 끔 → 같은 주소 접속 실패 확인 (공개 노출 없음)
4. 끝나면 서비스 중지, 필요 없으면 `tailscale serve --https=8443 off`

## 미확인 (P1 실기기 시험에서 확인)

- Even 앱 `app.json` network whitelist에 `*.ts.net:8443` 주소가 허용되는지, WebView의 origin 값
- 휴대폰 잠금/앱 전환 중 Tailscale 연결과 WebView 요청 유지 (AT-24)
- iOS에서 다른 VPN 사용 시 Tailscale 동시 사용 불가 → 그동안 G2 기능 정지(Chris/Discord는 영향 없음)
