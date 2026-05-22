import {BindingScope, injectable} from '@loopback/core';

/**
 * Per-model input/output token accumulator. Replaces the LangChain-callback-based
 * TokenCounter in v3. WorkflowRunner adds totals from
 * `await stream.usage` after every agent.stream() / workflow run completes.
 * LimitStrategy consumes `flush()` instead of the old `TokenCounter.report()`.
 *
 * REQUEST-scoped: each chat turn gets a fresh accumulator so totals
 * cannot leak across users / tenants. A SINGLETON variant would let
 * `snapshot()` return cumulative totals across every request the
 * process has handled — a foot-gun for any consumer wiring a
 * LimitStrategy against it.
 */
@injectable({scope: BindingScope.REQUEST})
export class UsageAccumulator {
  private readonly perModel = new Map<
    string,
    {input: number; output: number}
  >();

  add(model: string, usage: {inputTokens: number; outputTokens: number}): void {
    const m = this.perModel.get(model) ?? {input: 0, output: 0};
    this.perModel.set(model, {
      input: m.input + (usage.inputTokens ?? 0),
      output: m.output + (usage.outputTokens ?? 0),
    });
  }

  /**
   * Returns a snapshot of the accumulated per-model token totals
   * WITHOUT mutating state. Useful for periodic reporting.
   */
  snapshot(): Record<string, {input: number; output: number}> {
    return Object.fromEntries(this.perModel);
  }

  /**
   * Consume-and-reset: returns the current totals and clears the
   * internal Map. Use this when handing off totals to a consumer
   * (LimitStrategy, audit log, etc.) so the next request starts from
   * zero — important because this service is SINGLETON scope and the
   * Map would otherwise leak across requests / tests.
   */
  flush(): Record<string, {input: number; output: number}> {
    const out = Object.fromEntries(this.perModel);
    this.perModel.clear();
    return out;
  }

  reset(): void {
    this.perModel.clear();
  }
}
