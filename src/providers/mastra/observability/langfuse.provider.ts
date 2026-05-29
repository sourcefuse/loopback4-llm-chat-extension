import {BindingScope, injectable, Provider} from '@loopback/core';
import {Observability} from '@mastra/observability';
import {buildLangfuseExporter, makeObservability} from './util';

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
    const exporter = buildLangfuseExporter();
    if (!exporter) {
      throw new Error(
        'LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY env vars required for MastraLangfuseObservability',
      );
    }
    return makeObservability([exporter]);
  }
}
