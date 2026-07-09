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

/**
 * Default Mastra tool registry. Tools are discovered DYNAMICALLY by tag
 * (`@graphTool()` stamps `isTOOL: true`) instead of being hardcoded — so a
 * consumer adds a tool simply by binding a `@graphTool()`-decorated class as a
 * service, with no edit to this provider (restores the v2 tag-based discovery).
 *
 * The four built-in tools (get-data, improve-dataset, ask-about-dataset,
 * generate-visualization) are registered the same way. A tool whose
 * dependencies are not bound (e.g. DbQueryComponent / VisualizerComponent not
 * mounted) fails to resolve and is skipped, so the store stays resolvable in
 * partial mounts.
 *
 * SINGLETON so the underlying tool instances (which carry their own DI) are
 * constructed once and re-used per request.
 */
@injectable({scope: BindingScope.SINGLETON})
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
