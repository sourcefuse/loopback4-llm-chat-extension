import {expect, sinon} from '@loopback/testlab';
import {ExtractInfoNode} from '../../../../components/ui-integration/nodes/extract-info.node';
import {FormFillingState} from '../../../../components/ui-integration/graph/state';
import {
  FormFillStatus,
  FormConfig,
} from '../../../../components/ui-integration/types';
import {LLMProvider} from '../../../../types';

describe('ExtractInfoNode Unit', function () {
  let node: ExtractInfoNode;
  let llmStub: sinon.SinonStub;
  let mockFormConfig: FormConfig;

  beforeEach(async () => {
    llmStub = sinon.stub();
    const llm = llmStub as unknown as LLMProvider;

    node = new ExtractInfoNode(llm);

    mockFormConfig = {
      id: 'leave-request',
      name: 'Leave Request',
      description: 'Submit a leave request',
      fields: [
        {
          name: 'employeeId',
          type: 'text',
          required: true,
        },
        {
          name: 'leaveType',
          type: 'select',
          required: true,
          options: ['Sick', 'Vacation', 'Personal'],
        },
        {
          name: 'startDate',
          type: 'date',
          required: true,
        },
        {
          name: 'endDate',
          type: 'date',
          required: false,
        },
      ],
    };
  });

  it('should extract fields from user request', async () => {
    llmStub.resolves({
      content: JSON.stringify({
        employeeId: {value: 'EMP123', confidence: 0.95},
        leaveType: {value: 'Sick', confidence: 0.9},
        startDate: {value: '2025-03-20', confidence: 0.85},
        endDate: {value: null, confidence: 0.0},
      }),
    });

    const state: Partial<FormFillingState> = {
      prompt: 'I want to take sick leave starting March 20th',
      formConfig: mockFormConfig,
    };

    const result = await node.execute(state as FormFillingState, {});

    expect(result.extractedFields).to.have.lengthOf(4);
    expect(result.extractedFields![0].name).to.equal('employeeId');
    expect(result.extractedFields![0].value).to.equal('EMP123');
    expect(result.extractedFields![0].confidence).to.equal(0.95);
    expect(result.extractedFields![0].source).to.equal('extracted');
    expect(result.retryCount).to.equal(1);
  });

  it('should handle missing form config', async () => {
    const state: Partial<FormFillingState> = {
      prompt: 'I want to take leave',
    };

    const result = await node.execute(state as FormFillingState, {});

    expect(result.status).to.equal(FormFillStatus.Failed);
    expect(result.errors).to.containEql('Form configuration not found');
  });

  it('should handle invalid JSON from LLM', async () => {
    llmStub.resolves({
      content: 'invalid json{{}',
    });

    const state: Partial<FormFillingState> = {
      prompt: 'I want to take leave',
      formConfig: mockFormConfig,
    };

    const result = await node.execute(state as FormFillingState, {});

    expect(result.status).to.equal(FormFillStatus.Failed);
    expect(result.errors).to.not.be.empty();
    expect(result.errors![0]).to.match(/Failed to parse extracted information/);
  });

  it('should increment retry count', async () => {
    llmStub.resolves({
      content: JSON.stringify({
        employeeId: {value: 'EMP123', confidence: 0.95},
        leaveType: {value: 'Sick', confidence: 0.9},
      }),
    });

    const state: Partial<FormFillingState> = {
      prompt: 'I want to take sick leave',
      formConfig: mockFormConfig,
      retryCount: 2,
    };

    const result = await node.execute(state as FormFillingState, {});

    expect(result.retryCount).to.equal(3);
  });

  it('should include previous errors in prompt for retry', async () => {
    llmStub.resolves({
      content: JSON.stringify({
        employeeId: {value: 'EMP123', confidence: 0.95},
      }),
    });

    const state: Partial<FormFillingState> = {
      prompt: 'I want to take leave',
      formConfig: mockFormConfig,
      errors: ['employeeId is required', 'startDate is missing'],
    };

    await node.execute(state as FormFillingState, {});

    const llmCall = llmStub.getCalls()[0];
    // The LLM receives a StringPromptValue object with the formatted prompt in .value property
    const formattedPrompt = llmCall.args[0].value || llmCall.args[0];

    expect(formattedPrompt).to.match(/employeeId is required/);
    expect(formattedPrompt).to.match(/startDate is missing/);
  });

  it('should call LLM with formatted fields description', async () => {
    llmStub.resolves({
      content: '{}',
    });

    const state: Partial<FormFillingState> = {
      prompt: 'I want to take leave',
      formConfig: mockFormConfig,
    };

    await node.execute(state as FormFillingState, {});

    const llmCall = llmStub.getCalls()[0];
    // The LLM receives a StringPromptValue object with the formatted prompt in .value property
    const formattedPrompt = llmCall.args[0].value || llmCall.args[0];

    expect(formattedPrompt).to.match(/- employeeId \(text\) \[REQUIRED\]/);
    expect(formattedPrompt).to.match(/- leaveType \(select\) \[REQUIRED\]/);
    expect(formattedPrompt).to.match(/Options: Sick, Vacation, Personal/);
    expect(formattedPrompt).to.match(/- startDate \(date\) \[REQUIRED\]/);
    expect(formattedPrompt).to.match(/- endDate \(date\)/);
  });

  it('should handle fields without options', async () => {
    const formWithoutOptions: FormConfig = {
      id: 'simple-form',
      name: 'Simple Form',
      description: 'A simple form',
      fields: [
        {
          name: 'name',
          type: 'text',
          required: true,
          description: 'Full name',
        },
      ],
    };

    llmStub.resolves({
      content: JSON.stringify({
        name: {value: 'John Doe', confidence: 0.9},
      }),
    });

    const state: Partial<FormFillingState> = {
      prompt: 'Fill form for John Doe',
      formConfig: formWithoutOptions,
    };

    const result = await node.execute(state as FormFillingState, {});

    expect(result.extractedFields![0].name).to.equal('name');
    expect(result.extractedFields![0].value).to.equal('John Doe');
  });

  it('should use default confidence when not provided', async () => {
    llmStub.resolves({
      content: JSON.stringify({
        employeeId: {value: 'EMP123'},
      }),
    });

    const state: Partial<FormFillingState> = {
      prompt: 'I want to take leave',
      formConfig: mockFormConfig,
    };

    const result = await node.execute(state as FormFillingState, {});

    expect(result.extractedFields![0].confidence).to.equal(0.5);
  });
});
