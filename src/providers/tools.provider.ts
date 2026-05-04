import {
  BindingScope,
  Context,
  inject,
  injectable,
  Provider,
} from '@loopback/core';
import {IGraphTool} from '../types/tool';
import {ToolStore} from '../types';

@injectable({scope: BindingScope.REQUEST})
export class ToolsProvider implements Provider<ToolStore> {
  constructor(
    @inject.context()
    private readonly context: Context,
  ) {}
  async value(): Promise<ToolStore> {
    const bindings = this.context.findByTag({
      isTOOL: true,
    });
    if (bindings.length === 0) {
      return {
        list: [],
        map: {},
      };
    }
    const tools: IGraphTool[] = [];
    const toolMap: Record<string, IGraphTool> = {};
    for (const binding of bindings) {
      const toolInstance = await this.context.get<IGraphTool>(binding.key);
      tools.push(toolInstance);
      // Index by kebab key (LangGraph path, e.g. 'get-data-as-dataset')
      toolMap[toolInstance.key] = toolInstance;
      // Also index by class name (Mastra path, e.g. 'GetDataAsDatasetTool')
      // so saveStep / stream-handler can look up tool definitions by either name.
      const className = (toolInstance as object).constructor?.name;
      if (className && className !== toolInstance.key) {
        toolMap[className] = toolInstance;
      }
    }
    return {
      list: tools,
      map: toolMap,
    };
  }
}
