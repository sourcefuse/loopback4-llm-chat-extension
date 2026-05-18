import {BindingScope, inject, injectable, Provider} from '@loopback/core';
import {StructuredToolInterface} from '@langchain/core/tools';
import {RunnableToolLike} from '@langchain/core/runnables';
import {createTool} from '@mastra/core/tools';
import {z} from 'zod';
import {AiIntegrationBindings} from '../keys';
import type {IGraphTool} from '../graphs/types';
import type {LLMStreamEvent} from '../graphs/event.types';
import type {
  JsonObject,
  JsonValue,
  MastraToolDefinition,
  MastraToolStore,
  ToolStore,
} from '../types';
import {asWorkflowContext} from '../mastra/bridge/workflow-request-context';
import {
  askAboutDatasetTool,
  formatAskAboutDatasetResult,
  formatGetDataAsDatasetResult,
  formatImproveDatasetResult,
  getAskAboutDatasetMetadata,
  getDataAsDatasetMetadata,
  getDataAsDatasetTool,
  getImproveDatasetMetadata,
  improveDatasetTool,
} from '../mastra/workflows/db-query/tools';

const debug = require('debug')('ai-integration:provider:mastra-tools');

type LegacyTool = StructuredToolInterface | RunnableToolLike;

type LegacyInvokeConfig = {
  configurable?: Record<string, JsonValue>;
  writer?: (event: LLMStreamEvent) => void;
};

type InvokableLegacyTool = {
  invoke(
    input: JsonObject,
    config?: LegacyInvokeConfig,
  ): Promise<JsonValue | JsonObject>;
};

function isInvokableLegacyTool(
  tool: LegacyTool,
): tool is LegacyTool & InvokableLegacyTool {
  return 'invoke' in tool && typeof tool.invoke === 'function';
}

function resolveLegacyDescription(tool: LegacyTool, fallback: string): string {
  if ('description' in tool && typeof tool.description === 'string') {
    return tool.description;
  }
  return fallback;
}

function resolveLegacyInputSchema(tool: LegacyTool): z.ZodType<object> {
  if ('schema' in tool && tool.schema instanceof z.ZodType) {
    return tool.schema;
  }
  return z.object({}).passthrough();
}

function toJsonObject(value: JsonValue | JsonObject | undefined): JsonObject {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value;
  }

  if (typeof value === 'string' || typeof value === 'number') {
    return {value};
  }

  if (typeof value === 'boolean') {
    return {value};
  }

  if (value === null) {
    return {value: null};
  }

  return {};
}

function toLegacyRecord(result: JsonObject): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(result)) {
    output[key] =
      typeof value === 'string' ? value : JSON.stringify(value ?? null);
  }
  return output;
}

function createNativeDefinitions(): MastraToolDefinition[] {
  return [
    {
      id: getDataAsDatasetTool.id,
      tool: getDataAsDatasetTool,
      source: 'native',
      formatResult: formatGetDataAsDatasetResult,
      getMetadata: getDataAsDatasetMetadata,
    },
    {
      id: improveDatasetTool.id,
      tool: improveDatasetTool,
      source: 'native',
      formatResult: formatImproveDatasetResult,
      getMetadata: getImproveDatasetMetadata,
    },
    {
      id: askAboutDatasetTool.id,
      tool: askAboutDatasetTool,
      source: 'native',
      formatResult: formatAskAboutDatasetResult,
      getMetadata: getAskAboutDatasetMetadata,
    },
  ];
}

async function createLegacyCompatibilityDefinition(
  legacyTool: IGraphTool,
): Promise<MastraToolDefinition> {
  const builtTool = await legacyTool.build({configurable: {}});
  const description = resolveLegacyDescription(builtTool, legacyTool.key);
  const inputSchema = resolveLegacyInputSchema(builtTool);

  const wrappedTool = createTool({
    id: legacyTool.key,
    description,
    inputSchema,
    execute: async (inputData, context) => {
      const eventQueue = context?.requestContext
        ? asWorkflowContext(context.requestContext).get('eventQueue')
        : undefined;

      const runtimeTool = await legacyTool.build({configurable: {}});
      if (!isInvokableLegacyTool(runtimeTool)) {
        throw new Error(`Legacy tool ${legacyTool.key} is not invokable.`);
      }

      const invokeConfig: LegacyInvokeConfig = {
        configurable: {},
        writer: event => {
          eventQueue?.push(event);
        },
      };

      const result = await runtimeTool.invoke(
        toJsonObject(inputData),
        invokeConfig,
      );
      return toJsonObject(result);
    },
  });

  return {
    id: legacyTool.key,
    tool: wrappedTool,
    source: 'legacy-compat',
    formatResult: result => {
      if (legacyTool.getValue) {
        return legacyTool.getValue(toLegacyRecord(result));
      }
      return JSON.stringify(result);
    },
    getMetadata: result => {
      if (legacyTool.getMetadata) {
        const metadata = legacyTool.getMetadata(toLegacyRecord(result));
        return toJsonObject(metadata as JsonObject);
      }
      return {status: 'completed'};
    },
  };
}

@injectable({scope: BindingScope.REQUEST})
export class MastraToolsProvider implements Provider<MastraToolStore> {
  constructor(
    @inject(AiIntegrationBindings.Tools)
    private readonly legacyToolStore: ToolStore,
  ) {}

  async value(): Promise<MastraToolStore> {
    const nativeDefinitions = createNativeDefinitions();
    const definitions: MastraToolDefinition[] = [...nativeDefinitions];
    const nativeIds = new Set(
      nativeDefinitions.map(definition => definition.id),
    );

    for (const legacyTool of this.legacyToolStore.list) {
      if (legacyTool.needsReview) {
        continue;
      }
      if (nativeIds.has(legacyTool.key)) {
        continue;
      }

      try {
        const compatibilityDefinition =
          await createLegacyCompatibilityDefinition(legacyTool);
        definitions.push(compatibilityDefinition);
      } catch (error) {
        debug(
          `Failed to register legacy compatibility tool ${legacyTool.key}:`,
          error,
        );
      }
    }

    const map: Record<string, MastraToolDefinition> = {};
    const tools: Record<string, ReturnType<typeof createTool>> = {};
    for (const definition of definitions) {
      map[definition.id] = definition;
      tools[definition.id] = definition.tool;
    }

    return {
      list: definitions,
      map,
      tools,
    };
  }
}
