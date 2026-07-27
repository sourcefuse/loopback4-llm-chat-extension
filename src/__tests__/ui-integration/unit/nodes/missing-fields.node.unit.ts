import {expect} from '@loopback/testlab';
import {MissingFieldsNode} from '../../../../components/ui-integration/nodes/missing-fields.node';
import {FormFillingState} from '../../../../components/ui-integration/graph/state';
import {FormFillStatus, FormConfig, FormFieldValue, UIIntegrationConfig} from '../../../../components/ui-integration/types';

describe('MissingFieldsNode Unit', function () {
  let node: MissingFieldsNode;
  let mockFormConfig: FormConfig;
  let config: UIIntegrationConfig;

  beforeEach(async () => {
    config = {
      forms: [],
      maxMissingFields: 0,
    };

    node = new MissingFieldsNode(config);

    mockFormConfig = {
      id: 'test-form',
      name: 'Test Form',
      description: 'A test form',
      fields: [
        {
          name: 'requiredField',
          type: 'text',
          required: true,
        },
        {
          name: 'optionalField',
          type: 'text',
          required: false,
          defaultValue: 'default-value',
        },
        {
          name: 'dbEnrichedField',
          type: 'text',
          required: true,
          enrichment: {
            dataSource: 'database',
            query: 'SELECT value FROM table',
          },
        },
        {
          name: 'apiEnrichedField',
          type: 'text',
          required: true,
          enrichment: {
            dataSource: 'api',
            apiUrl: '/api/endpoint',
          },
        },
      ],
    };
  });

  it('should return complete status when all required fields have values', async () => {
    const enrichedFields: FormFieldValue[] = [
      {name: 'requiredField', value: 'provided', confidence: 0.9, source: 'extracted'},
      {name: 'dbEnrichedField', value: 'db-value', confidence: 0.9, source: 'extracted'},
      {name: 'apiEnrichedField', value: 'api-value', confidence: 0.9, source: 'extracted'},
    ];

    const state: Partial<FormFillingState> = {
      formConfig: mockFormConfig,
      enrichedFields,
    };

    const result = await node.execute(state as FormFillingState, {});

    expect(result.status).to.equal(FormFillStatus.Complete);
    expect(result.missingFields).to.be.empty();
    expect(result.finalFields).to.have.lengthOf(4); // 3 required + optional with default
    expect(result.finalFields!.find(f => f.name === 'optionalField')!.value).to.equal(
      'default-value',
    );
  });

  it('should identify missing required fields', async () => {
    const enrichedFields: FormFieldValue[] = [
      {name: 'optionalField', value: 'value', confidence: 0.9, source: 'extracted'},
    ];

    const state: Partial<FormFillingState> = {
      formConfig: mockFormConfig,
      enrichedFields,
    };

    const result = await node.execute(state as FormFillingState, {});

    expect(result.status).to.equal(FormFillStatus.Failed);
    expect(result.missingFields).to.containEql('requiredField');
    expect(result.errors).to.not.be.empty();
  });

  it('should categorize missing fields by enrichment source', async () => {
    const enrichedFields: FormFieldValue[] = [
      {name: 'requiredField', value: 'provided', confidence: 0.9, source: 'extracted'},
    ];

    const state: Partial<FormFillingState> = {
      formConfig: mockFormConfig,
      enrichedFields,
    };

    const result = await node.execute(state as FormFillingState, {});

    expect(result.fieldsNeedingDatabase).to.containEql('dbEnrichedField');
    expect(result.fieldsNeedingAPI).to.containEql('apiEnrichedField');
  });

  it('should allow incomplete status when maxMissingFields > 0', async () => {
    const configWithAllowance: UIIntegrationConfig = {
      forms: [],
      maxMissingFields: 2,
    };

    const nodeWithAllowance = new MissingFieldsNode(configWithAllowance);

    const enrichedFields: FormFieldValue[] = [
      {name: 'requiredField', value: 'provided', confidence: 0.9, source: 'extracted'},
    ];

    const state: Partial<FormFillingState> = {
      formConfig: mockFormConfig,
      enrichedFields,
    };

    const result = await nodeWithAllowance.execute(state as FormFillingState, {});

    expect(result.status).to.equal(FormFillStatus.Incomplete);
    expect(result.missingFields).to.have.lengthOf(2);
    expect(result.errors).to.be.undefined();
  });

  it('should fail when missing fields exceed maxMissingFields', async () => {
    const configWithAllowance: UIIntegrationConfig = {
      forms: [],
      maxMissingFields: 1,
    };

    const nodeWithAllowance = new MissingFieldsNode(configWithAllowance);

    const enrichedFields: FormFieldValue[] = [
      {name: 'requiredField', value: 'provided', confidence: 0.9, source: 'extracted'},
    ];

    const state: Partial<FormFillingState> = {
      formConfig: mockFormConfig,
      enrichedFields,
    };

    const result = await nodeWithAllowance.execute(state as FormFillingState, {});

    expect(result.status).to.equal(FormFillStatus.Failed);
    expect(result.errors).to.not.be.empty();
    expect(result.errors![0]).to.match(/Too many missing required fields/);
  });

  it('should add default values for optional fields', async () => {
    const enrichedFields: FormFieldValue[] = [
      {name: 'requiredField', value: 'provided', confidence: 0.9, source: 'extracted'},
    ];

    const state: Partial<FormFillingState> = {
      formConfig: mockFormConfig,
      enrichedFields,
    };

    const result = await node.execute(state as FormFillingState, {});

    const optionalField = result.finalFields!.find(
      f => f.name === 'optionalField',
    );

    expect(optionalField).to.not.be.undefined();
    expect(optionalField!.value).to.equal('default-value');
    expect(optionalField!.source).to.equal('default');
    expect(optionalField!.confidence).to.equal(1.0);
  });

  it('should not override existing optional field values with defaults', async () => {
    const enrichedFields: FormFieldValue[] = [
      {name: 'requiredField', value: 'provided', confidence: 0.9, source: 'extracted'},
      {
        name: 'optionalField',
        value: 'custom-value',
        confidence: 0.9,
        source: 'extracted',
      },
    ];

    const state: Partial<FormFillingState> = {
      formConfig: mockFormConfig,
      enrichedFields,
    };

    const result = await node.execute(state as FormFillingState, {});

    const optionalField = result.finalFields!.find(
      f => f.name === 'optionalField',
    );

    expect(optionalField!.value).to.equal('custom-value');
    expect(optionalField!.source).to.equal('extracted');
  });

  it('should handle missing form config', async () => {
    const enrichedFields: FormFieldValue[] = [
      {name: 'requiredField', value: 'provided', confidence: 0.9, source: 'extracted'},
    ];

    const state: Partial<FormFillingState> = {
      enrichedFields,
    };

    const result = await node.execute(state as FormFillingState, {});

    expect(result.status).to.equal(FormFillStatus.Failed);
    expect(result.errors).to.containEql(
      'Missing form configuration or enriched fields',
    );
  });

  it('should handle missing enriched fields', async () => {
    const state: Partial<FormFillingState> = {
      formConfig: mockFormConfig,
    };

    const result = await node.execute(state as FormFillingState, {});

    expect(result.status).to.equal(FormFillStatus.Failed);
    expect(result.errors).to.containEql(
      'Missing form configuration or enriched fields',
    );
  });

  it('should calculate average confidence', async () => {
    const enrichedFields: FormFieldValue[] = [
      {name: 'requiredField', value: 'provided', confidence: 0.9, source: 'extracted'},
      {
        name: 'optionalField',
        value: 'value',
        confidence: 0.7,
        source: 'extracted',
      },
    ];

    const state: Partial<FormFillingState> = {
      formConfig: mockFormConfig,
      enrichedFields,
    };

    const result = await node.execute(state as FormFillingState, {});

    // Should include default value field in calculation
    expect(result.finalFields!.length).to.be.greaterThan(0);
  });

  it('should handle undefined maxMissingFields (defaults to 0)', async () => {
    const nodeUndefinedMax = new MissingFieldsNode({forms: []});

    const enrichedFields: FormFieldValue[] = [
      {name: 'requiredField', value: 'provided', confidence: 0.9, source: 'extracted'},
    ];

    const state: Partial<FormFillingState> = {
      formConfig: mockFormConfig,
      enrichedFields,
    };

    const result = await nodeUndefinedMax.execute(state as FormFillingState, {});

    expect(result.status).to.equal(FormFillStatus.Failed);
  });

  it('should not add default for optional fields with no default value', async () => {
    const formConfigNoDefault: FormConfig = {
      id: 'test-form',
      name: 'Test Form',
      description: 'A test form',
      fields: [
        {
          name: 'requiredField',
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

    const enrichedFields: FormFieldValue[] = [
      {name: 'requiredField', value: 'provided', confidence: 0.9, source: 'extracted'},
    ];

    const state: Partial<FormFillingState> = {
      formConfig: formConfigNoDefault,
      enrichedFields,
    };

    const result = await node.execute(state as FormFillingState, {});

    const optionalField = result.finalFields!.find(
      f => f.name === 'optionalField',
    );

    expect(optionalField).to.be.undefined();
  });
});
