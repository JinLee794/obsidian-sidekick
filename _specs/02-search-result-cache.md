# Spec 02 — Search Result Cache

**Priority:** P2 (Low effort, High impact)
**Files modified:** `src/sidekickView.ts`
**New files:** None
**Dependencies:** None

---

## Problem

Every search (basic or advanced) makes a full LLM round-trip, even for identical
queries against the same scope. There is no caching layer.

### Current Implementation

```
src/sidekickView.ts:

handleBasicSearch(query) — line 3068:
  1. Reuse basicSearchSession (or create)
  2. Send searchPrompt + directory attachment
  3. session.sendAndWait() — 120s timeout
  4. renderSearchResults(content)
  → No cache check, no result storage

handleAdvancedSearch(query) — line 3093:
  1. Create NEW session per query
  2. Send searchPrompt + directory attachment
  3. session.sendAndWait() — 120s timeout
  4. renderSearchResults(content)
  5. Disconnect session
  → New session overhead + no cache
```

### Cost

- Identical query "meeting notes" searched 3 times = 3 full LLM inferences
- Each inference reads entire scope directory from scratch
- Basic search reuses session but still sends full query each time
- Advanced search creates + destroys a session per query

---

## Design

### Cache Structure

```typescript
interface SearchCacheEntry {
  /** Raw response content from LLM */
  content: string;
  /** Timestamp when cached */
  cachedAt: number;
  /** Scope paths used for this search */
  scopePaths: string[];
  /** Search mode (basic/advanced) */
  mode: 'basic' | 'advanced';
  /** Agent used (advanced only) */
  agent?: string;
}

// In-memory cache, keyed by normalized query hash
private searchCache = new Map<string, SearchCacheEntry>();

// Cache configuration
private static readonly SEARCH_CACHE_TTL = 5 * 60 * 1000;  // 5 minutes
private static readonly SEARCH_CACHE_MAX = 50;               // max entries
```

### Cache Key

```typescript
function buildSearchCacheKey(
  query: string,
  mode: 'basic' | 'advanced',
  scopePaths: string[],
  agent?: string,
): string {
  // Normalize: lowercase, trim, sort scope paths
  const normalized = [
    query.trim().toLowerCase(),
    mode,
    [...scopePaths].sort().join('|'),
    agent ?? '',
  ].join('\0');

  // Simple string hash (no crypto needed for in-memory cache)
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) - hash + normalized.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}
```

### Cache Invalidation

Invalidate on vault file changes that could affect results:

```typescript
// In the existing config file watcher (line 957), add:
// After the 500ms debounce, on any file modify/create/delete/rename:
this.invalidateSearchCache();

private invalidateSearchCache(): void {
  if (this.searchCache.size > 0) {
    this.searchCache.clear();
  }
}
```

This is intentionally aggressive (clears all entries on any vault change). A more
granular approach (invalidating only entries whose scope contains the changed file) is
possible but adds complexity for minimal gain in P2.

### Cache Hit Path

```typescript
// In handleBasicSearch / handleAdvancedSearch, before sending to LLM:

const cacheKey = buildSearchCacheKey(query, mode, scopePaths, agent);
const cached = this.searchCache.get(cacheKey);

if (cached && Date.now() - cached.cachedAt < SEARCH_CACHE_TTL) {
  this.renderSearchResults(cached.content);
  return;
}

// ... existing LLM call ...

// After successful response:
this.addToSearchCache(cacheKey, {
  content,
  cachedAt: Date.now(),
  scopePaths: [...this.scopePaths],
  mode,
  agent,
});
```

### LRU Eviction

```typescript
private addToSearchCache(key: string, entry: SearchCacheEntry): void {
  // Evict oldest if at capacity
  if (this.searchCache.size >= SidekickView.SEARCH_CACHE_MAX) {
    let oldestKey = '';
    let oldestTime = Infinity;
    for (const [k, v] of this.searchCache) {
      if (v.cachedAt < oldestTime) {
        oldestTime = v.cachedAt;
        oldestKey = k;
      }
    }
    if (oldestKey) this.searchCache.delete(oldestKey);
  }
  this.searchCache.set(key, entry);
}
```

---

## Changes

### `src/sidekickView.ts`

| Location | Change |
|----------|--------|
| Class properties | Add `searchCache: Map<string, SearchCacheEntry>`, constants for TTL and max size |
| `handleBasicSearch()` (line 3068) | Add cache check before `session.sendAndWait()`; cache result after |
| `handleAdvancedSearch()` (line 3093) | Add cache check before creating new session; cache result after; skip session creation on cache hit |
| Config file watcher (line 957) | Add `this.invalidateSearchCache()` call after debounced config reload |
| New private methods | `buildSearchCacheKey()`, `addToSearchCache()`, `invalidateSearchCache()` |
| New interface | `SearchCacheEntry` (can be local to file, no need in types.ts) |

### UI Indication (Optional)

Add a subtle "(cached)" label next to search results when served from cache:

```typescript
// In renderSearchResults, accept a `fromCache` parameter:
private renderSearchResults(content: string, fromCache = false): void {
  // ... existing rendering ...
  if (fromCache) {
    this.searchResultsEl.createDiv({
      cls: 'sidekick-search-cached',
      text: 'Cached results'
    });
  }
}
```

---

## Acceptance Criteria

1. Searching the same query twice within 5 minutes returns results instantly
   (no loading spinner, no LLM call)
2. Changing vault scope and re-searching triggers a fresh LLM call
3. Modifying any vault file clears the cache (next search is fresh)
4. Advanced search with different agents produces separate cache entries
5. Cache does not grow beyond 50 entries
6. No regression in search behavior when cache is empty (cold path unchanged)

## Non-Goals

- Persistent (disk) cache across plugin reloads
- Granular cache invalidation (per-file, per-folder)
- Cache sharing between basic and advanced search modes
