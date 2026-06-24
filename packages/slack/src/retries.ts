export interface SlackRetryInfo {
  retryNum: number;
  reason?: string;
}

export function parseSlackRetryHeaders(input: {
  retryNum?: string | undefined;
  retryReason?: string | undefined;
}): SlackRetryInfo | undefined {
  if (!input.retryNum) {
    return undefined;
  }

  const retryNum = Number(input.retryNum);
  if (!Number.isInteger(retryNum) || retryNum < 0) {
    return undefined;
  }

  const retry: SlackRetryInfo = { retryNum };
  const reason = normalizeRetryReason(input.retryReason);
  if (reason) {
    retry.reason = reason;
  }
  return retry;
}

function normalizeRetryReason(value: string | undefined): string | undefined {
  const reason = value?.trim();
  if (!reason) {
    return undefined;
  }
  return reason.slice(0, 120);
}
