import {expect} from '@loopback/testlab';
import {LangfuseExporter} from '@mastra/langfuse';
import {LangSmithExporter} from '@mastra/langsmith';
import {Observability} from '@mastra/observability';
import {LangfuseObservability} from '../../providers/mastra/observability/langfuse.provider';
import {LangSmithObservability} from '../../providers/mastra/observability/langsmith.provider';
import {MultiObservability} from '../../providers/mastra/observability/multi.provider';
import {
  buildLangSmithExporter,
  buildLangfuseExporter,
  makeObservability,
  parseSampleRate,
} from '../../providers/mastra/observability/util';

const LANGFUSE_KEYS = [
  'LANGFUSE_PUBLIC_KEY',
  'LANGFUSE_SECRET_KEY',
  'LANGFUSE_BASE_URL',
  'LANGFUSE_ENVIRONMENT',
  'LANGFUSE_RELEASE',
] as const;
const LANGSMITH_KEYS = [
  'LANGSMITH_API_KEY',
  'LANGCHAIN_API_KEY',
  'LANGSMITH_ENDPOINT',
  'LANGCHAIN_ENDPOINT',
  'LANGSMITH_PROJECT',
  'LANGCHAIN_PROJECT',
] as const;
const OTEL_KEYS = ['OTEL_SAMPLE_RATE', 'OTEL_SERVICE_NAME'] as const;
const ALL_KEYS = [...LANGFUSE_KEYS, ...LANGSMITH_KEYS, ...OTEL_KEYS] as const;

/**
 * Observability is the single place trace data leaves the process. A
 * regression here either silently drops every Langfuse/LangSmith span
 * (debugging goes dark in prod) OR boots an exporter with garbage
 * sampling probability (e.g. NaN → exporter never fires). The util layer
 * + three provider classes are the only public seam — pin both.
 */
