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
  setSite(lede: string, meta: string): void;
  setView(view: 'map' | 'plane'): void;
  tools: HTMLElement;
}

export function mountControls(
  parent: HTMLElement,
  clock: ClockState,
  options: {
    onChange: () => void;
    solarNoonMinutes: (isoDate: string) => number;
    onView: (view: 'map' | 'plane') => void;
  },
): ControlsHandle {
  const panel = document.createElement('aside');
  panel.id = 'panel';
  panel.innerHTML = `
    <div class="bar">
      <h1>SolarHome</h1>
      <div class="view-toggle" role="group" aria-label="View">
        <button id="show-map" type="button" aria-pressed="true">Map</button>
        <button id="show-plane" type="button" aria-pressed="false">3D</button>
      </div>
      <div id="tools"></div>
      <label>
        Date
        <input id="date" type="date" value="${clock.date}" />
      </label>
      <div class="time-row">
        <label class="time-label">
          Local time <strong id="time-label">${formatMinutes(clock.minutes)}</strong>
          <input id="time" type="range" min="0" max="1439" step="1" value="${clock.minutes}" />
        </label>
        <button id="play-time" type="button" aria-pressed="false">Play</button>
      </div>
      <button id="solar-noon" type="button">Solar noon</button>
      <p class="meta" id="site-meta">
        ${DEMO_LOCATION.latitude.toFixed(4)}°N, ${Math.abs(DEMO_LOCATION.longitude).toFixed(4)}°W
      </p>
    </div>
    <p class="lede" id="site-lede">Demonstration house at ${DEMO_LOCATION.name}. Click a building, or shift-drag a small box.</p>
    <p id="noon-note" class="note"></p>
    <dl>
      <div><dt>Sun altitude</dt><dd id="altitude">—</dd></div>
      <div><dt>Sun azimuth</dt><dd id="azimuth">—</dd></div>
      <div><dt>Shadow falls</dt><dd id="shadow">—</dd></div>
    </dl>
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
  const lede = required<HTMLElement>(panel, '#site-lede');
  const meta = required<HTMLElement>(panel, '#site-meta');
  const tools = required<HTMLElement>(panel, '#tools');
  const showMap = required<HTMLButtonElement>(panel, '#show-map');
  const showPlane = required<HTMLButtonElement>(panel, '#show-plane');
  const playButton = required<HTMLButtonElement>(panel, '#play-time');
  const setView = (view: 'map' | 'plane') => {
    showMap.setAttribute('aria-pressed', view === 'map' ? 'true' : 'false');
    showPlane.setAttribute('aria-pressed', view === 'plane' ? 'true' : 'false');
  };
  showMap.addEventListener('click', () => {
    setView('map');
    options.onView('map');
  });
  showPlane.addEventListener('click', () => {
    setView('plane');
    options.onView('plane');
  });

  let playing = false;
  let lastTick = 0;
  const stopPlay = () => {
    playing = false;
    lastTick = 0;
    playButton.textContent = 'Play';
    playButton.setAttribute('aria-pressed', 'false');
  };
  const tickPlay = (now: number) => {
    if (!playing) return;
    if (lastTick !== 0) {
      const delta = Math.min(100, now - lastTick);
      clock.minutes = (clock.minutes + (delta / 1000) * 60) % 1440;
      publish();
    }
    lastTick = now;
    requestAnimationFrame(tickPlay);
  };
  playButton.addEventListener('click', () => {
    playing = !playing;
    playButton.textContent = playing ? 'Pause' : 'Play';
    playButton.setAttribute('aria-pressed', playing ? 'true' : 'false');
    if (playing) requestAnimationFrame(tickPlay);
    else lastTick = 0;
  });

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
    stopPlay();
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
    setSite(ledeText, metaText) {
      lede.textContent = ledeText;
      meta.textContent = metaText;
    },
    setView,
    tools,
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
