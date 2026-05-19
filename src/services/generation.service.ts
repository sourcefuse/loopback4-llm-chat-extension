import {BindingScope, inject, injectable, service} from '@loopback/core';
import {AiIntegrationBindings} from '../keys';
import {ITransport} from '../transports/types';
import {ILimitStrategy} from './limit-strategies/types';
import {WorkflowRunner} from '../mastra/bridge/workflow-runner';

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

  async generate(prompt: string, files: Express.Multer.File[], id?: string) {
    await this.limiter?.check();
    const abortController = new AbortController();
    await this.transport.start();
    this.transport.onCancel(() => {
      abortController.abort();
    });

    try {
      for await (const event of this.workflowRunner.executeChatWorkflow(
        prompt,
        files,
        abortController,
        id,
      )) {
        await this.transport.send(event);
      }
      await this.transport.end();
    } catch (error) {
      await this.transport.end(error);
      throw error;
    }
  }
}
