import {expect} from '@loopback/testlab';
import {TokenCounter} from '../../services/token-counter.service';

describe('TokenCounter (Mastra path)', function () {
  let counter: TokenCounter;

  beforeEach(() => {
    counter = new TokenCounter();
  });

  describe('accumulate()', function () {
    it('increments global totals on the first call', () => {
      counter.accumulate(10, 5, 'gpt-4o');

      const counts = counter.getCounts();
      expect(counts.inputs).to.equal(10);
      expect(counts.outputs).to.equal(5);
    });

    it('sums multiple calls across the same model', () => {
      counter.accumulate(10, 5, 'gpt-4o');
      counter.accumulate(20, 8, 'gpt-4o');

      const counts = counter.getCounts();
      expect(counts.inputs).to.equal(30);
      expect(counts.outputs).to.equal(13);
      expect(counts.map['gpt-4o'].inputTokens).to.equal(30);
      expect(counts.map['gpt-4o'].outputTokens).to.equal(13);
    });

    it('tracks different models separately in the map', () => {
      counter.accumulate(100, 50, 'gpt-4o');
      counter.accumulate(200, 80, 'claude-3-5-sonnet');

      const counts = counter.getCounts();
      expect(counts.inputs).to.equal(300);
      expect(counts.outputs).to.equal(130);
      expect(counts.map['gpt-4o'].inputTokens).to.equal(100);
      expect(counts.map['claude-3-5-sonnet'].outputTokens).to.equal(80);
    });

    it('handles zero-token calls without error', () => {
      counter.accumulate(0, 0, 'unknown');

      const counts = counter.getCounts();
      expect(counts.inputs).to.equal(0);
      expect(counts.outputs).to.equal(0);
    });

    it('does not interfere with clear()', () => {
      counter.accumulate(50, 20, 'gpt-4o');
      counter.clear();

      const counts = counter.getCounts();
      expect(counts.inputs).to.equal(0);
      expect(counts.outputs).to.equal(0);
      expect(Object.keys(counts.map).length).to.equal(0);
    });
  });

  describe('getCounts()', function () {
    it('returns zero totals on a fresh instance', () => {
      const counts = counter.getCounts();
      expect(counts.inputs).to.equal(0);
      expect(counts.outputs).to.equal(0);
      expect(counts.map).to.deepEqual({});
    });

    it('returns a snapshot — not a live reference', () => {
      counter.accumulate(10, 5, 'gpt-4o');
      const snapshot = counter.getCounts();

      counter.accumulate(10, 5, 'gpt-4o');
      // snapshot should still show the first call's values
      expect(snapshot.inputs).to.equal(10);
    });
  });
});
