import {expect, sinon} from '@loopback/testlab';
import {IdentifyFormNode} from '../../../../components/ui-integration/nodes/identify-form.node';
import {FormFillingState} from '../../../../components/ui-integration/graph/state';
import {FormFillStatus} from '../../../../components/ui-integration/types';
import {LLMProvider} from '../../../../types';
import {FormRegistryService, FormStore} from '../../../../components/ui-integration/form-registry.service';
import {UIIntegrationConfig} from '../../../../components/ui-integration/types';

describe('IdentifyFormNode Unit', function () {
  let node: IdentifyFormNode;
  let llmStub: sinon.SinonStub;
  let formRegistry: FormRegistryService;
  let config: UIIntegrationConfig;

  beforeEach(async () => {
    llmStub = sinon.stub();
    const llm = llmStub as unknown as LLMProvider;

    config = {
      forms: [
        {
          id: 'leave-request',
          name: 'Leave Request',
          description: 'Submit a leave request',
          keywords: ['leave', 'vacation'],
          fields: [],
        },
        {
          id: 'expense-report',
          name: 'Expense Report',
          description: 'Submit an expense report',
          keywords: ['expense', 'reimbursement'],
          fields: [],
        },
      ],
    };

    const formStore = new FormStore();
    formRegistry = new FormRegistryService(config, formStore);

    node = new IdentifyFormNode(llm, formRegistry);
  });

  it('should identify form from user request', async () => {
    llmStub.resolves({
      content: 'leave-request',
    });

    const state: Partial<FormFillingState> = {
      prompt: 'I want to submit a leave request',
    };

    const result = await node.execute(state as FormFillingState, {});

    expect(result.formId).to.equal('leave-request');
    expect(result.formConfig).to.not.be.undefined();
    expect(result.formConfig!.id).to.equal('leave-request');
    expect(result.status).to.be.undefined();
    expect(result.retryCount).to.equal(0);
  });

  it('should handle case when form is not found (no-match)', async () => {
    llmStub.resolves({
      content: 'no-match',
    });

    const state: Partial<FormFillingState> = {
      prompt: 'I want to do something unknown',
    };

    const result = await node.execute(state as FormFillingState, {});

    expect(result.status).to.equal(FormFillStatus.Failed);
    expect(result.errors).to.not.be.empty();
    expect(result.errors![0]).to.match(/Could not identify a matching form/);
  });

  it('should handle case when LLM returns invalid form ID', async () => {
    llmStub.resolves({
      content: 'invalid-form-id',
    });

    const state: Partial<FormFillingState> = {
      prompt: 'I want to submit a form',
    };

    const result = await node.execute(state as FormFillingState, {});

    expect(result.status).to.equal(FormFillStatus.Failed);
    expect(result.errors).to.not.be.empty();
    expect(result.errors![0]).to.match(/Could not identify a matching form/);
  });

  it('should call LLM with formatted forms description', async () => {
    llmStub.resolves({
      content: 'leave-request',
    });

    const state: Partial<FormFillingState> = {
      prompt: 'Submit leave request',
    };

    await node.execute(state as FormFillingState, {});

    const llmCall = llmStub.getCalls()[0];
    // The LLM receives a StringPromptValue object with the formatted prompt in .value property
    const formattedPrompt = llmCall.args[0].value || llmCall.args[0];

    expect(formattedPrompt).to.match(/ID: leave-request/);
    expect(formattedPrompt).to.match(/Name: Leave Request/);
    expect(formattedPrompt).to.match(/leave, vacation/);
    expect(formattedPrompt).to.match(/Submit leave request/);
  });

  it('should reset retry count when identifying form', async () => {
    llmStub.resolves({
      content: 'leave-request',
    });

    const state: Partial<FormFillingState> = {
      prompt: 'Submit leave request',
      retryCount: 5,
    };

    const result = await node.execute(state as FormFillingState, {});

    expect(result.retryCount).to.equal(0);
  });

  it('should handle forms without keywords', async () => {
    const configWithoutKeywords: UIIntegrationConfig = {
      forms: [
        {
          id: 'simple-form',
          name: 'Simple Form',
          description: 'A simple form',
          fields: [],
        },
      ],
    };

    const formStore = new FormStore();
    const formRegistryNoKeywords = new FormRegistryService(
      configWithoutKeywords,
      formStore,
    );
    const nodeNoKeywords = new IdentifyFormNode(
      llmStub as unknown as LLMProvider,
      formRegistryNoKeywords,
    );

    llmStub.resolves({
      content: 'simple-form',
    });

    const state: Partial<FormFillingState> = {
      prompt: 'Fill simple form',
    };

    const result = await nodeNoKeywords.execute(state as FormFillingState, {});

    expect(result.formId).to.equal('simple-form');
  });
});
