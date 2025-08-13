import {AnyObject} from '@loopback/repository';

// Types and Interfaces
export interface TableNode {
  id: string;
  name: string;
  description: string;
  columns: ColumnInfo[];
  embedding?: number[];
}

export interface ColumnInfo {
  name: string;
  type: string;
  description?: string;
}

export interface Relationship {
  from: string;
  to: string;
  type: 'foreign_key' | 'semantic' | 'hierarchical';
  strength: number; // 0-1 confidence score
  description?: string;
}

export interface GraphNode {
  id: string;
  type: 'table' | 'column' | 'concept';
  properties: AnyObject;
  embedding?: number[];
}

export interface GraphEdge {
  from: string;
  to: string;
  type: string;
  weight: number;
  properties?: AnyObject;
}

export interface Graph {
  nodes: Map<string, GraphNode>;
  edges: Map<string, GraphEdge[]>;
}

export interface KnowledgeGraph<T, S> extends Graph {
  toJSON(): string;
  fromJSON(json: string): void;
  find(query: string, count: number): Promise<T[]>;
  seed(data: S): Promise<void>;
}

export type Concept = {
  concept: string;
  description: string;
  domain: string;
  confidence: number;
  relatedTables: string[];
};
