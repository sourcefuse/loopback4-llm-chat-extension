import {expect} from '@loopback/testlab';
import type {EmbeddingModelV2} from '@ai-sdk/provider';
import {withGoogleTaskType} from '../../sub-modules/providers/google/embedding/gemini-embedding.provider';
import {sanitizeFilenameForAwsConverse} from '../../sub-modules/providers/aws/utils';

// Coverage for two behaviours restored from v2 (LangGraph) that the Mastra
// migration had dropped:
//  1. Gemini embeddings tagged taskType=RETRIEVAL_DOCUMENT (retrieval quality).
//  2. Bedrock document filename sanitisation for the file-upload path.
describe('v2→v3 restored regressions (unit)', () => {
  describe('Gemini embedding taskType injection', () => {
    // Minimal fake EmbeddingModelV2 that records the doEmbed options it receives.
    function fakeModel(): {
      model: EmbeddingModelV2<string>;
      lastOptions: () => unknown;
    } {
      let captured: unknown;
      const model = {
        specificationVersion: 'v2',
        provider: 'google.generative-ai',
        modelId: 'gemini-embedding-001',
        maxEmbeddingsPerCall: 100,
        supportsParallelCalls: true,
        async doEmbed(options: unknown) {
          captured = options;
          return {embeddings: [[0.1]], usage: {tokens: 1}};
        },
      } as unknown as EmbeddingModelV2<string>;
      return {model, lastOptions: () => captured};
    }

    it('injects taskType=RETRIEVAL_DOCUMENT on doEmbed', async () => {
      const {model, lastOptions} = fakeModel();
      const wrapped = withGoogleTaskType(model, 'RETRIEVAL_DOCUMENT');
      await wrapped.doEmbed({values: ['hello']} as never);
      const opts = lastOptions() as {
        providerOptions?: {google?: {taskType?: string}};
      };
      expect(opts.providerOptions?.google?.taskType).to.equal(
        'RETRIEVAL_DOCUMENT',
      );
    });

    it('lets a caller-supplied taskType override the default', async () => {
      const {model, lastOptions} = fakeModel();
      const wrapped = withGoogleTaskType(model, 'RETRIEVAL_DOCUMENT');
      await wrapped.doEmbed({
        values: ['q'],
        providerOptions: {google: {taskType: 'RETRIEVAL_QUERY'}},
      } as never);
      const opts = lastOptions() as {
        providerOptions?: {google?: {taskType?: string}};
      };
      expect(opts.providerOptions?.google?.taskType).to.equal(
        'RETRIEVAL_QUERY',
      );
    });

    it('preserves other google providerOptions while adding taskType', async () => {
      const {model, lastOptions} = fakeModel();
      const wrapped = withGoogleTaskType(model, 'RETRIEVAL_DOCUMENT');
      await wrapped.doEmbed({
        values: ['x'],
        providerOptions: {google: {outputDimensionality: 256}},
      } as never);
      const g = (
        lastOptions() as {
          providerOptions?: {
            google?: {taskType?: string; outputDimensionality?: number};
          };
        }
      ).providerOptions?.google;
      expect(g?.taskType).to.equal('RETRIEVAL_DOCUMENT');
      expect(g?.outputDimensionality).to.equal(256);
    });

    it('passes through non-doEmbed members unchanged', () => {
      const {model} = fakeModel();
      const wrapped = withGoogleTaskType(model, 'RETRIEVAL_DOCUMENT');
      expect(wrapped.modelId).to.equal('gemini-embedding-001');
      expect(wrapped.provider).to.equal('google.generative-ai');
    });
  });

  describe('sanitizeFilenameForAwsConverse (Bedrock file upload)', () => {
    it('strips the extension', () => {
      expect(sanitizeFilenameForAwsConverse('report.pdf')).to.equal('report');
    });
    it('removes disallowed characters', () => {
      expect(sanitizeFilenameForAwsConverse('Q3_Report@2025!.pdf')).to.equal(
        'Q3Report2025',
      );
    });
    it('keeps allowed chars (alphanumeric, space, hyphen, parens, brackets)', () => {
      expect(
        sanitizeFilenameForAwsConverse('Annual Report (2025) [final].pdf'),
      ).to.equal('Annual Report (2025) [final]');
    });
    it('collapses consecutive whitespace', () => {
      expect(sanitizeFilenameForAwsConverse('a    b   c.pdf')).to.equal(
        'a b c',
      );
    });
    it('falls back to "document" when sanitisation empties the name', () => {
      expect(sanitizeFilenameForAwsConverse('@@@.pdf')).to.equal('document');
    });
  });
});
