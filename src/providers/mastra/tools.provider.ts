import {BindingScope, inject, injectable, Provider} from '@loopback/core';
import {AskAboutDatasetTool} from '../../components/db-query/tools/ask-about-dataset.tool';
import {GetDataAsDatasetTool} from '../../components/db-query/tools/get-data-as-dataset.tool';
import {ImproveDatasetTool} from '../../components/db-query/tools/improve-dataset.tool';
import {GenerateVisualizationTool} from '../../components/visualization/tools/generate-visualization.tool';
import type {ToolStore} from '../../graphs/types';

/**
 * Default Mastra tool registry — ships the 4 internal tools (get-data,
 * improve-dataset, ask-about-dataset, generate-visualization). Consumers
 * may override the binding entirely or wrap this provider to inject
 * extra tools.
 *
 * SINGLETON so the underlying tool instances (which carry their own DI)
 * are constructed once and re-used per request.
 */
@injectable({scope: BindingScope.SINGLETON})
export class DefaultToolsProvider implements Provider<ToolStore> {
  constructor(
    // Tool injections are optional — three of the four (get-data,
    // improve, ask) hard-depend on DbQuery bindings (DatasetStore,
    // SchemaStore, DbSchemaHelperService) and the fourth on
    // visualization bindings. An app that mounts the AI integrations
    // component without DbQueryComponent or VisualizerComponent must
    // still be able to resolve a Mastra tool store — only the tools
    // whose dependencies are bound end up in the registry.
    @inject('services.GetDataAsDatasetTool', {optional: true})
    private readonly getData?: GetDataAsDatasetTool,
    @inject('services.ImproveDatasetTool', {optional: true})
    private readonly improve?: ImproveDatasetTool,
    @inject('services.AskAboutDatasetTool', {optional: true})
    private readonly ask?: AskAboutDatasetTool,
    @inject('services.GenerateVisualizationTool', {optional: true})
    private readonly viz?: GenerateVisualizationTool,
  ) {}

  value(): ToolStore {
    const list = [this.getData, this.improve, this.ask, this.viz].filter(
      (t): t is NonNullable<typeof t> => t !== undefined,
    );
    return {list};
  }
}
