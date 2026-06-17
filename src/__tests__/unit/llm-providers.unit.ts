import {expect} from '@loopback/testlab';
import {
  OpenAI,
  createOpenAIModel,
} from '../../sub-modules/providers/openai/llms/openai.provider';
import {Claude} from '../../sub-modules/providers/anthropic/llms/anthropic.provider';
import {
  OpenRouter,
  createOpenRouterModel,
} from '../../sub-modules/providers/openrouter/llms/openrouter.provider';
import {Gemini} from '../../sub-modules/providers/google/llms/gemini.provider';
import {Cerebras} from '../../sub-modules/providers/cerebras/llm/cerebras.provider';
import {Groq} from '../../sub-modules/providers/groq/llms/groq.provider';
import {Ollama} from '../../sub-modules/providers/ollama/llms/ollama.provider';
import {Bedrock} from '../../sub-modules/providers/aws/llms/bedrock.provider';
import {BedrockNonThinking} from '../../sub-modules/providers/aws/llms/bedrock-non-thinking.provider';

/**
 * Unit coverage for the chat/file LLM provider factory classes. Each provider's
 * `value()` (and the `createXModel` factory variants) builds an AI-SDK model
 * object lazily from environment variables — no network call is made by
 * construction. We assert two things per provider:
 *   (a) fail-closed: throws when a required env var is missing, and
 *   (b) wiring: returns a model whose `modelId` matches the configured model.
 * Mirrors the style of `embedding-providers.unit.ts`.
 */
