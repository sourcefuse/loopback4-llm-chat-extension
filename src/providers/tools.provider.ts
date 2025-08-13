import {
  BindingScope,
  Context,
  inject,
  injectable,
  Provider,
} from '@loopback/core';
import {IGraphTool} from '../graphs/types';
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
      toolMap[toolInstance.key] = toolInstance;
    }
    return {
      list: tools,
      map: toolMap,
    };
  }
}
