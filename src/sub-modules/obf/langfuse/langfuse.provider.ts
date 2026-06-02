import {Provider} from '@loopback/core';
import {Observability} from '@mastra/observability';
import {
  buildLangfuseExporter,
  makeObservability,
} from '../../../providers/mastra/observability/util';

export class LangfuseObfProvider implements Provider<Observability> {
  value(): Observability {
    const exporter = buildLangfuseExporter();
    if (!exporter) {
      throw new Error(
        'LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY env vars required for LangfuseObfProvider',
      );
    }
    return makeObservability([exporter]);
  }
}
