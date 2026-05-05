import {BindingScope, inject, injectable, service} from '@loopback/core';
import {MastraChatAgent} from '../mastra';
import {AiIntegrationBindings} from '../keys';
import {ITransport} from '../transports/types';
import {AIIntegrationConfig} from '../types';
import {ILimitStrategy} from './limit-strategies/types';

@injectable({scope: BindingScope.REQUEST})
export class GenerationService {
  constructor(
    @service(MastraChatAgent)
    private readonly mastraChatAgent: MastraChatAgent,
    @inject(AiIntegrationBindings.Transport)
    private readonly transport: ITransport,
    @inject(AiIntegrationBindings.Config, {optional: true})
    private readonly aiConfig: AIIntegrationConfig | undefined,
    @inject(AiIntegrationBindings.LimitStrategy, {optional: true})
    private readonly limiter?: ILimitStrategy,
  ) {}

  async generate(prompt: string, files: Express.Multer.File[], id?: string) {
    await this.limiter?.check();
    const abortController = new AbortController();
    await this.transport.start();
    this.transport.onCancel(() => {
      abortController.abort();
    });

    await this._runMastraFlow(prompt, files, abortController.signal, id);
  }

  private async _runMastraFlow(
    prompt: string,
    files: Express.Multer.File[],
    abort: AbortSignal,
    id?: string,
  ) {
    // Write tool-internal ToolStatus events directly to the transport as they
    // are emitted during tool execution, so the frontend receives them in real
    // time instead of all at once after the tool finishes.
    const directWriter = (event: Parameters<typeof this.transport.send>[0]) => {
      // Fire-and-forget: SSETransport.send() calls response.write() which is
      // synchronous; the Promise wrapper completes immediately.
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      this.transport.send(event);
    };

    try {
      for await (const chunk of this.mastraChatAgent.execute(
        prompt,
        files,
        abort,
        id,
        directWriter,
      )) {
        await this.transport.send(chunk);
      }
      await this.transport.end();
    } catch (error) {
      await this.transport.end(error);
      throw error;
    }
  }
}
