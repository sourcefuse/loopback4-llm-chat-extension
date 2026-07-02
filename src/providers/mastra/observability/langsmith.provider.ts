import {BindingScope, injectable, Provider} from '@loopback/core';
import {Observability} from '@mastra/observability';
import {buildLangSmithExporter, makeObservability} from './util';

/**
 * Mastra Observability wired with the LangSmith exporter. Consumer binds
 * this against `AiIntegrationBindings.Observability` to ship every
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
export class LangSmithObservability implements Provider<Observability> {
  value(): Observability {
    const exporter = buildLangSmithExporter();
    if (!exporter) {
      throw new Error(
        'LANGSMITH_API_KEY (or LANGCHAIN_API_KEY) env var required for LangSmithObservability',
      );
    }
    return makeObservability([exporter]);
  }
}
