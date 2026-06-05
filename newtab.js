// SPDX-License-Identifier: MIT
const BOOKMARKS_BAR_ID = "1";
const FAVICON_SIZE = 64;

// Chrome blocks navigating to href="chrome://...". Workaround by opening them as a
// this page with the target as the fragment, then using chrome.tabs.update() to redirect.
const fragmentTarget = location.hash.slice(1);
if (fragmentTarget.startsWith("chrome://")) {
  chrome.tabs.update({ url: fragmentTarget });
}

// Get Chrome's default favicon (the globe) to be used for this page.
function setDefaultFavicon() {
  const link = document.createElement("link");
  link.rel = "icon";
  link.href = faviconUrl("about:blank");
  document.head.appendChild(link);
}

function faviconUrl(pageUrl) {
  const url = new URL(chrome.runtime.getURL("/_favicon/"));
  url.searchParams.set("pageUrl", pageUrl);
  url.searchParams.set("size", String(FAVICON_SIZE));
  return url.toString();
}

// Heuristic for hostnames under a second-level TLD (like "foo.co.uk")
const SECOND_LEVEL_TLDS = new Set([
  "co", "com", "org", "net", "gov", "edu", "ac", "or", "ne", "go",
]);

function initialFor(node) {
  if (node.title) return node.title.trim().charAt(0) || "?";
  if (!node.url) return "?";
  try {
    // Strip subdomains
    const parts = new URL(node.url).hostname.split(".");
    const tldParts = parts.length >= 3 && SECOND_LEVEL_TLDS.has(parts[parts.length - 2]) ? 2 : 1;
    const domain = parts[parts.length - tldParts - 1] ?? parts[0];
    return domain.charAt(0) || "?";
  } catch {
    return "?";
  }
}

function buildIcon(node) {
  const icon = document.createElement("div");
  icon.className = "icon";

  if (!node.url) return icon;

  const img = document.createElement("img");
  img.alt = "";
  img.draggable = false;
  img.loading = "lazy";
  img.referrerPolicy = "no-referrer";
  img.src = faviconUrl(node.url);
  img.addEventListener("error", () => {
    img.remove();
    const fallback = document.createElement("span");
    fallback.className = "fallback";
    fallback.textContent = initialFor(node);
    icon.appendChild(fallback);
  }, { once: true });
  icon.appendChild(img);
  return icon;
}

function buildTile(node) {
  const tile = document.createElement("a");
  tile.className = "tile";
  tile.draggable = false;
  tile.dataset.id = node.id;

  if (node.url) {
    tile.href = node.url;
  } else {
    tile.classList.add("folder");
    bindChromeLink(tile, `chrome://bookmarks/?id=${encodeURIComponent(node.id)}`, () => openFolder(node.id));
  }

  tile.appendChild(buildIcon(node));

  const label = document.createElement("span");
  label.className = "label";
  label.textContent = node.title || node.url || "Untitled";
  tile.appendChild(label);

  return tile;
}

// Wires up a link to a chrome:// URL.
// if onPlainClick is specified it'll intercept clicks (for opening folders, etc).
function bindChromeLink(element, url, onPlainClick) {
  element.href = `#${url}`;
  element.addEventListener("click", (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    if (onPlainClick) {
      onPlainClick();
    } else {
      chrome.tabs.update({ url });
    }
  });
}

async function render() {
  const grid = document.getElementById("grid");

  // Build into a fragment and swap in one shot. Clearing before the await would
  // let concurrent renders (many events fire on a sync) each clear then append,
  // duplicating tiles.
  const [bar] = await chrome.bookmarks.getSubTree(BOOKMARKS_BAR_ID);
  const children = bar?.children ?? [];
  const fragment = document.createDocumentFragment();
  children.forEach((node) => fragment.appendChild(buildTile(node)));
  grid.replaceChildren(fragment);

  if (!overlay.hidden) renderOverlay();
}

const overlay = document.querySelector(".overlay");
const overlayTitle = overlay.querySelector(".overlay-title");
const overlayGrid = overlay.querySelector(".overlay-grid");
const overlayBack = overlay.querySelector(".overlay-back");
let folderStack = [];

// Folder navigation is driven by the History API so the browser back button works.
async function openFolder(id) {
  folderStack.push(id);
  history.pushState({ folderStack: [...folderStack] }, "");
  await renderOverlay();
}

async function renderOverlay() {
  if (folderStack.length === 0) return;
  const id = folderStack[folderStack.length - 1];
  let folder;
  try {
    [folder] = await chrome.bookmarks.getSubTree(id);
  } catch {
    return closeOverlay();
  }
  if (!folder) {
    return closeOverlay();
  }
  overlayTitle.textContent = folder.title || "Folder";
  overlayBack.hidden = folderStack.length <= 1;
  overlayGrid.replaceChildren();
  for (const child of folder.children ?? []) {
    overlayGrid.appendChild(buildTile(child));
  }
  overlay.hidden = false;
}

