import {expect} from '@loopback/testlab';
import {Binding, Context, createBindingFromClass} from '@loopback/core';
import {STEP_DEFAULT, STEP_NAME} from '../../constant';
import {step} from '../../decorators';
import {GetTablesStep} from '../../components/db-query/steps/get-tables.step';
import type {IWorkflowStep, WorkflowStepCtx} from '../../graphs/types';

/**
 * Locks in the host-override contract for DI-backed workflow steps: binding a
 * `@step(key)` class with the same key as a bundled step REPLACES it at run
 * time, with no need to unbind the default. This mirrors
 * WorkflowRunner.resolveWorkflowStep (tag lookup → prefer the non-default
 * binding) at the Context level, so the binding mechanics are proven end-to-end
 * without an app boot.
 */

// A consumer's replacement for the bundled `get-tables` step.
@step('get-tables')
class HostGetTablesStep implements IWorkflowStep {
  async execute() {
    return {tables: ['host_override']};
  }
}

// Same selection rule as WorkflowRunner.resolveWorkflowStep.
async function resolveStep(ctx: Context, key: string): Promise<IWorkflowStep> {
  const bindings = ctx.findByTag({[STEP_NAME]: key}) as Binding[];
  const overrides = bindings.filter(b => !b.tagMap[STEP_DEFAULT]);
  const chosen = overrides.length > 0 ? overrides : bindings;
  expect(chosen).to.have.length(1);
  return ctx.get<IWorkflowStep>(chosen[0].key);
}

const emptyCtx = {
  inputData: {},
  requestContext: {get: () => undefined},
  getStepResult: () => undefined,
} as unknown as WorkflowStepCtx;

describe('workflow step override (DI)', () => {
  it('prefers a host @step override over the bundled default', async () => {
    const ctx = new Context('test-override');
    // Bundled default (marked STEP_DEFAULT, as the component registers it)...
    ctx.add(createBindingFromClass(GetTablesStep).tag({[STEP_DEFAULT]: true}));
    // ...and the consumer's override (a plain @step('get-tables') service).
    ctx.add(createBindingFromClass(HostGetTablesStep));

    const resolved = await resolveStep(ctx, 'get-tables');
    expect(await resolved.execute(emptyCtx)).to.eql({
      tables: ['host_override'],
    });
  });

  it('uses the bundled default when no override is bound', async () => {
    const ctx = new Context('test-default');
    ctx.add(createBindingFromClass(GetTablesStep).tag({[STEP_DEFAULT]: true}));

    const resolved = await resolveStep(ctx, 'get-tables');
    // No SchemaStore bound → fail-soft empty set, the bundled behaviour.
    expect(await resolved.execute(emptyCtx)).to.eql({tables: []});
  });
});
