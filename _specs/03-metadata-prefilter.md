# Spec 03 — Metadata Pre-Filter for Search

**Priority:** P3 (Medium effort, High impact)
**Files modified:** `src/sidekickView.ts`, `src/types.ts`
**New files:** `src/vaultIndex.ts`
**Dependencies:** None (but P4 and P5 will build on `VaultIndex`)

---

## Problem

Search sends the entire scope directory to the LLM, which must read and rank all files
from scratch. For a vault with 500+ files, this is slow, expensive, and often hits the
120-second timeout.

Obsidian's `app.metadataCache` already indexes every markdown file in the vault
(frontmatter, headings, links, tags, sections) — but Sidekick never uses it.

### Current Implementation

```
handleBasicSearch(query):
  searchPrompt = "Perform semantic search..." + query
  attachments = [{type: 'directory', path: scopePath}]
  session.sendAndWait({prompt, attachments}, 120_000)
  → LLM receives entire directory, reads all files, ranks from scratch
```

---

## Design

### New Module: `src/vaultIndex.ts`

A thin wrapper around `app.metadataCache` that provides query-oriented access.
No custom indexing, no persistence — it's a view layer over Obsidian's built-in cache.

```typescript
import { App, TFile, TFolder, CachedMetadata, normalizePath } from 'obsidian';

export interface NoteMetadata {
  path: string;
  name: string;           // filename without extension
  folder: string;         // parent folder path
  tags: string[];         // merged frontmatter + inline tags
  aliases: string[];      // from frontmatter
  headings: string[];     // all heading texts, flat
  links: string[];        // outgoing wikilink targets (resolved paths)
  backlinks: string[];    // files linking TO this file (resolved paths)
  frontmatter: Record<string, unknown> | undefined;
  mtime: number;          // last modified timestamp
  size: number;           // file size in bytes
}

export interface SearchCandidate {
  note: NoteMetadata;
  score: number;
  matchReasons: string[];
}

export class VaultIndex {
  constructor(private app: App) {}

  /** Get metadata for a single file (from metadataCache). */
  getNoteMetadata(file: TFile): NoteMetadata { ... }

  /** Get metadata for all markdown files within a scope (folder paths). */
  getNotesInScope(scopePaths: string[]): NoteMetadata[] { ... }

  /** 
   * Local pre-filter: score notes against a query using metadata only.
   * No file content read, no LLM call.
   * Returns candidates sorted by score (descending).
   */
  preFilter(query: string, scopePaths: string[], limit?: number): SearchCandidate[] { ... }

  /**
   * Get files that link to or from a given file path.
   * Uses metadataCache.resolvedLinks.
   */
  getLinkedFiles(filePath: string): { forward: string[]; backward: string[] } { ... }

  /**
   * Get all unique tags within a scope.
   */
  getTagsInScope(scopePaths: string[]): Map<string, number> { ... }
}
```

### Pre-Filter Scoring Algorithm

The pre-filter uses a simple weighted scoring model. All scoring happens locally
using metadata — no file reads, no LLM calls.

```typescript
preFilter(query: string, scopePaths: string[], limit = 25): SearchCandidate[] {
  const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 1);
  const notes = this.getNotesInScope(scopePaths);
  const candidates: SearchCandidate[] = [];

  for (const note of notes) {
    let score = 0;
    const reasons: string[] = [];

    // 1. Filename match (highest weight)
    const nameLower = note.name.toLowerCase();
    for (const term of queryTerms) {
      if (nameLower.includes(term)) {
        score += 5;
        reasons.push(`filename:${term}`);
      }
    }

    // 2. Alias match
    for (const alias of note.aliases) {
      const aliasLower = alias.toLowerCase();
      for (const term of queryTerms) {
        if (aliasLower.includes(term)) {
          score += 4;
          reasons.push(`alias:${term}`);
        }
      }
    }

    // 3. Tag match
    for (const tag of note.tags) {
      const tagLower = tag.toLowerCase().replace('#', '');
      for (const term of queryTerms) {
        if (tagLower.includes(term)) {
          score += 3;
          reasons.push(`tag:${tag}`);
        }
      }
    }

    // 4. Heading match
    for (const heading of note.headings) {
      const headingLower = heading.toLowerCase();
      for (const term of queryTerms) {
        if (headingLower.includes(term)) {
          score += 2;
          reasons.push(`heading:${heading}`);
        }
      }
    }

    // 5. Folder path match
    const folderLower = note.folder.toLowerCase();
    for (const term of queryTerms) {
      if (folderLower.includes(term)) {
        score += 1;
        reasons.push(`folder:${note.folder}`);
      }
    }

    // 6. Recency bonus (modified within last 7 days)
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    if (note.mtime > weekAgo) {
      score += 1;
      reasons.push('recent');
    }

    if (score > 0) {
      candidates.push({ note, score, matchReasons: reasons });
    }
  }

  // Sort by score descending, then by mtime descending
  candidates.sort((a, b) => b.score - a.score || b.note.mtime - a.note.mtime);

  return limit ? candidates.slice(0, limit) : candidates;
}
```

