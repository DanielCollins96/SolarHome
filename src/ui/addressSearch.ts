import type { GeocodeHit } from '../geo/geocode.ts';

export function mountAddressSearch(
  parent: HTMLElement,
  options: {
    onSearch: (query: string) => void;
    onSelect: (hit: GeocodeHit) => void;
    onClear: () => void;
  },
): {
  setBusy: (busy: boolean) => void;
  setResults: (hits: GeocodeHit[]) => void;
  setMessage: (message: string) => void;
  setClearEnabled: (enabled: boolean) => void;
} {
  const block = document.createElement('section');
  block.className = 'address';
  block.innerHTML = `
    <label>
      <span class="sr">Address</span>
      <input id="address" type="search" placeholder="Street address" autocomplete="off" />
    </label>
    <div class="selection">
      <p id="address-message" class="note"></p>
      <button id="clear-selection" type="button" hidden>Clear</button>
    </div>
    <ul id="address-results"></ul>
  `;
  parent.append(block);
  const input = required<HTMLInputElement>(block, '#address');
  const message = required<HTMLElement>(block, '#address-message');
  const clearButton = required<HTMLButtonElement>(block, '#clear-selection');
  const results = required<HTMLUListElement>(block, '#address-results');
  let timer = 0;
  let hits: GeocodeHit[] = [];
  let resultsFor = '';
  let dismissed = false;

  const closeResults = () => {
    hits = [];
    dismissed = true;
    results.replaceChildren();
  };
  const choose = (hit: GeocodeHit) => {
    window.clearTimeout(timer);
    input.value = shortPlaceLabel(hit.label);
    closeResults();
    input.blur();
    options.onSelect(hit);
  };

  input.addEventListener('input', () => {
    dismissed = false;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => options.onSearch(input.value), 300);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (results.childElementCount > 0) closeResults();
      else input.blur();
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    window.clearTimeout(timer);
    const first = hits[0];
    if (first !== undefined && resultsFor === input.value) {
      choose(first);
      return;
    }
    options.onSearch(input.value);
  });
  results.addEventListener('mousedown', (event) => {
    event.preventDefault();
  });
  results.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement)) return;
    const hit = hits[Number(target.dataset.index)];
    if (hit !== undefined) choose(hit);
  });
  clearButton.addEventListener('click', () => options.onClear());
  document.addEventListener('pointerdown', (event) => {
    if (event.target instanceof Node && block.contains(event.target)) return;
    closeResults();
  });

  return {
    setBusy(busy) {
      message.textContent = busy ? 'Looking up the address…' : message.textContent;
    },
    setResults(next) {
      if (dismissed) return;
      hits = next;
      resultsFor = input.value;
      results.replaceChildren(
        ...next.map((hit, index) => {
          const item = document.createElement('li');
          const button = document.createElement('button');
          button.type = 'button';
          button.dataset.index = String(index);
          button.textContent = shortPlaceLabel(hit.label);
          button.title = hit.label;
          item.append(button);
          return item;
        }),
      );
    },
    setMessage(text) {
      message.textContent = text;
    },
    setClearEnabled(enabled) {
      clearButton.hidden = !enabled;
    },
  };
}

function shortPlaceLabel(label: string): string {
  const parts = label
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  return parts.slice(0, 2).join(', ');
}

function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector}.`);
  return element;
}
