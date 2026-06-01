import {expect} from '@loopback/testlab';
import {RequestContext} from '@mastra/core/request-context';
import {
  getChatLlm,
  getCheapLlm,
  getSmartLlm,
  getSmartNonThinkingLlm,
  type MastraRcShape,
} from '../../mastra/workflows/db-query/_helpers';

// Sentinels — the accessors return whatever was stored, identity-comparable.
const CHAT_MODEL = {kind: 'chat'} as unknown;
const CHEAP_MODEL = {kind: 'cheap'} as unknown;
const SMART_MODEL = {kind: 'smart'} as unknown;
const NON_THINKING_MODEL = {kind: 'snt'} as unknown;

function buildRc(
  overrides: Partial<MastraRcShape>,
): RequestContext<MastraRcShape> {
  const shape: MastraRcShape = {
    resourceId: 'tenant-1:user-1',
    eventWriter: () => {},
    ...overrides,
  };
  return new RequestContext<MastraRcShape>(Object.entries(shape) as never);
}

describe('LLM tier accessors', () => {
  describe('with all tiers bound', () => {
    let rc: RequestContext<MastraRcShape>;
    beforeEach(() => {
      rc = buildRc({
        chatLlm: CHAT_MODEL as never,
        cheapLlm: CHEAP_MODEL as never,
        smartLlm: SMART_MODEL as never,
        smartNonThinkingLlm: NON_THINKING_MODEL as never,
      });
    });

    it('getChatLlm returns the chat slot', () => {
      expect(getChatLlm(rc)).to.equal(CHAT_MODEL);
    });

    it('getCheapLlm returns the cheap slot when bound', () => {
      expect(getCheapLlm(rc)).to.equal(CHEAP_MODEL);
    });

    it('getSmartLlm returns the smart slot when bound', () => {
      expect(getSmartLlm(rc)).to.equal(SMART_MODEL);
    });

    it('getSmartNonThinkingLlm returns the smart-non-thinking slot when bound', () => {
      expect(getSmartNonThinkingLlm(rc)).to.equal(NON_THINKING_MODEL);
    });
  });

  describe('fallback to chatLlm when tier slot is unbound', () => {
    let rc: RequestContext<MastraRcShape>;
    beforeEach(() => {
      // Only chat is bound — verifies the "consumer didn't set any tier
      // env vars" path stays runnable and silently uses the chat model.
      rc = buildRc({chatLlm: CHAT_MODEL as never});
    });

    it('getCheapLlm falls back to chatLlm', () => {
      expect(getCheapLlm(rc)).to.equal(CHAT_MODEL);
    });

    it('getSmartLlm falls back to chatLlm', () => {
      expect(getSmartLlm(rc)).to.equal(CHAT_MODEL);
    });

    it('getSmartNonThinkingLlm falls back to chatLlm', () => {
      expect(getSmartNonThinkingLlm(rc)).to.equal(CHAT_MODEL);
    });
  });

  describe('with no models bound at all', () => {
    let rc: RequestContext<MastraRcShape>;
    beforeEach(() => {
      rc = buildRc({});
    });

    it('every accessor returns undefined and the workflow step can short-circuit', () => {
      expect(getChatLlm(rc)).to.be.undefined();
      expect(getCheapLlm(rc)).to.be.undefined();
      expect(getSmartLlm(rc)).to.be.undefined();
      expect(getSmartNonThinkingLlm(rc)).to.be.undefined();
    });
  });

  describe('with no request context at all', () => {
    it('every accessor returns undefined (no rc supplied)', () => {
      expect(getChatLlm(undefined)).to.be.undefined();
      expect(getCheapLlm(undefined)).to.be.undefined();
      expect(getSmartLlm(undefined)).to.be.undefined();
      expect(getSmartNonThinkingLlm(undefined)).to.be.undefined();
    });
  });
});
