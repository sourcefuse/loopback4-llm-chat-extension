import {BindingScope, inject, injectable, service} from '@loopback/core';
import {ChatGraph} from '../graphs/chat/chat.graph';
import {AiIntegrationBindings} from '../keys';
import {ITransport} from '../transports/types';

@injectable({scope: BindingScope.REQUEST})
export class GenerationService {
  constructor(
    @service(ChatGraph)
    private readonly chatGraph: ChatGraph,
    @inject(AiIntegrationBindings.Transport)
    private readonly transport: ITransport,
  ) {}
  async generate(prompt: string, files: Express.Multer.File[], id?: string) {
    const abortController = new AbortController();
    await this.transport.start();
    this.transport.onCancel(() => {
      abortController.abort();
    });
    const stream = await this.chatGraph.execute(
      prompt,
      files,
      abortController.signal,
      id,
    );

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
}
