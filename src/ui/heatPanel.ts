import { heatGradientCss, panelKwhPerM2, type HeatSummary } from '../solar/heatmap.ts';

/**
 * The "Solar heatmap" switch, its colour key, progress while the year is traced, and a short
 * summary of the roof once it is done.
 */
export function mountHeatPanel(
  parent: HTMLElement,
  options: { onToggle: (on: boolean) => void },
): {
  on: () => boolean;
  /** A share from 0 to 1 while the sunlight is traced. */
  setProgress: (share: number) => void;
  /** `cloudLoss` is the roof's sunlight lost to clouds; null when there is no weather record and the sky is cloudless. */
  setSummary: (summary: HeatSummary, reference: string, cloudLoss: number | null) => void;
  setMessage: (text: string) => void;
} {
  const block = document.createElement('section');
  block.className = 'heat-panel';
  block.innerHTML = `
    <button id="heat-toggle" type="button" aria-pressed="false">Solar heatmap</button>
    <div id="heat-body" hidden>
      <div class="heat-head">
        <div class="heat-key" aria-hidden="true">
          <span class="heat-bar"></span>
          <span class="heat-ticks"><span>0%</span><span>50%</span><span>100%</span></span>
        </div>
        <button id="heat-about" type="button" aria-expanded="false" aria-controls="heat-reference" aria-label="About these figures" title="About these figures">i</button>
      </div>
      <p id="heat-status" class="note" aria-live="polite"></p>
      <dl id="heat-summary" hidden>
        <div><dt>Roof</dt><dd id="heat-roof"></dd></div>
        <div><dt>Average</dt><dd id="heat-mean"></dd></div>
        <div><dt id="heat-good-label">80%+</dt><dd id="heat-good"></dd></div>
        <div><dt>Lost to clouds</dt><dd id="heat-clouds"></dd></div>
        <div><dt>Lost to shade</dt><dd id="heat-loss"></dd></div>
        <div id="heat-output-row" class="heat-wide"><dt id="heat-output-label"></dt><dd id="heat-output"></dd></div>
      </dl>
      <p id="heat-reference" class="note" hidden></p>
    </div>
  `;
  parent.append(block);
  const toggle = required<HTMLButtonElement>(block, '#heat-toggle');
  const body = required<HTMLElement>(block, '#heat-body');
  const status = required<HTMLElement>(block, '#heat-status');
  const summaryList = required<HTMLElement>(block, '#heat-summary');
  const reference = required<HTMLElement>(block, '#heat-reference');
  required<HTMLElement>(block, '.heat-bar').style.background = heatGradientCss();
  // How the figures are made, and their sources, behind an info button.
  const about = required<HTMLButtonElement>(block, '#heat-about');
  about.addEventListener('click', () => {
    reference.hidden = !reference.hidden;
    about.setAttribute('aria-expanded', String(!reference.hidden));
  });
  let on = false;

  toggle.addEventListener('click', () => {
    on = !on;
    toggle.setAttribute('aria-pressed', String(on));
    body.hidden = !on;
    if (!on) {
      status.textContent = '';
      summaryList.hidden = true;
    }
    options.onToggle(on);
  });

  return {
    on: () => on,
    setProgress(share) {
      // The last result stays up while a change of trees or neighbours is traced again.
      const verb = summaryList.hidden ? 'Tracing a year of sunlight' : 'Updating for the latest shade';
      status.textContent = `${verb}… ${Math.round(share * 100)}%`;
    },
    setSummary(summary, referenceText, cloudLoss) {
      const measured = cloudLoss !== null;
      required<HTMLElement>(block, '#heat-clouds').textContent = measured ? `${Math.round(cloudLoss * 100)}%` : 'not counted';
      status.textContent = '';
      summaryList.hidden = false;
      required<HTMLElement>(block, '#heat-roof').textContent = `${Math.round(summary.roofM2)} m²`;
      required<HTMLElement>(block, '#heat-mean').textContent = `${Math.round(summary.meanShare * 100)}%`;
      required<HTMLElement>(block, '#heat-good-label').textContent = `${Math.round(summary.goodShare * 100)}% or more`;
      required<HTMLElement>(block, '#heat-good').textContent = `${Math.round(summary.goodM2)} m²`;
      required<HTMLElement>(block, '#heat-loss').textContent = `${Math.round(summary.shadeLoss * 100)}%`;
      const outputRow = required<HTMLElement>(block, '#heat-output-row');
      // A cloudless year would overstate the electricity by a third or more, so it is only given with real weather.
      outputRow.hidden = !measured || summary.goodM2 < 1;
      required<HTMLElement>(block, '#heat-output-label').textContent = `Panel output, with solar panels on the ${Math.round(summary.goodShare * 100)}%+ squares`;
      required<HTMLElement>(block, '#heat-output').textContent = `about ${roundKwh(panelKwhPerM2(summary.goodKwh))} kWh of electricity a year`;
      reference.textContent = referenceText;
    },
    setMessage(text) {
      status.textContent = text;
      summaryList.hidden = true;
    },
  };
}

/** Two significant figures: the estimate is not better than that. */
function roundKwh(kwh: number): string {
  if (kwh < 100) return String(Math.round(kwh));
  const step = 10 ** (Math.floor(Math.log10(kwh)) - 1);
  return (Math.round(kwh / step) * step).toLocaleString();
}

function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (element === null) throw new Error(`Missing ${selector}`);
  return element;
}
