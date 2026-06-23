import {expect} from '@loopback/testlab';
import {
  CHAT_AGENT_DIRECTIVES,
  buildChatInstructions,
} from '../../mastra/chat-agent-instructions';

/**
 * Restores v2 init-session.node behaviour: the chat agent's system prompt must
 * carry the directives, the current date, then the host systemContext, in that
 * order. The date is what lets relative-time questions ("joined last month")
 * resolve against today rather than the model's training cutoff.
 */
describe('buildChatInstructions (chat system prompt)', () => {
  const fixedDate = new Date('2026-06-23T10:00:00Z');

  it('includes every shared directive', () => {
    const out = buildChatInstructions([], fixedDate);
    for (const directive of CHAT_AGENT_DIRECTIVES) {
      expect(out).to.containEql(directive);
    }
  });

  it('injects the current date (v2 init-session parity)', () => {
    const out = buildChatInstructions([], fixedDate);
    expect(out).to.containEql(`Current date is ${fixedDate.toDateString()}`);
  });

  it('appends host systemContext after the date, in order', () => {
    const out = buildChatInstructions(['Rule A', 'Rule B'], fixedDate);
    const dateIdx = out.indexOf('Current date is');
    const aIdx = out.indexOf('Rule A');
    const bIdx = out.indexOf('Rule B');
    expect(dateIdx).to.be.greaterThan(-1);
    expect(aIdx).to.be.greaterThan(dateIdx);
    expect(bIdx).to.be.greaterThan(aIdx);
  });

  it('works with no systemContext (date still present)', () => {
    const out = buildChatInstructions(undefined, fixedDate);
    expect(out).to.containEql('Current date is');
    expect(out).to.containEql(CHAT_AGENT_DIRECTIVES[0]);
  });

  it('defaults to the real current date when none is passed', () => {
    const out = buildChatInstructions();
    expect(out).to.containEql(`Current date is ${new Date().toDateString()}`);
  });
});
