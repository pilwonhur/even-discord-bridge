// Server-side template allowlist (FR-10). Clients choose a template name only;
// they never supply free text, channel IDs, agent IDs or mentions.

export const TEMPLATES = {
  connection_check: '중계 연결 확인 시험입니다. 이 메시지를 읽었다면 "연결 확인"이라고만 짧게 답해 주세요.',
  recall_test_word: '이 채널에서 정해 둔 시험용 단어를 알려 주세요. 단어만 짧게 답해 주세요.',
  sentence_with_test_word: '방금 확인한 그 시험용 단어를 넣어 짧은 한국어 문장 하나를 만들어 주세요.',
} as const;

export type TemplateName = keyof typeof TEMPLATES;

export function isTemplateName(x: unknown): x is TemplateName {
  return typeof x === 'string' && Object.hasOwn(TEMPLATES, x);
}

/**
 * Renders the Discord message. The author stays the relay bot; the header states
 * that this is a relayed request from an authenticated user (FR-03) and does not
 * pretend to be the owner speaking directly or a system instruction.
 */
export function renderRequest(opts: { requestId: string; principalId: string; chrisBotId: string; template: TemplateName }): string {
  return [
    '[G2 중계 · 인증된 사용자 요청 · 텍스트 시험]',
    `요청 ID: ${opts.requestId}`,
    `인증 주체: ${opts.principalId} (작성자는 중계 봇)`,
    `<@${opts.chrisBotId}> ${TEMPLATES[opts.template]}`,
    '답변 첫 줄에 위 요청 ID를 그대로 적고, 이 메시지에 답글로 짧게 답해 주세요. 작업 지시가 아닌 읽기 전용 시험입니다.',
  ].join('\n');
}

/** The exact marker the relay looks for when recovering its own posts. */
export function requestMarker(requestId: string): string {
  return `요청 ID: ${requestId}`;
}
