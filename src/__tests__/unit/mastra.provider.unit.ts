import {expect} from '@loopback/testlab';
import {Mastra} from '@mastra/core';
import type {MastraCompositeStore} from '@mastra/core/storage';
import type {MastraEmbeddingModel, MastraVector} from '@mastra/core/vector';
import {MastraProvider} from '../../providers/mastra/mastra.provider';
import {DEFAULT_MAX_TOKEN_COUNT} from '../../constant';
import type {AIIntegrationConfig} from '../../types';

/**
 * Singleton Mastra runtime provider. This is the heart of the Mastra
 * integration: it constructs the Mastra instance the WorkflowRunner
 * streams through and registers the three workflows the tool wrappers
 * dispatch to (generateQuery / improveQuery / visualization).
 *
 * The contract under test:
 *   - Fail-closed when no chat model env var is set (no silent OpenAI
 *     billing if OPENAI_API_KEY happens to be present).
 *   - Registers the canonical chat agent + the three workflows.
 *   - Memory env wiring (generateTitle, semanticRecall) is opt-in,
 *     guarded behind explicit env vars + required dependencies.
 *
 * Memory + Agent are constructed against a duck-typed storage stub —
 * the real LibSQLStore path is exercised by storage.provider.unit.ts.
 */
describe('Mastra runtime Provider (unit)', () => {
  const ENV_KEYS = [
    'MASTRA_DEFAULT_CHAT_MODEL',
    'MASTRA_GENERATE_TITLE',
    'MASTRA_TITLE_MODEL',
    'MASTRA_SEMANTIC_RECALL',
    'MASTRA_SEMANTIC_RECALL_TOPK',
    'MASTRA_SEMANTIC_RECALL_RANGE',
  ] as const;
  let snapshot: Record<string, string | undefined>;

  beforeEach(() => {
    snapshot = {};
    for (const k of ENV_KEYS) {
      snapshot[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (snapshot[k] === undefined) delete process.env[k];
      else process.env[k] = snapshot[k];
    }
  });

  // The Provider only touches `storage` by passing it through to Memory
  // and Mastra. The Mastra constructor calls `storage.__setLogger(...)`,
  // so the duck-typed stub must provide it; nothing else is reached at
  // construction time.
  function makeStorage(): MastraCompositeStore {
    const storage = {} as Record<string, unknown>;
    storage['__setLogger'] = () => undefined;
    return storage as unknown as MastraCompositeStore;
  }

  // Minimal vector + embedder stubs for the semantic-recall path. They
  // never get called during construction; vector additionally receives
  // `__setLogger` from Mastra.addVector.
  function makeVector(): MastraVector {
    const vector = {} as Record<string, unknown>;
    vector['__setLogger'] = () => undefined;
    return vector as unknown as MastraVector;
  }
  function makeEmbedder(): MastraEmbeddingModel<string> {
    return {} as unknown as MastraEmbeddingModel<string>;
  }

  it('fails closed when MASTRA_DEFAULT_CHAT_MODEL is unset (refuses silent OpenAI fallback)', async () => {
    // The error message includes the env var name so consumers can
    // find the cause without grepping. Pin both halves.
    const provider = new MastraProvider(makeStorage());
    await expect(provider.value()).to.be.rejectedWith(
      /MASTRA_DEFAULT_CHAT_MODEL/,
    );
  });

  it('returns a Mastra instance with the db-query graph (+ sub-graphs) and ChatAgent registered (baseline contract)', async () => {
    process.env.MASTRA_DEFAULT_CHAT_MODEL = 'openai/gpt-4o-mini';
    const provider = new MastraProvider(makeStorage());
    const mastra = await provider.value();

    expect(mastra).to.be.instanceOf(Mastra);
    // The tool wrappers look up workflows by these EXACT ids — a typo
    // would silently break tools at runtime with "workflow not found".
    // `dbQueryGraph` is the single entry both db-query tools call; it
    // dispatches to the generate/improve sub-graphs (also registered so the
    // entry node can resolve them by id at run time).
    expect(mastra.getWorkflow('dbQueryGraph')).to.not.be.undefined();
    expect(mastra.getWorkflow('generateQueryGraph')).to.not.be.undefined();
    expect(mastra.getWorkflow('improveQueryGraph')).to.not.be.undefined();
    expect(mastra.getWorkflow('visualizationGraph')).to.not.be.undefined();
    // WorkflowRunner streams `mastra.getAgent('chatAgent')` — the key
    // is the Agent's `name`, NOT its `id`.
    expect(mastra.getAgent('chatAgent')).to.not.be.undefined();
  });

  it('boots cleanly when generateTitle is enabled without a title model (uses agent default model)', async () => {
    // Sanity check that the env-driven generateTitle option negotiates
    // both shapes (`true` and `{model}`) without throwing during Memory
    // construction. The actual title call happens at runtime and is out
    // of scope here.
    process.env.MASTRA_DEFAULT_CHAT_MODEL = 'openai/gpt-4o-mini';
    process.env.MASTRA_GENERATE_TITLE = 'true';
    const mastra = await new MastraProvider(makeStorage()).value();
    expect(mastra).to.be.instanceOf(Mastra);
  });

  it('boots cleanly when generateTitle is enabled with an explicit title model (cost-optimised path)', async () => {
    process.env.MASTRA_DEFAULT_CHAT_MODEL = 'openai/gpt-4o';
    process.env.MASTRA_GENERATE_TITLE = 'true';
    process.env.MASTRA_TITLE_MODEL = 'openai/gpt-4o-mini';
    const mastra = await new MastraProvider(makeStorage()).value();
    expect(mastra).to.be.instanceOf(Mastra);
  });

  it('boots cleanly with semanticRecall=true when both vector + embedder are bound (opt-in path)', async () => {
    process.env.MASTRA_DEFAULT_CHAT_MODEL = 'openai/gpt-4o';
    process.env.MASTRA_SEMANTIC_RECALL = 'true';
    process.env.MASTRA_SEMANTIC_RECALL_TOPK = '8';
    process.env.MASTRA_SEMANTIC_RECALL_RANGE = '4';
    const provider = new MastraProvider(
      makeStorage(),
      makeVector(),
      makeEmbedder(),
    );
    const mastra = await provider.value();
    expect(mastra).to.be.instanceOf(Mastra);
  });

  it('boots cleanly with semanticRecall=true but no vector binding (silently disables — guards against the "vector is for cache only" trap)', async () => {
    // Key defensive path: a consumer wires a vector store for the
    // db-query cache and toggles MASTRA_SEMANTIC_RECALL=true. The
    // provider must NOT throw — Memory just gets `semanticRecall:false`.
    process.env.MASTRA_DEFAULT_CHAT_MODEL = 'openai/gpt-4o';
    process.env.MASTRA_SEMANTIC_RECALL = 'true';
    const mastra = await new MastraProvider(makeStorage()).value();
    expect(mastra).to.be.instanceOf(Mastra);
  });

  // Token-budget precedence: config.maxTokenCount → MAX_TOKEN_COUNT env →
  // default. Regression guard — the provider previously read env ONLY, so a
  // host tuning AIIntegrationConfig.maxTokenCount (the LB4-idiomatic path the
  // config type + docstrings advertise) had its value silently dropped.
  //
  // `resolveTokenBudget` is a PROTECTED method (not a module function) so a host
  // can override the policy in a MastraProvider subclass, mirroring how v3 hosts
  // overrode the ContextCompressionNode class. This subclass exposes it exactly
  // the way such a host would reach it.
  describe('resolveTokenBudget (chat token-budget precedence)', () => {
    class ProbeProvider extends MastraProvider {
      budget(config?: AIIntegrationConfig, env?: NodeJS.ProcessEnv): number {
        return this.resolveTokenBudget(config, env);
      }
    }
    const probe = () => new ProbeProvider(makeStorage());

    it('honours config.maxTokenCount over the env var', () => {
      expect(
        probe().budget({maxTokenCount: 4242}, {MAX_TOKEN_COUNT: '9999'}),
      ).to.equal(4242);
    });

    it('falls back to MAX_TOKEN_COUNT env when config has no maxTokenCount', () => {
      expect(probe().budget({}, {MAX_TOKEN_COUNT: '9999'})).to.equal(9999);
      expect(probe().budget(undefined, {MAX_TOKEN_COUNT: '9999'})).to.equal(
        9999,
      );
    });

    it('falls back to the default when neither config nor env is set', () => {
      expect(probe().budget(undefined, {})).to.equal(DEFAULT_MAX_TOKEN_COUNT);
      expect(probe().budget({}, {})).to.equal(DEFAULT_MAX_TOKEN_COUNT);
    });

    it('is overridable by a subclass (the host-facing seam)', () => {
      class FixedBudgetProvider extends MastraProvider {
        protected resolveTokenBudget(): number {
          return 123;
        }
        expose(): number {
          return this.resolveTokenBudget();
        }
      }
      expect(new FixedBudgetProvider(makeStorage()).expose()).to.equal(123);
    });
  });
});
