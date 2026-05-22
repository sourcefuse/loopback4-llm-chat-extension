import {BindingScope, inject, injectable, Provider} from '@loopback/core';
import {MastraAskAboutDatasetTool} from '../../components/db-query/tools/ask-about-dataset.mastra.tool';
import {MastraGetDataAsDatasetTool} from '../../components/db-query/tools/get-data-as-dataset.mastra.tool';
import {MastraImproveDatasetTool} from '../../components/db-query/tools/improve-dataset.mastra.tool';
import {MastraGenerateVisualizationTool} from '../../components/visualization/tools/generate-visualization.mastra.tool';
import type {MastraToolStore} from '../../graphs/types';

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
export class DefaultMastraToolsProvider implements Provider<MastraToolStore> {
  constructor(
    @inject('services.MastraGetDataAsDatasetTool')
    private readonly getData: MastraGetDataAsDatasetTool,
    @inject('services.MastraImproveDatasetTool')
    private readonly improve: MastraImproveDatasetTool,
    @inject('services.MastraAskAboutDatasetTool')
    private readonly ask: MastraAskAboutDatasetTool,
    @inject('services.MastraGenerateVisualizationTool')
    private readonly viz: MastraGenerateVisualizationTool,
  ) {}

  value(): MastraToolStore {
    const list = [this.getData, this.improve, this.ask, this.viz];
    return {
      list,
      map: Object.fromEntries(list.map(t => [t.key, t])),
    };
  }
}
