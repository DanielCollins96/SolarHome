import { Vector3, type Camera } from 'three';

/** Screen compass. The rose rotates so N keeps pointing at world north (-Z). */
export function mountCompass(parent: HTMLElement): { update(camera: Camera): void } {
  const root = document.createElement('div');
  root.id = 'compass';
  root.setAttribute('aria-hidden', 'true');
  root.innerHTML = `
    <div class="rose">
      <span class="tick n">N</span>
      <span class="tick e">E</span>
      <span class="tick s">S</span>
      <span class="tick w">W</span>
    </div>
  `;
  parent.append(root);

  const rose = root.querySelector<HTMLElement>('.rose');
  if (!rose) throw new Error('Compass rose is missing.');

  const look = new Vector3();
  return {
    update(camera: Camera) {
      camera.getWorldDirection(look);
      const bearing = Math.atan2(look.x, -look.z);
      rose.style.transform = `rotate(${-bearing}rad)`;
    },
  };
}
