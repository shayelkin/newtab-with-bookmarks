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

function initialFor(node) {
  const source = (node.title || node.url || "?").trim();
  return source.charAt(0) || "?";
}

function buildIcon(node) {
  const icon = document.createElement("div");
  icon.className = "icon";

  if (!node.url) return icon;

  const img = document.createElement("img");
  img.alt = "";
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
  grid.replaceChildren();

  const [bar] = await chrome.bookmarks.getSubTree(BOOKMARKS_BAR_ID);
  const children = bar?.children ?? [];
  children.forEach((node) => grid.appendChild(buildTile(node)));

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

setDefaultFavicon();
render();

const manage = document.querySelector(".manage");
if (manage) bindChromeLink(manage, "chrome://bookmarks/");

for (const event of ["onCreated", "onRemoved", "onChanged", "onMoved", "onChildrenReordered"]) {
  chrome.bookmarks[event]?.addListener(render);
}
