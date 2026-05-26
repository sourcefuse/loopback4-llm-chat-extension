import {BindingScope, inject, injectable, service} from '@loopback/core';
import {WorkflowRunner} from '../mastra/bridge/workflow-runner';
import {AiIntegrationBindings} from '../keys';
import {ITransport} from '../transports/types';
import {ILimitStrategy} from './limit-strategies/types';

@injectable({scope: BindingScope.REQUEST})
export class GenerationService {
  constructor(
    @service(WorkflowRunner)
    private readonly workflowRunner: WorkflowRunner,
    @inject(AiIntegrationBindings.Transport)
    private readonly transport: ITransport,
    @inject(AiIntegrationBindings.LimitStrategy, {optional: true})
    private readonly limiter?: ILimitStrategy,
  ) {}
  async generate(
    prompt: string,
    files: Express.Multer.File[] | Express.Multer.File | undefined,
    id?: string,
  ) {
    await this.limiter?.check();
    const abortController = new AbortController();
    await this.transport.start();
    this.transport.onCancel(() => {
      abortController.abort();
    });
    const stream = this.workflowRunner.run(
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