describe('LLM providers (unit)', () => {
  const ALL_ENV = [
    'OPENAI_MODEL',
    'OPENAI_API_KEY',
    'OPENAI_API_BASE_URL',
    'CLAUDE_MODEL',
    'CLAUDE_API_KEY',
    'OPENROUTER_MODEL',
    'OPENROUTER_API_KEY',
    'OPENROUTER_BASE_URL',
    'GOOGLE_CHAT_MODEL',
    'GOOGLE_API_KEY',
    'CEREBRAS_MODEL',
    'CEREBRAS_KEY',
    'GROQ_MODEL',
    'GROQ_API_KEY',
    'OLLAMA_MODEL',
    'OLLAMA_BASE_URL',
    'BEDROCK_MODEL',
    'BEDROCK_AWS_REGION',
    'BEDROCK_AWS_ACCESS_KEY_ID',
    'BEDROCK_AWS_SECRET_ACCESS_KEY',
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

  describe('OpenAI', () => {
    it('throws when OPENAI_MODEL is missing', () => {
      process.env.OPENAI_API_KEY = 'k';
      expect(() => new OpenAI().value()).to.throw(/OPENAI_MODEL/);
    });
    it('throws when OPENAI_API_KEY is missing', () => {
      process.env.OPENAI_MODEL = 'gpt-4o';
      expect(() => new OpenAI().value()).to.throw(/OPENAI_API_KEY/);
    });
    it('returns a model when both env vars are set', () => {
      process.env.OPENAI_MODEL = 'gpt-4o';
      process.env.OPENAI_API_KEY = 'k';
      const model = new OpenAI().value();
      expect(model).to.not.be.undefined();
      expect((model as {modelId?: string}).modelId).to.equal('gpt-4o');
    });
  });

  describe('createOpenAIModel', () => {
    it('throws when no API key is available', () => {
      expect(() => createOpenAIModel('gpt-4o-mini')).to.throw(/OPENAI_API_KEY/);
    });
    it('builds the requested model from OPENAI_API_KEY', () => {
      process.env.OPENAI_API_KEY = 'k';
      const model = createOpenAIModel('gpt-4o-mini');
      expect((model as {modelId?: string}).modelId).to.equal('gpt-4o-mini');
    });
    it('builds the requested model from opts.apiKey (no env)', () => {
      const model = createOpenAIModel('gpt-4o-mini', {apiKey: 'explicit'});
      expect((model as {modelId?: string}).modelId).to.equal('gpt-4o-mini');
    });
  });

  describe('Claude', () => {
    it('throws when CLAUDE_MODEL is missing', () => {
      process.env.CLAUDE_API_KEY = 'k';
      expect(() => new Claude().value()).to.throw(/CLAUDE_MODEL/);
    });
    it('throws when CLAUDE_API_KEY is missing', () => {
      process.env.CLAUDE_MODEL = 'claude-3-5-sonnet-latest';
      expect(() => new Claude().value()).to.throw(/CLAUDE_API_KEY/);
    });
    it('returns a model when both env vars are set', () => {
      process.env.CLAUDE_MODEL = 'claude-3-5-sonnet-latest';
      process.env.CLAUDE_API_KEY = 'k';
      const model = new Claude().value();
      expect(model).to.not.be.undefined();
      expect((model as {modelId?: string}).modelId).to.equal(
        'claude-3-5-sonnet-latest',
      );
    });
  });

  describe('OpenRouter', () => {
    it('throws when OPENROUTER_MODEL is missing', () => {
      process.env.OPENROUTER_API_KEY = 'k';
      expect(() => new OpenRouter().value()).to.throw(/OPENROUTER_MODEL/);
    });
    it('throws when OPENROUTER_API_KEY is missing', () => {
      process.env.OPENROUTER_MODEL = 'openai/gpt-4o-mini';
      expect(() => new OpenRouter().value()).to.throw(/OPENROUTER_API_KEY/);
    });
    it('returns a model when both env vars are set', () => {
      process.env.OPENROUTER_MODEL = 'openai/gpt-4o-mini';
      process.env.OPENROUTER_API_KEY = 'k';
      const model = new OpenRouter().value();
      expect(model).to.not.be.undefined();
      expect((model as {modelId?: string}).modelId).to.equal(
        'openai/gpt-4o-mini',
      );
    });
  });

  describe('createOpenRouterModel', () => {
    it('throws when OPENROUTER_API_KEY is missing', () => {
      expect(() => createOpenRouterModel('openai/gpt-4o-mini')).to.throw(
        /OPENROUTER_API_KEY/,
      );
    });
    it('builds the requested model when OPENROUTER_API_KEY is set', () => {
      process.env.OPENROUTER_API_KEY = 'k';
      const model = createOpenRouterModel('openai/gpt-4o-mini');
      expect((model as {modelId?: string}).modelId).to.equal(
        'openai/gpt-4o-mini',
      );
    });
  });

  describe('Gemini', () => {
    it('throws when GOOGLE_CHAT_MODEL is missing', () => {
      process.env.GOOGLE_API_KEY = 'k';
      expect(() => new Gemini().value()).to.throw(/GOOGLE_CHAT_MODEL/);
    });
    it('throws when GOOGLE_API_KEY is missing', () => {
      process.env.GOOGLE_CHAT_MODEL = 'gemini-1.5-pro';
      expect(() => new Gemini().value()).to.throw(/GOOGLE_API_KEY/);
    });
    it('returns a model when both env vars are set', () => {
      process.env.GOOGLE_CHAT_MODEL = 'gemini-1.5-pro';
      process.env.GOOGLE_API_KEY = 'k';
      const model = new Gemini().value();
      expect(model).to.not.be.undefined();
      expect((model as {modelId?: string}).modelId).to.equal('gemini-1.5-pro');
    });
  });

  describe('Cerebras', () => {
    it('throws when CEREBRAS_MODEL is missing', () => {
      process.env.CEREBRAS_KEY = 'k';
      expect(() => new Cerebras().value()).to.throw(/CEREBRAS_MODEL/);
    });
    it('throws when CEREBRAS_KEY is missing', () => {
      process.env.CEREBRAS_MODEL = 'llama3.1-8b';
      expect(() => new Cerebras().value()).to.throw(/CEREBRAS_KEY/);
    });
    it('returns a model when both env vars are set', () => {
      process.env.CEREBRAS_MODEL = 'llama3.1-8b';
      process.env.CEREBRAS_KEY = 'k';
      const model = new Cerebras().value();
      expect(model).to.not.be.undefined();
      expect((model as {modelId?: string}).modelId).to.equal('llama3.1-8b');
    });
  });

  describe('Groq', () => {
    it('throws when GROQ_MODEL is missing', () => {
      process.env.GROQ_API_KEY = 'k';
      expect(() => new Groq().value()).to.throw(/GROQ_MODEL/);
    });
    it('throws when GROQ_API_KEY is missing', () => {
      process.env.GROQ_MODEL = 'llama-3.1-8b-instant';
      expect(() => new Groq().value()).to.throw(/GROQ_API_KEY/);
    });
    it('returns a model when both env vars are set', () => {
      process.env.GROQ_MODEL = 'llama-3.1-8b-instant';
      process.env.GROQ_API_KEY = 'k';
      const model = new Groq().value();
      expect(model).to.not.be.undefined();
      expect((model as {modelId?: string}).modelId).to.equal(
        'llama-3.1-8b-instant',
      );
    });
  });

  describe('Ollama', () => {
    it('throws when OLLAMA_MODEL is missing', () => {
      process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
      expect(() => new Ollama().value()).to.throw(/OLLAMA_MODEL/);
    });
    it('throws when OLLAMA_BASE_URL is missing', () => {
      process.env.OLLAMA_MODEL = 'llama3.1';
      expect(() => new Ollama().value()).to.throw(/OLLAMA_BASE_URL/);
    });
    it('returns a model when both env vars are set', () => {
      process.env.OLLAMA_MODEL = 'llama3.1';
      process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
      const model = new Ollama().value();
      expect(model).to.not.be.undefined();
      expect((model as {modelId?: string}).modelId).to.equal('llama3.1');
    });
  });

  describe('Bedrock', () => {
    it('throws when BEDROCK_MODEL is missing', () => {
      expect(() => new Bedrock().value()).to.throw(/BEDROCK_MODEL/);
    });
    it('returns a model when BEDROCK_MODEL is set', () => {
      process.env.BEDROCK_MODEL = 'anthropic.claude-3-5-sonnet-20241022-v2:0';
      process.env.BEDROCK_AWS_REGION = 'us-east-1';
      process.env.BEDROCK_AWS_ACCESS_KEY_ID = 'id';
      process.env.BEDROCK_AWS_SECRET_ACCESS_KEY = 'secret';
      const model = new Bedrock().value();
      expect(model).to.not.be.undefined();
      expect((model as {modelId?: string}).modelId).to.equal(
        'anthropic.claude-3-5-sonnet-20241022-v2:0',
      );
    });
  });

  describe('BedrockNonThinking', () => {
    it('throws when BEDROCK_MODEL is missing', () => {
      expect(() => new BedrockNonThinking().value()).to.throw(/BEDROCK_MODEL/);
    });
    it('returns a model when BEDROCK_MODEL is set', () => {
      process.env.BEDROCK_MODEL = 'anthropic.claude-3-5-sonnet-20241022-v2:0';
      process.env.BEDROCK_AWS_REGION = 'us-east-1';
      process.env.BEDROCK_AWS_ACCESS_KEY_ID = 'id';
      process.env.BEDROCK_AWS_SECRET_ACCESS_KEY = 'secret';
      const model = new BedrockNonThinking().value();
      expect(model).to.not.be.undefined();
      expect((model as {modelId?: string}).modelId).to.equal(
        'anthropic.claude-3-5-sonnet-20241022-v2:0',
      );
    });
  });
});
