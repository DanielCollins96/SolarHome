import type { GeographicBuilding } from '../house/assemble.ts';
import type { LngLat } from '../geo/projection.ts';
import { projectToLocal } from '../geo/projection.ts';

/** A selection the person can go back to: their home, or a place they looked at. */
export interface SavedPlace {
  id: string;
  label: string;
  at: LngLat;
  /** Milliseconds since 1970, when it was saved or last visited. */
  savedAt: number;
  /** The selected buildings, so going back needs no lookup. Left out when too large to keep. */
  buildings?: GeographicBuilding[];
}

export type PlaceInput = Omit<SavedPlace, 'id' | 'savedAt'>;

interface StoredPlaces {
  home: SavedPlace | null;
  recent: SavedPlace[];
}

const STORAGE_KEY = 'solarhome.places.v1';
export const MAX_RECENT = 12;
/** Buildings larger than this, as JSON, are a district. The place keeps only its location. */
const MAX_BUILDINGS_CHARS = 120_000;
/** A visit this close to an earlier one, or sharing a building with it, is the same place. */
const SAME_PLACE_M = 60;

/** The person's home and recently visited places. Kept in this browser only. */
export function createSavedPlaces(storage: Pick<Storage, 'getItem' | 'setItem'> | null = browserStorage(), now: () => number = Date.now) {
  let places = load(storage);
  let counter = 0;

  const save = () => {
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify(places));
    } catch {
      // Storage full. Keep the home whole and drop the buildings from the history, which can be looked up again.
      try {
        storage?.setItem(STORAGE_KEY, JSON.stringify({ ...places, recent: places.recent.map(({ buildings: _, ...rest }) => rest) }));
      } catch {
        // Storage blocked. The places still hold for this visit.
      }
    }
  };
  const make = (input: PlaceInput): SavedPlace => {
    const place: SavedPlace = { id: `${now().toString(36)}-${(counter++).toString(36)}`, label: input.label, at: input.at, savedAt: now() };
    if (input.buildings !== undefined && input.buildings.length > 0 && JSON.stringify(input.buildings).length <= MAX_BUILDINGS_CHARS) {
      place.buildings = input.buildings;
    }
    return place;
  };

  return {
    home: (): SavedPlace | null => places.home,
    recent: (): readonly SavedPlace[] => places.recent,
    setHome(input: PlaceInput): SavedPlace {
      places.home = make(input);
      save();
      return places.home;
    },
    clearHome(): void {
      places.home = null;
      save();
    },
    /** Put a place at the top of the history, replacing an earlier visit to the same place. */
    visit(input: PlaceInput): SavedPlace {
      const place = make(input);
      places.recent = [place, ...places.recent.filter((item) => !samePlace(item, place))].slice(0, MAX_RECENT);
      save();
      return place;
    },
    rename(id: string, label: string): void {
      const matches = [places.home, ...places.recent].filter((item) => item?.id === id);
      for (const item of matches) if (item !== null) item.label = label;
      if (matches.length > 0) save();
    },
    forget(id: string): void {
      places.recent = places.recent.filter((item) => item.id !== id);
      save();
    },
  };
}

export type SavedPlaces = ReturnType<typeof createSavedPlaces>;

/**
 * Two selections sharing a building are one place, so adding a garage does not make a new entry.
 * The house next door is its own place, so distance only decides when either has no buildings.
 */
export function samePlace(a: Pick<SavedPlace, 'at' | 'buildings'>, b: Pick<SavedPlace, 'at' | 'buildings'>): boolean {
  if (a.buildings !== undefined && b.buildings !== undefined) {
    const ids = new Set(a.buildings.map((building) => building.id));
    return b.buildings.some((building) => ids.has(building.id));
  }
  const offset = projectToLocal(a.at, b.at);
  return Math.hypot(offset.east, offset.north) <= SAME_PLACE_M;
}

function load(storage: Pick<Storage, 'getItem'> | null): StoredPlaces {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (raw === null || raw === undefined) return { home: null, recent: [] };
    const parsed = JSON.parse(raw) as Partial<StoredPlaces>;
    return {
      home: isPlace(parsed.home) ? parsed.home : null,
      recent: Array.isArray(parsed.recent) ? parsed.recent.filter(isPlace) : [],
    };
  } catch {
    return { home: null, recent: [] };
  }
}

function isPlace(value: unknown): value is SavedPlace {
  if (typeof value !== 'object' || value === null) return false;
  const place = value as Partial<SavedPlace>;
  return (
    typeof place.id === 'string' &&
    typeof place.label === 'string' &&
    typeof place.at?.latitude === 'number' &&
    typeof place.at.longitude === 'number' &&
    (place.buildings === undefined || Array.isArray(place.buildings))
  );
}

function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
