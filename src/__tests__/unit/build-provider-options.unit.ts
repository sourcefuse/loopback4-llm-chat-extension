import {expect} from '@loopback/testlab';
import {
  buildProviderOptions,
  resolveEnvTemperature,
} from '../../mastra/workflows/db-query/_helpers';

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

describe('resolveEnvTemperature (CLAUDE_TEMPERATURE / BEDROCK_TEMPERATURE / OPENAI_TEMPERATURE wiring)', () => {
  const KEYS = [
    'CLAUDE_TEMPERATURE',
    'BEDROCK_TEMPERATURE',
    'OPENAI_TEMPERATURE',
  ] as const;
  const ORIGINAL: Record<string, string | undefined> = {};
  before(() => {
    for (const k of KEYS) ORIGINAL[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (ORIGINAL[k] === undefined) delete process.env[k];
      else process.env[k] = ORIGINAL[k];
    }
  });

  it('returns undefined when none of the temperature envs are set', () => {
    for (const k of KEYS) delete process.env[k];
    expect(resolveEnvTemperature()).to.be.undefined();
  });

  it('returns the CLAUDE_TEMPERATURE value when set, parsed as float', () => {
    for (const k of KEYS) delete process.env[k];
    process.env.CLAUDE_TEMPERATURE = '0.3';
    expect(resolveEnvTemperature()).to.equal(0.3);
  });

  it('falls back to BEDROCK_TEMPERATURE when CLAUDE is unset', () => {
    for (const k of KEYS) delete process.env[k];
    process.env.BEDROCK_TEMPERATURE = '0.7';
    expect(resolveEnvTemperature()).to.equal(0.7);
  });

  it('falls back to OPENAI_TEMPERATURE when CLAUDE and BEDROCK are unset', () => {
    for (const k of KEYS) delete process.env[k];
    process.env.OPENAI_TEMPERATURE = '0';
    expect(resolveEnvTemperature()).to.equal(0);
  });

  it('CLAUDE wins over BEDROCK and OPENAI when all set', () => {
    process.env.CLAUDE_TEMPERATURE = '0.1';
    process.env.BEDROCK_TEMPERATURE = '0.5';
    process.env.OPENAI_TEMPERATURE = '0.9';
    expect(resolveEnvTemperature()).to.equal(0.1);
  });

  it('returns undefined for non-numeric values so AI SDK falls back to provider default', () => {
    for (const k of KEYS) delete process.env[k];
    process.env.CLAUDE_TEMPERATURE = 'not-a-number';
    expect(resolveEnvTemperature()).to.be.undefined();
  });
});
