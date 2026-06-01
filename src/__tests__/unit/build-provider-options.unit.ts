import {expect} from '@loopback/testlab';
import {buildProviderOptions} from '../../mastra/workflows/db-query/_helpers';

describe('buildProviderOptions (CLAUDE_THINKING wiring)', () => {
  const ORIGINAL_THINKING = process.env.CLAUDE_THINKING;
  const ORIGINAL_BUDGET = process.env.CLAUDE_THINKING_BUDGET;

  afterEach(() => {
    if (ORIGINAL_THINKING === undefined) delete process.env.CLAUDE_THINKING;
    else process.env.CLAUDE_THINKING = ORIGINAL_THINKING;
    if (ORIGINAL_BUDGET === undefined)
      delete process.env.CLAUDE_THINKING_BUDGET;
    else process.env.CLAUDE_THINKING_BUDGET = ORIGINAL_BUDGET;
  });

  it('returns undefined when CLAUDE_THINKING is unset and no forceThinkingOff override', () => {
    delete process.env.CLAUDE_THINKING;
    delete process.env.CLAUDE_THINKING_BUDGET;
    // Default-off path: caller should spread `...(opts ?? {})` and end up
    // not passing providerOptions at all, so the AI SDK model uses its
    // own default (which is thinking off for Anthropic/Bedrock).
    expect(buildProviderOptions()).to.be.undefined();
  });

  it('returns undefined when CLAUDE_THINKING is explicitly false', () => {
    process.env.CLAUDE_THINKING = 'false';
    expect(buildProviderOptions()).to.be.undefined();
  });

  it('emits enabled thinking for both Anthropic and Bedrock when CLAUDE_THINKING=true', () => {
    process.env.CLAUDE_THINKING = 'true';
    delete process.env.CLAUDE_THINKING_BUDGET;
    const opts = buildProviderOptions();
    expect(opts).to.deepEqual({
      anthropic: {thinking: {type: 'enabled', budgetTokens: 1024}},
      bedrock: {reasoningConfig: {type: 'enabled', budgetTokens: 1024}},
    });
  });

  it('honours CLAUDE_THINKING_BUDGET when set', () => {
    process.env.CLAUDE_THINKING = 'true';
    process.env.CLAUDE_THINKING_BUDGET = '8192';
    const opts = buildProviderOptions();
    expect(opts?.anthropic.thinking).to.deepEqual({
      type: 'enabled',
      budgetTokens: 8192,
    });
    expect(opts?.bedrock.reasoningConfig).to.deepEqual({
      type: 'enabled',
      budgetTokens: 8192,
    });
  });

  it('forceThinkingOff overrides CLAUDE_THINKING=true and emits disabled', () => {
    // Line-visualizer / strict structured-output call sites pass
    // forceThinkingOff so reasoning chunks don't break JSON schema mode.
    process.env.CLAUDE_THINKING = 'true';
    process.env.CLAUDE_THINKING_BUDGET = '4096';
    const opts = buildProviderOptions({forceThinkingOff: true});
    expect(opts).to.deepEqual({
      anthropic: {thinking: {type: 'disabled'}},
      bedrock: {reasoningConfig: {type: 'disabled'}},
    });
  });

  it('forceThinkingOff returns disabled even when env is unset', () => {
    delete process.env.CLAUDE_THINKING;
    const opts = buildProviderOptions({forceThinkingOff: true});
    expect(opts?.anthropic.thinking).to.deepEqual({type: 'disabled'});
  });
});