function closeOverlay() {
  if (folderStack.length > 0) history.go(-folderStack.length);
  else overlay.hidden = true;
}

overlayBack.addEventListener("click", () => history.back());

overlay.querySelector(".overlay-close").addEventListener("click", closeOverlay);
overlay.querySelector(".overlay-backdrop").addEventListener("click", closeOverlay);

document.addEventListener("keydown", (event) => {
  if (overlay.hidden) return;
  if (event.key === "Escape") closeOverlay();
});

window.addEventListener("popstate", (event) => {
  folderStack = event.state?.folderStack ? [...event.state.folderStack] : [];
  if (folderStack.length === 0) {
    overlay.hidden = true;
  } else {
    renderOverlay();
  }
});

const DRAG_THRESHOLD = 5;
let drag = null;

// Drag-to-reorder. Pointer-based so links keep behaving as links.
function enableReorder(container) {
  container.addEventListener("pointerdown", (event) => onPointerDown(event, container));
}

function onPointerDown(event, container) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
  const tile = event.target.closest(".tile");
  if (!tile || !tile.dataset.id) return;
  drag = {
    tile,
    container,
    startX: event.clientX,
    startY: event.clientY,
    startIndex: [...container.children].filter((el) => el.dataset?.id).indexOf(tile),
    started: false,
  };
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
}

function onPointerMove(event) {
  if (!drag) return;
  if (!drag.started) {
    if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < DRAG_THRESHOLD) return;
    beginDrag();
  }
  const { tile, container, placeholder, offsetX, offsetY } = drag;
  tile.style.left = `${event.clientX - offsetX}px`;
  tile.style.top = `${event.clientY - offsetY}px`;
  container.insertBefore(placeholder, insertionPoint(event.clientX, event.clientY));
}

// The tile the placeholder should sit before, in reading order, or null if cursor
// is past the last tile.
// Scanning geometry rather than the element under the cursor lets drops land in
// the empty space after the grid.
function insertionPoint(x, y) {
  const tiles = [...drag.container.children].filter(
    (el) => el.classList.contains("tile") && el !== drag.tile,
  );
  for (const t of tiles) {
    const r = t.getBoundingClientRect();
    if (y < r.top) return t;
    if (y <= r.bottom && x < r.left + r.width / 2) return t;
  }
  return null;
}

function beginDrag() {
  const { tile, container } = drag;
  const r = tile.getBoundingClientRect();
  drag.offsetX = drag.startX - r.left;
  drag.offsetY = drag.startY - r.top;
  drag.started = true;

  const placeholder = document.createElement("div");
  placeholder.className = "drag-placeholder";
  placeholder.style.width = `${r.width}px`;
  placeholder.style.height = `${r.height}px`;
  container.insertBefore(placeholder, tile);
  drag.placeholder = placeholder;

  tile.classList.add("dragging");
  tile.style.width = `${r.width}px`;
  tile.style.height = `${r.height}px`;
  tile.style.left = `${r.left}px`;
  tile.style.top = `${r.top}px`;
  document.body.classList.add("dragging-active");
}

function onPointerUp() {
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointerup", onPointerUp);
  window.removeEventListener("pointercancel", onPointerUp);
  if (!drag) return;
  const { tile, container, placeholder, started, startIndex } = drag;
  drag = null;
  if (!started) return;

  container.insertBefore(tile, placeholder);
  placeholder.remove();
  tile.classList.remove("dragging");
  ["left", "top", "width", "height"].forEach((p) => tile.style.removeProperty(p));
  document.body.classList.remove("dragging-active");

  // Swallow the click that the browser fires on the link after pointerup.
  tile.addEventListener("click", suppressClick, { capture: true, once: true });

  // Chrome resolves the destination index against the children list *before*
  // the node is removed, so a downward move within the same folder needs +1.
  const siblings = [...container.children].filter((el) => el.dataset?.id);
  const newIndex = siblings.indexOf(tile);
  chrome.bookmarks.move(tile.dataset.id, { index: newIndex > startIndex ? newIndex + 1 : newIndex });
}

function suppressClick(event) {
  event.preventDefault();
  event.stopImmediatePropagation();
}

enableReorder(document.getElementById("grid"));
enableReorder(overlayGrid);

setDefaultFavicon();
render();

const manage = document.querySelector(".manage");
if (manage) bindChromeLink(manage, "chrome://bookmarks/");

for (const event of ["onCreated", "onRemoved", "onChanged", "onMoved", "onChildrenReordered"]) {
  chrome.bookmarks[event]?.addListener(render);
}
