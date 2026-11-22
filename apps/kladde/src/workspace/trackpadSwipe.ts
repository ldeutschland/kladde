export type Direction = -1 | 1;

interface TrackpadSwipe {
  area: () => HTMLElement | null;
  can: (direction: Direction) => boolean;
  go: (direction: Direction) => void;
}

interface Gesture {
  across: number;
  along: number;
  axis: "open" | "across" | "ignored";
  spent: boolean;
}

const LOCK = 8;
const TRIGGER = 140;
const QUIET_MS = 220;
const HINT_TRAVEL = 56;

function freshGesture(): Gesture {
  return { across: 0, along: 0, axis: "open", spent: false };
}

function scrollsSideways(element: Element, toward: number) {
  const style = getComputedStyle(element);

  if (!/(auto|scroll)/.test(style.overflowX)) return false;
  if (element.scrollWidth <= element.clientWidth) return false;
  if (toward < 0) return element.scrollLeft > 0;

  return element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
}

function scrollableBetween(
  from: EventTarget | null,
  area: Element,
  delta: number,
) {
  let element = from instanceof Element ? from : null;

  while (element && element !== area.parentElement) {
    if (scrollsSideways(element, delta)) return true;
    element = element.parentElement;
  }

  return false;
}

function fingerDirection(e: WheelEvent, across: number): Direction {
  const inverted = (
    e as WheelEvent & { webkitDirectionInvertedFromDevice?: boolean }
  ).webkitDirectionInvertedFromDevice;
  const fingersRight = inverted === false ? across > 0 : across < 0;

  return fingersRight ? -1 : 1;
}

function makeHint() {
  const hint = document.createElement("div");

  hint.className = "swipehint";
  hint.setAttribute("aria-hidden", "true");
  document.body.append(hint);

  return hint;
}

function showHint(hint: HTMLElement, direction: Direction, share: number) {
  const pull = Math.min(1, share);

  hint.dataset.side = direction < 0 ? "back" : "forward";
  hint.dataset.ready = pull >= 1 ? "true" : "false";
  hint.style.setProperty("--pull", String(pull * HINT_TRAVEL));
  hint.style.opacity = String(pull);
}

function hideHint(hint: HTMLElement) {
  hint.style.opacity = "0";
}

export function followTrackpadSwipe({ area, can, go }: TrackpadSwipe) {
  const hint = makeHint();
  let gesture = freshGesture();
  let quiet = 0;

  const finish = () => {
    gesture = freshGesture();
    hideHint(hint);
  };

  const lockAxis = (e: WheelEvent, root: HTMLElement) => {
    if (Math.max(Math.abs(gesture.across), Math.abs(gesture.along)) < LOCK)
      return;
    const sideways = Math.abs(gesture.across) > Math.abs(gesture.along) * 2;
    const blocked = scrollableBetween(e.target, root, gesture.across);

    gesture.axis = sideways && !blocked ? "across" : "ignored";
  };

  const wheel = (e: WheelEvent) => {
    const root = area();

    window.clearTimeout(quiet);
    quiet = window.setTimeout(finish, QUIET_MS);
    if (!root || !(e.target instanceof Node) || !root.contains(e.target))
      return;
    if (e.ctrlKey || gesture.spent || gesture.axis === "ignored") return;
    gesture.across += e.deltaX;
    gesture.along += e.deltaY;
    if (gesture.axis === "open") lockAxis(e, root);
    if (gesture.axis !== "across") return;
    const direction = fingerDirection(e, gesture.across);

    if (!can(direction)) return hideHint(hint);
    const share = Math.abs(gesture.across) / TRIGGER;

    showHint(hint, direction, share);
    if (share < 1) return;
    gesture.spent = true;
    hideHint(hint);
    go(direction);
  };

  window.addEventListener("wheel", wheel, { passive: true });

  return () => {
    window.removeEventListener("wheel", wheel);
    window.clearTimeout(quiet);
    hint.remove();
  };
}
