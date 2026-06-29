import {step} from '../../../decorators';
import type {IWorkflowStep} from '../../../graphs/types';
import {STEP_IMPROVE_FAILED} from './constants';

type ImproveOut = {datasetId: string; sql: string};

/**
 * Terminal failure step for the improve workflow (successor of the LangGraph
 * improve FailedNode). Its Mastra step id is `'failed'` within the improve
 * workflow, but its DI resolver key is the distinct `'improve-failed'`
 * (STEP_IMPROVE_FAILED) so it never collides with the generate `failed` step.
 */
@step(STEP_IMPROVE_FAILED)
export class ImproveFailedStep implements IWorkflowStep<unknown, ImproveOut> {
  async execute(): Promise<ImproveOut> {
    return {datasetId: '', sql: ''};
  }
}
