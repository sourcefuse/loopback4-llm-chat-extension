import {
  Application,
  BindingScope,
  Component,
  CoreBindings,
  inject,
  injectable,
  Provider,
} from '@loopback/core';
import {Observability} from '@mastra/observability';
import {InternalBindings} from '../../../runtime/internal-bindings';
import {
  buildLangfuseExporter,
  buildLangSmithExporter,
  makeObservability,
} from './util';

/**
 * Mastra Observability wired with EVERY exporter whose env keys are
 * present — Langfuse (LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY) and/or
 * LangSmith (LANGSMITH_API_KEY / LANGCHAIN_API_KEY). Consumer binds this
 * against `InternalBindings.Observability` to ship the same
 * agent / workflow / tool spans to multiple backends at once.
 *
 * Mastra fans a single config's span stream out to all exporters in the
 * array, so this avoids the "one observability key = one backend" limit
 * of the single-exporter providers. Bind THIS instead of
 * LangfuseObservability / LangSmithObservability when you
 * want traces in more than one tool.
 */
@injectable({scope: BindingScope.SINGLETON})
export class MultiObservability implements Provider<Observability> {
  value(): Observability {
    const exporters = [
      buildLangfuseExporter(),
      buildLangSmithExporter(),
    ].filter((e): e is NonNullable<typeof e> => e !== undefined);
    if (exporters.length === 0) {
      throw new Error(
        'MultiObservability requires at least one exporter — set ' +
          'LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY and/or LANGSMITH_API_KEY ' +
          '(or LANGCHAIN_API_KEY).',
      );
    }
    return makeObservability(exporters);
  }
}

/**
 * Opt-in multi-backend Mastra observability.
 *
 * Registering this component points `InternalBindings.Observability` at
 * {@link MultiObservability}, so the consumer never has to import the internal
 * binding key to enable tracing — the same way any other feature component is
 * mounted:
 *
 * ```ts
 * import {MultiObservabilityComponent} from 'lb4-llm-chat-component/mastra-observability';
 * this.component(MultiObservabilityComponent);
 * ```
 *
 * Exporters are auto-selected from whichever env keys are present (Langfuse
 * and/or LangSmith); {@link MultiObservability.value} throws if none are set.
 * The provider is still exported for consumers that wire the binding manually.
 */
export class MultiObservabilityComponent implements Component {
  constructor(
    @inject(CoreBindings.APPLICATION_INSTANCE)
    private readonly application: Application,
  ) {
    this.application
      .bind(InternalBindings.Observability)
      .toProvider(MultiObservability);
  }
}