### Integration with Search

#### Basic Search (Hybrid: local pre-filter + LLM re-rank)

```typescript
async handleBasicSearch(query: string): Promise<void> {
  // Phase 1: Local pre-filter (instant)
  const candidates = this.vaultIndex.preFilter(query, this.scopePaths, 25);

  if (candidates.length === 0) {
    // No metadata matches — fall back to full LLM search (existing behavior)
    return this.handleBasicSearchFull(query);
  }

  // Phase 2: Build compact summaries for LLM re-ranking
  const summaries = candidates.map(c => ({
    file: c.note.path,
    folder: c.note.folder,
    tags: c.note.tags.slice(0, 5),
    headings: c.note.headings.slice(0, 5),
    matchReasons: c.matchReasons,
    score: c.score,
  }));

  // Phase 3: LLM re-ranks the pre-filtered candidates (much cheaper)
  const reRankPrompt = [
    'Re-rank these search candidates by relevance to the query.',
    'Return ONLY a JSON array of objects with "file", "folder", and "reason".',
    'Sort by relevance (best first). No markdown fences, no extra text.',
    '',
    `Query: ${query}`,
    '',
    'Candidates:',
    JSON.stringify(summaries, null, 2),
  ].join('\n');

  // Send only the summaries, not the entire directory
  const response = await this.basicSearchSession.sendAndWait({
    prompt: reRankPrompt,
    // NO directory attachment — candidates already narrowed
  }, 30_000); // Much shorter timeout (30s vs 120s)

  const content = response?.data.content || '';
  this.renderSearchResults(content);
}
```

#### Advanced Search

Advanced search continues to use directory attachments (the agent/MCP tools may
need them), but the pre-filter results are included as a hint in the prompt:

```typescript
// In handleAdvancedSearch, prepend pre-filter context:
const candidates = this.vaultIndex.preFilter(query, this.scopePaths, 15);
const hint = candidates.length > 0
  ? `\n\nLocal pre-filter found ${candidates.length} likely matches:\n` +
    candidates.map(c => `- ${c.note.path} (${c.matchReasons.join(', ')})`).join('\n') +
    '\n\nUse these as starting points, but search beyond them if needed.'
  : '';

const searchPrompt = `Perform a semantic search...${hint}\n\nQuery: ${query}`;
```

---

## Changes

### New: `src/vaultIndex.ts`

| Export | Purpose |
|--------|---------|
| `VaultIndex` class | Thin wrapper over `app.metadataCache` |
| `NoteMetadata` interface | Normalized metadata for one note |
| `SearchCandidate` interface | Scored search result with match reasons |

### `src/types.ts`

No changes needed — `NoteMetadata` and `SearchCandidate` are exported from
`vaultIndex.ts` directly (they're only consumed by the search pipeline).

### `src/sidekickView.ts`

| Location | Change |
|----------|--------|
| Imports | Add `import { VaultIndex } from './vaultIndex'` |
| Class properties | Add `private vaultIndex: VaultIndex` |
| `onOpen()` | Initialize `this.vaultIndex = new VaultIndex(this.app)` |
| `handleBasicSearch()` (line 3068) | Add Phase 1 pre-filter before LLM call |
| `handleAdvancedSearch()` (line 3093) | Add pre-filter hints to prompt |

---

## Obsidian API Usage

```typescript
// All from app.metadataCache — zero custom indexing:

// Get file cache (frontmatter, headings, links, tags, sections)
const cache: CachedMetadata | null = app.metadataCache.getFileCache(file);

// Get resolved forward links
const links: Record<string, Record<string, number>> = app.metadataCache.resolvedLinks;
// links["note.md"]["other.md"] = number of links from note.md to other.md

// Get backlinks (reverse of resolvedLinks)
// No direct API — compute from resolvedLinks by inverting the map

// Get all markdown files
const files: TFile[] = app.vault.getMarkdownFiles();

// File stats
const stat = file.stat; // { mtime, ctime, size }

// Listen for metadata changes
app.metadataCache.on('changed', (file: TFile, data: string, cache: CachedMetadata) => {
  // Incremental update — only this file changed
});
```

---

## Acceptance Criteria

1. Basic search with a query like "meeting" returns results faster than the current
   full-LLM path (targets <5s vs current 10-30s)
2. Pre-filter correctly matches files by filename, tags, headings, aliases, and
   folder path
3. When pre-filter finds 0 matches, falls back to existing full-directory search
4. Advanced search includes pre-filter hints but still has full directory access
5. No regression in search quality — results should be at least as relevant as before
6. `VaultIndex` adds zero startup overhead (lazy, no initialization until first use)

## Non-Goals

- Full-text content search (requires reading files — deferred to P4/P6)
- Fuzzy matching (exact substring only; fuse.js considered in P4)
- Persistent index or embedding cache
- Changes to the search UI
