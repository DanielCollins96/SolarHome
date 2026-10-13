import type { SavedPlace } from '../scene/savedPlaces.ts';

/** What the current selection is to the panel: nothing, or a place that may be the home or saved. */
export interface PlaceSelection {
  selected: boolean;
  home: boolean;
  saved: boolean;
}

/**
 * The Home, Save as home and save buttons, and the list of saved and recent places. A click on
 * home or a listed place selects it again.
 */
export function mountPlacesPanel(
  parent: HTMLElement,
  options: {
    onGo: (place: SavedPlace) => void;
    onSaveHome: () => void;
    onForgetHome: () => void;
    /** Save the selection, or remove it from the saved places when it is one. */
    onToggleSaved: () => void;
    onUnsave: (place: SavedPlace) => void;
    onForget: (place: SavedPlace) => void;
  },
): {
  setPlaces: (home: SavedPlace | null, saved: readonly SavedPlace[], recent: readonly SavedPlace[]) => void;
  setSelection: (state: PlaceSelection) => void;
} {
  const block = document.createElement('section');
  block.className = 'places';
  block.innerHTML = `
    <div class="places-row">
      <button id="go-home" type="button" disabled>${HOME_ICON}<span>Home</span></button>
      <button id="save-home" type="button" disabled>Save as home</button>
      <button id="save-place" type="button" aria-pressed="false" disabled>${STAR_ICON}</button>
      <button id="show-places" type="button" aria-expanded="false" aria-controls="places-list" aria-label="Places" title="Places" disabled>${BOOKMARK_ICON}</button>
    </div>
    <ul id="places-list" hidden></ul>
  `;
  parent.append(block);
  const goHome = required<HTMLButtonElement>(block, '#go-home');
  const saveHome = required<HTMLButtonElement>(block, '#save-home');
  const savePlace = required<HTMLButtonElement>(block, '#save-place');
  const showPlaces = required<HTMLButtonElement>(block, '#show-places');
  const list = required<HTMLUListElement>(block, '#places-list');
  let home: SavedPlace | null = null;
  let saved: readonly SavedPlace[] = [];
  let recent: readonly SavedPlace[] = [];
  let selection: PlaceSelection = { selected: false, home: false, saved: false };

  const setOpen = (open: boolean) => {
    list.hidden = !open;
    showPlaces.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  const heading = (text: string) => {
    const item = document.createElement('li');
    item.className = 'places-heading';
    item.textContent = text;
    return item;
  };
  const row = (place: SavedPlace, kind: 'saved' | 'recent') => {
    const item = document.createElement('li');
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'place-go';
    go.dataset.id = place.id;
    go.dataset.kind = kind;
    go.title = `${place.label}\n${place.at.latitude.toFixed(5)}, ${place.at.longitude.toFixed(5)}`;
    const name = document.createElement('span');
    name.textContent = place.label;
    const when = document.createElement('small');
    when.textContent = kind === 'saved' ? `Saved ${timeAgo(place.savedAt)}` : timeAgo(place.savedAt);
    go.append(name, when);
    const forget = document.createElement('button');
    forget.type = 'button';
    forget.className = 'place-forget';
    forget.dataset.forget = place.id;
    forget.dataset.kind = kind;
    forget.setAttribute('aria-label', `Remove ${place.label} from ${kind} places`);
    forget.textContent = '×';
    item.append(go, forget);
    return item;
  };
  const render = () => {
    goHome.disabled = home === null;
    goHome.title = home === null ? 'Save a selection as home first' : `Go to ${home.label}`;
    saveHome.disabled = !selection.selected && home === null;
    saveHome.textContent = selection.home || (!selection.selected && home !== null) ? 'Clear home' : 'Save as home';
    savePlace.disabled = !selection.selected;
    savePlace.setAttribute('aria-pressed', selection.saved ? 'true' : 'false');
    const saveLabel = !selection.selected ? 'Select a building to save it' : selection.saved ? 'Remove from saved places' : 'Save this place';
    savePlace.title = saveLabel;
    savePlace.setAttribute('aria-label', saveLabel);
    const empty = saved.length === 0 && recent.length === 0;
    showPlaces.disabled = empty;
    if (empty) setOpen(false);
    list.replaceChildren(
      ...(saved.length > 0 ? [heading('Saved'), ...saved.map((place) => row(place, 'saved'))] : []),
      ...(recent.length > 0 ? [heading('Recent'), ...recent.map((place) => row(place, 'recent'))] : []),
    );
  };

  goHome.addEventListener('click', () => {
    if (home !== null) options.onGo(home);
  });
  saveHome.addEventListener('click', () => {
    if (saveHome.textContent === 'Clear home') options.onForgetHome();
    else options.onSaveHome();
  });
  savePlace.addEventListener('click', () => {
    options.onToggleSaved();
  });
  showPlaces.addEventListener('click', () => {
    // Redrawn on opening, so "5 min ago" is current.
    if (list.hidden) render();
    setOpen(list.hidden !== false);
  });
  list.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('button') : null;
    if (target === null) return;
    const from = target.dataset.kind === 'saved' ? saved : recent;
    const forgetId = target.dataset.forget;
    if (forgetId !== undefined) {
      const place = from.find((item) => item.id === forgetId);
      if (place === undefined) return;
      if (target.dataset.kind === 'saved') options.onUnsave(place);
      else options.onForget(place);
      return;
    }
    const place = from.find((item) => item.id === target.dataset.id);
    if (place === undefined) return;
    setOpen(false);
    options.onGo(place);
  });
  document.addEventListener('pointerdown', (event) => {
    if (event.target instanceof Node && block.contains(event.target)) return;
    setOpen(false);
  });

  return {
    setPlaces(nextHome, nextSaved, nextRecent) {
      home = nextHome;
      saved = nextSaved;
      recent = nextRecent;
      render();
    },
    setSelection(next) {
      selection = next;
      render();
    },
  };
}

function timeAgo(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return days === 1 ? 'yesterday' : `${days} days ago`;
  return new Date(at).toLocaleDateString();
}

function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector}.`);
  return element;
}

const HOME_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 3 2 12h3v8h6v-6h2v6h6v-8h3z"/></svg>';

const STAR_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z"/></svg>';

const BOOKMARK_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 3.5h11v17L12 16.5l-5.5 4z"/></svg>';
