import {BindingScope, injectable} from '@loopback/core';

/**
 * Per-model input/output token accumulator. Replaces the LangChain-callback-based
 * TokenCounter in v3 (Section 7.8 / Section 14). WorkflowRunner adds totals from
 * `await stream.usage` after every agent.stream() / workflow run completes.
 * LimitStrategy consumes `flush()` instead of the old `TokenCounter.report()`.
 */
@injectable({scope: BindingScope.SINGLETON})
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

  flush(): Record<string, {input: number; output: number}> {
    return Object.fromEntries(this.perModel);
  }

  reset(): void {
    this.perModel.clear();
  }
}
