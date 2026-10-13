import { Vector3, type Camera, type PerspectiveCamera } from 'three';
import type { SunVector } from '../sun/sunPosition.ts';

export interface CompassSun {
  azimuthDeg: number;
  altitudeDeg: number;
}

/** Within this many degrees of north, the view counts as facing north, and a click turns it south. */
const FACING_NORTH_DEG = 10;

/**
 * Screen compass. The rose rotates so N keeps pointing at world north (-Z). A click turns the
 * view to face north, or south when it already faces north.
 */
export function mountCompass(parent: HTMLElement, onFace: (bearingDeg: 0 | 180) => void): { update(camera: Camera, sun: CompassSun): void } {
  const root = document.createElement('button');
  root.id = 'compass';
  root.type = 'button';
  root.innerHTML = `
    <div class="rose">
      <span class="tick n">N</span>
      <span class="tick e">E</span>
      <span class="tick s">S</span>
      <span class="tick w">W</span>
      <span class="sun-mark" hidden></span>
    </div>
  `;
  parent.append(root);

  const rose = root.querySelector<HTMLElement>('.rose');
  const sunMark = root.querySelector<HTMLElement>('.sun-mark');
  if (!rose || !sunMark) throw new Error('Compass rose is missing.');

  let facingNorth = false;
  root.addEventListener('click', () => onFace(facingNorth ? 180 : 0));
  // A press on the compass must not also start turning the view underneath it.
  root.addEventListener('pointerdown', (event) => event.stopPropagation());
  const look = new Vector3();
  return {
    update(camera: Camera, sun: CompassSun) {
      camera.getWorldDirection(look);
      const bearing = Math.atan2(look.x, -look.z);
      const nowNorth = Math.abs(bearing) < (FACING_NORTH_DEG * Math.PI) / 180;
      if (nowNorth !== facingNorth || !root.hasAttribute('aria-label')) {
        facingNorth = nowNorth;
        const label = facingNorth ? 'Face south' : 'Face north';
        root.setAttribute('aria-label', label);
        root.title = label;
      }
      rose.style.transform = `rotate(${-bearing}rad)`;
      const up = sun.altitudeDeg > 0;
      sunMark.hidden = !up;
      if (up) sunMark.style.transform = `rotate(${sun.azimuthDeg}deg) translateY(-34px)`;
    },
  };
}

/** On-screen sun. Sticks to the edge of the 3D view when the disc is outside the frame. */
export function mountSunBadge(parent: HTMLElement): {
  update(camera: PerspectiveCamera, sun: SunVector & { altitudeDeg: number }, target: Vector3, width: number, height: number): void;
} {
  const badge = document.createElement('div');
  badge.id = 'sun-badge';
  badge.textContent = 'Sun';
  badge.hidden = true;
  parent.append(badge);
  const point = new Vector3();
  return {
    update(camera, sun, target, width, height) {
      const up = sun.altitudeDeg > 0 && width > 0 && height > 0;
      badge.hidden = !up;
      if (!up) return;
      point.set(target.x + sun.x * 400, target.y + sun.y * 400, target.z + sun.z * 400);
      point.project(camera);
      let x = (point.x * 0.5 + 0.5) * width;
      let y = (-point.y * 0.5 + 0.5) * height;
      const behind = point.z > 1;
      if (behind) {
        x = width - x;
        y = height - y;
      }
      const pad = 36;
      const edge = behind || x < pad || y < pad || x > width - pad || y > height - pad;
      x = Math.min(width - pad, Math.max(pad, x));
      y = Math.min(height - pad, Math.max(pad, y));
      const panel = document.querySelector('#panel');
      if (panel !== null) {
        const panelBox = panel.getBoundingClientRect();
        const stageBox = parent.getBoundingClientRect();
        const panelRight = panelBox.right - stageBox.left + 16;
        const panelBottom = panelBox.bottom - stageBox.top + 16;
        if (x < panelRight && y < panelBottom) {
          if (panelRight - x < panelBottom - y) x = Math.min(width - pad, panelRight);
          else y = Math.min(height - pad, panelBottom);
        }
      }
      // The compass sits in the top-right corner. Slide the badge below it rather than over it.
      const compass = parent.querySelector('#compass');
      if (compass !== null) {
        const compassBox = compass.getBoundingClientRect();
        const stageBox = parent.getBoundingClientRect();
        const left = compassBox.left - stageBox.left - pad;
        const bottom = compassBox.bottom - stageBox.top + pad;
        if (x > left && y < bottom) {
          if (x - left < bottom - y) x = Math.max(pad, left);
          else y = Math.min(height - pad, bottom);
        }
      }
      badge.dataset.edge = edge ? 'true' : 'false';
      badge.style.left = `${x}px`;
      badge.style.top = `${y}px`;
    },
  };
}
