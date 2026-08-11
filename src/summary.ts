/**
 * Daily summary: requests by endpoint, error codes seen, turnover, violations.
 * Emitted on a fixed cadence and once at shutdown. Structured JSON so it can be
 * grepped out of the activity log or a webhook.
 */
import type { HttpClient } from "./http.ts";
import type { Logger } from "./logger.ts";

export function emitSummary(http: HttpClient, log: Logger, turnoverContracts: bigint, extra: Record<string, unknown> = {}): void {
  const byEndpoint = Object.fromEntries([...http.counts.entries()].sort((a, b) => b[1] - a[1]));
  const byCode = Object.fromEntries([...http.codeCounts.entries()].sort((a, b) => b[1] - a[1]));
  const findingsByKind: Record<string, number> = {};
  for (const f of log.findings) findingsByKind[f.kind] = (findingsByKind[f.kind] ?? 0) + 1;
  log.info("daily summary", {
    summary: true,
    requestsByEndpoint: byEndpoint,
    totalRequests: [...http.counts.values()].reduce((a, b) => a + b, 0),
    errorCodesSeen: byCode,
    turnoverContracts: turnoverContracts.toString(),
    findings: log.findings.length,
    findingsByKind,
    ...extra,
  });
  if (log.findings.length > 0) {
    log.alert(`soak summary: ${log.findings.length} finding(s) recorded`, { findingsByKind });
  }
}
