import type { SavedPlace } from '../scene/savedPlaces.ts';

/**
 * Compare mode: the saved places with a tick each. Ticked places stand side by side in 3D, where
 * they can be dragged about. Done goes back to the selection.
 */
export function mountComparePanel(
  parent: HTMLElement,
  options: {
    onChoose: (place: SavedPlace, chosen: boolean) => void;
    onDone: () => void;
  },
): {
  /** Shows the panel with these places, the chosen ones ticked, or hides it with null. */
  show: (saved: readonly SavedPlace[] | null, chosen: ReadonlySet<string>) => void;
  setMessage: (text: string) => void;
} {
  const block = document.createElement('section');
  block.className = 'compare';
  block.hidden = true;
  block.innerHTML = `
    <div class="compare-head">
      <strong>Compare in 3D</strong>
      <button id="compare-done" type="button">Done</button>
    </div>
    <ul id="compare-list"></ul>
    <p id="compare-message" class="note"></p>
  `;
  parent.append(block);
  const list = required<HTMLUListElement>(block, '#compare-list');
  const message = required<HTMLElement>(block, '#compare-message');
  let places: readonly SavedPlace[] = [];

  required<HTMLButtonElement>(block, '#compare-done').addEventListener('click', () => options.onDone());
  list.addEventListener('change', (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    const place = places.find((item) => item.id === input.dataset.id);
    if (place !== undefined) options.onChoose(place, input.checked);
  });

  return {
    show(saved, chosen) {
      block.hidden = saved === null;
      places = saved ?? [];
      list.replaceChildren(
        ...places.map((place) => {
          const item = document.createElement('li');
          const label = document.createElement('label');
          const input = document.createElement('input');
          input.type = 'checkbox';
          input.dataset.id = place.id;
          input.checked = chosen.has(place.id);
          const name = document.createElement('span');
          name.textContent = place.label;
          label.append(input, name);
          item.append(label);
          return item;
        }),
      );
    },
    setMessage(text) {
      message.textContent = text;
    },
  };
}

function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector}.`);
  return element;
}
