import { PANEL_KW_PER_M2, panelKwhPerM2, type RoofTotal } from '../solar/heatmap.ts';

/** What one heatmap square shows when it is clicked. */
export interface CellReading {
  /** Share of the ideal panel's sunlight. */
  share: number;
  kwhPerM2: number;
  /** Sunlight lost to shade, as a share of what this square would get in the open. */
  shadeLoss: number;
  tiltDeg: number;
  azimuthDeg: number;
  areaM2: number;
  /** Sunlight lost to clouds, from the place's weather record. Null when there is none and the sky is cloudless. */
  cloudLoss: number | null;
  /** The share counted as a good spot, such as 0.8. */
  goodShare: number;
  /** The roof side the square is on, added up. */
  side: RoofTotal;
  /** The building's whole roof, when it has more than one side. */
  roof: RoofTotal | null;
}

/** Space between the label and its square, and the least between the label and the view's edges. */
const GAP_PX = 12;
const MARGIN_PX = 8;

const FACINGS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'] as const;

/** A small label pinned to a clicked heatmap square in the 3D view. */
export function mountCellReadout(stage: HTMLElement): {
  show: (reading: CellReading) => void;
  /** Screen position inside the stage, or null when the square is behind the camera. */
  place: (at: { x: number; y: number } | null) => void;
  hide: () => void;
} {
  const label = document.createElement('div');
  label.id = 'cell-readout';
  label.hidden = true;
  label.setAttribute('role', 'status');
  // Beside the stage rather than in it, so it can sit in front of the controls panel. The stage fills the app, so the coordinates match.
  stage.after(label);
  // Presses on the label are for selecting its text, not for turning the view or picking another square.
  for (const type of ['pointerdown', 'click', 'wheel', 'contextmenu'] as const) {
    label.addEventListener(type, (event) => event.stopPropagation());
  }
  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.className = 'readout-copy';
  copyButton.addEventListener('click', () => {
    // Each line of the label on its own line, without the button's own text.
    const text = [...label.children]
      .filter((child) => child !== copyButton)
      // textContent, not innerText: the headings are only shown in capitals.
      .map((child) => (child.textContent ?? '').trim())
      .join('\n');
    navigator.clipboard.writeText(text).then(
      () => {
        copyButton.textContent = 'Copied';
      },
      () => {
        copyButton.textContent = 'Select the text to copy';
      },
    );
  });

  return {
    show(reading) {
      const flat = reading.tiltDeg < 2;
      const facing = FACINGS[Math.round(reading.azimuthDeg / 45) % 8] ?? 'south';
      const shade = reading.shadeLoss >= 0.005 ? `shade takes ${Math.round(reading.shadeLoss * 100)}%` : 'no shade';
      const losses =
        reading.cloudLoss === null ? `Cloudless sky (no weather record), ${shade}` : `Clouds take ${Math.round(reading.cloudLoss * 100)}%, ${shade}`;
      const lines = [
        `<strong>${Math.round(reading.share * 100)}%</strong> of an ideal panel`,
        `Sunlight: ${Math.round(reading.kwhPerM2).toLocaleString()} kWh/m² a year`,
        losses,
        ...(reading.cloudLoss === null
          ? []
          : [`<b>Panel output: about ${Math.round(panelKwhPerM2(reading.kwhPerM2))} kWh a year</b> per m² of solar panel`]),
        flat ? 'Flat roof' : `Faces ${facing}, ${Math.round(reading.tiltDeg)}° slope`,
      ];
      // Totals: how big a system panels over the whole side, and over the building's best squares, would be, and what it would make.
      const measured = reading.cloudLoss !== null;
      const system = (areaM2: number, sunKwh: number) =>
        `About ${roundKw(areaM2 * PANEL_KW_PER_M2)} kW of panels${measured ? `, <b>about ${roundKwh(panelKwhPerM2(sunKwh))} kWh a year</b>` : ''}`;
      const side = reading.side;
      lines.push(
        `<span class="readout-head">This roof side</span>`,
        `${Math.round(side.areaM2)} m², average ${Math.round(side.meanShare * 100)}%`,
        system(side.areaM2, side.kwh),
      );
      const roof = reading.roof;
      if (roof !== null) {
        lines.push(
          `<span class="readout-head">This building's whole roof</span>`,
          `${Math.round(roof.areaM2)} m², average ${Math.round(roof.meanShare * 100)}%`,
          system(roof.areaM2, roof.kwh),
        );
        if (roof.goodM2 >= 1 && roof.goodM2 < roof.areaM2 - 0.5) {
          lines.push(`Just its ${Math.round(reading.goodShare * 100)}%+ squares: ${Math.round(roof.goodM2)} m²`, system(roof.goodM2, roof.goodKwh));
        }
      }
      lines.push(`<span class="readout-note">Totals cover every square with panels, edges included.</span>`);
      if (reading.areaM2 < 0.95) lines.push(`Edge square: ${reading.areaM2.toFixed(1)} m² of roof`);
      label.innerHTML = lines.map((line) => (line.startsWith('<span class="readout-') ? line : `<span>${line}</span>`)).join('');
      label.prepend(copyButton);
      copyButton.textContent = 'Copy';
      label.hidden = false;
    },
    place(at) {
      if (label.hidden) return;
      label.style.visibility = at === null ? 'hidden' : 'visible';
      if (at === null) return;
      // Above the square, unless that runs off the top: then below it, pointing up.
      const width = label.offsetWidth;
      const height = label.offsetHeight;
      const room = stage.clientWidth;
      const stageBox = stage.getBoundingClientRect();
      const panelBox = document.querySelector('#panel')?.getBoundingClientRect();
      // The controls panel floats over the view's left side. Where the label would cross it, its left edge starts past the panel.
      const leftEdgeAt = (below: boolean) => {
        if (panelBox === undefined) return MARGIN_PX;
        const top = (below ? at.y + GAP_PX : at.y - GAP_PX - height) + stageBox.top;
        const crosses = top < panelBox.bottom && top + height > panelBox.top;
        return crosses ? Math.max(MARGIN_PX, panelBox.right - stageBox.left + MARGIN_PX) : MARGIN_PX;
      };
      const fits = (leftEdge: number) => room - MARGIN_PX - leftEdge >= width;
      let below = at.y - height - GAP_PX < MARGIN_PX;
      // On a narrow screen there is no room beside the panel: hang below the square instead, if that clears it.
      if (!below && !fits(leftEdgeAt(false)) && fits(leftEdgeAt(true))) below = true;
      label.dataset.below = below ? 'true' : 'false';
      const leftEdge = leftEdgeAt(below);
      const left = Math.min(Math.max(at.x, leftEdge + width / 2), room - MARGIN_PX - width / 2);
      label.style.left = `${left}px`;
      label.style.top = `${at.y}px`;
      // The arrow still points at the square when the label slides sideways.
      label.style.setProperty('--arrow-x', `${at.x - left}px`);
    },
    hide() {
      label.hidden = true;
    },
  };
}

/** Panel rating in kW: one decimal place below 10 kW, two significant figures above. */
function roundKw(kw: number): string {
  if (kw < 10) return kw.toFixed(1);
  return roundKwh(kw);
}

/** Two significant figures: the estimate is not better than that. */
function roundKwh(kwh: number): string {
  if (kwh < 100) return String(Math.round(kwh));
  const step = 10 ** (Math.floor(Math.log10(kwh)) - 1);
  return (Math.round(kwh / step) * step).toLocaleString();
}
