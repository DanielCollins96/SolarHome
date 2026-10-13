import type { LngLat } from '../geo/projection.ts';
import { projectToLocal } from '../geo/projection.ts';
import type { TreeKind } from './treeMesh.ts';

/** A tree with its place on the map, before it is placed around a model. */
export interface PlacedTree {
  id: string;
  at: LngLat;
  kind: TreeKind;
  widthM: number;
  heightM?: number;
}

/** A change to a tree from the city's data, found again by its place. */
interface TreeChange {
  at: LngLat;
  /** Where the person moved the tree to. `at` stays its original place, so the change finds it again. */
  movedTo?: LngLat;
  removed?: boolean;
  kind?: TreeKind;
  widthM?: number;
  heightM?: number;
}

interface StoredEdits {
  changes: TreeChange[];
  added: PlacedTree[];
}

const STORAGE_KEY = 'solarhome.treeEdits.v1';
/** A change applies to the generated tree within this distance. Regenerated trees can shift a little. */
const MATCH_M = 1.5;
export const MIN_TREE_WIDTH_M = 1;
export const MAX_TREE_WIDTH_M = 20;
export const MIN_TREE_HEIGHT_M = 1;
export const MAX_TREE_HEIGHT_M = 35;

/**
 * The person's own corrections to the trees: ones removed, resized or switched between
 * evergreen and broadleaf, and ones planted. Kept in this browser only.
 */
export function createTreeEdits(storage: Pick<Storage, 'getItem' | 'setItem'> | null = browserStorage()) {
  let edits = load(storage);
  let counter = 0;

  const save = () => {
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify(edits));
    } catch {
      // Storage full or blocked. The edits still hold for this visit.
    }
  };
  const changeNear = (at: LngLat) => edits.changes.find((change) => distanceM(change.at, at) <= MATCH_M);
  const addedById = (id: string) => edits.added.find((tree) => tree.id === id);

  return {
    /** The generated trees with the person's changes applied, plus the trees they planted. */
    apply(generated: readonly PlacedTree[]): PlacedTree[] {
      const kept = generated.flatMap((tree) => {
        const change = changeNear(tree.at);
        if (change === undefined) return [tree];
        if (change.removed === true) return [];
        const heightM = change.heightM ?? tree.heightM;
        return [
          {
            ...tree,
            at: change.movedTo ?? tree.at,
            kind: change.kind ?? tree.kind,
            widthM: change.widthM ?? tree.widthM,
            ...(heightM === undefined ? {} : { heightM }),
          },
        ];
      });
      return [...kept, ...edits.added];
    },
    /** A new tree. A height left out follows from the width and kind, like the city's trees. */
    plant(at: LngLat, kind: TreeKind, widthM: number, heightM?: number): PlacedTree {
      const tree: PlacedTree = { id: `planted:${Date.now().toString(36)}-${(counter += 1)}`, at, kind, widthM, ...(heightM === undefined ? {} : { heightM }) };
      edits.added.push(tree);
      save();
      return tree;
    },
    update(tree: PlacedTree, next: { removed?: boolean; kind?: TreeKind; widthM?: number; heightM?: number; at?: LngLat }): void {
      const planted = addedById(tree.id);
      if (planted !== undefined) {
        if (next.removed === true) edits.added = edits.added.filter((item) => item !== planted);
        else
          Object.assign(
            planted,
            next.kind === undefined ? {} : { kind: next.kind },
            next.widthM === undefined ? {} : { widthM: next.widthM },
            next.heightM === undefined ? {} : { heightM: next.heightM },
            next.at === undefined ? {} : { at: next.at },
          );
        save();
        return;
      }
      const { at, ...rest } = next;
      const changed = at === undefined ? rest : { ...rest, movedTo: at };
      // A city tree that was moved before arrives at its new place, so look for that change first.
      const change = edits.changes.find((item) => item.movedTo !== undefined && distanceM(item.movedTo, tree.at) <= MATCH_M) ?? changeNear(tree.at);
      if (change === undefined) edits.changes.push({ at: tree.at, ...changed });
      else Object.assign(change, changed);
      save();
    },
    /** Forget every change and planted tree within this distance of a place. */
    resetAround(at: LngLat, radiusM: number): void {
      edits = {
        changes: edits.changes.filter((change) => distanceM(change.at, at) > radiusM),
        added: edits.added.filter((tree) => distanceM(tree.at, at) > radiusM),
      };
      save();
    },
  };
}

export type TreeEdits = ReturnType<typeof createTreeEdits>;

function load(storage: Pick<Storage, 'getItem'> | null): StoredEdits {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (raw === null || raw === undefined) return { changes: [], added: [] };
    const parsed = JSON.parse(raw) as Partial<StoredEdits>;
    return { changes: Array.isArray(parsed.changes) ? parsed.changes : [], added: Array.isArray(parsed.added) ? parsed.added : [] };
  } catch {
    return { changes: [], added: [] };
  }
}

function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function distanceM(a: LngLat, b: LngLat): number {
  const offset = projectToLocal(a, b);
  return Math.hypot(offset.east, offset.north);
}
