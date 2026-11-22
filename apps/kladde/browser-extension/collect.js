(() => {
  const MAX_HTML_BYTES = 5 * 1024 * 1024;
  const MAX_IMAGES = 20;
  const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
  const MAX_IMAGE_TOTAL = 30 * 1024 * 1024;
  const MAX_VISITED = 20000;
  const CHUNK = 0x8000;
  const DROPPED =
    "script,style,noscript,template,iframe,frame,object,embed,svg,canvas,video,audio,link";
  const CONTENT = "article, main, [role=main]";
  const WEB = /^https?:$/;

  function absolute(value) {
    try {
      return new URL(value, document.baseURI).href;
    } catch {
      return "";
    }
  }

  function isWeb(address) {
    try {
      return WEB.test(new URL(address).protocol);
    } catch {
      return false;
    }
  }

  function invisible(element) {
    return (
      !element.checkVisibility() &&
      getComputedStyle(element).display !== "contents"
    );
  }

  function settle(live, copy) {
    if (invisible(live)) {
      copy.setAttribute("hidden", "");
      return;
    }
    if (live instanceof HTMLImageElement)
      copy.setAttribute("src", live.currentSrc || live.src);
    if (live instanceof HTMLAnchorElement && live.href)
      copy.setAttribute("href", live.href);
  }

  function settleAll(liveRoot, copyRoot) {
    const live = document.createTreeWalker(liveRoot, NodeFilter.SHOW_ELEMENT);
    const copy = document.createTreeWalker(copyRoot, NodeFilter.SHOW_ELEMENT);
    for (let seen = 0; seen < MAX_VISITED; seen++) {
      if (!live.nextNode() || !copy.nextNode()) return;
      settle(live.currentNode, copy.currentNode);
    }
  }

  function absolutize(root) {
    for (const image of root.querySelectorAll("img[src]"))
      image.setAttribute("src", absolute(image.getAttribute("src")));
    for (const link of root.querySelectorAll("a[href]"))
      link.setAttribute("href", absolute(link.getAttribute("href")));
  }

  function wholePage() {
    const copy = document.documentElement.cloneNode(true);
    const body = copy.querySelector("body");
    if (document.body && body) settleAll(document.body, body);
    return copy;
  }

  function selectedPart() {
    const selection = getSelection();
    if (!selection || selection.isCollapsed) return null;
    const part = document.createDocumentFragment();
    for (let index = 0; index < selection.rangeCount; index++)
      part.append(selection.getRangeAt(index).cloneContents());
    absolutize(part);
    const page = document.implementation.createHTMLDocument(document.title);
    page.body.append(part);
    return page.documentElement;
  }

  function imageCandidates(root, kind) {
    const scope = (kind === "article" && root.querySelector(CONTENT)) || root;
    const addresses = Array.from(scope.querySelectorAll("img[src]"))
      .filter((image) => !image.closest("[hidden]"))
      .map((image) => image.getAttribute("src"))
      .filter(isWeb);
    return [...new Set(addresses)].slice(0, MAX_IMAGES);
  }

  async function encode(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let text = "";
    for (let start = 0; start < bytes.length; start += CHUNK)
      text += String.fromCharCode(...bytes.subarray(start, start + CHUNK));
    return btoa(text);
  }

  async function fetchImage(address, budget) {
    try {
      const response = await fetch(address, { credentials: "include" });
      if (!response.ok) return null;
      const blob = await response.blob();
      if (!blob.size || blob.size > Math.min(MAX_IMAGE_BYTES, budget))
        return null;
      return { url: isWeb(address) ? address : "", data: await encode(blob) };
    } catch {
      return null;
    }
  }

  async function fetchImages(addresses) {
    const images = [];
    let budget = MAX_IMAGE_TOTAL;
    for (const address of addresses) {
      const image = await fetchImage(address, budget);
      if (!image) continue;
      budget -= (image.data.length * 3) / 4;
      images.push(image);
    }
    return images;
  }

  async function page(kind) {
    const root = kind === "selection" ? selectedPart() : wholePage();
    if (!root) return { error: "no_selection" };
    root.querySelectorAll(DROPPED).forEach((node) => node.remove());
    const html = "<!doctype html>" + root.outerHTML;
    if (new TextEncoder().encode(html).length > MAX_HTML_BYTES)
      return { error: "too_large" };
    return { html, images: await fetchImages(imageCandidates(root, kind)) };
  }

  async function image(address) {
    return fetchImage(address, MAX_IMAGE_BYTES);
  }

  globalThis.kladdeCollect = { page, image };
})();
