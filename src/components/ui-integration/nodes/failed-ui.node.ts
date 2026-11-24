import {graphNode} from '../../../decorators';
import {
  IGraphNode,
  LLMStreamEventType,
  RunnableConfig,
  ToolStatus,
} from '../../../graphs';
import {FormFillingState} from '../graph/state';
import {FormFillStatus} from '../types';
import {FormFillingNodes} from '../nodes.enum';

@graphNode(FormFillingNodes.FailedUI)
export class FailedUINode implements IGraphNode<FormFillingState> {
  async execute(
    state: FormFillingState,
    config: RunnableConfig,
  ): Promise<FormFillingState> {
    config.writer?.({
      type: LLMStreamEventType.ToolStatus,
      data: {
        status: ToolStatus.Failed,
      },
    });

    return {
      ...state,
      status: FormFillStatus.Failed,
      finalFields: state.validatedFields || [],
      missingFields:
        state.formConfig?.fields.filter(f => f.required).map(f => f.name) || [],
    };
  }
}