describe('providers/mastra/observability (unit)', () => {
  let snapshot: Record<string, string | undefined>;

  beforeEach(() => {
    snapshot = {};
    for (const key of ALL_KEYS) {
      snapshot[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ALL_KEYS) {
      if (snapshot[key] === undefined) delete process.env[key];
      else process.env[key] = snapshot[key];
    }
  });

  describe('parseSampleRate', () => {
    it('returns the fallback when the env value is undefined or empty', () => {
      expect(parseSampleRate(undefined)).to.equal(1.0);
      expect(parseSampleRate('')).to.equal(1.0);
      expect(parseSampleRate(undefined, 0.25)).to.equal(0.25);
    });

    it('returns the fallback for non-numeric input (would otherwise yield NaN and silently disable sampling)', () => {
      expect(parseSampleRate('not-a-number')).to.equal(1.0);
    });

    it('clamps negative and > 1 inputs into the [0, 1] range', () => {
      // OpenTelemetry SDK probability MUST be in [0, 1]; without
      // clamping a typo'd OTEL_SAMPLE_RATE=2 would silently disable
      // exporting entirely.
      expect(parseSampleRate('-0.5')).to.equal(0);
      expect(parseSampleRate('1.5')).to.equal(1);
    });

    it('returns valid in-range values verbatim', () => {
      expect(parseSampleRate('0')).to.equal(0);
      expect(parseSampleRate('0.1')).to.equal(0.1);
      expect(parseSampleRate('1')).to.equal(1);
    });
  });

  describe('buildLangfuseExporter', () => {
    it('returns undefined when either Langfuse env key is missing', () => {
      // No silent fallback — multi.provider depends on `undefined`
      // signalling "skip me" instead of constructing a broken exporter.
      expect(buildLangfuseExporter()).to.be.undefined();
      process.env.LANGFUSE_PUBLIC_KEY = 'pk';
      expect(buildLangfuseExporter()).to.be.undefined();
    });

    it('builds a LangfuseExporter when both required env vars are present', () => {
      process.env.LANGFUSE_PUBLIC_KEY = 'pk';
      process.env.LANGFUSE_SECRET_KEY = 'sk';
      const exporter = buildLangfuseExporter();
      expect(exporter).to.be.instanceOf(LangfuseExporter);
    });
  });

  describe('buildLangSmithExporter', () => {
    it('returns undefined when neither LANGSMITH_API_KEY nor LANGCHAIN_API_KEY is set', () => {
      expect(buildLangSmithExporter()).to.be.undefined();
    });

    it('accepts the LangChain-style env vars as fallback (single-key required)', () => {
      // Existing host apps already configure LANGCHAIN_API_KEY for the
      // legacy SDK — the LangSmith exporter must inherit that key so
      // consumers do not have to set two.
      process.env.LANGCHAIN_API_KEY = 'lk';
      const exporter = buildLangSmithExporter();
      expect(exporter).to.be.instanceOf(LangSmithExporter);
    });

    it('prefers LANGSMITH_API_KEY when both are set', () => {
      process.env.LANGSMITH_API_KEY = 'ls';
      process.env.LANGCHAIN_API_KEY = 'lk';
      expect(buildLangSmithExporter()).to.be.instanceOf(LangSmithExporter);
    });
  });

  describe('makeObservability', () => {
    it('wraps the supplied exporters in a single Mastra Observability instance', () => {
      // Mastra fans one config's span stream out to every exporter —
      // a list of two means both Langfuse + LangSmith get the same
      // span stream, not two separate observability rigs.
      process.env.LANGFUSE_PUBLIC_KEY = 'pk';
      process.env.LANGFUSE_SECRET_KEY = 'sk';
      process.env.LANGSMITH_API_KEY = 'ls';
      const exporters = [
        buildLangfuseExporter(),
        buildLangSmithExporter(),
      ].filter(
        (e): e is LangfuseExporter | LangSmithExporter => e !== undefined,
      );

      const obs = makeObservability(exporters);

      expect(obs).to.be.instanceOf(Observability);
    });
  });

  describe('LangfuseObservability provider', () => {
    it('fails closed when Langfuse env vars are absent', () => {
      // Default OFF — booting a Langfuse-only build without keys must
      // raise immediately so the consumer notices, not silently swallow
      // spans.
      const provider = new LangfuseObservability();
      expect(() => provider.value()).to.throw(/LANGFUSE_PUBLIC_KEY/);
    });

    it('returns an Observability instance when Langfuse env vars are present', () => {
      process.env.LANGFUSE_PUBLIC_KEY = 'pk';
      process.env.LANGFUSE_SECRET_KEY = 'sk';
      const provider = new LangfuseObservability();
      expect(provider.value()).to.be.instanceOf(Observability);
    });
  });

  describe('LangSmithObservability provider', () => {
    it('fails closed when no LangSmith / LangChain API key is configured', () => {
      const provider = new LangSmithObservability();
      expect(() => provider.value()).to.throw(/LANGSMITH_API_KEY/);
    });

    it('returns an Observability instance when LANGCHAIN_API_KEY (legacy) is set', () => {
      process.env.LANGCHAIN_API_KEY = 'lk';
      const provider = new LangSmithObservability();
      expect(provider.value()).to.be.instanceOf(Observability);
    });
  });

  describe('MultiObservability provider', () => {
    it('fails closed when neither Langfuse nor LangSmith env vars are present', () => {
      // The whole purpose of the multi-exporter provider is fan-out —
      // booting it with zero exporters configured would silently
      // observe nothing.
      const provider = new MultiObservability();
      expect(() => provider.value()).to.throw(/MultiObservability/);
    });

    it('returns Observability when at least one exporter is configured (Langfuse-only)', () => {
      process.env.LANGFUSE_PUBLIC_KEY = 'pk';
      process.env.LANGFUSE_SECRET_KEY = 'sk';
      const provider = new MultiObservability();
      expect(provider.value()).to.be.instanceOf(Observability);
    });

    it('returns Observability when at least one exporter is configured (LangSmith-only)', () => {
      process.env.LANGSMITH_API_KEY = 'ls';
      const provider = new MultiObservability();
      expect(provider.value()).to.be.instanceOf(Observability);
    });

    it('returns Observability when BOTH exporters are configured (the actual fan-out case)', () => {
      process.env.LANGFUSE_PUBLIC_KEY = 'pk';
      process.env.LANGFUSE_SECRET_KEY = 'sk';
      process.env.LANGSMITH_API_KEY = 'ls';
      const provider = new MultiObservability();
      expect(provider.value()).to.be.instanceOf(Observability);
    });
  });
});
