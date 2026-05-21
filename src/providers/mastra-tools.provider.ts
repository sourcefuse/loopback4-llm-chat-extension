import {BindingScope, injectable, Provider} from '@loopback/core';
import type {MastraToolDefinition, MastraToolStore} from '../types';
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
import {
  formatGenerateVisualizationResult,
  generateVisualizationTool,
  getGenerateVisualizationMetadata,
} from '../mastra/workflows/visualization/tools';

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
    {
      id: generateVisualizationTool.id,
      tool: generateVisualizationTool,
      source: 'native',
      formatResult: formatGenerateVisualizationResult,
      getMetadata: getGenerateVisualizationMetadata,
    },
  ];
}

@injectable({scope: BindingScope.REQUEST})
export class MastraToolsProvider implements Provider<MastraToolStore> {
  async value(): Promise<MastraToolStore> {
    const definitions = createNativeDefinitions();

    const map: Record<string, MastraToolDefinition> = {};
    const tools: Record<string, MastraToolDefinition['tool']> = {};
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
