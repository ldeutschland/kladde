const EDGE = 24;
const LOCK = 10;
const COMMIT_SHARE = 0.4;
const FLICK_SPEED = 0.45;
const SETTLE_MS = 240;
const STUCK_MS = 1500;
const REVEAL_MS = 260;
const EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";

interface EdgeSwipe {
  surface: () => HTMLElement | null;
  underlay: (surface: HTMLElement) => HTMLElement | null;
  enabled: () => boolean;
  back: () => void;
}

interface Sample {
  x: number;
  time: number;
}

function reducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function scrolledAside(from: EventTarget | null) {
  let element = from instanceof Element ? from : null;

  while (element && element !== document.body) {
    if (element.scrollLeft > 0) return true;
    element = element.parentElement;
  }

  return false;
}

function place(surface: HTMLElement, offset: number) {
  surface.style.transform = offset ? `translate3d(${offset}px, 0, 0)` : "";
}

function settle(surface: HTMLElement, offset: number, done?: () => void) {
  const finish = () => {
    surface.style.transition = "";
    surface.removeAttribute("data-swiping");
    if (!offset) place(surface, 0);
    done?.();
  };

  if (reducedMotion()) {
    place(surface, offset);
    finish();

    return;
  }

  surface.style.transition = `transform ${SETTLE_MS}ms ${EASE}`;
  place(surface, offset);
  window.setTimeout(finish, SETTLE_MS);
}

function release(surface: HTMLElement, layer: HTMLElement | null) {
  const began = performance.now();

  const check = () => {
    if (!surface.isConnected)
      return void window.setTimeout(() => layer?.remove(), REVEAL_MS);
    if (performance.now() - began < STUCK_MS)
      return void requestAnimationFrame(check);
    settle(surface, 0, () => layer?.remove());
  };

  requestAnimationFrame(check);
}

export function followEdgeSwipe({
  surface,
  underlay,
  enabled,
  back,
}: EdgeSwipe) {
  let start: Sample & { y: number } = { x: 0, y: 0, time: 0 };
  let last: Sample = { x: 0, time: 0 };
  let armed = false;
  let moving: HTMLElement | null = null;
  let layer: HTMLElement | null = null;

  const begin = (e: TouchEvent) => {
    const touch = e.touches[0];

    armed =
      e.touches.length === 1 &&
      !!touch &&
      touch.clientX <= EDGE &&
      enabled() &&
      !scrolledAside(e.target);
    if (!armed || !touch) return;
    start = { x: touch.clientX, y: touch.clientY, time: e.timeStamp };
    last = { x: touch.clientX, time: e.timeStamp };
  };

  const grab = (across: number, along: number) => {
    if (Math.abs(along) > LOCK && Math.abs(along) > across) armed = false;
    if (!armed || across < LOCK) return;
    moving = surface();

    if (!moving) {
      armed = false;

      return;
    }

    moving.style.transition = "none";
    moving.setAttribute("data-swiping", "");
    layer = underlay(moving);
  };

  const move = (e: TouchEvent) => {
    const touch = e.touches[0];

    if (!armed || !touch) return;
    const across = touch.clientX - start.x;

    if (!moving) grab(across, touch.clientY - start.y);
    if (!moving) return;
    e.preventDefault();
    last = { x: touch.clientX, time: e.timeStamp };
    place(moving, Math.max(0, across));
  };

  const end = (e: TouchEvent) => {
    const surfaceNow = moving;
    const layerNow = layer;

    armed = false;
    moving = null;
    layer = null;
    if (!surfaceNow) return;
    const x = e.changedTouches[0]?.clientX ?? last.x;
    const across = Math.max(0, x - start.x);
    const speed = (x - last.x) / Math.max(1, e.timeStamp - last.time);
    const width = surfaceNow.clientWidth;
    const leave = across > width * COMMIT_SHARE || speed > FLICK_SPEED;

    if (!leave) return settle(surfaceNow, 0, () => layerNow?.remove());
    settle(surfaceNow, width, () => {
      back();
      release(surfaceNow, layerNow);
    });
  };

  const cancel = () => {
    const layerNow = layer;

    if (moving) settle(moving, 0, () => layerNow?.remove());
    else layerNow?.remove();
    armed = false;
    moving = null;
    layer = null;
  };

  document.addEventListener("touchstart", begin, { passive: true });
  document.addEventListener("touchmove", move, { passive: false });
  document.addEventListener("touchend", end, { passive: true });
  document.addEventListener("touchcancel", cancel, { passive: true });

  return () => {
    document.removeEventListener("touchstart", begin);
    document.removeEventListener("touchmove", move);
    document.removeEventListener("touchend", end);
    document.removeEventListener("touchcancel", cancel);
  };
}
