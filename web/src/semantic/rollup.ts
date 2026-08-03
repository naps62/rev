/**
 * Global entity rollup for the triage flow: group every entity change in the
 * diff into (bucket × change kind) so the review opens as "23 new functions,
 * 15 modified, 40 tests" instead of a wall of hunks.
 */

import type {
  EntityChange,
  EntityChangeKind,
  SemanticFileEntities,
} from "#shared/types";

export type EntityBucket = "functions" | "types" | "values" | "tests" | "other";

const BUCKETS: Array<[RegExp, EntityBucket]> = [
  [/^(test|test_suite)$/, "tests"],
  [/^(function|method|constructor)$/, "functions"],
  [/^(class|struct|enum|trait|interface|type|impl|module)$/, "types"],
  [/^(constant|variable|property|field|array)$/, "values"],
];

export function bucketOf(entityType: string): EntityBucket {
  for (const [re, b] of BUCKETS) if (re.test(entityType)) return b;
  return "other";
}

export const BUCKET_LABEL: Record<EntityBucket, string> = {
  functions: "functions",
  types: "types",
  values: "consts & fields",
  tests: "tests",
  other: "other",
};

const BUCKET_ORDER: EntityBucket[] = ["functions", "types", "values", "tests", "other"];
const CHANGE_ORDER: EntityChangeKind[] = [
  "added",
  "modified",
  "deleted",
  "renamed",
  "moved",
  "reordered",
];

export interface RollupItem {
  path: string;
  entity: EntityChange;
}

export interface RollupGroup {
  bucket: EntityBucket;
  change: EntityChangeKind;
  items: RollupItem[];
}

/** Non-empty (bucket × change) groups in fixed display order. */
export function buildRollup(files: SemanticFileEntities[]): RollupGroup[] {
  const m = new Map<string, RollupGroup>();
  for (const f of files) {
    for (const entity of f.entities) {
      const key = `${bucketOf(entity.entityType)}\0${entity.change}`;
      let g = m.get(key);
      if (!g) {
        m.set(key, (g = { bucket: bucketOf(entity.entityType), change: entity.change, items: [] }));
      }
      g.items.push({ path: f.path, entity });
    }
  }
  return [...m.values()].sort(
    (a, b) =>
      BUCKET_ORDER.indexOf(a.bucket) - BUCKET_ORDER.indexOf(b.bucket) ||
      CHANGE_ORDER.indexOf(a.change) - CHANGE_ORDER.indexOf(b.change),
  );
}

