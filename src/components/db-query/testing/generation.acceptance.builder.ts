import {Client} from '@loopback/testlab';
import {
  GenerationAcceptanceSuiteResult,
  GenerationAcceptanceTestCase,
  GenerationAcceptanceTestResult,
} from './types';
import {Application} from '@loopback/core';
import {PermissionKey} from '../../../permissions';
import {DbQueryAIExtensionBindings} from '../keys';
import {sign} from 'jsonwebtoken';
import {randomUUID} from 'crypto';
import {
  LLMStreamEvent,
  LLMStreamEventType,
  LLMStreamTokenCountEvent,
  LLMStreamToolStatusEvent,
  ToolStatus,
} from '../../../graphs';
import {generateMarkdownTable, getModelNameFromEnv} from './utils';
import {writeFileSync} from 'fs';
import {juggler} from '@loopback/repository';
import {ILogger, LOGGER} from '@sourceloop/core';

function parsePrompt(prompt: string) {
  const keys: Record<string, string> = {
    testDeal: process.env.SAMPLE_DEAL_NAME ?? 'test-deal',
  };
  for (const key of Object.keys(keys)) {
    prompt = prompt.replace(new RegExp(`\\<${key}\\>`, 'g'), keys[key]);
  }
  return prompt;
}

function parseQuery(prompt: string) {
  const keys: Record<string, string> = {
    testDeal: (process.env.SAMPLE_DEAL_NAME ?? 'test-deal')
      .split(' ')
      .join('%')
      .split('_')
      .join('%'),
    tenantId: process.env.TEST_TENANT_ID ?? 'test-tenant',
    date: new Date().toISOString().split('T')[0],
  };
  for (const key of Object.keys(keys)) {
    prompt = prompt.replace(new RegExp(`\\<${key}\\>`, 'g'), keys[key]);
  }
  return prompt;
}

function tokenBuilder(tenantid: string, permissions: string[]) {
  return sign(
    {
      id: randomUUID(),
      userTenantId: randomUUID(),
      permissions: permissions,
      tenantId: tenantid,
    },
    process.env.JWT_SECRET ?? '',
    {
      issuer: process.env.JWT_ISSUER ?? '',
    },
  );
}

export async function generationAcceptanceBuilder(
  cases: GenerationAcceptanceTestCase[],
  client: Client,
  app: Application,
  countPerPrompt = 1,
  writeReport = false,
): Promise<GenerationAcceptanceSuiteResult> {
  // setup app
  const config = app.getSync(DbQueryAIExtensionBindings.Config);
  const token = tokenBuilder(process.env.TEST_TENANT_ID ?? 'test-tenant', [
    ...config.models.map(v => v.readPermissionKey),
    PermissionKey.AskAI,
    PermissionKey.ViewDataset,
    PermissionKey.ExecuteDataset,
  ]);
  const datasetStore = await app.get(DbQueryAIExtensionBindings.DatasetStore);
  const ds = await app.get<juggler.DataSource>('datasources.db');
  const logger = await app.get<ILogger>(LOGGER.LOGGER_INJECT);

  const results: GenerationAcceptanceTestResult[] = [];
  const anyOnly = cases.some(q => q.only);
  const queriesToRun = anyOnly
    ? cases.filter(q => q.only && !q.skip)
    : cases.filter(q => !q.skip);

  for (const query of queriesToRun) {
    const count = query.count ?? countPerPrompt;
    for (let i = 0; i < count; i++) {
      logger.info(
        `Running query: ${query.case} ${i > 0 ? `Iteration: ${i + 1}` : ''}`,
      );
      const result: GenerationAcceptanceTestResult = {
        success: false,
        time: 0,
        inputTokens: 0,
        outputTokens: 0,
        emptyOutput: false,
        generationCount: 0,
        query: '',
        case: query.case,
        description: '',
        actualResult: null,
        expectedResult: null,
      };
      try {
        const startTime = Date.now();
        const {body} = await client
          .post('/reply')
          .set('Authorization', `Bearer ${token}`)
          .field(
            'prompt',
            `${parsePrompt(query.prompt)}. ${query.outputInstructions}`,
          )
          .expect(200);
        // time in seconds
        result.time = (Date.now() - startTime) / 1000;
        const status = body.filter(
          (v: LLMStreamEvent) => v.type === LLMStreamEventType.ToolStatus,
        );
        const lastStatus: LLMStreamToolStatusEvent = status[status.length - 1];
        const [tokenCount]: LLMStreamTokenCountEvent[] = body.filter(
          (v: LLMStreamEvent) => v.type === LLMStreamEventType.TokenCount,
        );
        result.inputTokens = tokenCount.data.inputTokens;
        result.outputTokens = tokenCount.data.outputTokens;

        const finalDescription = body.filter(
          (v: LLMStreamEvent) =>
            v.type === LLMStreamEventType.ToolStatus &&
            v.data.status.startsWith('DESCRIPTION:'),
        );
        if (finalDescription.length > 0) {
          result.description = finalDescription
            .pop()
            .data.status.replace('DESCRIPTION:', '');
        }
        result.generationCount = body.filter(
          (v: LLMStreamEvent) =>
            v.type === LLMStreamEventType.ToolStatus &&
            v.data.status === 'Generating SQL query from the prompt',
        ).length;
        if (lastStatus.data.status === ToolStatus.Completed) {
          const dataset = await datasetStore.findById(
            lastStatus.data.data?.['datasetId'],
          );
          result.query = parseQuery(dataset.query);
          const {body: actualData} = await client
            .get(`/datasets/${dataset.id}/execute`)
            .set('Authorization', `Bearer ${token}`)
            .expect(200);
          const expectedData = await ds.execute(parseQuery(query.resultQuery));
          result.actualResult = actualData;
          result.expectedResult = expectedData;
          // compare actualData and expectedData
          if (JSON.stringify(actualData) === JSON.stringify(expectedData)) {
            result.success = true;
          }
          if (expectedData.length === 0) {
            result.emptyOutput = true;
          }
        } else {
          result.actualResult = JSON.stringify(lastStatus);
          logger.error('Tool did not complete successfully');
        }
      } catch (error) {
        result.actualResult = error.message ?? error.toString();
        logger.error('Error: ', error);
      }
      results.push(result);
      if (writeReport) {
        writeResultSoFar(results);
      }
    }
  }

  return buildFinalResult(results);
}

