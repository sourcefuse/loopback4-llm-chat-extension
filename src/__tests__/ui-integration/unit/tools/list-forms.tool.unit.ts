import {expect, sinon} from '@loopback/testlab';
import {ListFormsTool} from '../../../../components/ui-integration/tools/list-forms.tool';
import {FormRegistryService} from '../../../../components/ui-integration/form-registry.service';
import {FormStore} from '../../../../components/ui-integration/form-registry.service';
import {UIIntegrationConfig} from '../../../../components/ui-integration/types';
import {z} from 'zod';

describe('ListFormsTool Unit', function () {
  let tool: ListFormsTool;
  let formRegistry: FormRegistryService;
  let config: UIIntegrationConfig;

  beforeEach(async () => {
    config = {
      forms: [
        {
          id: 'leave-request',
          name: 'Leave Request',
          description: 'Submit a leave request',
          category: 'HR',
          keywords: ['leave', 'vacation'],
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
              options: ['Sick', 'Vacation'],
            },
          ],
        },
        {
          id: 'expense-report',
          name: 'Expense Report',
          description: 'Submit an expense report',
          category: 'Finance',
          keywords: ['expense', 'reimbursement'],
          fields: [
            {
              name: 'amount',
              type: 'number',
              required: true,
            },
            {
              name: 'description',
              type: 'text',
              required: true,
            },
          ],
        },
      ],
    };

    const formStore = new FormStore();
    formRegistry = new FormRegistryService(config, formStore);
    tool = new ListFormsTool(formRegistry);
  });

  it('should have correct key and needsReview properties', () => {
    expect(tool.key).to.equal('list-forms');
    expect(tool.needsReview).to.be.false();
  });

  it('should build tool with correct schema', async () => {
    const builtTool = await tool.build();

    expect(builtTool).to.not.be.undefined();
    expect(builtTool.name).to.equal('list-forms');
    expect(builtTool.description).to.match(/Lists all available forms/);
  });

  it('should return formatted list of forms', async () => {
    const builtTool = await tool.build();
    const result = await builtTool.invoke({});

    expect(result).to.match(/Leave Request/);
    expect(result).to.match(/ID: leave-request/);
    expect(result).to.match(/Description: Submit a leave request/);
    expect(result).to.match(/Fields: 2 total \(2 required\)/);
    expect(result).to.match(/Keywords: leave, vacation/);
    expect(result).to.match(/Expense Report/);
    expect(result).to.match(/ID: expense-report/);
    expect(result).to.match(/Fields: 2 total \(2 required\)/);
  });

  it('should handle forms without category', async () => {
    const configWithoutCategory: UIIntegrationConfig = {
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
    const formRegistryNoCategory = new FormRegistryService(
      configWithoutCategory,
      formStore,
    );
    const toolNoCategory = new ListFormsTool(formRegistryNoCategory);

    const builtTool = await toolNoCategory.build();
    const result = await builtTool.invoke({});

    expect(result).to.match(/Simple Form/);
    expect(result).to.match(/ID: simple-form/);
    expect(result).to.not.match(/Category:/);
  });

  it('should handle forms without keywords', async () => {
    const configWithoutKeywords: UIIntegrationConfig = {
      forms: [
        {
          id: 'no-keywords-form',
          name: 'No Keywords Form',
          description: 'A form without keywords',
          fields: [],
        },
      ],
    };

    const formStore = new FormStore();
    const formRegistryNoKeywords = new FormRegistryService(
      configWithoutKeywords,
      formStore,
    );
    const toolNoKeywords = new ListFormsTool(formRegistryNoKeywords);

    const builtTool = await toolNoKeywords.build();
    const result = await builtTool.invoke({});

    expect(result).to.match(/No Keywords Form/);
    expect(result).to.match(/ID: no-keywords-form/);
    expect(result).to.not.match(/Keywords:/);
  });

  it('should handle forms with no fields', async () => {
    const configWithNoFields: UIIntegrationConfig = {
      forms: [
        {
          id: 'empty-form',
          name: 'Empty Form',
          description: 'A form with no fields',
          fields: [],
        },
      ],
    };

    const formStore = new FormStore();
    const formRegistryNoFields = new FormRegistryService(
      configWithNoFields,
      formStore,
    );
    const toolNoFields = new ListFormsTool(formRegistryNoFields);

    const builtTool = await toolNoFields.build();
    const result = await builtTool.invoke({});

    expect(result).to.match(/Empty Form/);
    expect(result).to.match(/Fields: 0 total \(0 required\)/);
  });

  it('should handle empty forms list', async () => {
    const emptyConfig: UIIntegrationConfig = {
      forms: [],
    };

    const formStore = new FormStore();
    const emptyFormRegistry = new FormRegistryService(emptyConfig, formStore);
    const emptyTool = new ListFormsTool(emptyFormRegistry);

    const builtTool = await emptyTool.build();
    const result = await builtTool.invoke({});

    expect(result).to.equal('');
  });

  it('should show field counts correctly', async () => {
    const builtTool = await tool.build();
    const result = await builtTool.invoke({});

    expect(result).to.match(/Fields: 2 total \(2 required\)/);
  });
});
