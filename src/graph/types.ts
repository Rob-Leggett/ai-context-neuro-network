export type NodeKind = 'concept' | 'entity' | 'decision' | 'pattern' | 'topic';
export type SourceKind = 'chatgpt' | 'copilot' | 'mcp' | 'manual';

export interface GraphNode {
  id: number;
  key: string;
  label: string;
  kind: NodeKind;
  summary: string | null;
  weight: number;
  mentions: number;
  created_at: number;
  updated_at: number;
  meta: Record<string, unknown> | null;
}

export interface GraphEdge {
  id: number;
  src: number;
  dst: number;
  kind: string;
  weight: number;
  created_at: number;
  updated_at: number;
  meta: Record<string, unknown> | null;
}

export interface Source {
  id: number;
  kind: SourceKind;
  external_id: string | null;
  title: string | null;
  created_at: number;
  meta: Record<string, unknown> | null;
}

export interface GraphEvent {
  type: 'node' | 'edge' | 'reset';
  node?: GraphNode;
  edge?: GraphEdge;
}
