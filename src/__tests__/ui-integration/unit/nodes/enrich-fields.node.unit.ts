import {expect, sinon} from '@loopback/testlab';
import {EnrichFieldsNode} from '../../../../components/ui-integration/nodes/enrich-fields.node';
import {FormFillingState} from '../../../../components/ui-integration/graph/state';
import {FormFillStatus, FormConfig, FormFieldValue} from '../../../../components/ui-integration/types';
import {Getter} from '@loopback/core';
import {IAuthUserWithPermissions} from '@sourceloop/core';

describe('EnrichFieldsNode Unit', function () {
  let node: EnrichFieldsNode;
  let mockFormConfig: FormConfig;
  let getCurrentUserStub: sinon.SinonStub;

  beforeEach(async () => {
    getCurrentUserStub = sinon.stub();

    const getCurrentUser: Getter<IAuthUserWithPermissions | undefined> =
      getCurrentUserStub as unknown as Getter<
        IAuthUserWithPermissions | undefined
      >;

    node = new EnrichFieldsNode(getCurrentUser);

    mockFormConfig = {
      id: 'test-form',
      name: 'Test Form',
      description: 'A test form',
      fields: [
        {
          name: 'userId',
          type: 'text',
          required: true,
          enrichment: {
            dataSource: 'user-context',
            userContextField: 'id',
          },
        },
        {
          name: 'department',
          type: 'text',
          required: true,
          enrichment: {
            dataSource: 'user-context',
            userContextField: 'userProfile.department',
          },
        },
        {
          name: 'email',
          type: 'text',
          required: true,
          enrichment: {
            dataSource: 'user-context',
            userContextField: 'email',
          },
        },
        {
          name: 'dbField',
          type: 'text',
          required: true,
          enrichment: {
            dataSource: 'database',
            query: 'SELECT email FROM employees WHERE id = {userId}',
          },
        },
        {
          name: 'apiField',
          type: 'text',
          required: true,
          enrichment: {
            dataSource: 'api',
            apiUrl: '/api/external/data',
          },
        },
        {
          name: 'normalField',
          type: 'text',
          required: true,
        },
      ],
    };
  });

  it('should enrich fields from user context', async () => {
    const mockUser = {
      id: 'user123',
      email: 'user@example.com',
      userProfile: {
        department: 'Engineering',
      },
    };

    getCurrentUserStub.resolves(mockUser);

    const validatedFields: FormFieldValue[] = [
      {name: 'userId', value: null, confidence: 0, source: 'extracted'},
      {
        name: 'department',
        value: null,
        confidence: 0,
        source: 'extracted',
      },
      {name: 'email', value: null, confidence: 0, source: 'extracted'},
      {name: 'dbField', value: null, confidence: 0, source: 'extracted'},
      {name: 'apiField', value: null, confidence: 0, source: 'extracted'},
      {name: 'normalField', value: 'provided value', confidence: 0.9, source: 'extracted'},
    ];

    const state: Partial<FormFillingState> = {
      formConfig: mockFormConfig,
      validatedFields,
    };

    const result = await node.execute(state as FormFillingState, {});

    expect(result.enrichedFields).to.have.lengthOf(6);
    expect(result.enrichedFields!.find(f => f.name === 'userId')!.value).to.equal(
      'user123',
    );
    expect(
      result.enrichedFields!.find(f => f.name === 'userId')!.source,
    ).to.equal('enriched');
    expect(
      result.enrichedFields!.find(f => f.name === 'department')!.value,
    ).to.equal('Engineering');
    expect(
      result.enrichedFields!.find(f => f.name === 'department')!.source,
    ).to.equal('enriched');
    expect(
      result.enrichedFields!.find(f => f.name === 'email')!.value,
    ).to.equal('user@example.com');
    expect(
      result.enrichedFields!.find(f => f.name === 'email')!.source,
    ).to.equal('enriched');
    expect(
      result.enrichedFields!.find(f => f.name === 'normalField')!.value,
    ).to.equal('provided value');
  });

  it('should not override existing values', async () => {
    const mockUser = {
      id: 'user123',
      email: 'user@example.com',
    };

    getCurrentUserStub.resolves(mockUser);

    const validatedFields: FormFieldValue[] = [
      {name: 'userId', value: 'custom-user-id', confidence: 0.9, source: 'extracted'},
      {name: 'email', value: null, confidence: 0, source: 'extracted'},
    ];

    const state: Partial<FormFillingState> = {
      formConfig: mockFormConfig,
      validatedFields,
    };

    const result = await node.execute(state as FormFillingState, {});

    expect(result.enrichedFields!.find(f => f.name === 'userId')!.value).to.equal(
      'custom-user-id',
    );
    expect(
      result.enrichedFields!.find(f => f.name === 'userId')!.source,
    ).to.equal('extracted');
    expect(
      result.enrichedFields!.find(f => f.name === 'email')!.value,
    ).to.equal('user@example.com');
    expect(
      result.enrichedFields!.find(f => f.name === 'email')!.source,
    ).to.equal('enriched');
  });

  it('should handle undefined nested user context', async () => {
    const mockUser = {
      id: 'user123',
    };

    getCurrentUserStub.resolves(mockUser);

    const validatedFields: FormFieldValue[] = [
      {name: 'userId', value: null, confidence: 0, source: 'extracted'},
      {
        name: 'department',
        value: null,
        confidence: 0,
        source: 'extracted',
      },
    ];

    const state: Partial<FormFillingState> = {
      formConfig: mockFormConfig,
      validatedFields,
    };

    const result = await node.execute(state as FormFillingState, {});

    expect(result.enrichedFields!.find(f => f.name === 'userId')!.value).to.equal(
      'user123',
    );
    expect(
      result.enrichedFields!.find(f => f.name === 'department')!.value,
    ).to.be.undefined();
  });

  it('should handle missing user context', async () => {
    getCurrentUserStub.resolves(undefined);

    const validatedFields: FormFieldValue[] = [
      {name: 'userId', value: null, confidence: 0, source: 'extracted'},
      {name: 'email', value: null, confidence: 0, source: 'extracted'},
    ];

    const state: Partial<FormFillingState> = {
      formConfig: mockFormConfig,
      validatedFields,
    };

    const result = await node.execute(state as FormFillingState, {});

    expect(result.enrichedFields!.find(f => f.name === 'userId')!.value).to.be.null();
    expect(result.enrichedFields!.find(f => f.name === 'email')!.value).to.be.null();
  });

  it('should skip fields without enrichment config', async () => {
    const validatedFields: FormFieldValue[] = [
      {name: 'normalField', value: 'provided value', confidence: 0.9, source: 'extracted'},
    ];

    const state: Partial<FormFillingState> = {
      formConfig: mockFormConfig,
      validatedFields,
    };

    const result = await node.execute(state as FormFillingState, {});

    expect(
      result.enrichedFields!.find(f => f.name === 'normalField')!.value,
    ).to.equal('provided value');
    expect(
      result.enrichedFields!.find(f => f.name === 'normalField')!.source,
    ).to.equal('extracted');
  });

  it('should handle missing form config', async () => {
    const validatedFields: FormFieldValue[] = [
      {name: 'userId', value: null, confidence: 0, source: 'extracted'},
    ];

    const state: Partial<FormFillingState> = {
      validatedFields,
    };

    const result = await node.execute(state as FormFillingState, {});

    expect(result.status).to.equal(FormFillStatus.Failed);
    expect(result.errors).to.containEql(
      'Missing form configuration or validated fields',
    );
  });

  it('should handle missing validated fields', async () => {
    const state: Partial<FormFillingState> = {
      formConfig: mockFormConfig,
    };

    const result = await node.execute(state as FormFillingState, {});

    expect(result.status).to.equal(FormFillStatus.Failed);
    expect(result.errors).to.containEql(
      'Missing form configuration or validated fields',
    );
  });

  it('should not enrich database fields (handled by LLM)', async () => {
    const mockUser = {
      id: 'user123',
    };

    getCurrentUserStub.resolves(mockUser);

    const validatedFields: FormFieldValue[] = [
      {name: 'dbField', value: null, confidence: 0, source: 'extracted'},
    ];

    const state: Partial<FormFillingState> = {
      formConfig: mockFormConfig,
      validatedFields,
    };

    const result = await node.execute(state as FormFillingState, {});

    expect(result.enrichedFields!.find(f => f.name === 'dbField')!.value).to.be.null();
  });

  it('should not enrich API fields (handled by LLM)', async () => {
    const mockUser = {
      id: 'user123',
    };

    getCurrentUserStub.resolves(mockUser);

    const validatedFields: FormFieldValue[] = [
      {name: 'apiField', value: null, confidence: 0, source: 'extracted'},
    ];

    const state: Partial<FormFillingState> = {
      formConfig: mockFormConfig,
      validatedFields,
    };

    const result = await node.execute(state as FormFillingState, {});

    expect(
      result.enrichedFields!.find(f => f.name === 'apiField')!.value,
    ).to.be.null();
  });
});
