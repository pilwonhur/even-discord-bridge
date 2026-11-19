# 요청 상태 전이 (I-04)

```
            POST 202
               │
           accepted ──(재시작: 미시도 확정 → 1회 dispatch)
               │  DB에 sending 먼저 기록 후 네트워크 호출
            sending ──429──► (Retry-After 대기, 최대 5회) ──► sending
           ╱   │    ╲
 not_sent/   성공    unknown(timeout·reset·5xx) / 재시작 시 sending
 4xx/예외     │              │
   ▼          ▼              ▼
 failed  awaiting_reply ◄── delivery_unknown ──(자기 게시 스캔 실패)──► 유지 + 운영자 확인
              │   ▲  자기 게시 스캔 성공 / 운영자 confirm-posted
              │
   ┌──────────┼──────────────────────┐
 대응 응답     deadline 경과            deadline 경과
 (본문 있음)   후보 0                   모호 후보 ≥1
   ▼          ▼                       ▼
 completed  timed_out             ambiguous_response
            (늦은 답 → late part)   (늦은 답 → late part)
```

- **in-flight(채널 잠금)**: `accepted`, `sending`, `awaiting_reply`, `delivery_unknown`. DB 부분 유일 인덱스 `requests_one_inflight`로 강제. 종료 상태가 되면 잠금 해제.
- **delivery_unknown은 자동으로 풀리지 않는다.** 재게시하면 Chris가 두 번 실행될 수 있으므로 운영자가 Discord에서 확인 후 `admin.ts confirm-posted` 또는 `resolve-failed`.
- **completed의 의미**: “대응 조건을 만족한 Chris 메시지를 처음 받았다”. OpenClaw run 완료가 아니다(`run_completion: "unverified"`). 기본 `progress` 스트리밍에서는 이 메시지가 이후 편집될 수 있고, 편집은 같은 part의 `text`/`edited_at`에 반영된다.
- 본문이 비어 있는 대응 메시지(Message Content Intent 상실 등) → `failed / reply_content_unavailable`. 성공으로 표시하지 않는다.

## 대응 규칙 (src/correlation.ts)

1. guild/channel 불일치 → 무시(`other_channel`, 메타데이터만 기록)
2. 작성자 = 중계 봇 → 무시(루프 방지)
3. 작성자 ≠ 설정된 Chris bot ID → 무시(`non_target_author`). 표시 이름은 보지 않는다.
4. `message_reference`가 요청 메시지를 가리킴 + 본문 request_id 없음/동일 → 대응
5. reference 없음 + 본문에 알려진 request_id 정확히 1개 → 대응(`request_id_text`)
6. reference와 본문 ID 충돌, 또는 ID 여러 개 → `ambiguous` (붙이지 않음)
7. 둘 다 없음 → `unreferenced` (붙이지 않음; 대기 중 요청의 모호 후보 수 +1)

“요청 다음에 온 첫 메시지”, 응답 시각, 표시 이름으로는 절대 대응하지 않는다.

## 늦은 답 / 추가 조각

- `timed_out`/`ambiguous_response`/`failed` 요청에 대응된 메시지 → `late: true` part로만 저장. 상태 불변, 새 요청 생성 없음.
- `completed` 이후 같은 요청에 대응된 두 번째 메시지 → part로 저장하고 `multipart_detected: true`. **P0는 분할 응답을 지원하지 않는다**(AT-26, P2).

## 중복 이벤트

- 키: create `c:<message_id>`, update `u:<message_id>:<edited_timestamp>`. `processed_events`에 INSERT OR IGNORE.
- Gateway 재전달·REST catch-up·재시작이 같은 메시지를 다시 줘도 한 번만 처리.
