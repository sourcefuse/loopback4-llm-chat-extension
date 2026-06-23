import {expect} from '@loopback/testlab';
import {stripThinkingTokens} from '../../utils';

/**
 * stripThinkingTokens strips model reasoning before it reaches the user.
 * The second pass was rewritten from a `.*?</think>` regex (super-linear
 * backtracking on tag-less input — SonarQube S8786) to a lastIndexOf scan;
 * these assertions lock the original behaviour: drop complete <think> pairs,
 * then drop everything up to and including the LAST closing think tag.
 */
describe('stripThinkingTokens (unit)', () => {
  it('removes a complete <think>...</think> block', () => {
    expect(stripThinkingTokens('<think>reasoning</think>answer')).to.equal(
      'answer',
    );
  });

  it('removes a complete <thinking>...</thinking> block', () => {
    expect(
      stripThinkingTokens('<thinking>reasoning</thinking>answer'),
    ).to.equal('answer');
  });

  it('strips orphaned reasoning up to a dangling closing tag', () => {
    expect(stripThinkingTokens('leftover reasoning</think>final')).to.equal(
      'final',
    );
  });

  it('strips up to the LAST closing tag when several are present', () => {
    expect(stripThinkingTokens('a</think>b</thinking>real answer')).to.equal(
      'real answer',
    );
  });

  it('leaves plain text without think tags untouched', () => {
    const plain = 'a'.repeat(5000);
    expect(stripThinkingTokens(plain)).to.equal(plain);
  });

  it('handles multiline reasoning (dot-matches-newline)', () => {
    expect(stripThinkingTokens('<think>line1\nline2</think>done')).to.equal(
      'done',
    );
  });

  it('unwraps a {content} message object', () => {
    expect(stripThinkingTokens({content: '<think>x</think>hi'})).to.equal('hi');
  });
});
