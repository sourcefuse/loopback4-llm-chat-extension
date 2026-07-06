// Test-only node registries. Production discovers nodes by `@graphNode(key)`
// tag from the LB4 container (WorkflowRunner.resolveGraphNode); these arrays/maps
// let unit + integration tests bind or look up node classes WITHOUT booting the
// container. They live in the test layer so the production `nodes/index.ts`
// barrels stay pure re-exports (matching the LangGraph structure).
import type {IGraphNode} from '../../graphs/types';
import {DbQueryNodes} from '../../components/db-query/nodes.enum';
import {VisualizationGraphNodes} from '../../components/visualization/nodes.enum';
import {
  CheckCacheNode,
  CheckTemplatesNode,
  FailedNode,
  FixQueryNode,
  GenerateChecklistNode,
  GetColumnsNode,
  GetTablesNode,
  ImproveFailedNode,
  LoadExistingNode,
  PostCacheAndTablesNode,
  ReturnCachedNode,
  SaveDataSetNode,
  SaveDatasetFromTemplateNode,
  SaveImprovedNode,
  SqlAndValidateNode,
  VerifyChecklistNode,
} from '../../components/db-query/nodes';
import {
  CallQueryGenerationNode,
  GetDatasetDataNode,
  RenderVisualizationNode,
  SelectVisualizationNode,
} from '../../components/visualization/nodes';

export const DB_QUERY_NODE_CLASSES: Array<new () => IGraphNode> = [
  CheckCacheNode,
  CheckTemplatesNode,
  FailedNode,
  FixQueryNode,
  GenerateChecklistNode,
  GetColumnsNode,
  GetTablesNode,
  ImproveFailedNode,
  LoadExistingNode,
  PostCacheAndTablesNode,
  ReturnCachedNode,
  SaveDataSetNode,
  SaveDatasetFromTemplateNode,
  SaveImprovedNode,
  SqlAndValidateNode,
  VerifyChecklistNode,
];

export const VISUALIZATION_NODE_CLASSES: Array<new () => IGraphNode> = [
  SelectVisualizationNode,
  CallQueryGenerationNode,
  GetDatasetDataNode,
  RenderVisualizationNode,
];

export const DB_QUERY_NODE_BY_KEY: Record<string, new () => IGraphNode> = {
  [DbQueryNodes.CheckCache]: CheckCacheNode,
  [DbQueryNodes.CheckTemplates]: CheckTemplatesNode,
  [DbQueryNodes.Failed]: FailedNode,
  [DbQueryNodes.FixQuery]: FixQueryNode,
  [DbQueryNodes.GenerateChecklist]: GenerateChecklistNode,
  [DbQueryNodes.GetColumns]: GetColumnsNode,
  [DbQueryNodes.GetTables]: GetTablesNode,
  [DbQueryNodes.ImproveFailed]: ImproveFailedNode,
  [DbQueryNodes.LoadExisting]: LoadExistingNode,
  [DbQueryNodes.PostCacheAndTables]: PostCacheAndTablesNode,
  [DbQueryNodes.ReturnCached]: ReturnCachedNode,
  [DbQueryNodes.SaveDataset]: SaveDataSetNode,
  [DbQueryNodes.SaveFromTemplate]: SaveDatasetFromTemplateNode,
  [DbQueryNodes.SaveImproved]: SaveImprovedNode,
  [DbQueryNodes.SqlAndValidate]: SqlAndValidateNode,
  [DbQueryNodes.VerifyChecklist]: VerifyChecklistNode,
};

export const VISUALIZATION_NODE_BY_KEY: Record<string, new () => IGraphNode> = {
  [VisualizationGraphNodes.SelectVisualisation]: SelectVisualizationNode,
  [VisualizationGraphNodes.CallQueryGeneration]: CallQueryGenerationNode,
  [VisualizationGraphNodes.GetDatasetData]: GetDatasetDataNode,
  [VisualizationGraphNodes.RenderVisualization]: RenderVisualizationNode,
};
