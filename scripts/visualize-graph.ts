/**
 * Run with: npx ts-node scripts/visualize-graph.ts
 * Outputs a Mermaid diagram of the DbQuery graph to stdout.
 * Paste the output into https://mermaid.live to visualize.
 *
 * Uses subgraphs to enforce logical pipeline stage ordering,
 * since Mermaid's auto-layout can misplace nodes when shortcut
 * edges (like template → pre_validation) exist.
 */
import {Context} from '@loopback/core';
import {DbQueryGraph, DbQueryNodes} from '../src/components';
import {GRAPH_NODE_NAME} from '../src/constant';

// Pipeline stages in visual order — each group is rendered as a
// Mermaid subgraph so nodes within a stage sit at the same level.
const STAGES: {name: string; nodes: string[]}[] = [
  {
    name: 'Entry',
    nodes: [DbQueryNodes.IsImprovement],
  },
  {
    name: 'Cache & Tables',
    nodes: [
      DbQueryNodes.CheckCache,
      DbQueryNodes.GetTables,
      DbQueryNodes.CheckTemplates,
    ],
  },
  {
    name: 'Routing',
    nodes: [DbQueryNodes.PostCacheAndTables],
  },
  {
    name: 'Column Selection',
    nodes: [DbQueryNodes.GetColumns],
  },
  {
    name: 'Generation',
    nodes: [
      DbQueryNodes.GenerateChecklist,
      DbQueryNodes.SqlGeneration,
      DbQueryNodes.GenerateDescription,
      DbQueryNodes.VerifyChecklist,
    ],
  },
  {
    name: 'Validation',
    nodes: [
      DbQueryNodes.PreValidation,
      DbQueryNodes.SyntacticValidator,
      DbQueryNodes.SemanticValidator,
      DbQueryNodes.PostValidation,
    ],
  },
  {
    name: 'Output',
    nodes: [DbQueryNodes.SaveDataset, DbQueryNodes.Failed],
  },
];

function buildStageSubgraphs(rawMermaid: string): string {
  const lines = rawMermaid.split('\n');

  // Separate header, node declarations, edges, and class definitions
  const header: string[] = [];
  const nodeDecls: string[] = [];
  const edges: string[] = [];
  const classDefs: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('%%') || trimmed.startsWith('graph ')) {
      header.push(line);
    } else if (trimmed.startsWith('classDef')) {
      classDefs.push(line);
    } else if (trimmed.includes('-->') || trimmed.includes('-.')) {
      edges.push(line);
    } else if (trimmed.length > 0) {
      nodeDecls.push(line);
    }
  }

  // Build a set of all nodes placed in stages
  const stagedNodes = new Set(STAGES.flatMap(s => s.nodes));

  // Build node declaration lookup by node id
  const declMap = new Map<string, string>();
  for (const decl of nodeDecls) {
    const match = decl.trim().match(/^(\w+)[\[(]/);
    if (match) {
      declMap.set(match[1], decl);
    }
  }

  const output: string[] = [...header];

  // Emit subgraphs in order
  for (const stage of STAGES) {
    const stageId = stage.name.replace(/[^a-zA-Z0-9]/g, '_') + '_stage';
    output.push(`\tsubgraph ${stageId}["${stage.name}"]`);
    output.push(`\tdirection LR`);
    for (const nodeId of stage.nodes) {
      const decl = declMap.get(nodeId);
      if (decl) {
        output.push(`\t${decl.trim()}`);
      }
    }
    output.push(`\tend`);
  }

  // Emit any node declarations not in a stage (e.g. __start__, __end__)
  for (const decl of nodeDecls) {
    const match = decl.trim().match(/^(\w+)[\[(]/);
    if (match && !stagedNodes.has(match[1])) {
      output.push(decl);
    }
  }

  // Emit all edges
  for (const edge of edges) {
    output.push(edge);
  }

  // Emit class definitions and add transparent styling for subgraphs
  for (const classDef of classDefs) {
    output.push(classDef);
  }
  for (const stage of STAGES) {
    const stageId = stage.name.replace(/[^a-zA-Z0-9]/g, '_') + '_stage';
    output.push(`\tstyle ${stageId} fill:none,stroke:none;`);
  }

  return output.join('\n');
}

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
  const rawMermaid = graph.drawMermaid();

  const structured = buildStageSubgraphs(rawMermaid);
  console.log(structured);
}

main().catch(console.error);
