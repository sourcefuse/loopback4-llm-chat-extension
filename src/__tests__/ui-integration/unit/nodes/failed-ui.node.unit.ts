import {expect} from '@loopback/testlab';
import {FailedUINode} from '../../../../components/ui-integration/nodes/failed-ui.node';
import {FormFillingState} from '../../../../components/ui-integration/graph/state';
import {FormFillStatus, FormConfig, FormFieldValue} from '../../../../components/ui-integration/types';

describe('FailedUINode Unit', function () {
  let node: FailedUINode;
  let mockFormConfig: FormConfig;

  beforeEach(async () => {
    node = new FailedUINode();

    mockFormConfig = {
      id: 'test-form',
      name: 'Test Form',
      description: 'A test form',
      fields: [
        {
          name: 'field1',
          type: 'text',
          required: true,
        },
        {
          name: 'field2',
          type: 'text',
          required: true,
        },
        {
          name: 'optionalField',
          type: 'text',
          required: false,
        },
      ],
    };
  });

  it('should set status to failed', async () => {
    const state: Partial<FormFillingState> = {
      formConfig: mockFormConfig,
    };

    const result = await node.execute(state as FormFillingState, {});

    expect(result.status).to.equal(FormFillStatus.Failed);
  });

  it('should use validated fields as final fields when available', async () => {
    const validatedFields: FormFieldValue[] = [
      {name: 'field1', value: 'value1', confidence: 0.9, source: 'extracted'},
      {name: 'field2', value: 'value2', confidence: 0.9, source: 'extracted'},
    ];

    const state: Partial<FormFillingState> = {
      formConfig: mockFormConfig,
      validatedFields,
    };

    const result = await node.execute(state as FormFillingState, {});

    expect(result.finalFields).to.deepEqual(validatedFields);
  });

  it('should set missing fields to all required fields', async () => {
    const state: Partial<FormFillingState> = {
      formConfig: mockFormConfig,
    };

    const result = await node.execute(state as FormFillingState, {});

    expect(result.missingFields).to.containEql('field1');
    expect(result.missingFields).to.containEql('field2');
    expect(result.missingFields).to.not.containEql('optionalField');
  });

  it('should handle missing form config', async () => {
    const state: Partial<FormFillingState> = {};

    const result = await node.execute(state as FormFillingState, {});

    expect(result.status).to.equal(FormFillStatus.Failed);
    expect(result.finalFields).to.be.empty();
    expect(result.missingFields).to.be.empty();
  });

  it('should handle missing validated fields', async () => {
    const state: Partial<FormFillingState> = {
      formConfig: mockFormConfig,
    };

    const result = await node.execute(state as FormFillingState, {});

    expect(result.finalFields).to.be.empty();
  });

  it('should preserve other state properties', async () => {
    const validatedFields: FormFieldValue[] = [
      {name: 'field1', value: 'value1', confidence: 0.9, source: 'extracted'},
    ];

    const state: Partial<FormFillingState> = {
      formConfig: mockFormConfig,
      validatedFields,
      formId: 'test-form-id',
      prompt: 'test prompt',
      errors: ['some error'],
    };

    const result = await node.execute(state as FormFillingState, {});

    expect(result.formId).to.equal('test-form-id');
    expect(result.prompt).to.equal('test prompt');
    expect(result.errors).to.containEql('some error');
  });
});
