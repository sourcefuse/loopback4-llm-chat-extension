import {expect} from '@loopback/testlab';
import {FormRegistryService, FormStore} from '../../../../components/ui-integration/form-registry.service';
import {UIIntegrationConfig} from '../../../../components/ui-integration/types';

describe('FormRegistryService Unit', function () {
  let formRegistry: FormRegistryService;
  let formStore: FormStore;
  let config: UIIntegrationConfig;

  beforeEach(async () => {
    formStore = new FormStore();
    config = {
      forms: [
        {
          id: 'leave-request',
          name: 'Leave Request',
          description: 'Submit a leave request',
          category: 'HR',
          keywords: ['leave', 'vacation', 'time off'],
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
              required: true,
            },
          ],
        },
        {
          id: 'expense-report',
          name: 'Expense Report',
          description: 'Submit an expense report',
          category: 'Finance',
          keywords: ['expense', 'reimbursement', 'cost'],
          fields: [
            {
              name: 'amount',
              type: 'number',
              required: true,
              validation: {
                min: 0,
              },
            },
            {
              name: 'description',
              type: 'text',
              required: true,
            },
          ],
        },
      ],
      enrichmentEnabled: true,
      maxMissingFields: 0,
    };

    formRegistry = new FormRegistryService(config, formStore);
  });

  it('should register all forms from config on initialization', () => {
    const allForms = formRegistry.getAllForms();

    expect(allForms).to.have.lengthOf(2);
    expect(allForms.map(f => f.id)).to.containEql('leave-request');
    expect(allForms.map(f => f.id)).to.containEql('expense-report');
  });

  it('should get form by ID', () => {
    const form = formRegistry.getForm('leave-request');

    expect(form).to.not.be.undefined();
    expect(form.id).to.equal('leave-request');
    expect(form.name).to.equal('Leave Request');
  });

  it('should throw error when getting non-existent form', () => {
    expect(() => formRegistry.getForm('non-existent')).to.throw(
      'Form not found: non-existent',
    );
  });

  it('should find form by ID (case-sensitive)', () => {
    const form = formRegistry.findForm('leave-request');

    expect(form).to.not.be.undefined();
    expect(form!.id).to.equal('leave-request');
  });

  it('should find form by name (case-insensitive)', () => {
    const form = formRegistry.findForm('Leave Request');

    expect(form).to.not.be.undefined();
    expect(form!.id).to.equal('leave-request');
  });

  it('should return undefined when finding non-existent form', () => {
    const form = formRegistry.findForm('non-existent');

    expect(form).to.be.undefined();
  });

  it('should find form by keyword', () => {
    const form1 = formRegistry.findForm('vacation');
    const form2 = formRegistry.findForm('reimbursement');

    expect(form1).to.not.be.undefined();
    expect(form1!.id).to.equal('leave-request');
    expect(form2).to.not.be.undefined();
    expect(form2!.id).to.equal('expense-report');
  });

  it('should handle empty forms config', () => {
    const emptyConfig: UIIntegrationConfig = {
      forms: [],
    };
    const emptyRegistry = new FormRegistryService(emptyConfig, new FormStore());

    const allForms = emptyRegistry.getAllForms();

    expect(allForms).to.be.an.Array();
    expect(allForms).to.be.empty();
  });
});
