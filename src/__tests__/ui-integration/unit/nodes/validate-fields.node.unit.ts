import {expect} from '@loopback/testlab';
import {ValidateFieldsNode} from '../../../../components/ui-integration/nodes/validate-fields.node';
import {FormFillingState} from '../../../../components/ui-integration/graph/state';
import {
  FormFillStatus,
  FormConfig,
  FormFieldValue,
} from '../../../../components/ui-integration/types';

describe('ValidateFieldsNode Unit', function () {
  let node: ValidateFieldsNode;
  let mockFormConfig: FormConfig;

  beforeEach(async () => {
    node = new ValidateFieldsNode();

    mockFormConfig = {
      id: 'test-form',
      name: 'Test Form',
      description: 'A test form',
      fields: [
        {
          name: 'name',
          type: 'text',
          required: true,
        },
        {
          name: 'age',
          type: 'number',
          required: true,
          validation: {
            min: 18,
            max: 100,
          },
        },
        {
          name: 'email',
          type: 'text',
          required: true,
          validation: {
            pattern: '^[\\w-\\.]+@([\\w-]+\\.)+[\\w-]{2,4}$',
          },
        },
        {
          name: 'leaveType',
          type: 'select',
          required: true,
          options: ['Sick', 'Vacation', 'Personal'],
        },
        {
          name: 'tags',
          type: 'multiselect',
          required: false,
          options: ['tag1', 'tag2', 'tag3'],
        },
        {
          name: 'startDate',
          type: 'date',
          required: true,
        },
        {
          name: 'isActive',
          type: 'boolean',
          required: false,
        },
        {
          name: 'enrichedField',
          type: 'text',
          required: true,
          enrichment: {
            dataSource: 'database',
          },
        },
      ],
    };
  });

  it('should validate all extracted fields successfully', async () => {
    const extractedFields: FormFieldValue[] = [
      {name: 'name', value: 'John Doe', confidence: 0.9, source: 'extracted'},
      {name: 'age', value: '25', confidence: 0.9, source: 'extracted'},
      {
        name: 'email',
        value: 'john@example.com',
        confidence: 0.9,
        source: 'extracted',
      },
      {name: 'leaveType', value: 'Sick', confidence: 0.9, source: 'extracted'},
      {
        name: 'startDate',
        value: '2025-03-20',
        confidence: 0.9,
        source: 'extracted',
      },
      {name: 'enrichedField', value: null, confidence: 0, source: 'extracted'},
    ];

    const state: Partial<FormFillingState> = {
      formConfig: mockFormConfig,
      extractedFields,
    };

    const result = await node.execute(state as FormFillingState, {});

    expect(result.validatedFields).to.have.lengthOf(6);
    expect(result.errors).to.be.empty();
    expect(
      result.validatedFields!.find(f => f.name === 'enrichedField')!.value,
    ).to.be.null();
  });

  it('should detect missing required fields without enrichment', async () => {
    const extractedFields: FormFieldValue[] = [
      {name: 'name', value: 'John Doe', confidence: 0.9, source: 'extracted'},
    ];

    const state: Partial<FormFillingState> = {
      formConfig: mockFormConfig,
      extractedFields,
    };

    const result = await node.execute(state as FormFillingState, {});

    expect(result.errors).to.not.be.empty();
    expect(result.errors).to.containEql('Required field "age" is missing');
    expect(result.errors).to.containEql('Required field "email" is missing');
  });

  it('should validate number type', async () => {
    const extractedFields: FormFieldValue[] = [
      {name: 'name', value: 'John Doe', confidence: 0.9, source: 'extracted'},
      {
        name: 'age',
        value: 'not a number',
        confidence: 0.9,
        source: 'extracted',
      },
      {
        name: 'email',
        value: 'john@example.com',
        confidence: 0.9,
        source: 'extracted',
      },
      {name: 'leaveType', value: 'Sick', confidence: 0.9, source: 'extracted'},
      {
        name: 'startDate',
        value: '2025-03-20',
        confidence: 0.9,
        source: 'extracted',
      },
      {name: 'enrichedField', value: null, confidence: 0, source: 'extracted'},
    ];

    const state: Partial<FormFillingState> = {
      formConfig: mockFormConfig,
      extractedFields,
    };

    const result = await node.execute(state as FormFillingState, {});

    expect(result.errors).to.containEql('Field "age" must be a number');
    expect(
      result.validatedFields!.find(f => f.name === 'age')!.value,
    ).to.be.null();
  });

  it('should validate number min/max constraints', async () => {
    const extractedFields: FormFieldValue[] = [
      {name: 'name', value: 'John Doe', confidence: 0.9, source: 'extracted'},
      {name: 'age', value: '15', confidence: 0.9, source: 'extracted'},
      {
        name: 'email',
        value: 'john@example.com',
        confidence: 0.9,
        source: 'extracted',
      },
      {name: 'leaveType', value: 'Sick', confidence: 0.9, source: 'extracted'},
      {
        name: 'startDate',
        value: '2025-03-20',
        confidence: 0.9,
        source: 'extracted',
      },
      {name: 'enrichedField', value: null, confidence: 0, source: 'extracted'},
    ];

    const state: Partial<FormFillingState> = {
      formConfig: mockFormConfig,
      extractedFields,
    };

    const result = await node.execute(state as FormFillingState, {});

    expect(result.errors).to.containEql('Field "age" must be at least 18');
  });

  it('should validate date type', async () => {
    const extractedFields: FormFieldValue[] = [
      {name: 'name', value: 'John Doe', confidence: 0.9, source: 'extracted'},
      {name: 'age', value: '25', confidence: 0.9, source: 'extracted'},
      {
        name: 'email',
        value: 'john@example.com',
        confidence: 0.9,
        source: 'extracted',
      },
      {name: 'leaveType', value: 'Sick', confidence: 0.9, source: 'extracted'},
      {
        name: 'startDate',
        value: 'invalid-date',
        confidence: 0.9,
        source: 'extracted',
      },
      {name: 'enrichedField', value: null, confidence: 0, source: 'extracted'},
    ];

    const state: Partial<FormFillingState> = {
      formConfig: mockFormConfig,
      extractedFields,
    };

    const result = await node.execute(state as FormFillingState, {});

    expect(result.errors).to.containEql(
      'Field "startDate" must be a valid date',
    );
  });

  it('should validate select options', async () => {
    const extractedFields: FormFieldValue[] = [
      {name: 'name', value: 'John Doe', confidence: 0.9, source: 'extracted'},
      {name: 'age', value: '25', confidence: 0.9, source: 'extracted'},
      {
        name: 'email',
        value: 'john@example.com',
        confidence: 0.9,
        source: 'extracted',
      },
      {
        name: 'leaveType',
        value: 'InvalidOption',
        confidence: 0.9,
        source: 'extracted',
      },
      {
        name: 'startDate',
        value: '2025-03-20',
        confidence: 0.9,
        source: 'extracted',
      },
      {name: 'enrichedField', value: null, confidence: 0, source: 'extracted'},
    ];

    const state: Partial<FormFillingState> = {
      formConfig: mockFormConfig,
      extractedFields,
    };

    const result = await node.execute(state as FormFillingState, {});

    expect(result.errors).to.containEql(
      'Field "leaveType" must be one of: Sick, Vacation, Personal',
    );
  });

  it('should validate multiselect type and options', async () => {
    const extractedFields: FormFieldValue[] = [
      {name: 'name', value: 'John Doe', confidence: 0.9, source: 'extracted'},
      {name: 'age', value: '25', confidence: 0.9, source: 'extracted'},
      {
        name: 'email',
        value: 'john@example.com',
        confidence: 0.9,
        source: 'extracted',
      },
      {name: 'leaveType', value: 'Sick', confidence: 0.9, source: 'extracted'},
      {
        name: 'tags',
        value: 'not an array',
        confidence: 0.9,
        source: 'extracted',
      },
      {
        name: 'startDate',
        value: '2025-03-20',
        confidence: 0.9,
        source: 'extracted',
      },
      {name: 'enrichedField', value: null, confidence: 0, source: 'extracted'},
    ];

    const state: Partial<FormFillingState> = {
      formConfig: mockFormConfig,
      extractedFields,
    };

    const result = await node.execute(state as FormFillingState, {});

    expect(result.errors).to.containEql('Field "tags" must be an array');
  });

  it('should validate multiselect with invalid options', async () => {
    const extractedFields: FormFieldValue[] = [
      {name: 'name', value: 'John Doe', confidence: 0.9, source: 'extracted'},
      {name: 'age', value: '25', confidence: 0.9, source: 'extracted'},
      {
        name: 'email',
        value: 'john@example.com',
        confidence: 0.9,
        source: 'extracted',
      },
      {name: 'leaveType', value: 'Sick', confidence: 0.9, source: 'extracted'},
      {
        name: 'tags',
        value: ['tag1', 'invalid'],
        confidence: 0.9,
        source: 'extracted',
      },
      {
        name: 'startDate',
        value: '2025-03-20',
        confidence: 0.9,
        source: 'extracted',
      },
      {name: 'enrichedField', value: null, confidence: 0, source: 'extracted'},
    ];

    const state: Partial<FormFillingState> = {
      formConfig: mockFormConfig,
      extractedFields,
    };

    const result = await node.execute(state as FormFillingState, {});

    expect(result.errors).to.containEql(
      'Field "tags" has invalid values: invalid',
    );
  });

  it('should validate boolean type', async () => {
    const extractedFields: FormFieldValue[] = [
      {name: 'name', value: 'John Doe', confidence: 0.9, source: 'extracted'},
      {name: 'age', value: '25', confidence: 0.9, source: 'extracted'},
      {
        name: 'email',
        value: 'john@example.com',
        confidence: 0.9,
        source: 'extracted',
      },
      {name: 'leaveType', value: 'Sick', confidence: 0.9, source: 'extracted'},
      {
        name: 'isActive',
        value: 'not boolean',
        confidence: 0.9,
        source: 'extracted',
      },
      {
        name: 'startDate',
        value: '2025-03-20',
        confidence: 0.9,
        source: 'extracted',
      },
      {name: 'enrichedField', value: null, confidence: 0, source: 'extracted'},
    ];

    const state: Partial<FormFillingState> = {
      formConfig: mockFormConfig,
      extractedFields,
    };

    const result = await node.execute(state as FormFillingState, {});

    expect(result.errors).to.containEql('Field "isActive" must be a boolean');
  });

  it('should validate pattern matching', async () => {
    const extractedFields: FormFieldValue[] = [
      {name: 'name', value: 'John Doe', confidence: 0.9, source: 'extracted'},
      {name: 'age', value: '25', confidence: 0.9, source: 'extracted'},
      {
        name: 'email',
        value: 'invalid-email',
        confidence: 0.9,
        source: 'extracted',
      },
      {name: 'leaveType', value: 'Sick', confidence: 0.9, source: 'extracted'},
      {
        name: 'startDate',
        value: '2025-03-20',
        confidence: 0.9,
        source: 'extracted',
      },
      {name: 'enrichedField', value: null, confidence: 0, source: 'extracted'},
    ];

    const state: Partial<FormFillingState> = {
      formConfig: mockFormConfig,
      extractedFields,
    };

    const result = await node.execute(state as FormFillingState, {});

    expect(result.errors).to.containEql(
      'Field "email" does not match the required format',
    );
  });

  it('should skip optional missing fields', async () => {
    const extractedFields: FormFieldValue[] = [
      {name: 'name', value: 'John Doe', confidence: 0.9, source: 'extracted'},
      {name: 'age', value: '25', confidence: 0.9, source: 'extracted'},
      {
        name: 'email',
        value: 'john@example.com',
        confidence: 0.9,
        source: 'extracted',
      },
      {name: 'leaveType', value: 'Sick', confidence: 0.9, source: 'extracted'},
      {
        name: 'startDate',
        value: '2025-03-20',
        confidence: 0.9,
        source: 'extracted',
      },
      {name: 'enrichedField', value: null, confidence: 0, source: 'extracted'},
    ];

    const state: Partial<FormFillingState> = {
      formConfig: mockFormConfig,
      extractedFields,
    };

    const result = await node.execute(state as FormFillingState, {});

    expect(
      result.validatedFields!.find(f => f.name === 'isActive'),
    ).to.be.undefined();
  });

  it('should handle missing form config', async () => {
    const extractedFields: FormFieldValue[] = [
      {name: 'name', value: 'John Doe', confidence: 0.9, source: 'extracted'},
    ];

    const state: Partial<FormFillingState> = {
      extractedFields,
    };

    const result = await node.execute(state as FormFillingState, {});

    expect(result.status).to.equal(FormFillStatus.Failed);
    expect(result.errors).to.containEql(
      'Missing form configuration or extracted fields',
    );
  });

  it('should handle missing extracted fields', async () => {
    const state: Partial<FormFillingState> = {
      formConfig: mockFormConfig,
    };

    const result = await node.execute(state as FormFillingState, {});

    expect(result.status).to.equal(FormFillStatus.Failed);
    expect(result.errors).to.containEql(
      'Missing form configuration or extracted fields',
    );
  });

  it('should accept boolean strings', async () => {
    const extractedFields: FormFieldValue[] = [
      {name: 'name', value: 'John Doe', confidence: 0.9, source: 'extracted'},
      {name: 'age', value: '25', confidence: 0.9, source: 'extracted'},
      {
        name: 'email',
        value: 'john@example.com',
        confidence: 0.9,
        source: 'extracted',
      },
      {name: 'leaveType', value: 'Sick', confidence: 0.9, source: 'extracted'},
      {name: 'isActive', value: 'true', confidence: 0.9, source: 'extracted'},
      {
        name: 'startDate',
        value: '2025-03-20',
        confidence: 0.9,
        source: 'extracted',
      },
      {name: 'enrichedField', value: null, confidence: 0, source: 'extracted'},
    ];

    const state: Partial<FormFillingState> = {
      formConfig: mockFormConfig,
      extractedFields,
    };

    const result = await node.execute(state as FormFillingState, {});

    expect(result.errors).to.be.empty();
  });
});
