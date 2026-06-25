import {expect} from '@loopback/testlab';
import {UsageAccumulator} from '../../services/usage-accumulator.service';

/**
 * The per-model token map the runtime accumulates and hands to the limit
 * strategies / thread metadata (v2 EndSession's per-model count map). Locks the
 * accumulate / snapshot / flush / reset contract.
 */
describe('UsageAccumulator (per-model token map)', () => {
  it('accumulates input/output per model across multiple adds', () => {
    const acc = new UsageAccumulator();
    acc.add('gpt-4o', {inputTokens: 10, outputTokens: 5});
    acc.add('gpt-4o', {inputTokens: 3, outputTokens: 2});
    expect(acc.snapshot()).to.eql({'gpt-4o': {input: 13, output: 7}});
  });

  it('tracks each model separately', () => {
    const acc = new UsageAccumulator();
    acc.add('cheap', {inputTokens: 1, outputTokens: 1});
    acc.add('smart', {inputTokens: 20, outputTokens: 30});
    expect(acc.snapshot()).to.eql({
      cheap: {input: 1, output: 1},
      smart: {input: 20, output: 30},
    });
  });

  it('snapshot does not mutate; flush returns then clears', () => {
    const acc = new UsageAccumulator();
    acc.add('m', {inputTokens: 4, outputTokens: 6});
    expect(acc.snapshot()).to.eql({m: {input: 4, output: 6}});
    // snapshot left state intact
    expect(acc.flush()).to.eql({m: {input: 4, output: 6}});
    // flush consumed it
    expect(acc.snapshot()).to.eql({});
  });

  it('reset clears all totals', () => {
    const acc = new UsageAccumulator();
    acc.add('m', {inputTokens: 1, outputTokens: 1});
    acc.reset();
    expect(acc.snapshot()).to.eql({});
  });

  it('treats missing token fields as zero', () => {
    const acc = new UsageAccumulator();
    acc.add('m', {} as never);
    expect(acc.snapshot()).to.eql({m: {input: 0, output: 0}});
  });
});
