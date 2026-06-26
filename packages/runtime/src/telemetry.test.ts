import { afterEach, describe, expect, it, vi } from "vitest";

import { registerBekTelemetry, resetBekTelemetryForTests } from "./telemetry";

const registerTelemetry = vi.hoisted(() => vi.fn());
vi.mock("ai", () => ({ registerTelemetry }));

afterEach(() => {
  resetBekTelemetryForTests();
  registerTelemetry.mockClear();
});

describe("registerBekTelemetry", () => {
  it("registers integrations exactly once per process", () => {
    const integration = {} as never;
    const first = registerBekTelemetry(integration);
    const second = registerBekTelemetry(integration);

    expect(first).toEqual({ registered: true, integrationCount: 1 });
    expect(second).toEqual({ registered: false, integrationCount: 1 });
    expect(registerTelemetry).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when no integrations are provided", () => {
    const result = registerBekTelemetry();
    expect(result).toEqual({ registered: false, integrationCount: 0 });
    expect(registerTelemetry).not.toHaveBeenCalled();
  });

  it("forwards every integration to registerTelemetry in one call", () => {
    const first = {} as never;
    const second = {} as never;
    const result = registerBekTelemetry(first, second);

    expect(result).toEqual({ registered: true, integrationCount: 2 });
    expect(registerTelemetry).toHaveBeenCalledTimes(1);
    expect(registerTelemetry).toHaveBeenCalledWith(first, second);
  });

  it("does not latch the once-guard when called with no integrations", () => {
    // A no-op empty call must not block a later real registration.
    const noop = registerBekTelemetry();
    expect(noop.registered).toBe(false);

    const real = registerBekTelemetry({} as never);
    expect(real.registered).toBe(true);
    expect(registerTelemetry).toHaveBeenCalledTimes(1);
  });

  it("re-registers after the test reset clears the once-guard", () => {
    expect(registerBekTelemetry({} as never).registered).toBe(true);
    expect(registerBekTelemetry({} as never).registered).toBe(false);

    resetBekTelemetryForTests();

    expect(registerBekTelemetry({} as never).registered).toBe(true);
    expect(registerTelemetry).toHaveBeenCalledTimes(2);
  });
});
