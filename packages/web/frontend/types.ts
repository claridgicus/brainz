// API payload shapes as consumed by the frontend (mirrors src/app.ts output).

export interface ApiNode {
  id: string;
  title: string;
  type: string; // concept type or "pending"
  product?: string;
  tags: string[];
  degree: number;
  pending?: boolean;
}

export interface ApiEdge {
  from: string;
  to: string;
  relation: string;
}

export interface GraphPayload {
  nodes: ApiNode[];
  edges: ApiEdge[];
}

export interface ConceptDetail {
  id: string;
  title: string;
  type: string;
  status: string;
  product?: string;
  tags: string[];
  body: string;
  neighbors: { id: string; title: string; type: string; distance: number }[];
  edges: { outgoing: ApiEdge[]; incoming: ApiEdge[] };
}

export interface StatsPayload {
  name: string;
  dir: string;
  concepts: number;
  edges: number;
  products: string[];
  tags: string[];
  byType: Record<string, number>;
  embeddingStatus: "ready" | "unavailable";
}

export interface SearchHitPayload {
  concept: { id: string; title: string; type: string; product?: string; tags: string[] };
  score: number;
  snippet: string;
}
