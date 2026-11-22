const SCROLL_LIMIT = 200;
const PICTURE_LIMIT = 8;
const RESTORE_FRAMES = 30;
const ROOT_PREFIX = "root:";
const LIVE_CONTENT = "iframe, video, audio, object, embed, canvas";

const scrolls = new Map<string, number>();
const pictures = new Map<string, HTMLElement>();

function store<V>(map: Map<string, V>, key: string, value: V, limit: number) {
  map.delete(key);
  map.set(key, value);
  if (map.size <= limit) return;
  const oldest = map.keys().next().value;

  if (oldest !== undefined) map.delete(oldest);
}

function stillPicture(view: HTMLElement) {
  const copy = view.cloneNode(true) as HTMLElement;

  copy.querySelectorAll(LIVE_CONTENT).forEach((node) => node.remove());
  copy.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
  copy.removeAttribute("id");

  return copy;
}

export function viewKey(page: string | null, root: string) {
  return page ?? ROOT_PREFIX + root;
}

export function rememberView(view: HTMLElement | null, withPicture: boolean) {
  const key = view?.dataset.view;

  if (!view || !key) return;
  store(scrolls, key, view.scrollTop, SCROLL_LIMIT);
  if (withPicture) store(pictures, key, stillPicture(view), PICTURE_LIMIT);
}

export function restoreView(view: HTMLElement) {
  const top = scrolls.get(view.dataset.view ?? "") ?? 0;
  let frames = 0;

  const attempt = () => {
    view.scrollTop = top;
    frames += 1;
    if (!view.isConnected || frames >= RESTORE_FRAMES) return;
    if (Math.abs(view.scrollTop - top) > 1) requestAnimationFrame(attempt);
  };

  attempt();
}

export function showPicture(key: string, above: HTMLElement) {
  const picture = pictures.get(key);

  if (!picture || !above.parentElement) return null;
  const layer = document.createElement("div");

  layer.className = "underlay";
  layer.inert = true;
  layer.setAttribute("aria-hidden", "true");
  layer.append(picture);
  above.before(layer);
  picture.scrollTop = scrolls.get(key) ?? 0;

  return layer;
}
