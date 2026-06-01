import {expect} from '@loopback/testlab';
import {createMaxTokenCountProcessor} from '../../mastra/processors/max-token-count.processor';

// Each character ≈ 0.25 tokens (approxTokenCounter: 1 token / 4 chars).
// Use 400-char messages = 100 tokens each so the math stays obvious.
const longText = (chars: number, label: string): string =>
  label.padEnd(chars, '.');

interface MockMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

async function runProcessor(
  budget: number | undefined,
  systemMessages: MockMessage[],
  messages: MockMessage[],
): Promise<MockMessage[]> {
  const processor = createMaxTokenCountProcessor(
    budget !== undefined ? {maxTokenCount: budget} : {},
  );
  const result = await (
    processor.processInput as (args: unknown) => Promise<unknown>
  )({
    messages,
    systemMessages,
    state: {},
  } as unknown);
  return result as MockMessage[];
}

describe('MaxTokenCountProcessor', () => {
  const ORIGINAL_ENV = process.env.MAX_TOKEN_COUNT;
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.MAX_TOKEN_COUNT;
    else process.env.MAX_TOKEN_COUNT = ORIGINAL_ENV;
  });

  it('returns messages unchanged when total tokens fit in budget', async () => {
    const messages: MockMessage[] = [
      {role: 'user', content: longText(400, 'a')}, // ~100 tokens
      {role: 'assistant', content: longText(400, 'b')},
    ];
    const result = await runProcessor(1000, [], messages);
    expect(result).to.have.length(2);
  });

  it('drops oldest non-system messages until under budget', async () => {
    const messages: MockMessage[] = [
      {role: 'user', content: longText(400, 'one')}, // ~100 tokens
      {role: 'assistant', content: longText(400, 'two')},
      {role: 'user', content: longText(400, 'three')},
      {role: 'assistant', content: longText(400, 'four')},
      {role: 'user', content: longText(400, 'five')},
    ];
    // 5 messages × 100 tokens = 500 tokens; budget 250 → drop until ≤ 250
    const result = await runProcessor(250, [], messages);
    expect(result.length).to.be.lessThan(5);
    // Most recent message must survive (current user turn)
    expect(result[result.length - 1].content.startsWith('five')).to.be.true();
  });

  it('always preserves at least one message (the latest)', async () => {
    const messages: MockMessage[] = [
      {role: 'user', content: longText(40000, 'huge')}, // ~10K tokens
    ];
    const result = await runProcessor(100, [], messages);
    expect(result).to.have.length(1);
  });

  it('subtracts system-message tokens from the budget', async () => {
    const systemMessages: MockMessage[] = [
      {role: 'system', content: longText(400, 'sys')}, // ~100 tokens
    ];
    const messages: MockMessage[] = [
      {role: 'user', content: longText(400, 'a')},
      {role: 'assistant', content: longText(400, 'b')},
      {role: 'user', content: longText(400, 'c')},
    ];
    // System=100, budget=250, so message budget = 150 → at most 1 message
    // since each is 100 tokens.
    const result = await runProcessor(250, systemMessages, messages);
    expect(result).to.have.length(1);
    expect(result[0].content.startsWith('c')).to.be.true();
  });

  it('returns empty when system messages alone exceed budget', async () => {
    const systemMessages: MockMessage[] = [
      {role: 'system', content: longText(40000, 'sys')}, // ~10K tokens
    ];
    const messages: MockMessage[] = [
      {role: 'user', content: longText(400, 'a')},
    ];
    const result = await runProcessor(100, systemMessages, messages);
    expect(result).to.have.length(0);
  });

  it('reads MAX_TOKEN_COUNT env when no constructor arg is provided', async () => {
    process.env.MAX_TOKEN_COUNT = '150';
    const messages: MockMessage[] = [
      {role: 'user', content: longText(400, 'one')}, // ~100 tokens
      {role: 'assistant', content: longText(400, 'two')},
      {role: 'user', content: longText(400, 'three')},
    ];
    // Total 300 tokens, env-budget 150 → at most 1 fits
    const result = await runProcessor(undefined, [], messages);
    expect(result).to.have.length(1);
    expect(result[0].content.startsWith('three')).to.be.true();
  });

  it('constructor maxTokenCount overrides env', async () => {
    process.env.MAX_TOKEN_COUNT = '10';
    const messages: MockMessage[] = [
      {role: 'user', content: longText(400, 'one')}, // ~100 tokens
      {role: 'user', content: longText(400, 'two')},
    ];
    // Env says 10 (would drop everything except last), constructor 500 (fits)
    const result = await runProcessor(500, [], messages);
    expect(result).to.have.length(2);
  });
});
