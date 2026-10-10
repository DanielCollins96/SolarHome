import { ArrowHelper, CanvasTexture, Group, Sprite, SpriteMaterial, Vector3 } from 'three';

/** A ground arrow pointing true north (-Z), plus a label at its tip. */
export function createNorthArrow(): Group {
  const group = new Group();
  group.name = 'north-arrow';

  // South of the house, in open ground, pointing toward -Z (north).
  const origin = new Vector3(0, 0.2, 8.2);
  const arrow = new ArrowHelper(new Vector3(0, 0, -1), origin, 3.2, 0xc73838, 1.1, 0.6);
  arrow.name = 'north-arrow-shaft';
  group.add(arrow);

  const label = createNorthLabel();
  if (label) {
    label.position.set(0, 1.6, 8.6);
    group.add(label);
  }
  return group;
}

function createNorthLabel(): Sprite | null {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  if (!context) return null;

  context.clearRect(0, 0, 128, 128);
  context.fillStyle = '#c73838';
  context.font = 'bold 84px sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText('N', 64, 68);

  const material = new SpriteMaterial({
    map: new CanvasTexture(canvas),
    depthTest: true,
    transparent: true,
  });
  const sprite = new Sprite(material);
  sprite.name = 'north-label';
  sprite.scale.set(1.6, 1.6, 1);
  sprite.renderOrder = 2;
  return sprite;
}
