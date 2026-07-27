import {expect} from '@loopback/testlab';
import {GetFormSchemaTool} from '../../../../components/ui-integration/tools/get-form-schema.tool';
import {FormRegistryService} from '../../../../components/ui-integration/form-registry.service';
import {FormStore} from '../../../../components/ui-integration/form-registry.service';
import {UIIntegrationConfig} from '../../../../components/ui-integration/types';

describe('GetFormSchemaTool Unit', function () {
  let tool: GetFormSchemaTool;
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
              description: 'Employee ID',
            },
            {
              name: 'leaveType',
              type: 'select',
              required: true,
              options: ['Sick', 'Vacation', 'Personal'],
              description: 'Type of leave',
            },
            {
              name: 'reason',
              type: 'text',
              required: false,
              description: 'Reason for leave',
            },
          ],
        },
        {
          id: 'simple-form',
          name: 'Simple Form',
          description: 'A simple form without category',
          fields: [
            {
              name: 'name',
              type: 'text',
              required: true,
            },
          ],
        },
      ],
    };

    const formStore = new FormStore();
    formRegistry = new FormRegistryService(config, formStore);
    tool = new GetFormSchemaTool(formRegistry);
  });

  it('should have correct key and needsReview properties', () => {
    expect(tool.key).to.equal('get-form-schema');
    expect(tool.needsReview).to.be.false();
  });

  it('should build tool with correct schema', async () => {
    const builtTool = await tool.build();

    expect(builtTool).to.not.be.undefined();
    expect(builtTool.name).to.equal('get-form-schema');
    expect(builtTool.description).to.match(/complete information about a form/);
  });

  it('should return form schema when form exists by ID', async () => {
    const builtTool = await tool.build();
    const result = await builtTool.invoke({formNameOrId: 'leave-request'});

    expect(result).to.match(/\*\*Form:\*\* Leave Request/);
    expect(result).to.match(/\*\*Description:\*\* Submit a leave request/);
    expect(result).to.match(/\*\*ID:\*\* leave-request/);
    expect(result).to.match(/\*\*Category:\*\* HR/);
    expect(result).to.match(/\*\*Keywords:\*\* leave, vacation/);
    expect(result).to.match(/\*\*Fields \(3 total\):\*\*/);
    expect(result).to.match(/- employeeId \(text\) \[REQUIRED\]/);
    expect(result).to.match(/  Description: Employee ID/);
    expect(result).to.match(/- leaveType \(select\) \[REQUIRED\]/);
    expect(result).to.match(/  Description: Type of leave/);
    expect(result).to.match(/  Options: Sick, Vacation, Personal/);
    expect(result).to.match(/- reason \(text\) \[OPTIONAL\]/);
    expect(result).to.match(
      /IMPORTANT: This form contains ONLY the 3 field\(s\)/,
    );
  });

  it('should return form schema when form exists by name', async () => {
    const builtTool = await tool.build();
    const result = await builtTool.invoke({formNameOrId: 'Leave Request'});

    expect(result).to.match(/\*\*Form:\*\* Leave Request/);
    expect(result).to.match(/\*\*ID:\*\* leave-request/);
  });

  it('should return form schema when form exists by name (case-insensitive)', async () => {
    const builtTool = await tool.build();
    const result = await builtTool.invoke({formNameOrId: 'leave request'});

    expect(result).to.match(/\*\*Form:\*\* Leave Request/);
    expect(result).to.match(/\*\*ID:\*\* leave-request/);
  });

  it('should return not found message when form does not exist', async () => {
    const builtTool = await tool.build();
    const result = await builtTool.invoke({formNameOrId: 'non-existent'});

    expect(result).to.equal('Form not found: non-existent');
  });

  it('should handle form without category', async () => {
    const builtTool = await tool.build();
    const result = await builtTool.invoke({formNameOrId: 'simple-form'});

    expect(result).to.match(/\*\*Form:\*\* Simple Form/);
    expect(result).to.match(/\*\*ID:\*\* simple-form/);
    expect(result).to.not.match(/\*\*Category:\*\*/);
  });

  it('should handle form without keywords', async () => {
    const builtTool = await tool.build();
    const result = await builtTool.invoke({formNameOrId: 'simple-form'});

    expect(result).to.match(/\*\*Form:\*\* Simple Form/);
    expect(result).to.not.match(/\*\*Keywords:\*\*/);
  });

  it('should handle field without description', async () => {
    const builtTool = await tool.build();
    const result = await builtTool.invoke({formNameOrId: 'simple-form'});

    expect(result).to.match(/- name \(text\) \[REQUIRED\]/);
    expect(result).to.match(/Description:/); // Will show but with no value
  });

  it('should handle select field without options', async () => {
    const configWithNoOptions: UIIntegrationConfig = {
      forms: [
        {
          id: 'no-options-form',
          name: 'No Options Form',
          description: 'A form with select field without options',
          fields: [
            {
              name: 'selectField',
              type: 'select',
              required: true,
            },
          ],
        },
      ],
    };

    const formStore = new FormStore();
    const formRegistryNoOptions = new FormRegistryService(
      configWithNoOptions,
      formStore,
    );
    const toolNoOptions = new GetFormSchemaTool(formRegistryNoOptions);

    const builtTool = await toolNoOptions.build();
    const result = await builtTool.invoke({formNameOrId: 'no-options-form'});

    expect(result).to.match(/- selectField \(select\) \[REQUIRED\]/);
    expect(result).to.not.match(/Options:/);
  });

  it('should show correct field count', async () => {
    const builtTool = await tool.build();
    const result = await builtTool.invoke({formNameOrId: 'leave-request'});

    expect(result).to.match(/Fields \(3 total\):/);
  });

  it('should distinguish between required and optional fields', async () => {
    const builtTool = await tool.build();
    const result = await builtTool.invoke({formNameOrId: 'leave-request'});

    expect(result).to.match(/\[REQUIRED\]/);
    expect(result).to.match(/\[OPTIONAL\]/);
  });

  it('should show field type', async () => {
    const builtTool = await tool.build();
    const result = await builtTool.invoke({formNameOrId: 'leave-request'});

    expect(result).to.match(/\(text\)/);
    expect(result).to.match(/\(select\)/);
  });
});
