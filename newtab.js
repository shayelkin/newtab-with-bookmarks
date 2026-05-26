// SPDX-License-Identifier: MIT
const BOOKMARKS_BAR_ID = "1";
const FAVICON_SIZE = 64;

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
  if (!node.url) tile.classList.add("folder");

  if (node.url) {
    tile.href = node.url;
  } else {
    tile.href = `chrome://bookmarks/?id=${encodeURIComponent(node.id)}`;
  }

  tile.appendChild(buildIcon(node));

  const label = document.createElement("span");
  label.className = "label";
  label.textContent = node.title || node.url || "Untitled";
  tile.appendChild(label);

  return tile;
}

async function render() {
  const grid = document.getElementById("grid");
  grid.replaceChildren();

  const [bar] = await chrome.bookmarks.getSubTree(BOOKMARKS_BAR_ID);
  const children = bar?.children ?? [];
  for (const node of children) {
    grid.appendChild(buildTile(node));
  }
}

render();

for (const event of ["onCreated", "onRemoved", "onChanged", "onMoved", "onChildrenReordered"]) {
  chrome.bookmarks[event]?.addListener(() => render());
}
