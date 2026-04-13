import {expect, sinon} from '@loopback/testlab';
import {FillFormTool} from '../../../../components/ui-integration/tools/fill-form.tool';
import {FormFillingGraph} from '../../../../components/ui-integration/graph/form-filling.graph';
import {FormFillStatus} from '../../../../components/ui-integration/types';
import {RunnableConfig} from '../../../../graphs';
import {z} from 'zod';

describe('FillFormTool Unit', function () {
  let tool: FillFormTool;
  let graphStub: any;
  let compiledGraphStub: any;

  beforeEach(async () => {
    compiledGraphStub = {
      asTool: sinon.stub().returns({
        name: 'fill-form',
        description: 'Fills out a pre-configured form',
        schema: z.object({
          prompt: z.string(),
        }),
      }),
    };

    graphStub = {
      build: sinon.stub().resolves(compiledGraphStub),
    };

    tool = new FillFormTool(graphStub);
  });

  it('should have correct key and needsReview properties', () => {
    expect(tool.key).to.equal('fill-form');
    expect(tool.needsReview).to.be.false();
  });

  it('should build tool with correct schema', async () => {
    const builtTool = await tool.build();

    expect(builtTool).to.not.be.undefined();
    expect(builtTool.name).to.equal('fill-form');
    expect(graphStub.build.calledOnce).to.be.true();
  });

  it('should return success message for complete form', () => {
    const result = {
      status: FormFillStatus.Complete,
      formConfig: {
        name: 'Leave Request',
      },
      finalFields: [
        {name: 'field1', value: 'value1', confidence: 0.9},
        {name: 'field2', value: 'value2', confidence: 0.8},
      ],
    };

    const message = tool.getValue(result);

    expect(message).to.match(/Successfully filled form/);
    expect(message).to.match(/Leave Request/);
    expect(message).to.match(/2 fields/);
    expect(message).to.match(/85%/); // Average confidence
  });

  it('should return failure message for failed form', () => {
    const result = {
      status: FormFillStatus.Failed,
      formConfig: {
        name: 'Leave Request',
      },
    };

    const message = tool.getValue(result);

    expect(message).to.equal('Failed to fill form: Leave Request');
  });

  it('should return incomplete message for missing required fields', () => {
    const result = {
      status: FormFillStatus.Incomplete,
      formConfig: {
        name: 'Leave Request',
      },
      missingFields: ['employeeId', 'startDate'],
    };

    const message = tool.getValue(result);

    expect(message).to.match(/partially filled/);
    expect(message).to.match(/employeeId/);
    expect(message).to.match(/startDate/);
  });

  it('should return database enrichment message', () => {
    const result = {
      status: FormFillStatus.Incomplete,
      formConfig: {
        name: 'Leave Request',
      },
      fieldsNeedingDatabase: ['employeeEmail', 'department'],
      missingFields: [],
    };

    const message = tool.getValue(result);

    expect(message).to.match(/FORM INCOMPLETE/);
    expect(message).to.match(/requires data from database/);
    expect(message).to.match(/employeeEmail/);
    expect(message).to.match(/department/);
    expect(message).to.match(/generate-query/);
    expect(message).to.match(/execute-dataset/);
  });

  it('should return API enrichment message', () => {
    const result = {
      status: FormFillStatus.Incomplete,
      formConfig: {
        name: 'Leave Request',
      },
      fieldsNeedingAPI: ['externalData'],
      missingFields: [],
    };

    const message = tool.getValue(result);

    expect(message).to.match(/FORM INCOMPLETE/);
    expect(message).to.match(/requires data from external APIs/);
    expect(message).to.match(/externalData/);
  });

  it('should return metadata for complete form', () => {
    const result = {
      status: FormFillStatus.Complete,
      formId: 'leave-request',
      formName: 'Leave Request',
      formConfig: {
        name: 'Leave Request',
      },
      finalFields: [
        {name: 'field1', value: 'value1', confidence: 0.9},
      ],
      missingFields: [],
      fieldsNeedingDatabase: [],
      fieldsNeedingAPI: [],
    };

    const metadata = tool.getMetadata(result);

    expect(metadata.status).to.equal('completed');
    expect(metadata.formId).to.equal('leave-request');
    expect(metadata.formName).to.equal('Leave Request');
    expect(metadata.missingFields).to.be.empty();
    expect(metadata.fieldsNeedingDatabase).to.be.empty();
    expect(metadata.fieldsNeedingAPI).to.be.empty();
  });

  it('should return metadata for failed form', () => {
    const result = {
      status: FormFillStatus.Failed,
      formId: 'leave-request',
      formName: 'Leave Request',
      formConfig: {
        name: 'Leave Request',
      },
      missingFields: ['field1', 'field2'],
      fieldsNeedingDatabase: ['dbField'],
      fieldsNeedingAPI: ['apiField'],
    };

    const metadata = tool.getMetadata(result);

    expect(metadata.status).to.equal('failed');
    expect(metadata.formId).to.equal('leave-request');
    expect(metadata.missingFields).to.containEql('field1');
    expect(metadata.missingFields).to.containEql('field2');
    expect(metadata.fieldsNeedingDatabase).to.containEql('dbField');
    expect(metadata.fieldsNeedingAPI).to.containEql('apiField');
  });

  it('should handle missing formConfig in getValue', () => {
    const result = {
      status: FormFillStatus.Complete,
      formName: 'Leave Request',
      finalFields: [],
    };

    const message = tool.getValue(result);

    expect(message).to.match(/Leave Request/);
  });

  it('should handle empty final fields in getValue', () => {
    const result = {
      status: FormFillStatus.Complete,
      formConfig: {
        name: 'Leave Request',
      },
      finalFields: [],
    };

    const message = tool.getValue(result);

    expect(message).to.match(/0 fields/);
    expect(message).to.match(/0%/);
  });

  it('should handle string missingFields in getMetadata', () => {
    const result = {
      status: FormFillStatus.Failed,
      formId: 'test',
      missingFields: 'field1,field2',
    };

    const metadata = tool.getMetadata(result);

    expect(metadata.missingFields).to.containEql('field1');
    expect(metadata.missingFields).to.containEql('field2');
  });
});
