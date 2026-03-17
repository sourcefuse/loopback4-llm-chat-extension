/**
 * Run with: npx ts-node scripts/visualize-graph.ts
 * Outputs a Mermaid diagram of the DbQuery graph to stdout.
 * Paste the output into https://mermaid.live to visualize.
 */
import {Context} from '@loopback/core';
import {DbQueryGraph, DbQueryNodes} from '../src/components';
import {GRAPH_NODE_NAME} from '../src/constant';

async function main() {
  const context = new Context('visualize');
  context.bind('DbQueryGraph').toClass(DbQueryGraph);

  // Register dummy nodes for all enum values
  for (const key of Object.values(DbQueryNodes)) {
    context
      .bind(`services.${key}`)
      .to({execute: async (state: unknown) => state})
      .tag({[GRAPH_NODE_NAME]: key});
  }

  const graphBuilder = await context.get<DbQueryGraph>('DbQueryGraph');
  const compiled = await graphBuilder.build();
  const graph = compiled.getGraph();
  const mermaid = graph.drawMermaid();

  console.log(mermaid);
}

main().catch(console.error);
