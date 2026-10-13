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
  /** `at`, when given, adds a link that opens the place in Google Maps. */
  setSite(lede: string, meta: string, at?: { latitude: number; longitude: number }): void;
  setView(view: 'map' | 'plane'): void;
  /** Marks sunrise and sunset on the time slider, in minutes since local midnight. Null hides a mark. */
  setDaylight(sunrise: number | null, sunset: number | null): void;
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
    <div class="panel-head">
      <h1>SolarHome</h1>
      <div class="view-toggle" role="group" aria-label="View">
        <button id="show-map" type="button" aria-pressed="true">Map</button>
        <button id="show-plane" type="button" aria-pressed="false">3D</button>
      </div>
      <button id="fold-panel" type="button" aria-expanded="true" aria-label="Show fewer controls">${CHEVRON}</button>
    </div>
    <div id="panel-body" class="bar">
      <div id="tools"></div>
      <div class="when">
        <label class="sr" for="date">Date</label>
        <input id="date" type="date" value="${clock.date}" aria-label="Date" />
        <strong id="time-label">${formatMinutes(clock.minutes)}</strong>
      </div>
      <div class="time-row">
        <label class="sr" for="time">Local time</label>
        <div class="time-track">
          <input id="time" type="range" min="0" max="1439" step="1" value="${clock.minutes}" aria-label="Local time" />
          <span id="sunrise-flag" class="sun-flag" hidden><span class="sr">Sunrise</span><span class="sun-flag-time"></span></span>
          <span id="sunset-flag" class="sun-flag" hidden><span class="sr">Sunset</span><span class="sun-flag-time"></span></span>
        </div>
        <button id="play-time" type="button" aria-pressed="false" aria-label="Play">${PLAY_ICON}</button>
        <button id="solar-noon" type="button" aria-label="Solar noon">${SUN_ICON}</button>
      </div>
      <div class="readout">
        <div><span>Alt</span><strong id="altitude">—</strong></div>
        <div><span>Az</span><strong id="azimuth">—</strong></div>
        <div><span>Shadow</span><strong id="shadow">—</strong></div>
      </div>
      <p class="meta" id="site-meta">
        ${DEMO_LOCATION.latitude.toFixed(4)}°N, ${Math.abs(DEMO_LOCATION.longitude).toFixed(4)}°W
      </p>
    </div>
    <p class="lede" id="site-lede">Demonstration house at ${DEMO_LOCATION.name}. Click a building, or shift-drag a small box.</p>
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
  const lede = required<HTMLElement>(panel, '#site-lede');
  const meta = required<HTMLElement>(panel, '#site-meta');
  const tools = required<HTMLElement>(panel, '#tools');
  const showMap = required<HTMLButtonElement>(panel, '#show-map');
  const showPlane = required<HTMLButtonElement>(panel, '#show-plane');
  const playButton = required<HTMLButtonElement>(panel, '#play-time');
  const foldButton = required<HTMLButtonElement>(panel, '#fold-panel');
  const sunriseFlag = required<HTMLElement>(panel, '#sunrise-flag');
  const sunsetFlag = required<HTMLElement>(panel, '#sunset-flag');
  const placeFlag = (flag: HTMLElement, minutes: number | null, arrow: string) => {
    flag.hidden = minutes === null;
    if (minutes === null) return;
    flag.style.setProperty('--at', String(minutes / 1439));
    required<HTMLElement>(flag, '.sun-flag-time').textContent = `${arrow} ${formatMinutes(minutes)}`;
  };
  foldButton.addEventListener('click', () => {
    const collapsed = panel.classList.toggle('collapsed');
    foldButton.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    foldButton.setAttribute('aria-label', collapsed ? 'Show all controls' : 'Show fewer controls');
  });
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
  // Pause then play within one frame would otherwise leave two loops running at double speed.
  let playLoop = 0;
  const stopPlay = () => {
    playing = false;
    lastTick = 0;
    playButton.innerHTML = PLAY_ICON;
    playButton.setAttribute('aria-label', 'Play');
    playButton.setAttribute('aria-pressed', 'false');
  };
  const tickPlay = (loop: number, now: number) => {
    if (!playing || loop !== playLoop) return;
    if (lastTick !== 0) {
      const delta = Math.min(100, now - lastTick);
      clock.minutes = (clock.minutes + (delta / 1000) * 60) % 1440;
      publish();
    }
    lastTick = now;
    requestAnimationFrame((next) => tickPlay(loop, next));
  };
  playButton.addEventListener('click', () => {
    playing = !playing;
    playButton.innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
    playButton.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    playButton.setAttribute('aria-pressed', playing ? 'true' : 'false');
    lastTick = 0;
    if (playing) {
      const loop = ++playLoop;
      requestAnimationFrame((next) => tickPlay(loop, next));
    }
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
      azimuth.textContent = `${readout.azimuthDeg.toFixed(1)}°`;
      shadow.textContent = readout.belowHorizon ? '—' : shortShadow(readout.shadowLabel);
      // The noon sun is due south north of the tropics and due north south of them.
      const onMeridian = angularDifference(readout.azimuthDeg, 180) <= 1 || angularDifference(readout.azimuthDeg, 0) <= 1;
      noonNote.textContent =
        !readout.belowHorizon && onMeridian
          ? `Solar noon. The shadow points ${readout.shadowLabel}.`
          : 'At solar noon the shadow points north in the northern hemisphere and south in the southern.';
    },
    setStatus(message) {
      status.textContent = message;
    },
    setSite(ledeText, metaText, at) {
      lede.textContent = ledeText;
      meta.textContent = metaText;
      if (at !== undefined) {
        const link = document.createElement('a');
        link.className = 'maps-link';
        link.href = `https://www.google.com/maps/search/?api=1&query=${at.latitude.toFixed(6)},${at.longitude.toFixed(6)}`;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'Google Maps';
        meta.append(' · ', link);
      }
    },
    setView,
    setDaylight(sunrise, sunset) {
      placeFlag(sunriseFlag, sunrise, '↑');
      placeFlag(sunsetFlag, sunset, '↓');
    },
    tools,
  };
}

function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector}.`);
  return element;
}

const SHORT_SHADOW: Record<string, string> = {
  north: 'N',
  northeast: 'NE',
  east: 'E',
  southeast: 'SE',
  south: 'S',
  southwest: 'SW',
  west: 'W',
  northwest: 'NW',
  overhead: '—',
};

function shortShadow(label: string): string {
  return SHORT_SHADOW[label] ?? label;
}

const CHEVRON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 14.5 12 8.5l6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path></svg>`;
const PLAY_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6.5v11l9-5.5-9-5.5Z" fill="currentColor"></path></svg>`;
const PAUSE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 6h3.2v12H7V6Zm6.8 0H17v12h-3.2V6Z" fill="currentColor"></path></svg>`;
const SUN_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="1.8"></circle><path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4 18 18M18 6l-1.6 1.6M7.6 16.4 6 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path></svg>`;

function angularDifference(a: number, b: number): number {
  return Math.abs((((a - b) % 360) + 540) % 360 - 180);
}
