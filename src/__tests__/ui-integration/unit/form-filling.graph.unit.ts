import {Context} from '@loopback/core';
import {expect, sinon} from '@loopback/testlab';
import {
  FormFillingGraph,
  FormFillingNodes,
  FormFillStatus,
} from '../../../components/ui-integration';
import {GRAPH_NODE_NAME} from '../../../constant';
import {buildNodeStub} from '../../test-helper';

describe(`FormFillingGraph Unit`, function () {
  let graph: FormFillingGraph;
  let stubMap: Record<FormFillingNodes, sinon.SinonStub>;

  beforeEach(async () => {
    const context = new Context('test-context');
    context.bind('services.FormFillingGraph').toClass(FormFillingGraph);
    stubMap = {} as Record<FormFillingNodes, sinon.SinonStub>;

    for (const key of Object.values(FormFillingNodes)) {
      const stub = buildNodeStub();
      context
        .bind(`services.${key}`)
        .to(stub)
        .tag({
          [GRAPH_NODE_NAME]: key,
        });
      stubMap[key] = stub.execute;
    }

    graph = await context.get<FormFillingGraph>('services.FormFillingGraph');
  });

  it('should follow the ideal flow: identify form → extract info → validate → enrich → missing fields → complete', async () => {
    const compiledGraph = await graph.build();

    stubMap[FormFillingNodes.IdentifyForm].callsFake(state => ({
      ...state,
      formId: 'leave-request',
      formConfig: {
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
            type: 'text',
            required: true,
          },
        ],
      },
      retryCount: 0,
    }));

    stubMap[FormFillingNodes.ExtractInfo].callsFake(state => ({
      ...state,
      extractedFields: [
        {
          name: 'employeeId',
          value: 'EMP123',
          confidence: 0.9,
          source: 'extracted',
        },
        {
          name: 'leaveType',
          value: 'Sick',
          confidence: 0.9,
          source: 'extracted',
        },
      ],
      retryCount: 1,
    }));

    stubMap[FormFillingNodes.ValidateFields].callsFake(state => ({
      ...state,
      validatedFields: state.extractedFields,
    }));

    stubMap[FormFillingNodes.EnrichFields].callsFake(state => ({
      ...state,
      enrichedFields: state.validatedFields,
    }));

    stubMap[FormFillingNodes.MissingFields].callsFake(state => ({
      ...state,
      finalFields: state.enrichedFields,
      missingFields: [],
      fieldsNeedingDatabase: [],
      fieldsNeedingAPI: [],
      status: FormFillStatus.Complete,
    }));

    const result = await compiledGraph.invoke({
      prompt: 'I want to submit a sick leave request',
    });

    expect(stubMap[FormFillingNodes.IdentifyForm].calledOnce).to.be.true();
    expect(stubMap[FormFillingNodes.ExtractInfo].calledOnce).to.be.true();
    expect(stubMap[FormFillingNodes.ValidateFields].calledOnce).to.be.true();
    expect(stubMap[FormFillingNodes.EnrichFields].calledOnce).to.be.true();
    expect(stubMap[FormFillingNodes.MissingFields].calledOnce).to.be.true();
    expect(stubMap[FormFillingNodes.FailedUI].called).to.be.false();
    expect(result.status).to.equal(FormFillStatus.Complete);
  });

  it('should retry extraction when validation fails (less than 3 times)', async () => {
    const compiledGraph = await graph.build();

    let extractCallCount = 0;
    stubMap[FormFillingNodes.IdentifyForm].callsFake(state => ({
      ...state,
      formId: 'leave-request',
      formConfig: {
        id: 'leave-request',
        name: 'Leave Request',
        description: 'Submit a leave request',
        fields: [
          {
            name: 'employeeId',
            type: 'text',
            required: true,
          },
        ],
      },
      retryCount: 0,
    }));

    stubMap[FormFillingNodes.ExtractInfo].callsFake(state => {
      extractCallCount++;
      if (extractCallCount === 1) {
        return {
          ...state,
          extractedFields: [
            {
              name: 'employeeId',
              value: 'invalid',
              confidence: 0.5,
              source: 'extracted',
            },
          ],
          retryCount: 1,
        };
      }
      return {
        ...state,
        extractedFields: [
          {
            name: 'employeeId',
            value: 'EMP123',
            confidence: 0.9,
            source: 'extracted',
          },
        ],
        retryCount: 2,
      };
    });

    stubMap[FormFillingNodes.ValidateFields].callsFake(state => {
      if (state.extractedFields?.[0].value === 'invalid') {
        return {
          ...state,
          validatedFields: state.extractedFields,
          errors: ['Invalid employee ID format'],
        };
      }
      // Clear errors when validation passes
      return {
        ...state,
        validatedFields: state.extractedFields,
        errors: undefined, // Important: Clear errors so conditional edge routes correctly
      };
    });

    stubMap[FormFillingNodes.EnrichFields].callsFake(state => ({
      ...state,
      enrichedFields: state.validatedFields,
    }));

    stubMap[FormFillingNodes.MissingFields].callsFake(state => ({
      ...state,
      finalFields: state.enrichedFields,
      missingFields: [],
      fieldsNeedingDatabase: [],
      fieldsNeedingAPI: [],
      status: FormFillStatus.Complete,
    }));

    stubMap[FormFillingNodes.FailedUI].callsFake(state => state);

    await compiledGraph.invoke({
      prompt: 'Submit leave request',
    });

    expect(stubMap[FormFillingNodes.ExtractInfo].calledTwice).to.be.true();
    expect(stubMap[FormFillingNodes.ValidateFields].calledTwice).to.be.true();
  });

  it('should fail after 3 validation failures', async () => {
    const compiledGraph = await graph.build();

    stubMap[FormFillingNodes.IdentifyForm].callsFake(state => ({
      ...state,
      formId: 'leave-request',
      formConfig: {
        id: 'leave-request',
        name: 'Leave Request',
        description: 'Submit a leave request',
        fields: [
          {
            name: 'employeeId',
            type: 'text',
            required: true,
          },
        ],
      },
      retryCount: 0,
    }));

    stubMap[FormFillingNodes.ExtractInfo].callsFake(state => ({
      ...state,
      extractedFields: [
        {
          name: 'employeeId',
          value: 'invalid',
          confidence: 0.5,
          source: 'extracted',
        },
      ],
      retryCount: (state.retryCount || 0) + 1,
    }));

    stubMap[FormFillingNodes.ValidateFields].callsFake(state => ({
      ...state,
      validatedFields: state.extractedFields,
      errors: ['Invalid employee ID format'],
    }));

    stubMap[FormFillingNodes.EnrichFields].callsFake(state => state);

    stubMap[FormFillingNodes.MissingFields].callsFake(state => state);

    stubMap[FormFillingNodes.FailedUI].callsFake(state => ({
      ...state,
      status: FormFillStatus.Failed,
      finalFields: state.validatedFields || [],
      missingFields:
        state.formConfig?.fields
          .filter((f: any) => f.required)
          .map((f: any) => f.name) || [],
    }));

    const result = await compiledGraph.invoke({
      prompt: 'Submit leave request',
    });

    expect(stubMap[FormFillingNodes.FailedUI].calledOnce).to.be.true();
    expect(result.status).to.equal(FormFillStatus.Failed);
  });

  xit('should fail when form identification fails', async () => {
    // Reset all stubs to default behavior first
    for (const key of Object.values(FormFillingNodes)) {
      stubMap[key].resetBehavior();
    }

    const compiledGraph = await graph.build();

    stubMap[FormFillingNodes.IdentifyForm].callsFake(state => ({
      ...state,
      status: FormFillStatus.Failed,
      errors: ['No matching form found'],
      formId: 'unknown-form',
      formConfig: {
        id: 'unknown-form',
        name: 'Unknown Form',
        description: 'An unknown form',
        fields: [
          {
            name: 'employeeId',
            type: 'text',
            required: true,
          },
        ],
      },
      retryCount: 0,
    }));

    // Stub remaining nodes to pass through state with required fields
    stubMap[FormFillingNodes.ExtractInfo].callsFake(state => ({
      ...state,
      extractedFields: [],
    }));
    stubMap[FormFillingNodes.ValidateFields].callsFake(state => ({
      ...state,
      validatedFields: [],
    }));
    stubMap[FormFillingNodes.EnrichFields].callsFake(state => ({
      ...state,
      enrichedFields: [],
    }));
    stubMap[FormFillingNodes.MissingFields].callsFake(state => ({
      ...state,
      finalFields: [],
      missingFields: [],
      fieldsNeedingDatabase: [],
      fieldsNeedingAPI: [],
      status: FormFillStatus.Failed,
    }));
    stubMap[FormFillingNodes.FailedUI].callsFake(state => ({
      ...state,
      status: FormFillStatus.Failed,
      finalFields: [],
      missingFields: ['employeeId'],
    }));

    const result = await compiledGraph.invoke({
      prompt: 'Do something unknown',
    });

    expect(result.status).to.equal(FormFillStatus.Failed);
  });

  it('should return incomplete status when some fields are missing', async () => {
    const compiledGraph = await graph.build();

    stubMap[FormFillingNodes.IdentifyForm].callsFake(state => ({
      ...state,
      formId: 'leave-request',
      formConfig: {
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
            type: 'text',
            required: true,
          },
        ],
      },
      retryCount: 0,
    }));

    stubMap[FormFillingNodes.ExtractInfo].callsFake(state => ({
      ...state,
      extractedFields: [
        {
          name: 'employeeId',
          value: 'EMP123',
          confidence: 0.9,
          source: 'extracted',
        },
      ],
      retryCount: 1,
    }));

    stubMap[FormFillingNodes.ValidateFields].callsFake(state => ({
      ...state,
      validatedFields: state.extractedFields,
    }));

    stubMap[FormFillingNodes.EnrichFields].callsFake(state => ({
      ...state,
      enrichedFields: state.validatedFields,
    }));

    stubMap[FormFillingNodes.MissingFields].callsFake(state => ({
      ...state,
      finalFields: state.enrichedFields,
      missingFields: ['leaveType'],
      fieldsNeedingDatabase: [],
      fieldsNeedingAPI: [],
      status: FormFillStatus.Incomplete,
    }));

    const result = await compiledGraph.invoke({
      prompt: 'Submit leave request',
    });

    expect(result.status).to.equal(FormFillStatus.Incomplete);
    expect(result.missingFields).to.containEql('leaveType');
  });

  it('should identify fields needing database enrichment', async () => {
    const compiledGraph = await graph.build();

    stubMap[FormFillingNodes.IdentifyForm].callsFake(state => ({
      ...state,
      formId: 'leave-request',
      formConfig: {
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
            name: 'employeeEmail',
            type: 'text',
            required: true,
            enrichment: {
              dataSource: 'database',
            },
          },
        ],
      },
      retryCount: 0,
    }));

    stubMap[FormFillingNodes.ExtractInfo].callsFake(state => ({
      ...state,
      extractedFields: [
        {
          name: 'employeeId',
          value: 'EMP123',
          confidence: 0.9,
          source: 'extracted',
        },
      ],
      retryCount: 1,
    }));

    stubMap[FormFillingNodes.ValidateFields].callsFake(state => ({
      ...state,
      validatedFields: state.extractedFields,
    }));

    stubMap[FormFillingNodes.EnrichFields].callsFake(state => ({
      ...state,
      enrichedFields: state.validatedFields,
    }));

    stubMap[FormFillingNodes.MissingFields].callsFake(state => ({
      ...state,
      finalFields: state.enrichedFields,
      missingFields: ['employeeEmail'],
      fieldsNeedingDatabase: ['employeeEmail'],
      fieldsNeedingAPI: [],
      status: FormFillStatus.Incomplete,
    }));

    const result = await compiledGraph.invoke({
      prompt: 'Submit leave request',
    });

    expect(result.fieldsNeedingDatabase).to.containEql('employeeEmail');
  });

  it('should identify fields needing API enrichment', async () => {
    const compiledGraph = await graph.build();

    stubMap[FormFillingNodes.IdentifyForm].callsFake(state => ({
      ...state,
      formId: 'leave-request',
      formConfig: {
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
            name: 'externalData',
            type: 'text',
            required: true,
            enrichment: {
              dataSource: 'api',
            },
          },
        ],
      },
      retryCount: 0,
    }));

    stubMap[FormFillingNodes.ExtractInfo].callsFake(state => ({
      ...state,
      extractedFields: [
        {
          name: 'employeeId',
          value: 'EMP123',
          confidence: 0.9,
          source: 'extracted',
        },
      ],
      retryCount: 1,
    }));

    stubMap[FormFillingNodes.ValidateFields].callsFake(state => ({
      ...state,
      validatedFields: state.extractedFields,
    }));

    stubMap[FormFillingNodes.EnrichFields].callsFake(state => ({
      ...state,
      enrichedFields: state.validatedFields,
    }));

    stubMap[FormFillingNodes.MissingFields].callsFake(state => ({
      ...state,
      finalFields: state.enrichedFields,
      missingFields: ['externalData'],
      fieldsNeedingDatabase: [],
      fieldsNeedingAPI: ['externalData'],
      status: FormFillStatus.Incomplete,
    }));

    const result = await compiledGraph.invoke({
      prompt: 'Submit leave request',
    });

    expect(result.fieldsNeedingAPI).to.containEql('externalData');
  });

  it('should fail when too many required fields are missing', async () => {
    const compiledGraph = await graph.build();

    stubMap[FormFillingNodes.IdentifyForm].callsFake(state => ({
      ...state,
      formId: 'leave-request',
      formConfig: {
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
            type: 'text',
            required: true,
          },
          {
            name: 'startDate',
            type: 'date',
            required: true,
          },
        ],
      },
      retryCount: 0,
    }));

    stubMap[FormFillingNodes.ExtractInfo].callsFake(state => ({
      ...state,
      extractedFields: [
        {
          name: 'employeeId',
          value: 'EMP123',
          confidence: 0.9,
          source: 'extracted',
        },
      ],
      retryCount: 1,
    }));

    stubMap[FormFillingNodes.ValidateFields].callsFake(state => ({
      ...state,
      validatedFields: state.extractedFields,
    }));

    stubMap[FormFillingNodes.EnrichFields].callsFake(state => ({
      ...state,
      enrichedFields: state.validatedFields,
    }));

    stubMap[FormFillingNodes.MissingFields].callsFake(state => ({
      ...state,
      finalFields: state.enrichedFields,
      missingFields: ['leaveType', 'startDate'],
      fieldsNeedingDatabase: [],
      fieldsNeedingAPI: [],
      status: FormFillStatus.Failed,
      errors: [
        'Too many missing required fields (2). Maximum allowed: 0. Missing: leaveType, startDate',
      ],
    }));

    const result = await compiledGraph.invoke({
      prompt: 'Submit leave request',
    });

    expect(stubMap[FormFillingNodes.FailedUI].calledOnce).to.be.true();
    expect(result.status).to.equal(FormFillStatus.Failed);
  });
});
