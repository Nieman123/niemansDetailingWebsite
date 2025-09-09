// public/scripts/slider.js
export function hydrateSlider(rootSelector = '.slideshow') {
  const root = document.querySelector(rootSelector);
  if (!root) return;

  const track = root.querySelector('.slides-track');
  const tpl = root.querySelector('#slides-template');
  const prev = root.querySelector('.slide-prev');
  const next = root.querySelector('.slide-next');
  if (!track || !tpl) return;

  // Mount the rest of the slides from template
  const frag = document.createElement('div');
  frag.innerHTML = tpl.innerHTML.trim();
  const toAppend = Array.from(frag.children);
  track.append(...toAppend);

  const slides = Array.from(track.children);
  let index = 0;
  const count = slides.length;

  // Show controls if more than 1 slide
  const showControls = count > 1;
  if (showControls) {
    prev.hidden = false;
    next.hidden = false;
  }

  function go(i) {
    index = (i + count) % count;
    track.style.transform = `translateX(-${index * 100}%)`;
  }

  prev && prev.addEventListener('click', () => go(index - 1));
  next && next.addEventListener('click', () => go(index + 1));

  // Basic swipe support
  let startX = null;
  track.addEventListener('touchstart', e => { startX = e.touches[0].clientX; }, { passive: true });
  track.addEventListener('touchmove', e => {
    if (startX == null) return;
    const dx = e.touches[0].clientX - startX;
    if (Math.abs(dx) > 40) {
      go(index + (dx < 0 ? 1 : -1));
      startX = null;
    }
  }, { passive: true });
}