function buildFinalResult(results: GenerationAcceptanceTestResult[]) {
  const success = results.filter(r => r.success).length;
  const total = results.length;
  return {
    total,
    success,
    results,
  };
}

function writeResultSoFar(results: GenerationAcceptanceTestResult[]) {
  const successCount = results.filter(r => r.success).length;
  const totalCount = results.length;
  const totalInputTokens = results.reduce((acc, r) => acc + r.inputTokens, 0);
  const totalOutputTokens = results.reduce((acc, r) => acc + r.outputTokens, 0);
  const totalTime = results.reduce((acc, r) => acc + r.time, 0);
  const avgTime = totalTime / totalCount || 0;
  const avgInputTokens = totalInputTokens / totalCount || 0;
  const avgOutputTokens = totalOutputTokens / totalCount || 0;
  const modelName = getModelNameFromEnv();
  let report = `# For Model - ${modelName}\n`;
  // print a table with success, non empty success, total time, avg time, total tokens, avg tokens
  report += `## Success Metrics\n`;
  report += generateMarkdownTable([
    {
      'Success Count': successCount,
      'Total Count': results.length,
      'Success Rate': ((successCount / totalCount) * 100).toFixed(2) + '%',
    },
  ]);
  report += `\n## Time Metrics\n`;
  report += generateMarkdownTable([
    {
      'Total Time (s)': totalTime.toFixed(2),
      'Avg Time (s)': avgTime.toFixed(2),
    },
  ]);
  report += `\n## Token Metrics\n`;
  report += generateMarkdownTable([
    {
      'Total Input Tokens': totalInputTokens,
      'Total Output Tokens': totalOutputTokens,
      'Avg Input Tokens': avgInputTokens.toFixed(2),
      'Avg Output Tokens': avgOutputTokens.toFixed(2),
      'Total Tokens': (totalInputTokens + totalOutputTokens).toFixed(2),
    },
  ]);
  report += `\n## Detailed Results\n`;
  report += generateMarkdownTable(
    results.map(result => ({
      Query: result.case,
      Success: result.success ? `:green_circle:` : `:red_circle:`,
      'Empty Output': result.emptyOutput,
      'Time (s)': result.time.toFixed(2),
      'Input Tokens Used': result.inputTokens,
      'Output Tokens Used': result.outputTokens,
      'Generation Count': result.generationCount,
    })),
  );
  report += `\n## Failed Queries and Results\n`;
  for (const result of results) {
    if (result.success) continue;
    report += `\n ### Query: ${result.case}\n`;
    report += `**Description:** ${result.description}\n\n`;
    report += `\n \`\`\`sql\n${result.query}\n\`\`\`\n`;
    report += `\n**Actual Result:**\n\n`;
    if (Array.isArray(result.actualResult)) {
      report += generateMarkdownTable(result.actualResult ?? []);
    } else {
      report += '```\n' + JSON.stringify(result.actualResult) + '\n```\n';
    }
    report += `\n**Expected Result:**\n\n`;
    report += generateMarkdownTable(result.expectedResult ?? []);
    report += `\n---\n`;
  }
  writeFileSync(
    `./llm-reports/generation-report-${modelName.toLowerCase().replace(/[\s\_\/\\]/g, '-')}.md`,
    report,
  );
}
