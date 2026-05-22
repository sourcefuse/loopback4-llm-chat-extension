import {BindingScope, injectable, Provider} from '@loopback/core';
import {Observability, SamplingStrategyType} from '@mastra/observability';
import {LangfuseExporter} from '@mastra/langfuse';
import {parseSampleRate} from './util';

/**
 * Mastra Observability wired with the Langfuse exporter. Consumer binds
 * this against `AiIntegrationBindings.MastraObservability` to ship every
 * agent / workflow / tool span to Langfuse Cloud (or a self-hosted
 * deployment) for trace inspection, prompt evals and scoring.
 *
 * Required env: LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY.
 * Optional env: LANGFUSE_BASE_URL (defaults to Langfuse Cloud).
 *
 * Refs: the migration plan.
 */
@injectable({scope: BindingScope.SINGLETON})
export class MastraLangfuseObservability implements Provider<Observability> {
  value(): Observability {
    if (!process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY) {
      throw new Error(
        'LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY env vars required for MastraLangfuseObservability',
      );
    }
    return new Observability({
      configs: {
        default: {
          serviceName: process.env.OTEL_SERVICE_NAME ?? 'lb4-llm-chat',
          exporters: [
            new LangfuseExporter({
              publicKey: process.env.LANGFUSE_PUBLIC_KEY,
              secretKey: process.env.LANGFUSE_SECRET_KEY,
              baseUrl: process.env.LANGFUSE_BASE_URL,
              environment: process.env.LANGFUSE_ENVIRONMENT,
              release: process.env.LANGFUSE_RELEASE,
            }),
          ],
          sampling: {
            type: SamplingStrategyType.RATIO,
            probability: parseSampleRate(process.env.OTEL_SAMPLE_RATE),
          },
        },
      },
    });
  }
}
