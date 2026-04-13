import {PromptTemplate} from '@langchain/core/prompts';
import {RunnableSequence} from '@langchain/core/runnables';
import {inject} from '@loopback/core';
import {graphNode} from '../../../decorators';
import {IGraphNode, LLMStreamEventType, RunnableConfig} from '../../../graphs';
import {AiIntegrationBindings} from '../../../keys';
import {LLMProvider} from '../../../types';
import {stripThinkingTokens} from '../../../utils';
import {UIIntegrationBindings} from '../keys';
import {FormFillingState} from '../graph/state';
import {FormFillingNodes} from '../nodes.enum';
import {FormConfig, FormFillStatus} from '../types';

@graphNode(FormFillingNodes.IdentifyForm)
export class IdentifyFormNode implements IGraphNode<FormFillingState> {
  constructor(
    @inject(AiIntegrationBindings.SmartLLM)
    private readonly llm: LLMProvider,
    @inject('services.FormRegistryService')
    private readonly formRegistry: any,
  ) {}

  prompt = PromptTemplate.fromTemplate(`
You are an AI assistant that identifies which form a user wants to fill based on their request.

Available forms:
{forms}

User request: {request}

Analyze the user's request and match it to the best form based on:
- Form name
- Form description
- Keywords

Return ONLY the form ID (exact match from the list above). If the user request clearly mentions wanting to fill a form that exists in the list, return that form's ID.
If no form matches at all, return "no-match".

Do not include any explanation, only return the form ID or "no-match".
`);

  async execute(
    state: FormFillingState,
    config: RunnableConfig,
  ): Promise<FormFillingState> {
    const forms: FormConfig[] = this.formRegistry.getAllForms();

    config.writer?.({
      type: LLMStreamEventType.Log,
      data: `Available forms count: ${forms.length}, Form IDs: ${forms.map(f => f.id).join(', ')}`,
    });

    // Format forms for LLM
    const formsDescription = forms
      .map(
        f =>
          `ID: ${f.id}\nName: ${f.name}\nDescription: ${f.description}\nKeywords: ${f.keywords?.join(', ') || 'none'}\n`,
      )
      .join('\n---\n');

    const chain = RunnableSequence.from([this.prompt, this.llm]);

    config.writer?.({
      type: LLMStreamEventType.ToolStatus,
      data: {status: 'Identifying the appropriate form...'},
    });

    const result = await chain.invoke({
      forms: formsDescription,
      request: state.prompt,
    });

    const formId = stripThinkingTokens(result).trim();

    config.writer?.({
      type: LLMStreamEventType.Log,
      data: `LLM returned form ID: "${formId}"`,
    });

    if (formId === 'no-match' || !forms.find(f => f.id === formId)) {
      return {
        ...state,
        status: FormFillStatus.Failed,
        errors: [
          `Could not identify a matching form. LLM returned: "${formId}". Available forms: ` +
            forms.map(f => `${f.name} (ID: ${f.id})`).join(', '),
        ],
      };
    }

    const formConfig = this.formRegistry.getForm(formId);

    config.writer?.({
      type: LLMStreamEventType.Log,
      data: `Identified form: ${formConfig.name}`,
    });

    return {
      ...state,
      formId,
      formConfig,
      retryCount: 0,
    };
  }
}
