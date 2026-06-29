import {injectable} from '@loopback/core';
import {STEP_NAME, STEP_TAG} from '../constant';

/**
 * Mark a class as a workflow step bound by `key` (the Mastra-named successor of
 * `@graphNode`). Stamps the LB4 binding with `STEP: <key>` + `isSTEP: true` so
 * WorkflowRunner can discover it via `context.findByTag({STEP: key})` and
 * resolve the instance per request — the same tag-discovery seam `@graphTool`
 * uses for tools.
 *
 * A host app overrides a step by binding its own `@step('get-tables')` class
 * as a service: the workflow looks the step up by key, so the consumer's
 * implementation is resolved with no edit to the library workflow. The shell's
 * resolver rejects duplicate keys, so an override REPLACES (re-binds the same
 * key), it does not stack a second step.
 */
export function step(key: string): ClassDecorator {
  return function <T extends Function>(target: T) {
    injectable({
      tags: {
        [STEP_NAME]: key,
        [STEP_TAG]: true,
      },
    })(target);
  };
}
