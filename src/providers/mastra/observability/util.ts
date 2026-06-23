import {Observability, SamplingStrategyType} from '@mastra/observability';
import {SpanType} from '@mastra/core/observability';
import {LangfuseExporter} from '@mastra/langfuse';
import {LangSmithExporter} from '@mastra/langsmith';

/**
 * Parse `OTEL_SAMPLE_RATE` (or any sample-rate env var) into a number
 * in the [0, 1] range. Non-numeric or out-of-range values fall back to
 * the supplied default (defaults to 1.0 — sample everything). Prevents
 * the observability exporter from booting with `NaN` or a negative /
 * >1 probability that would silently break sampling.
 */
export function parseSampleRate(
  raw: string | undefined,
  fallback = 1.0,
): number {
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < 0) return 0;
  if (parsed > 1) return 1;
  return parsed;
}

/**
 * Build the Langfuse exporter when its env keys are present, else
 * `undefined`. Shared by the Langfuse-only and multi-exporter providers.
 */
export function buildLangfuseExporter(): LangfuseExporter | undefined {
  if (!process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY) {
    return undefined;
  }
  return new LangfuseExporter({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    baseUrl: process.env.LANGFUSE_BASE_URL,
    environment: process.env.LANGFUSE_ENVIRONMENT,
    release: process.env.LANGFUSE_RELEASE,
  });
}

/**
 * Build the LangSmith exporter when its env keys are present, else
 * `undefined`. Accepts the LangChain-style env vars too. Shared by the
 * LangSmith-only and multi-exporter providers.
 */
export function buildLangSmithExporter(): LangSmithExporter | undefined {
  if (!process.env.LANGSMITH_API_KEY && !process.env.LANGCHAIN_API_KEY) {
    return undefined;
  }
  return new LangSmithExporter({
    apiKey: process.env.LANGSMITH_API_KEY ?? process.env.LANGCHAIN_API_KEY,
    apiUrl: process.env.LANGSMITH_ENDPOINT ?? process.env.LANGCHAIN_ENDPOINT,
    projectName: process.env.LANGSMITH_PROJECT ?? process.env.LANGCHAIN_PROJECT,
  });
}

/**
 * Wrap one or more exporters in a Mastra `Observability` instance with the
 * shared serviceName + sampling config. Mastra fans a single config's
 * span stream out to every exporter in the array, so this is how the
 * multi-exporter provider ships the same agent/workflow/tool spans to
 * both Langfuse and LangSmith at once.
 */
export function makeObservability(
  exporters: Array<LangfuseExporter | LangSmithExporter>,
): Observability {
  return new Observability({
    configs: {
      default: {
        serviceName: process.env.OTEL_SERVICE_NAME ?? 'lb4-llm-chat',
        exporters,
        sampling: {
          type: SamplingStrategyType.RATIO,
          probability: parseSampleRate(process.env.OTEL_SAMPLE_RATE),
        },
        // Exclude only MODEL_CHUNK — the per-token streaming deltas that flood
        // the exporter (hundreds per request) and carry no actionable debug
        // info; the parent MODEL_GENERATION span already has the full I/O.
        // Do NOT exclude MODEL_STEP: the agent's tool-calling step spans are
        // the PARENT of the tool + nested db-query/visualization workflow
        // subtree. Excluding MODEL_STEP orphans that entire subtree (the
        // exporter drops children whose parent was never exported), which is
        // why traces showed only ~6 spans with no workflow on every turn.
        excludeSpanTypes: [SpanType.MODEL_CHUNK],
      },
    },
  });
}
