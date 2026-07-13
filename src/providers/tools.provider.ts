import {
  BindingScope,
  Context,
  inject,
  injectable,
  Provider,
} from '@loopback/core';
import {TOOL_TAG} from '../constant';
import type {IGraphTool} from '../graphs/types';
import type {ToolStore} from '../types';

const debug = require('debug')('ai-integration:mastra:tools');

@injectable({scope: BindingScope.REQUEST})
export class ToolsProvider implements Provider<ToolStore> {
  constructor(
    @inject.context()
    private readonly context: Context,
  ) {}

  async value(): Promise<ToolStore> {
    const bindings = this.context.findByTag({[TOOL_TAG]: true});
    const list: IGraphTool[] = [];
    const map: Record<string, IGraphTool> = {};
    for (const binding of bindings) {
      try {
        const tool = await this.context.get<IGraphTool>(binding.key);
        if (!tool?.key) continue;
        list.push(tool);
        map[tool.key] = tool;
      } catch (err) {
        // A tagged tool whose deps aren't bound (component not mounted) is
        // skipped rather than failing the whole registry resolution.
        debug('skipping tool %s — failed to resolve: %o', binding.key, err);
      }
    }
    return {list, map};
  }
}
