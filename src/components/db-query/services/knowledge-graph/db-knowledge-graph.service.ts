import {RunnableSequence} from '@langchain/core/runnables';
import {BindingScope, inject, injectable} from '@loopback/core';
import {AnyObject} from '@loopback/repository';
import {AiIntegrationBindings} from '../../../../keys';
import {EmbeddingProvider, LLMProvider} from '../../../../types';
import {stripThinkingTokens} from '../../../../utils';
import {DbQueryAIExtensionBindings} from '../../keys';
import {DatabaseSchema, DbQueryConfig, TableSchema} from '../../types';
import {
  CLUSTER_THRESHOLD,
  CONCEPT_THRESHOLD,
  GRAPH_WEIGHT,
  MAX_CLUSTER_SIZE,
  VECTOR_WEIGHT,
} from './constants';
import {Concept, GraphEdge, GraphNode, KnowledgeGraph} from './types';

const debug = require('debug')('ai-integration:knowledge-graph');

@injectable({scope: BindingScope.SINGLETON})
export class DbKnowledgeGraphService implements KnowledgeGraph<
  string,
  DatabaseSchema
> {
  edges: Map<string, GraphEdge[]>;
  nodes: Map<string, GraphNode>;
  private vectorWeight: number;
  private graphWeight: number;
  private clusterThreshold: number;
  private conceptThreshold: number;
  private maxStrength = 0.9;
  private defaultConfidence = 0.5;
  private confidenceOffset = 0.2; // Offset to apply to confidence scores
  private maxClusterSize: number; // Max size of clusters to consider for concept extraction

  constructor(
    @inject(AiIntegrationBindings.CheapLLM)
    private readonly llm: LLMProvider,
    @inject(AiIntegrationBindings.EmbeddingModel)
    private readonly embeddingModel: EmbeddingProvider,
    @inject(DbQueryAIExtensionBindings.Config)
    private readonly config: DbQueryConfig,
  ) {
    this.edges = new Map<string, GraphEdge[]>();
    this.nodes = new Map<string, GraphNode>();
    this.vectorWeight = config.knowledgeGraph?.vectorWeight ?? VECTOR_WEIGHT;
    this.graphWeight = config.knowledgeGraph?.graphWeight ?? GRAPH_WEIGHT;
    this.clusterThreshold =
      config.knowledgeGraph?.clusterThreshold ?? CLUSTER_THRESHOLD;
    this.conceptThreshold =
      config.knowledgeGraph?.conceptThreshold ?? CONCEPT_THRESHOLD;
    this.maxClusterSize =
      config.knowledgeGraph?.maxClusterSize ?? MAX_CLUSTER_SIZE; // Default max cluster size
  }

  async find(query: string, topK: number): Promise<string[]> {
    debug(`Selecting tables for query: "${query}"`);

    // Step 1: Generate query embedding
    const queryEmbedding = await this.generateEmbedding(query);

    // Step 2: Find initial candidates using vector similarity
    const candidates = await this.findVectorCandidates(
      queryEmbedding,
      topK * 2,
    );

    // Step 3: Expand using graph traversal
    const expandedCandidates = await this.expandWithGraphTraversal(
      candidates,
      query,
    );

    // Step 4: Rank final results
    const rankedTables = await this.rankTables(
      expandedCandidates,
      query,
      queryEmbedding,
    );

    return rankedTables.slice(0, topK);
  }

  private async findVectorCandidates(
    queryEmbedding: number[],
    limit: number,
  ): Promise<Array<{id: string; score: number}>> {
    const candidates: Array<{id: string; score: number}> = [];

    for (const [nodeId, node] of this.nodes.entries()) {
      if (node.type === 'table' && node.embedding) {
        const similarity = this.cosineSimilarity(
          queryEmbedding,
          node.embedding,
        );
        candidates.push({id: nodeId, score: similarity});
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, limit);
  }

  private async expandWithGraphTraversal(
    candidates: Array<{id: string; score: number}>,
    query: string,
  ): Promise<Array<{id: string; score: number}>> {
    const expanded = new Map<string, number>();
    const visited = new Set<string>();

    // Add initial candidates
    for (const candidate of candidates) {
      expanded.set(candidate.id, candidate.score);
    }

    // Traverse graph from each candidate
    for (const candidate of candidates) {
      await this.dfsTraversal(
        candidate.id,
        expanded,
        visited,
        candidate.score,
        2,
        query,
      );
    }

    return Array.from(expanded.entries()).map(([id, score]) => ({id, score}));
  }

  private async dfsTraversal(
    nodeId: string,
    expanded: Map<string, number>,
    visited: Set<string>,
    currentScore: number,
    depth: number,
    query: string,
  ): Promise<void> {
    if (depth <= 0 || visited.has(nodeId)) return;

    visited.add(nodeId);
    const edges = this.edges.get(nodeId) ?? [];

    for (const edge of edges) {
      const neighborId = edge.to;
      const neighbor = this.nodes.get(neighborId);

      if (!neighbor || neighbor.type !== 'table') continue;

      // Calculate propagated score with decay
      const decayFactor = 0.7; // Reduce score as we traverse
      const edgeWeight = edge.weight;
      const propagatedScore = currentScore * decayFactor * edgeWeight;

      // Update score if better
      const existingScore = expanded.get(neighborId) ?? 0;
      if (propagatedScore > existingScore) {
        expanded.set(neighborId, Math.max(propagatedScore, existingScore));
      }

      // Continue traversal
      await this.dfsTraversal(
        neighborId,
        expanded,
        visited,
        propagatedScore,
        depth - 1,
        query,
      );
    }
  }

  private async rankTables(
    candidates: Array<{id: string; score: number}>,
    query: string,
    queryEmbedding: number[],
  ): Promise<string[]> {
    // Combine vector similarity with graph scores
    const scoredCandidates = candidates.map(candidate => {
      const node = this.nodes.get(candidate.id);
      if (!node?.embedding)
        return {id: candidate.id, finalScore: candidate.score};

      const vectorSimilarity = this.cosineSimilarity(
        queryEmbedding,
        node.embedding,
      );
      const graphScore = candidate.score;

      // Weighted combination
      const finalScore =
        vectorSimilarity * this.vectorWeight + graphScore * this.graphWeight;

      return {id: candidate.id, finalScore};
    });

    // Sort by final score
    scoredCandidates.sort((a, b) => b.finalScore - a.finalScore);
    // Return top candidate ids
    return scoredCandidates.map(c => c.id);
  }

  async seed(schema: DatabaseSchema): Promise<void> {
    const tables = schema.tables;
    // Add table nodes
    for (const tableName of Object.keys(tables)) {
      const table = tables[tableName];
      const tableNode: GraphNode = {
        id: tableName,
        type: 'table',
        properties: {
          name: tableName,
          description: table.description,
          columns: table.columns,
        },
      };

      // Generate embedding for table
      tableNode.embedding = await this.generateEmbedding(
        `${tableName}: ${table.description}\n${table.context.join('\n')}`,
      );

      this.nodes.set(tableName, tableNode);

      // Add column nodes
      for (const columnName of Object.keys(table.columns)) {
        const columnId = `${tableName}.${columnName}`;
        const column = table.columns[columnName];
        const columnNode: GraphNode = {
          id: columnId,
          type: 'column',
          properties: {
            name: columnName,
            type: column.type,
            description: column.description,
            parentTable: tableName,
          },
        };

        this.nodes.set(columnId, columnNode);

        // Add table-column relationship
        this.addEdge(tableName, columnId, 'contains', 1.0);
      }
    }

    // Add relationships between tables
    for (const rel of schema.relations) {
      this.addEdge(rel.table, rel.referencedTable, `relates_to`, 1.0, {
        description: rel.description,
      });
      this.addEdge(
        `${rel.table}.${rel.column}`,
        `${rel.referencedTable}.${rel.referencedColumn}`,
        'foreign_key',
        1.0,
        {
          description: rel.description,
        },
      );
    }

    // Extract semantic concepts and relationships
    await this.extractConceptsWithClustering(schema);
  }

  private async generateEmbedding(text: string): Promise<number[]> {
    return this.embeddingModel.embedDocuments([text]).then(embeddings => {
      if (embeddings.length === 0 || !embeddings[0]) {
        throw new Error('Failed to generate embedding');
      }
      return embeddings[0];
    });
  }

  // Smart concept extraction using clustering
  private async extractConceptsWithClustering(
    schema: DatabaseSchema,
  ): Promise<void> {
    debug('Extracting concepts using clustering approach...');

    // Step 1: Cluster tables by similarity
    const clusters = await this.clusterTablesByEmbeddings(schema);

    debug(
      `Found ${clusters.length} clusters of related tables for concept extraction.`,
    );

    // Step 2: Extract concepts from each cluster
    for (const [clusterIndex, cluster] of clusters.entries()) {
      debug(
        `Processing cluster ${clusterIndex + 1}/${clusters.length} (${cluster.length} tables)`,
      );

      if (cluster.length < 2) {
        debug(
          `Skipping cluster ${clusterIndex + 1} with only ${cluster.length} table(s)`,
        );
        continue;
      } // Skip single-table clusters

      try {
        await this.extractConceptFromCluster(cluster, clusterIndex);
      } catch (error) {
        debug(`Error processing cluster ${clusterIndex}:`, error);
      }
    }
  }

  private async clusterTablesByEmbeddings(
    schema: DatabaseSchema,
  ): Promise<[string, TableSchema][][]> {
    // Simple clustering: group by embedding similarity
    const clusters: [string, TableSchema][][] = [];
    const processed = new Set<string>();

    for (const [tableName, table] of Object.entries(schema.tables)) {
      debug(`Processing table: ${tableName}`);
      if (processed.has(tableName)) continue;

      const cluster: [string, TableSchema][] = [[tableName, table]];
      processed.add(tableName);

      const tableNode = this.nodes.get(tableName);
      if (!tableNode?.embedding) continue;

      // Find similar tables
      for (const [otherTableName, otherTable] of Object.entries(
        schema.tables,
      )) {
        debug(`    Comparing with: ${otherTableName}`);
        this._compareTables(
          processed,
          cluster,
          tableNode,
          otherTableName,
          otherTable,
        );
      }

      clusters.push(cluster);
    }

    return clusters.filter(cluster => cluster.length > 1); // Only multi-table clusters
  }

  private _compareTables(
    processed: Set<string>,
    cluster: [string, TableSchema][],
    tableNode: GraphNode,
    otherTableName: string,
    otherTable: TableSchema,
  ): void {
    if (
      processed.has(otherTableName) ||
      cluster.length >= this.maxClusterSize ||
      !tableNode.embedding
    )
      return;

    const otherNode = this.nodes.get(otherTableName);
    if (!otherNode?.embedding) return;

    const similarity = this.cosineSimilarity(
      tableNode.embedding,
      otherNode.embedding,
    );

    if (similarity < this.clusterThreshold) return; // Skip low similarity

    if (similarity > this.clusterThreshold) {
      // Similarity threshold
      cluster.push([otherTableName, otherTable]);
      processed.add(otherTableName);
    }
  }

  private async extractConceptFromCluster(
    cluster: [string, TableSchema][],
    clusterIndex: number,
  ): Promise<void> {
    const prompt = `
Analyze this cluster of related database tables and identify the main semantic concept that unifies them:


${cluster
  .map(
    ([name, table]) => `Table: ${name}
Description: ${table.description}
Key columns: ${Object.entries(table.columns)
      .slice(0, 4)
      .map((cname, c) => cname)
      .join(', ')}`,
  )
  .join('\n\n')}

Return a single JSON object for the main concept with following structure:
{
  "concept": "main_concept_name", 
  "description": "what unifies these tables",
  "domain": "business_domain",
  "confidence": 0.8
}

The output should be JUST a valid JSON and no other markdown or formatting text.
Focus on the core business concept or data domain. AGAIN, ensure the output is a valid JSON object with no additional text or formatting that can be parsed directly.`;

    try {
      const chain = RunnableSequence.from([this.llm, stripThinkingTokens]);
      const response = await chain.invoke([{role: 'user', content: prompt}]);

      debug(`Extracted concept for cluster ${clusterIndex}:`, response);
      const concept = JSON.parse(response);

      if (concept.concept && concept.confidence > this.conceptThreshold) {
        await this.addConceptToGraph({
          ...concept,
          relatedTables: cluster.map(([tname, t]) => tname),
        });
      }
    } catch (error) {
      debug(`Error extracting concept from cluster ${clusterIndex}:`, error);
    }
  }

  private async addConceptToGraph(concept: Concept): Promise<void> {
    const conceptId = `concept_${concept.concept.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;

    const conceptNode: GraphNode = {
      id: conceptId,
      type: 'concept',
      properties: {
        name: concept.concept,
        description: concept.description,
        confidence: concept.confidence || this.defaultConfidence,
      },
    };

    // Generate embedding
    conceptNode.embedding = await this.generateEmbedding(
      `${concept.concept}: ${concept.description}`,
    );

    // Add to graph
    this.nodes.set(conceptId, conceptNode);

    // Link to related tables
    for (const tableId of concept.relatedTables) {
      if (this.nodes.has(tableId)) {
        const strength = Math.min(
          this.maxStrength,
          (concept.confidence || this.defaultConfidence) +
            this.confidenceOffset,
        );
        this.addEdge(conceptId, tableId, 'relates_to', strength);
      }
    }
  }

  private addEdge(
    from: string,
    to: string,
    type: string,
    weight: number,
    properties?: AnyObject,
  ): void {
    const edge: GraphEdge = {from, to, type, weight, properties};

    if (!this.edges.has(from)) {
      this.edges.set(from, []);
    }
    this.edges.get(from)!.push(edge);

    // Add reverse edge for undirected relationships
    if (type === 'semantic' || type === 'relates_to') {
      if (!this.edges.has(to)) {
        this.edges.set(to, []);
      }
      this.edges.get(to)!.push({from: to, to: from, type, weight, properties});
    }
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  toJSON(): string {
    const nodesArray = Array.from(this.nodes.values());
    const edgesArray = Array.from(this.edges.entries()).flatMap(
      ([from, edges]) =>
        edges.map(edge => ({
          ...edge,
          from,
        })),
    );

    return JSON.stringify({nodes: nodesArray, edges: edgesArray});
  }

  fromJSON(json: string): void {
    const data = JSON.parse(json);
    this.nodes.clear();
    this.edges.clear();

    for (const node of data.nodes) {
      this.nodes.set(node.id, node);
    }

    for (const edge of data.edges) {
      if (!this.edges.has(edge.from)) {
        this.edges.set(edge.from, []);
      }
      this.edges.get(edge.from)!.push(edge);
    }
  }
}
