import type { SavedPlace } from '../scene/savedPlaces.ts';

/**
 * The Home and Save as home buttons, and the list of recent places. A click on home or a recent
 * place selects it again.
 */
export function mountPlacesPanel(
  parent: HTMLElement,
  options: {
    onGo: (place: SavedPlace) => void;
    onSaveHome: () => void;
    onForgetHome: () => void;
    onForget: (place: SavedPlace) => void;
  },
): {
  setPlaces: (home: SavedPlace | null, recent: readonly SavedPlace[]) => void;
  /** Whether there is a selection to save, and whether it is already the home. */
  setSelection: (state: 'none' | 'other' | 'home') => void;
} {
  const block = document.createElement('section');
  block.className = 'places';
  block.innerHTML = `
    <div class="places-row">
      <button id="go-home" type="button" disabled>${HOME_ICON}<span>Home</span></button>
      <button id="save-home" type="button" disabled>Save as home</button>
      <button id="show-recent" type="button" aria-expanded="false" aria-controls="recent-list" disabled>Recent</button>
    </div>
    <ul id="recent-list" hidden></ul>
  `;
  parent.append(block);
  const goHome = required<HTMLButtonElement>(block, '#go-home');
  const saveHome = required<HTMLButtonElement>(block, '#save-home');
  const showRecent = required<HTMLButtonElement>(block, '#show-recent');
  const list = required<HTMLUListElement>(block, '#recent-list');
  let home: SavedPlace | null = null;
  let recent: readonly SavedPlace[] = [];
  let selection: 'none' | 'other' | 'home' = 'none';

  const setOpen = (open: boolean) => {
    list.hidden = !open;
    showRecent.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  const render = () => {
    goHome.disabled = home === null;
    goHome.title = home === null ? 'Save a selection as home first' : `Go to ${home.label}`;
    saveHome.disabled = selection === 'none' && home === null;
    saveHome.textContent = selection === 'home' || (selection === 'none' && home !== null) ? 'Forget home' : 'Save as home';
    showRecent.disabled = recent.length === 0;
    showRecent.textContent = recent.length === 0 ? 'Recent' : `Recent (${recent.length})`;
    if (recent.length === 0) setOpen(false);
    list.replaceChildren(
      ...recent.map((place) => {
        const item = document.createElement('li');
        const go = document.createElement('button');
        go.type = 'button';
        go.className = 'recent-go';
        go.dataset.id = place.id;
        go.title = `${place.label}\n${place.at.latitude.toFixed(5)}, ${place.at.longitude.toFixed(5)}`;
        const name = document.createElement('span');
        name.textContent = place.label;
        const when = document.createElement('small');
        when.textContent = timeAgo(place.savedAt);
        go.append(name, when);
        const forget = document.createElement('button');
        forget.type = 'button';
        forget.className = 'recent-forget';
        forget.dataset.forget = place.id;
        forget.setAttribute('aria-label', `Remove ${place.label} from recent places`);
        forget.textContent = '×';
        item.append(go, forget);
        return item;
      }),
    );
  };

  goHome.addEventListener('click', () => {
    if (home !== null) options.onGo(home);
  });
  saveHome.addEventListener('click', () => {
    if (saveHome.textContent === 'Forget home') options.onForgetHome();
    else options.onSaveHome();
  });
  showRecent.addEventListener('click', () => {
    // Redrawn on opening, so "5 min ago" is current.
    if (list.hidden) render();
    setOpen(list.hidden !== false);
  });
  list.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('button') : null;
    if (target === null) return;
    const forgetId = target.dataset.forget;
    if (forgetId !== undefined) {
      const place = recent.find((item) => item.id === forgetId);
      if (place !== undefined) options.onForget(place);
      return;
    }
    const place = recent.find((item) => item.id === target.dataset.id);
    if (place === undefined) return;
    setOpen(false);
    options.onGo(place);
  });
  document.addEventListener('pointerdown', (event) => {
    if (event.target instanceof Node && block.contains(event.target)) return;
    setOpen(false);
  });

  return {
    setPlaces(nextHome, nextRecent) {
      home = nextHome;
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
