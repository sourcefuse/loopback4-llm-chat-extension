import {Context} from '@loopback/core';
import {expect} from '@loopback/testlab';
import {
  FormFillingGraph,
  FormFillStatus,
  FormRegistryService,
  FormStore,
  UIIntegrationConfig,
} from '../../../components';
import {TestApp} from '../../fixtures/test-app';
import {setupApplication} from '../../test-helper';

describe(`Form Filling Graph Acceptance`, () => {
  let app: TestApp;
  let graphBuilder: FormFillingGraph;

  before('checkIfCanRun', function () {
    if (process.env.RUN_WITH_LLM !== 'true') {
      // eslint-disable-next-line @typescript-eslint/no-invalid-this
      this.skip();
    }
  });

  before('setupApplication', async () => {
    ({app} = await setupApplication({}));

    // Configure the UI integration component with test forms
    const uiConfig: UIIntegrationConfig = {
      forms: [
        {
          id: 'leave-request',
          name: 'Leave Request',
          description: 'Submit a leave request for time off',
          category: 'HR',
          keywords: ['leave', 'vacation', 'time off', 'sick leave'],
          fields: [
            {
              name: 'employeeId',
              type: 'text',
              required: true,
              enrichment: {
                dataSource: 'user-context',
                userContextField: 'id',
              },
            },
            {
              name: 'employeeEmail',
              type: 'text',
              required: true,
              enrichment: {
                dataSource: 'user-context',
                userContextField: 'email',
              },
            },
            {
              name: 'leaveType',
              type: 'select',
              required: true,
              options: ['Sick', 'Vacation', 'Personal', 'Bereavement'],
            },
            {
              name: 'startDate',
              type: 'date',
              required: true,
            },
            {
              name: 'endDate',
              type: 'date',
              required: true,
            },
            {
              name: 'reason',
              type: 'text',
              required: false,
            },
          ],
        },
        {
          id: 'expense-report',
          name: 'Expense Report',
          description: 'Submit an expense report for reimbursement',
          category: 'Finance',
          keywords: ['expense', 'reimbursement', 'cost'],
          fields: [
            {
              name: 'employeeId',
              type: 'text',
              required: true,
              enrichment: {
                dataSource: 'user-context',
                userContextField: 'id',
              },
            },
            {
              name: 'amount',
              type: 'number',
              required: true,
              validation: {
                min: 0,
              },
            },
            {
              name: 'currency',
              type: 'select',
              required: true,
              options: ['USD', 'EUR', 'GBP', 'JPY'],
            },
            {
              name: 'description',
              type: 'text',
              required: true,
            },
            {
              name: 'receiptUrl',
              type: 'text',
              required: false,
            },
          ],
        },
      ],
      enrichmentEnabled: true,
      maxMissingFields: 0,
    };

    // Bind the config and form registry
    app.bind('ui-integration.config').to(uiConfig);

    const formStore = new FormStore();
    const formRegistry = new FormRegistryService(uiConfig, formStore);
    app.bind('services.FormRegistryService').to(formRegistry);
    app.bind('services.FormStore').to(formStore);
  });

  after(async () => {
    if (app) {
      await app.stop();
    }
  });

  beforeEach(async () => {
    const ctx = new Context(app, 'newCtx');
    graphBuilder = await ctx.get<FormFillingGraph>('services.FormFillingGraph');
  });

  const testCases = [
    {
      name: 'should complete leave request form with all information',
      prompt:
        'I want to submit a sick leave request starting tomorrow for 3 days because I have a fever',
      expectedStatus: FormFillStatus.Complete,
      expectedFormId: 'leave-request',
      expectedFields: ['employeeId', 'employeeEmail', 'leaveType', 'startDate'],
      assertions: (result: any) => {
        expect(result.status).to.equal(FormFillStatus.Complete);
        expect(result.formId).to.equal('leave-request');
        expect(result.finalFields).to.not.be.empty();
        expect(result.missingFields).to.be.empty();
        expect(
          result.finalFields!.some(
            (f: any) => f.name === 'leaveType' && f.value === 'Sick',
          ),
        ).to.be.true();
      },
    },
    {
      name: 'should identify expense report form',
      prompt:
        'I need to submit an expense report for $150 USD for travel costs',
      expectedStatus: FormFillStatus.Incomplete,
      expectedFormId: 'expense-report',
      expectedFields: ['employeeId', 'amount', 'currency', 'description'],
      assertions: (result: any) => {
        expect(result.formId).to.equal('expense-report');
        expect(result.finalFields).to.not.be.empty();
        expect(
          result.finalFields!.some(
            (f: any) => f.name === 'amount' && f.value === '150',
          ),
        ).to.be.true();
      },
    },
    {
      name: 'should handle leave request with specific dates',
      prompt: 'Submit a vacation request from March 25th to March 30th',
      expectedStatus: FormFillStatus.Incomplete,
      expectedFormId: 'leave-request',
      expectedFields: ['startDate', 'endDate'],
      assertions: (result: any) => {
        expect(result.formId).to.equal('leave-request');
        expect(
          result.finalFields!.some(
            (f: any) => f.name === 'leaveType' && f.value === 'Vacation',
          ),
        ).to.be.true();
      },
    },
    {
      name: 'should handle incomplete form when missing required info',
      prompt: 'I want to take leave',
      expectedStatus: FormFillStatus.Incomplete,
      expectedFormId: 'leave-request',
      assertions: (result: any) => {
        expect(result.formId).to.equal('leave-request');
        expect(result.status).to.equal(FormFillStatus.Incomplete);
        expect(result.missingFields).to.not.be.empty();
      },
    },
  ];

  for (const testCase of testCases) {
    it(testCase.name, async () => {
      const compiledGraph = await graphBuilder.build();

      const result = await compiledGraph.invoke({
        prompt: testCase.prompt,
      });

      if (testCase.assertions) {
        testCase.assertions(result);
      }
    });
  }

  it('should handle form not found scenario', async () => {
    const compiledGraph = await graphBuilder.build();

    const result = await compiledGraph.invoke({
      prompt: 'I want to do something that is not related to any form',
    });

    expect(result.status).to.equal(FormFillStatus.Failed);
    expect(result.errors).to.not.be.empty();
    expect(result.errors![0]).to.containEql(
      'Could not identify a matching form',
    );
  });

  it('should validate form field types', async () => {
    const compiledGraph = await graphBuilder.build();

    const result = await compiledGraph.invoke({
      prompt: 'Submit expense report for amount "not a number" USD for travel',
    });

    // Should either complete with validation error or retry with correct extraction
    expect(result.formId).to.equal('expense-report');
    if (result.status === FormFillStatus.Failed) {
      expect(result.errors).to.not.be.empty();
    }
  });

  it('should enrich fields from user context', async () => {
    // This test would require mocking the authentication context
    // For now, we'll just verify the form can be identified
    const compiledGraph = await graphBuilder.build();

    const result = await compiledGraph.invoke({
      prompt: 'Submit leave request',
    });

    expect(result.formId).to.equal('leave-request');
    expect(result.finalFields).to.not.be.empty();
  });
});
