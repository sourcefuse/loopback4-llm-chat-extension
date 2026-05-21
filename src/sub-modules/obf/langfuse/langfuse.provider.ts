import {Provider, ValueOrPromise} from '@loopback/core';
import {LangfuseSpanProcessor} from '@langfuse/otel';
import {NodeTracerProvider} from '@opentelemetry/sdk-trace-node';

type LangfuseTelemetryHandle = {
  forceFlush: () => Promise<void>;
};

let tracerProvider: NodeTracerProvider | undefined;

function ensureLangfuseTracerProvider(): NodeTracerProvider {
  if (!tracerProvider) {
    tracerProvider = new NodeTracerProvider({
      spanProcessors: [
        new LangfuseSpanProcessor({
          publicKey: process.env.LANGFUSE_PUBLIC_KEY,
          secretKey: process.env.LANGFUSE_SECRET_KEY,
          baseUrl: process.env.LANGFUSE_BASE_URL,
          environment: process.env.LANGFUSE_TRACING_ENVIRONMENT,
          release: process.env.LANGFUSE_RELEASE,
        }),
      ],
    });
    tracerProvider.register();
  }

  return tracerProvider;
}

export class LangfuseObfProvider implements Provider<LangfuseTelemetryHandle> {
  value(): ValueOrPromise<LangfuseTelemetryHandle> {
    const provider = ensureLangfuseTracerProvider();

    return {
      forceFlush: async () => {
        await provider.forceFlush();
      },
    };
  }
}
