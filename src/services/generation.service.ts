import {BindingScope, inject, injectable, service} from '@loopback/core';
import {MastraChatAgent} from '../mastra';
import {ChatGraph} from '../graphs/chat/chat.graph';
import {AiIntegrationBindings} from '../keys';
import {ITransport} from '../transports/types';
import {AIIntegrationConfig} from '../types';
import {ILimitStrategy} from './limit-strategies/types';

@injectable({scope: BindingScope.REQUEST})
export class GenerationService {
  constructor(
    @service(ChatGraph)
    private readonly chatGraph: ChatGraph,
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

    if (this.aiConfig?.runtime === 'mastra') {
      await this._runMastraFlow(prompt, files, abortController.signal, id);
    } else {
      await this._runLangGraphFlow(prompt, files, abortController.signal, id);
    }
  }

  private async _runLangGraphFlow(
    prompt: string,
    files: Express.Multer.File[],
    abort: AbortSignal,
    id?: string,
  ) {
    const stream = await this.chatGraph.execute(prompt, files, abort, id);
    try {
      for await (const chunk of stream) {
        await this.transport.send(chunk);
      }
      await this.transport.end();
    } catch (error) {
      await this.transport.end(error);
      throw error;
    }
  }

  private async _runMastraFlow(
    prompt: string,
    files: Express.Multer.File[],
    abort: AbortSignal,
    id?: string,
  ) {
    try {
      for await (const chunk of this.mastraChatAgent.execute(
        prompt,
        files,
        abort,
        id,
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
