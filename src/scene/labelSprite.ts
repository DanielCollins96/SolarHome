import { CanvasTexture, LinearFilter, Sprite, SpriteMaterial } from 'three';

/** Screen height of a label, as a share of the view's height. */
const LABEL_HEIGHT = 0.045;

/** A name that stays the same size on screen and in front of everything, to float over a building. */
export function createLabelSprite(text: string): Sprite {
  const scale = 2;
  const font = `600 ${15 * scale}px system-ui, sans-serif`;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (context === null) return new Sprite();
  context.font = font;
  const padX = 10 * scale;
  const height = 28 * scale;
  canvas.width = Math.ceil(Math.min(context.measureText(text).width, 360 * scale) + padX * 2);
  canvas.height = height;
  context.font = font;
  context.fillStyle = 'rgba(255, 255, 255, 0.92)';
  context.beginPath();
  context.roundRect(0, 0, canvas.width, height, height / 2);
  context.fill();
  context.fillStyle = '#1c2430';
  context.textBaseline = 'middle';
  context.fillText(text, padX, height / 2, canvas.width - padX * 2);
  const texture = new CanvasTexture(canvas);
  texture.minFilter = LinearFilter;
  const sprite = new Sprite(new SpriteMaterial({ map: texture, depthTest: false, sizeAttenuation: false, toneMapped: false }));
  sprite.scale.set((LABEL_HEIGHT * canvas.width) / height, LABEL_HEIGHT, 1);
  // Sprites centre on their position. Rest the label's bottom edge there instead.
  sprite.center.set(0.5, 0);
  sprite.renderOrder = 2;
  return sprite;
}
