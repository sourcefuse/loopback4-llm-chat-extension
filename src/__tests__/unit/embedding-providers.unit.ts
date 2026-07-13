import {expect} from '@loopback/testlab';
import {GeminiEmbedding} from '../../sub-modules/providers/google/embedding/gemini-embedding.provider';
import {BedrockEmbedding} from '../../sub-modules/providers/aws/embedding/bedrock-embedding.provider';
import {OllamaEmbedding} from '../../sub-modules/providers/ollama/embedding/ollama-embedding.provider';

/**
 * Unit coverage for the three embedding providers (Gemini / Bedrock / Ollama).
 * These had ZERO tests before — the parity audit flagged them as untested, and
 * the Gemini one carries a known behaviour change (no `taskType`/`title`). The
 * value() factory returns an AI-SDK `textEmbeddingModel`, so we assert the
 * fail-closed env guard and that a model object is produced when the required
 * env is present (no network call is made by construction).
 */
describe('Embedding providers (unit)', () => {
  const ALL_ENV = [
    'GOOGLE_EMBEDDING_MODEL',
    'GOOGLE_API_KEY',
    'BEDROCK_EMBEDDING_MODEL',
    'BEDROCK_AWS_REGION',
    'BEDROCK_AWS_ACCESS_KEY_ID',
    'BEDROCK_AWS_SECRET_ACCESS_KEY',
    'OLLAMA_EMBEDDING_MODEL',
    'OLLAMA_URL',
  ];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ALL_ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ALL_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  describe('GeminiEmbedding', () => {
    it('throws when GOOGLE_EMBEDDING_MODEL is missing', () => {
      process.env.GOOGLE_API_KEY = 'k';
      expect(() => new GeminiEmbedding().value()).to.throw(
        /GOOGLE_EMBEDDING_MODEL/,
      );
    });
    it('throws when GOOGLE_API_KEY is missing', () => {
      process.env.GOOGLE_EMBEDDING_MODEL = 'text-embedding-004';
      expect(() => new GeminiEmbedding().value()).to.throw(/embedding model/i);
    });
    it('returns an embedding model when both env vars are set', () => {
      process.env.GOOGLE_EMBEDDING_MODEL = 'text-embedding-004';
      process.env.GOOGLE_API_KEY = 'k';
      const model = new GeminiEmbedding().value();
      expect(model).to.not.be.undefined();
      expect((model as {modelId?: string}).modelId).to.equal(
        'text-embedding-004',
      );
    });
  });

  describe('BedrockEmbedding', () => {
    it('throws when BEDROCK_EMBEDDING_MODEL is missing', () => {
      expect(() => new BedrockEmbedding().value()).to.throw(
        /BEDROCK_EMBEDDING_MODEL/,
      );
    });
    it('returns an embedding model when the model env is set', () => {
      process.env.BEDROCK_EMBEDDING_MODEL = 'amazon.titan-embed-text-v2:0';
      process.env.BEDROCK_AWS_REGION = 'us-east-1';
      process.env.BEDROCK_AWS_ACCESS_KEY_ID = 'id';
      process.env.BEDROCK_AWS_SECRET_ACCESS_KEY = 'secret';
      const model = new BedrockEmbedding().value();
      expect(model).to.not.be.undefined();
      expect((model as {modelId?: string}).modelId).to.equal(
        'amazon.titan-embed-text-v2:0',
      );
    });
  });

  describe('OllamaEmbedding', () => {
    it('throws when OLLAMA_EMBEDDING_MODEL is missing', () => {
      expect(() => new OllamaEmbedding().value()).to.throw(
        /OLLAMA_EMBEDDING_MODEL/,
      );
    });
    it('returns an embedding model (default base URL) when the model env is set', () => {
      process.env.OLLAMA_EMBEDDING_MODEL = 'nomic-embed-text';
      const model = new OllamaEmbedding().value();
      expect(model).to.not.be.undefined();
      expect((model as {modelId?: string}).modelId).to.equal(
        'nomic-embed-text',
      );
    });
    it('honours OLLAMA_URL when provided', () => {
      process.env.OLLAMA_EMBEDDING_MODEL = 'nomic-embed-text';
      process.env.OLLAMA_URL = 'http://ollama.internal:11434';
      const model = new OllamaEmbedding().value();
      expect(model).to.not.be.undefined();
    });
  });
});
