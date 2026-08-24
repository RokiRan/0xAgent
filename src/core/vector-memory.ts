// ============================================================
// Core: Vector Memory (Lightweight RAG)
// No external vector DB. Simple embedding + cosine similarity.
// ============================================================

export interface MemoryDocument {
  id: string;
  content: string;
  embedding: number[];
  metadata?: Record<string, unknown>;
  createdAt: number;
}

export interface MemorySearchResult {
  document: MemoryDocument;
  score: number;
}

// Simple embedding: term frequency vector (character n-grams)
// Good enough for semantic-like search without external API calls
export class SimpleEmbedder {
  private vocab = new Map<string, number>();
  private vocabSize = 0;
  private readonly n = 3; // character trigrams

  embed(text: string): number[] {
    const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
    const grams = this.extractNGrams(normalized);

    // Build/update vocab on first use
    for (const g of grams) {
      if (!this.vocab.has(g)) {
        this.vocab.set(g, this.vocabSize++);
      }
    }

    // Term frequency vector
    const vec = new Array(this.vocabSize).fill(0);
    for (const g of grams) {
      const idx = this.vocab.get(g)!;
      vec[idx]++;
    }

    return this.normalize(vec);
  }

  private extractNGrams(text: string): string[] {
    const grams: string[] = [];
    for (let i = 0; i <= text.length - this.n; i++) {
      grams.push(text.slice(i, i + this.n));
    }
    return grams;
  }

  private normalize(vec: number[]): number[] {
    const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    if (magnitude === 0) return vec;
    return vec.map(v => v / magnitude);
  }
}

export class VectorMemory {
  private documents: MemoryDocument[] = [];
  private embedder = new SimpleEmbedder();

  add(content: string, metadata?: Record<string, unknown>): MemoryDocument {
    const doc: MemoryDocument = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      content,
      embedding: this.embedder.embed(content),
      metadata,
      createdAt: Date.now(),
    };
    this.documents.push(doc);
    return doc;
  }

  // filter applies BEFORE the topK slice — slicing first would let
  // out-of-scope docs evict in-scope ones from the candidate window
  search(query: string, topK = 5, filter?: (doc: MemoryDocument) => boolean): MemorySearchResult[] {
    const queryEmbedding = this.embedder.embed(query);

    const scored = this.documents
      .filter((doc) => (filter ? filter(doc) : true))
      .map(doc => ({
        document: doc,
        score: this.cosineSimilarity(queryEmbedding, doc.embedding),
      }));

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).filter(s => s.score > 0.1);
  }

  searchByEmbedding(embedding: number[], topK = 5): MemorySearchResult[] {
    const scored = this.documents.map(doc => ({
      document: doc,
      score: this.cosineSimilarity(embedding, doc.embedding),
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).filter(s => s.score > 0.1);
  }

  delete(id: string): boolean {
    const idx = this.documents.findIndex(d => d.id === id);
    if (idx >= 0) {
      this.documents.splice(idx, 1);
      return true;
    }
    return false;
  }

  clear(): void {
    this.documents = [];
  }

  list(): MemoryDocument[] {
    return [...this.documents];
  }

  // Batch add for efficiency
  addBatch(contents: Array<{ content: string; metadata?: Record<string, unknown> }>): MemoryDocument[] {
    return contents.map(c => this.add(c.content, c.metadata));
  }

  // Export/import for persistence
  export(): MemoryDocument[] {
    return this.list();
  }

  import(docs: MemoryDocument[]): void {
    for (const doc of docs) {
      // Re-embed if dimensions mismatch
      if (!this.documents.find(d => d.id === doc.id)) {
        this.documents.push({
          ...doc,
          embedding: this.embedder.embed(doc.content),
        });
      }
    }
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    const minLen = Math.min(a.length, b.length);
    let dot = 0;
    for (let i = 0; i < minLen; i++) {
      dot += a[i] * b[i];
    }
    return dot;
  }
}

// --- Thread-aware memory store ---
import { Thread, Turn, Item } from './thread.js';

export class ThreadMemory {
  private vectorMemory = new VectorMemory();

  // Index all messages from a thread
  indexThread(thread: Thread): void {
    for (const turn of thread.turns) {
      for (const item of turn.items) {
        if (item.type === 'message' && item.content) {
          this.vectorMemory.add(item.content, {
            threadId: thread.id,
            turnId: turn.id,
            itemId: item.id,
            role: item.role,
          });
        }
      }
    }
  }

  // Search indexed threads; pass threadId to isolate to one conversation
  // (default is unfiltered for explicit memory/search tooling).
  // Filter runs before the topK slice inside VectorMemory — no over-fetch heuristic.
  search(query: string, topK = 5, threadId?: string): Array<{
    content: string;
    score: number;
    threadId: string;
    turnId: string;
    role?: string;
  }> {
    const results = this.vectorMemory.search(
      query,
      topK,
      threadId ? (doc) => String(doc.metadata?.threadId ?? '') === threadId : undefined
    );
    return results.map(r => ({
      content: r.document.content,
      score: r.score,
      threadId: String(r.document.metadata?.threadId ?? ''),
      turnId: String(r.document.metadata?.turnId ?? ''),
      role: String(r.document.metadata?.role ?? ''),
    }));
  }

  // Get relevant context for a query (for prompt augmentation).
  // threadId scopes retrieval to the current conversation — cross-thread
  // recall stays available via the explicit memory/search API.
  getRelevantContext(query: string, maxTokens = 2000, threadId?: string): string {
    const results = this.search(query, 5, threadId);
    if (results.length === 0) return '';

    let context = 'Relevant previous context:\n';
    let tokens = 0;

    for (const r of results) {
      const entry = `[${r.role}]: ${r.content}\n`;
      tokens += entry.length / 2; // rough estimate
      if (tokens > maxTokens) break;
      context += entry;
    }

    return context;
  }

  clear(): void {
    this.vectorMemory.clear();
  }
}
