import {BindingScope, injectable, Provider} from '@loopback/core';
import {Observability, SamplingStrategyType} from '@mastra/observability';
import {LangSmithExporter} from '@mastra/langsmith';
import {parseSampleRate} from './util';

/**
 * Mastra Observability wired with the LangSmith exporter. Consumer binds
 * this against `AiIntegrationBindings.MastraObservability` to ship every
 * agent / workflow / tool span to LangSmith for trace inspection and
 * dataset capture.
 *
 * Required env: LANGSMITH_API_KEY.
 * Optional env: LANGSMITH_PROJECT (defaults to "default"),
 *               LANGSMITH_ENDPOINT (defaults to https://api.smith.langchain.com).
 *
 * LangSmith's client also reads `LANGCHAIN_API_KEY` / `LANGCHAIN_PROJECT`
 * variables for compatibility; both env styles work.
 */
@injectable({scope: BindingScope.SINGLETON})
export class MastraLangSmithObservability implements Provider<Observability> {
  value(): Observability {
    if (!process.env.LANGSMITH_API_KEY && !process.env.LANGCHAIN_API_KEY) {
      throw new Error(
        'LANGSMITH_API_KEY (or LANGCHAIN_API_KEY) env var required for MastraLangSmithObservability',
      );
    }
    return new Observability({
      configs: {
        default: {
          serviceName: process.env.OTEL_SERVICE_NAME ?? 'lb4-llm-chat',
          exporters: [
            new LangSmithExporter({
              apiKey:
                process.env.LANGSMITH_API_KEY ?? process.env.LANGCHAIN_API_KEY,
              apiUrl:
                process.env.LANGSMITH_ENDPOINT ??
                process.env.LANGCHAIN_ENDPOINT,
              projectName:
                process.env.LANGSMITH_PROJECT ?? process.env.LANGCHAIN_PROJECT,
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
