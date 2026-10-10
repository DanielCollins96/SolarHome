import { DEMO_LOCATION } from '../scene/demoLocation.ts';
import { formatMinutes } from '../sun/zonedTime.ts';

export interface ClockState {
  /** Civil date at the site, YYYY-MM-DD. */
  date: string;
  /** Minutes since local midnight at the site. */
  minutes: number;
}

export const DEFAULT_CLOCK: ClockState = {
  date: '2026-06-21',
  minutes: 15 * 60,
};

export interface SunReadout {
  altitudeDeg: number;
  azimuthDeg: number;
  shadowLabel: string;
  belowHorizon: boolean;
}

export interface ControlsHandle {
  setReadout(readout: SunReadout): void;
  setStatus(message: string): void;
}

export function mountControls(
  parent: HTMLElement,
  clock: ClockState,
  options: {
    onChange: () => void;
    solarNoonMinutes: (isoDate: string) => number;
  },
): ControlsHandle {
  const panel = document.createElement('aside');
  panel.id = 'panel';
  panel.innerHTML = `
    <h1>SolarHome</h1>
    <p class="lede">
      Hardcoded house at ${DEMO_LOCATION.name}. Height and roof shape are illustrative, not measured.
      Address search and traced outlines come later.
    </p>
    <p class="meta">
      ${DEMO_LOCATION.latitude.toFixed(4)}°N, ${Math.abs(DEMO_LOCATION.longitude).toFixed(4)}°W
      · ${DEMO_LOCATION.timeZone}
    </p>
    <label>
      Date
      <input id="date" type="date" value="${clock.date}" />
    </label>
    <label>
      Local time <strong id="time-label">${formatMinutes(clock.minutes)}</strong>
      <input id="time" type="range" min="0" max="1439" step="1" value="${clock.minutes}" />
    </label>
    <button id="solar-noon" type="button">Jump to solar noon</button>
    <dl>
      <div><dt>Sun altitude</dt><dd id="altitude">—</dd></div>
      <div><dt>Sun azimuth</dt><dd id="azimuth">—</dd></div>
      <div><dt>Shadow falls</dt><dd id="shadow">—</dd></div>
    </dl>
    <p id="noon-note" class="note"></p>
    <p id="status" class="status"></p>
  `;
  parent.append(panel);

  const dateInput = required<HTMLInputElement>(panel, '#date');
  const timeInput = required<HTMLInputElement>(panel, '#time');
  const timeLabel = required<HTMLElement>(panel, '#time-label');
  const noonButton = required<HTMLButtonElement>(panel, '#solar-noon');
  const altitude = required<HTMLElement>(panel, '#altitude');
  const azimuth = required<HTMLElement>(panel, '#azimuth');
  const shadow = required<HTMLElement>(panel, '#shadow');
  const noonNote = required<HTMLElement>(panel, '#noon-note');
  const status = required<HTMLElement>(panel, '#status');

  const publish = () => {
    timeLabel.textContent = formatMinutes(clock.minutes);
    timeInput.value = String(clock.minutes);
    options.onChange();
  };

  dateInput.addEventListener('change', () => {
    if (!dateInput.value) return;
    clock.date = dateInput.value;
    publish();
  });

  timeInput.addEventListener('input', () => {
    clock.minutes = Number(timeInput.value);
    timeLabel.textContent = formatMinutes(clock.minutes);
    options.onChange();
  });

  noonButton.addEventListener('click', () => {
    clock.minutes = Math.round(options.solarNoonMinutes(clock.date));
    publish();
  });

  return {
    setReadout(readout) {
      altitude.textContent = `${readout.altitudeDeg.toFixed(1)}°`;
      azimuth.textContent = `${readout.azimuthDeg.toFixed(1)}° from north`;
      shadow.textContent = readout.belowHorizon ? 'none — sun is down' : readout.shadowLabel;
      const nearSouth = angularDifference(readout.azimuthDeg, 180) <= 1;
      noonNote.textContent =
        !readout.belowHorizon && nearSouth
          ? 'Solar noon. In the northern hemisphere the shadow points north.'
          : 'At solar noon the shadow points north.';
    },
    setStatus(message) {
      status.textContent = message;
    },
  };
}

function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector}.`);
  return element;
}

function angularDifference(a: number, b: number): number {
  return Math.abs((((a - b) % 360) + 540) % 360 - 180);
}
