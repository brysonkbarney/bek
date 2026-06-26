import { registerTelemetry, type Telemetry } from "ai";

/**
 * AI SDK 7 global telemetry registration for Bek.
 *
 * AI SDK 7 replaced per-call telemetry wiring with a single global registration
 * (`registerTelemetry`). Deployments pass their chosen integration(s) — for
 * example `new OpenTelemetry()` from `@ai-sdk/otel`, or Langfuse/Braintrust/
 * Sentry adapters — and every `generateText`/`streamText`/`ToolLoopAgent` call
 * downstream emits spans into them. Bek does not hard-depend on any specific
 * OTel package so operators can pick their backend.
 *
 * Registration is idempotent within a process so calling it from multiple entry
 * points (API, worker) is safe.
 */

let registered = false;

export interface RegisterBekTelemetryResult {
  registered: boolean;
  integrationCount: number;
}

export function registerBekTelemetry(
  ...integrations: Telemetry[]
): RegisterBekTelemetryResult {
  if (registered) {
    return { registered: false, integrationCount: integrations.length };
  }
  if (integrations.length === 0) {
    return { registered: false, integrationCount: 0 };
  }
  registerTelemetry(...integrations);
  registered = true;
  return { registered: true, integrationCount: integrations.length };
}

/** Test-only: reset the once-guard so registration can be re-exercised. */
export function resetBekTelemetryForTests(): void {
  registered = false;
}
