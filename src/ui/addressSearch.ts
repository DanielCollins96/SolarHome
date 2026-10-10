import type { GeocodeHit } from '../geo/geocode.ts';

export function mountAddressSearch(
  parent: HTMLElement,
  options: {
    onSearch: (query: string) => void;
    onSelect: (hit: GeocodeHit) => void;
  },
): {
  setBusy: (busy: boolean) => void;
  setResults: (hits: GeocodeHit[]) => void;
  setMessage: (message: string) => void;
} {
  const block = document.createElement('section');
  block.className = 'address';
  block.innerHTML = `
    <label>
      Address
      <input id="address" type="search" placeholder="Street address" autocomplete="off" />
    </label>
    <p id="address-message" class="note"></p>
    <ul id="address-results"></ul>
  `;
  parent.append(block);
  const input = required<HTMLInputElement>(block, '#address');
  const message = required<HTMLElement>(block, '#address-message');
  const results = required<HTMLUListElement>(block, '#address-results');
  let timer = 0;
  let hits: GeocodeHit[] = [];
  let resultsFor = '';

  input.addEventListener('input', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => options.onSearch(input.value), 300);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    window.clearTimeout(timer);
    const first = hits[0];
    if (first !== undefined && resultsFor === input.value) {
      options.onSelect(first);
      return;
    }
    options.onSearch(input.value);
  });
  results.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement)) return;
    const hit = hits[Number(target.dataset.index)];
    if (hit !== undefined) options.onSelect(hit);
  });

  return {
    setBusy(busy) {
      message.textContent = busy ? 'Looking up the address…' : message.textContent;
    },
    setResults(next) {
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
