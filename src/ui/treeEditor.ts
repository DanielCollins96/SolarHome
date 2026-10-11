import type { TreeKind } from '../scene/treeMesh.ts';

export interface SelectedTree {
  kind: TreeKind;
  widthM: number;
  heightM: number;
}

/**
 * The "Edit trees" switch, and the type, width, height and remove controls for the selected tree. While it is on, a click on
 * the map or in 3D picks a tree, and a click on open ground plants one.
 */
export function mountTreeEditor(
  parent: HTMLElement,
  options: {
    onToggle: (editing: boolean) => void;
    onKind: (kind: TreeKind) => void;
    /** A factor on the crown width, such as 1.15 for wider. */
    onWidth: (factor: number) => void;
    /** A factor on the height, such as 1.15 for taller. */
    onHeight: (factor: number) => void;
    onRemove: () => void;
    onReset: () => void;
  },
): {
  editing: () => boolean;
  /** Null when no tree is selected. */
  setSelected: (tree: SelectedTree | null) => void;
  setNote: (note: string) => void;
} {
  const block = document.createElement('section');
  block.className = 'tree-editor';
  block.innerHTML = `
    <div class="tree-head">
      <button id="tree-edit" type="button" aria-pressed="false">Edit trees</button>
      <span id="tree-note" class="note"></span>
    </div>
    <div id="tree-body" hidden>
      <p class="note">Click a tree to change it, drag it to move it, or click open ground to plant one.</p>
      <div id="tree-selected" hidden>
        <label class="tree-row">
          <span>Type</span>
          <select id="tree-kind">
            <option value="evergreen">Evergreen (spruce, pine)</option>
            <option value="deciduous">Broadleaf (ash, elm, poplar)</option>
          </select>
        </label>
        <div class="tree-row">
          <span>Width</span>
          <button id="tree-narrower" type="button" aria-label="Narrower">−</button>
          <span id="tree-width-label" class="tree-value"></span>
          <button id="tree-wider" type="button" aria-label="Wider">+</button>
        </div>
        <div class="tree-row">
          <span>Height</span>
          <button id="tree-shorter" type="button" aria-label="Shorter">−</button>
          <span id="tree-height-label" class="tree-value"></span>
          <button id="tree-taller" type="button" aria-label="Taller">+</button>
          <button id="tree-remove" type="button">Remove</button>
        </div>
      </div>
      <button id="tree-reset" type="button">Undo my tree edits here</button>
    </div>
  `;
  parent.append(block);
  const toggle = required<HTMLButtonElement>(block, '#tree-edit');
  const body = required<HTMLElement>(block, '#tree-body');
  const selected = required<HTMLElement>(block, '#tree-selected');
  const kindSelect = required<HTMLSelectElement>(block, '#tree-kind');
  const widthLabel = required<HTMLElement>(block, '#tree-width-label');
  const heightLabel = required<HTMLElement>(block, '#tree-height-label');
  const note = required<HTMLElement>(block, '#tree-note');
  let editing = false;

  toggle.addEventListener('click', () => {
    editing = !editing;
    toggle.setAttribute('aria-pressed', String(editing));
    body.hidden = !editing;
    options.onToggle(editing);
  });
  kindSelect.addEventListener('change', () => options.onKind(kindSelect.value === 'evergreen' ? 'evergreen' : 'deciduous'));
  required<HTMLButtonElement>(block, '#tree-narrower').addEventListener('click', () => options.onWidth(1 / 1.15));
  required<HTMLButtonElement>(block, '#tree-wider').addEventListener('click', () => options.onWidth(1.15));
  required<HTMLButtonElement>(block, '#tree-shorter').addEventListener('click', () => options.onHeight(1 / 1.15));
  required<HTMLButtonElement>(block, '#tree-taller').addEventListener('click', () => options.onHeight(1.15));
  required<HTMLButtonElement>(block, '#tree-remove').addEventListener('click', () => options.onRemove());
  required<HTMLButtonElement>(block, '#tree-reset').addEventListener('click', () => options.onReset());

  return {
    editing: () => editing,
    setSelected(tree) {
      selected.hidden = tree === null;
      if (tree === null) return;
      kindSelect.value = tree.kind;
      widthLabel.textContent = `${tree.widthM.toFixed(1)} m`;
      heightLabel.textContent = `${tree.heightM.toFixed(1)} m`;
    },
    setNote(text) {
      note.textContent = text;
    },
  };
}

function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (element === null) throw new Error(`Missing ${selector}`);
  return element;
}
