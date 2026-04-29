import {injectable} from '@loopback/core';
import {TOOL_NAME, TOOL_TAG} from '../constant';

export type GraphToolMetadata = {
  /**
   * Human-readable description shown to the LLM when deciding which tool to call.
   * Stored as a binding tag so the Mastra bridge factory can read it at startup
   * WITHOUT resolving the tool instance (which may have request-scoped dependencies).
   */
  description?: string;
  /**
   * Zod schema describing the tool's input, stored as a binding tag for the same reason.
   * Typed as `unknown` to avoid a hard dependency on `zod` in the decorator module.
   */
  inputSchema?: unknown;
};

export function graphTool(metadata?: GraphToolMetadata): ClassDecorator {
  return function <T extends Function>(target: T) {
    injectable({
      tags: {
        [TOOL_NAME]: target.name,
        [TOOL_TAG]: true,
        ...(metadata?.description !== undefined && {
          toolDescription: metadata.description,
        }),
        ...(metadata?.inputSchema !== undefined && {
          toolInputSchema: metadata.inputSchema,
        }),
      },
    })(target);
  };
}
