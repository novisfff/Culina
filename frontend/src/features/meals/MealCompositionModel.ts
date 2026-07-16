export type CompositionEntry = {
  id: string;
  food_id: string;
  servings: number;
  note: string;
  food_name?: string;
  rating?: number | null;
};

export type CompositionConflictField = 'food_id' | 'servings' | 'note' | 'existence';

export type CompositionConflict = {
  entry_key: string;
  field: CompositionConflictField;
  base: unknown;
  draft: unknown;
  server: unknown;
};

export type MealCompositionMergeResult = {
  entries: CompositionEntry[];
  conflicts: CompositionConflict[];
};

function createUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Temporary local entry ids use `client:<uuid>` until the server assigns a real id. */
export function createLocalCompositionEntryId(uuid: string = createUuid()): string {
  return uuid.startsWith('client:') ? uuid : `client:${uuid}`;
}

function indexById(entries: CompositionEntry[]): Map<string, CompositionEntry> {
  return new Map(entries.map((entry) => [entry.id, entry]));
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return left === right;
}

function mergeField<T>(args: {
  entryKey: string;
  field: Exclude<CompositionConflictField, 'existence'>;
  base: T;
  draft: T;
  server: T;
  conflicts: CompositionConflict[];
}): T {
  if (valuesEqual(args.draft, args.server)) {
    return args.draft;
  }
  if (valuesEqual(args.draft, args.base)) {
    return args.server;
  }
  if (valuesEqual(args.server, args.base)) {
    return args.draft;
  }
  args.conflicts.push({
    entry_key: args.entryKey,
    field: args.field,
    base: args.base,
    draft: args.draft,
    server: args.server,
  });
  // Never auto-select server over draft; provisional value stays draft until explicit resolve.
  return args.draft;
}

function mergePresentEntry(
  base: CompositionEntry | undefined,
  draft: CompositionEntry,
  server: CompositionEntry | undefined,
  conflicts: CompositionConflict[],
): CompositionEntry {
  if (!base && !server) {
    return draft;
  }
  if (!base && server) {
    // Same temporary/server id collision is unexpected; prefer draft and surface field conflicts.
    return {
      ...draft,
      food_id: mergeField({
        entryKey: draft.id,
        field: 'food_id',
        base: draft.food_id,
        draft: draft.food_id,
        server: server.food_id,
        conflicts,
      }),
      servings: mergeField({
        entryKey: draft.id,
        field: 'servings',
        base: draft.servings,
        draft: draft.servings,
        server: server.servings,
        conflicts,
      }),
      note: mergeField({
        entryKey: draft.id,
        field: 'note',
        base: draft.note,
        draft: draft.note,
        server: server.note,
        conflicts,
      }),
    };
  }

  const baseEntry = base!;
  if (!server) {
    conflicts.push({
      entry_key: draft.id,
      field: 'existence',
      base: true,
      draft: true,
      server: false,
    });
    return draft;
  }

  return {
    ...draft,
    food_id: mergeField({
      entryKey: draft.id,
      field: 'food_id',
      base: baseEntry.food_id,
      draft: draft.food_id,
      server: server.food_id,
      conflicts,
    }),
    servings: mergeField({
      entryKey: draft.id,
      field: 'servings',
      base: baseEntry.servings,
      draft: draft.servings,
      server: server.servings,
      conflicts,
    }),
    note: mergeField({
      entryKey: draft.id,
      field: 'note',
      base: baseEntry.note,
      draft: draft.note,
      server: server.note,
      conflicts,
    }),
    // Prefer draft display fields; rating remains server-owned unless draft carries one.
    food_name: draft.food_name ?? server.food_name ?? baseEntry.food_name,
    rating: draft.rating !== undefined ? draft.rating : server.rating,
  };
}

/**
 * Three-way entry-ID merge for composition correction recovery.
 * Conflicts never auto-select a side; provisional entries keep draft values
 * except user-delete/server-edit keeps the server row for review.
 */
export function mergeMealComposition(
  base: CompositionEntry[],
  draft: CompositionEntry[],
  server: CompositionEntry[],
): MealCompositionMergeResult {
  const baseById = indexById(base);
  const draftById = indexById(draft);
  const serverById = indexById(server);
  const conflicts: CompositionConflict[] = [];
  const entries: CompositionEntry[] = [];
  const seen = new Set<string>();

  for (const draftEntry of draft) {
    seen.add(draftEntry.id);
    const baseEntry = baseById.get(draftEntry.id);
    const serverEntry = serverById.get(draftEntry.id);
    entries.push(mergePresentEntry(baseEntry, draftEntry, serverEntry, conflicts));
  }

  for (const serverEntry of server) {
    if (seen.has(serverEntry.id)) continue;
    seen.add(serverEntry.id);
    const baseEntry = baseById.get(serverEntry.id);
    const draftEntry = draftById.get(serverEntry.id);
    if (draftEntry) {
      // Already handled via draft order.
      continue;
    }
    if (baseEntry) {
      // User deleted, server still has (and may have edited) the entry.
      conflicts.push({
        entry_key: serverEntry.id,
        field: 'existence',
        base: true,
        draft: false,
        server: true,
      });
      entries.push(serverEntry);
      continue;
    }
    // Server-only addition.
    entries.push(serverEntry);
  }

  return { entries, conflicts };
}
