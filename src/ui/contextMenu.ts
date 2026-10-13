export interface MenuItem {
  label: string;
  run: () => void;
  /** Drawn in red, for something that takes a thing away. */
  danger?: boolean;
}

/**
 * A small right-click menu at a point on the page. A choice, a click elsewhere, Escape, the
 * wheel or a resize closes it.
 */
export function mountContextMenu(): { open: (at: { x: number; y: number }, items: MenuItem[]) => void; close: () => void } {
  const menu = document.createElement('div');
  menu.id = 'context-menu';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  document.body.append(menu);

  const close = () => {
    menu.hidden = true;
    menu.replaceChildren();
  };
  // Capture, so the press that closes the menu is seen before the map or the 3D view handle it.
  window.addEventListener('pointerdown', (event) => {
    if (!menu.hidden && !menu.contains(event.target as Node)) close();
  }, true);
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });
  window.addEventListener('wheel', close, { passive: true });
  window.addEventListener('resize', close);
  menu.addEventListener('contextmenu', (event) => event.preventDefault());

  return {
    close,
    open(at, items) {
      menu.replaceChildren(
        ...items.map((item) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.setAttribute('role', 'menuitem');
          button.textContent = item.label;
          if (item.danger === true) button.classList.add('danger');
          button.addEventListener('click', () => {
            close();
            item.run();
          });
          return button;
        }),
      );
      menu.hidden = false;
      // Keep it on screen near the right and bottom edges.
      const { width, height } = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(4, Math.min(at.x, window.innerWidth - width - 4))}px`;
      menu.style.top = `${Math.max(4, Math.min(at.y, window.innerHeight - height - 4))}px`;
      menu.querySelector('button')?.focus();
    },
  };
}
