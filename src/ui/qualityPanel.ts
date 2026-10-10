import { exportHouseGlb } from '../house/gltfExport.ts';
import {
  exportHouseJson,
  houseFootprintArea,
  importHouseJson,
  type HouseModel,
  type RoofSpec,
  type RoofType,
} from '../house/houseModel.ts';
import type { Object3D } from 'three';

export function mountQualityPanel(
  parent: HTMLElement,
  options: {
    onEave: (meters: number) => void;
    onRoof: (roof: RoofSpec) => void;
    onOrientation: (degrees: number) => void;
    onTracing: (tracing: boolean) => void;
    onOpacity: (opacity: number) => void;
    onNewOutline: () => void;
    onImport: (model: HouseModel) => void;
    houseObject: () => Object3D;
  },
): { setModel: (model: HouseModel) => void } {
  const root = document.createElement('section');
  root.className = 'quality';
  root.innerHTML = `
    <h2 id="house-label">House</h2>
    <p class="note">Footprint area <strong id="house-area">—</strong></p>
    <label>Eave height (m) <input id="eave" type="number" min="0.5" max="200" step="0.1" /></label>
    <label>Roof
      <select id="roof-type">
        <option value="flat">Flat</option>
        <option value="shed">Shed</option>
        <option value="gable">Gable</option>
        <option value="hip">Hip</option>
      </select>
    </label>
    <label>Direction (°) <input id="roof-direction" type="number" min="0" max="359" step="1" /></label>
    <label>Pitch (°) <input id="roof-pitch" type="number" min="0" max="80" step="1" /></label>
    <label>Overhang (m) <input id="roof-overhang" type="number" min="0" max="3" step="0.05" /></label>
    <label>Plan rotation (°) <input id="orientation" type="number" min="-180" max="180" step="1" /></label>
    <ul id="provenance" class="provenance"></ul>
    <ul id="issues" class="issues"></ul>
    <button id="trace-toggle" type="button">Edit outline</button>
    <button id="new-outline" type="button">New outline</button>
    <label>Map footprint opacity <input id="opacity" type="range" min="0" max="1" step="0.05" value="0.5" /></label>
    <button id="export-json" type="button">Export JSON</button>
    <label class="file">Import JSON <input id="import-json" type="file" accept="application/json,.json" /></label>
    <button id="export-glb" type="button">Export glTF</button>
    <p class="note">© OpenStreetMap contributors. Vector map only; satellite tracing is a later milestone.</p>
  `;
  parent.append(root);

  const label = required<HTMLElement>(root, '#house-label');
  const area = required<HTMLElement>(root, '#house-area');
  const eave = required<HTMLInputElement>(root, '#eave');
  const roofType = required<HTMLSelectElement>(root, '#roof-type');
  const direction = required<HTMLInputElement>(root, '#roof-direction');
  const pitch = required<HTMLInputElement>(root, '#roof-pitch');
  const overhang = required<HTMLInputElement>(root, '#roof-overhang');
  const orientation = required<HTMLInputElement>(root, '#orientation');
  const provenance = required<HTMLElement>(root, '#provenance');
  const issues = required<HTMLElement>(root, '#issues');
  const traceToggle = required<HTMLButtonElement>(root, '#trace-toggle');
  let model: HouseModel | null = null;
  let tracing = false;

  const readRoof = (): RoofSpec | null => {
    if (!isRoofType(roofType.value)) return null;
    const directionDeg = Number(direction.value);
    const pitchDeg = Number(pitch.value);
    const overhangM = Number(overhang.value);
    if (![directionDeg, pitchDeg, overhangM].every(Number.isFinite)) return null;
    return { type: roofType.value, directionDeg, pitchDeg, overhangM };
  };

  eave.addEventListener('change', () => {
    const meters = Number(eave.value);
    if (Number.isFinite(meters) && meters > 0) options.onEave(meters);
  });
  const publishRoof = () => {
    const roof = readRoof();
    if (roof !== null) options.onRoof(roof);
  };
  roofType.addEventListener('change', publishRoof);
  direction.addEventListener('change', publishRoof);
  pitch.addEventListener('change', publishRoof);
  overhang.addEventListener('change', publishRoof);
  orientation.addEventListener('change', () => {
    const degrees = Number(orientation.value);
    if (Number.isFinite(degrees)) options.onOrientation(degrees);
  });
  traceToggle.addEventListener('click', () => {
    tracing = !tracing;
    traceToggle.textContent = tracing ? 'Done editing' : 'Edit outline';
    options.onTracing(tracing);
  });
  required<HTMLButtonElement>(root, '#new-outline').addEventListener('click', () => options.onNewOutline());
  required<HTMLInputElement>(root, '#opacity').addEventListener('input', (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement) options.onOpacity(Number(target.value));
  });
  required<HTMLButtonElement>(root, '#export-json').addEventListener('click', () => {
    if (model === null) return;
    download(`${slug(model.label)}.json`, new Blob([exportHouseJson(model)], { type: 'application/json' }));
  });
  required<HTMLInputElement>(root, '#import-json').addEventListener('change', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    const file = target.files?.[0];
    target.value = '';
    if (file === undefined) return;
    try {
      options.onImport(importHouseJson(await file.text()));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'That file could not be imported.';
      window.alert(message);
    }
  });
  required<HTMLButtonElement>(root, '#export-glb').addEventListener('click', async () => {
    if (model === null) return;
    const blob = await exportHouseGlb(options.houseObject());
    download(`${slug(model.label)}.glb`, blob);
  });

  return {
    setModel(next) {
      model = next;
      label.textContent = next.label;
      area.textContent = `${houseFootprintArea(next).toFixed(1)} m²`;
      const editing = root.contains(document.activeElement);
      const part = next.parts[0];
      if (!editing && part !== undefined) {
        eave.value = String(part.eaveHeightM);
        roofType.value = part.roof.type;
        direction.value = String(part.roof.directionDeg);
        pitch.value = String(part.roof.pitchDeg);
        overhang.value = String(part.roof.overhangM);
        orientation.value = String(next.orientationDeg);
      }
      provenance.replaceChildren(
        ...Object.entries(next.provenance).map(([name, item]) => {
          const row = document.createElement('li');
          const note = item.note === undefined ? '' : ` — ${item.note}`;
          row.textContent = `${name}: ${item.source}, confidence ${item.confidence.toFixed(2)}${note}`;
          return row;
        }),
      );
      issues.replaceChildren(
        ...next.issues.map((issue) => {
          const row = document.createElement('li');
          row.textContent = issue;
          return row;
        }),
      );
    },
  };
}

function isRoofType(value: string): value is RoofType {
  return value === 'flat' || value === 'shed' || value === 'gable' || value === 'hip';
}

function slug(label: string): string {
  const cleaned = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return cleaned.length > 0 ? cleaned : 'house';
}

function download(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector}.`);
  return element;
}
