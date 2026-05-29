import {BindingScope, injectable, Provider} from '@loopback/core';
import {Observability} from '@mastra/observability';
import {
  buildLangfuseExporter,
  buildLangSmithExporter,
  makeObservability,
} from './util';

/**
 * Mastra Observability wired with EVERY exporter whose env keys are
 * present — Langfuse (LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY) and/or
 * LangSmith (LANGSMITH_API_KEY / LANGCHAIN_API_KEY). Consumer binds this
 * against `AiIntegrationBindings.MastraObservability` to ship the same
 * agent / workflow / tool spans to multiple backends at once.
 *
 * Mastra fans a single config's span stream out to all exporters in the
 * array, so this avoids the "one observability key = one backend" limit
 * of the single-exporter providers. Bind THIS instead of
 * MastraLangfuseObservability / MastraLangSmithObservability when you
 * want traces in more than one tool.
 */
@injectable({scope: BindingScope.SINGLETON})
export class MastraMultiObservability implements Provider<Observability> {
  value(): Observability {
    const exporters = [
      buildLangfuseExporter(),
      buildLangSmithExporter(),
    ].filter((e): e is NonNullable<typeof e> => e !== undefined);
    if (exporters.length === 0) {
      throw new Error(
        'MastraMultiObservability requires at least one exporter — set ' +
          'LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY and/or LANGSMITH_API_KEY ' +
          '(or LANGCHAIN_API_KEY).',
      );
    }
    return makeObservability(exporters);
  }
}
