// SPDX-License-Identifier: MIT
const STORAGE_KEY = "icalUrls";
const MORNING_CUTOFF_HOUR = 6;
const REFRESH_MS = 10 * 60 * 1000;
const MAX_ITERATIONS = 10000;
const DAY_MS = 86400000;
const WEEKDAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

// The window runs from now until tomorrow at MORNING_CUTOFF_HOUR, so late-night
// events that spill past midnight are still shown.
function windowBounds(now = new Date()) {
  const end = new Date(now);
  end.setDate(end.getDate() + 1);
  end.setHours(MORNING_CUTOFF_HOUR, 0, 0, 0);
  return { winStart: now.getTime(), winEnd: end.getTime() };
}

// ---- iCal parsing ----

function unfold(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n[ \t]/g, "");
}

function unescapeText(value) {
  return value
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

function parseLine(line) {
  const idx = line.indexOf(":");
  if (idx === -1) return null;
  const left = line.slice(0, idx);
  const value = line.slice(idx + 1);
  const [name, ...paramParts] = left.split(";");
  const params = {};
  for (const part of paramParts) {
    const eq = part.indexOf("=");
    if (eq !== -1) params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
  }
  return { name: name.toUpperCase(), params, value };
}

// Offset (ms) of an IANA time zone at a given UTC instant.
function tzOffsetMs(timeZone, utcMs) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = {};
  for (const { type, value } of dtf.formatToParts(new Date(utcMs))) p[type] = value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - utcMs;
}

// Wall-clock components in a time zone -> UTC instant. Refined once to settle DST jumps.
function zonedToUtc(y, mo, d, h, mi, s, timeZone) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const offset = tzOffsetMs(timeZone, guess - tzOffsetMs(timeZone, guess));
  return guess - offset;
}

function parseIcsDate(value, params) {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?(Z)?$/);
  if (!m) return null;
  const [, y, mo, d, h = "0", mi = "0", s = "0", z] = m;
  const dateOnly = params.VALUE === "DATE" || !value.includes("T");
  if (dateOnly) {
    return { ms: new Date(+y, +mo - 1, +d).getTime(), dateOnly: true };
  }
  if (z === "Z") {
    return { ms: Date.UTC(+y, +mo - 1, +d, +h, +mi, +s), dateOnly: false };
  }
  if (params.TZID) {
    return { ms: zonedToUtc(+y, +mo, +d, +h, +mi, +s, params.TZID), dateOnly: false };
  }
  return { ms: new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime(), dateOnly: false };
}

function parseRRule(value) {
  const rule = {};
  for (const part of value.split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1) rule[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
  }
  return rule;
}

function parseEvents(text) {
  const events = [];
  let cur = null;
  for (const raw of unfold(text).split("\n")) {
    const line = raw.trim();
    if (line === "BEGIN:VEVENT") {
      cur = { exdates: [] };
      continue;
    }
    if (line === "END:VEVENT") {
      if (cur) events.push(cur);
      cur = null;
      continue;
    }
    if (!cur) continue;
    const parsed = parseLine(line);
    if (!parsed) continue;
    const { name, params, value } = parsed;
    switch (name) {
    case "DTSTART": cur.start = parseIcsDate(value, params); break;
    case "DTEND": cur.end = parseIcsDate(value, params); break;
    case "SUMMARY": cur.summary = unescapeText(value); break;
    case "RRULE": cur.rrule = parseRRule(value); break;
    case "STATUS": cur.status = value.toUpperCase(); break;
    case "EXDATE":
      for (const v of value.split(",")) {
        const ex = parseIcsDate(v, params);
        if (ex) cur.exdates.push(ex.ms);
      }
      break;
    }
  }
  return events;
}

function parseCalendarName(text) {
  for (const raw of unfold(text).split("\n")) {
    const line = raw.trim();
    if (line.startsWith("X-WR-CALNAME")) {
      const parsed = parseLine(line);
      if (parsed) return unescapeText(parsed.value);
    }
  }
  return null;
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// ---- Recurrence expansion (within the agenda window) ----

function dayFloorUTC(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function addMonthsUTC(ms, months) {
  const d = new Date(ms);
  return Date.UTC(
    d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate(),
    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(),
  );
}

// Yields occurrence start instants in chronological order. When `skipBefore` is
// finite (COUNT is unbounded) it fast-forwards near the window to bound iteration.
function* occurrences(startMs, rule, skipBefore) {
  const freq = rule.FREQ;
  const interval = Math.max(1, parseInt(rule.INTERVAL || "1", 10));

  if (freq === "WEEKLY" && rule.BYDAY) {
    const wantDays = rule.BYDAY.split(",")
      .map((code) => WEEKDAYS[code.replace(/^[+-]?\d+/, "")])
      .filter((n) => n !== undefined);
    const tod = startMs - dayFloorUTC(startMs);
    const weekMs = interval * 7 * DAY_MS;
    const monday = new Date(startMs).getUTCDay();
    let weekStart = dayFloorUTC(startMs) - ((monday + 6) % 7) * DAY_MS;
    if (skipBefore !== -Infinity && weekStart + weekMs < skipBefore) {
      weekStart += Math.floor((skipBefore - weekStart) / weekMs) * weekMs;
    }
    while (true) {
      for (let dow = 0; dow < 7; dow++) {
        const dayMs = weekStart + dow * DAY_MS;
        if (wantDays.includes(new Date(dayMs).getUTCDay())) {
          const occ = dayFloorUTC(dayMs) + tod;
          if (occ >= startMs) yield occ;
        }
      }
      weekStart += weekMs;
    }
  }

  if (freq === "DAILY" || freq === "WEEKLY") {
    const step = (freq === "DAILY" ? 1 : 7) * interval * DAY_MS;
    let cur = startMs;
    if (skipBefore !== -Infinity && cur < skipBefore) {
      cur += Math.floor((skipBefore - cur) / step) * step;
    }
    while (true) {
      yield cur;
      cur += step;
    }
  }

  if (freq === "MONTHLY" || freq === "YEARLY") {
    const stepMonths = (freq === "MONTHLY" ? 1 : 12) * interval;
    let n = 0;
    while (true) {
      yield addMonthsUTC(startMs, n * stepMonths);
      n++;
    }
  }
}

function recurStarts(startMs, rule, winStart, winEnd, exset) {
  const count = rule.COUNT ? parseInt(rule.COUNT, 10) : Infinity;
  const until = rule.UNTIL ? (parseIcsDate(rule.UNTIL, {})?.ms ?? Infinity) : Infinity;
  const skipBefore = count === Infinity ? winStart - DAY_MS : -Infinity;
  const out = [];
  let emitted = 0;
  let iterations = 0;
  for (const occ of occurrences(startMs, rule, skipBefore)) {
    if (++iterations > MAX_ITERATIONS) break;
    if (occ > until || emitted >= count) break;
    emitted++;
    if (occ > winEnd) break;
    if (occ < winStart - DAY_MS) continue;
    if (!exset.has(occ)) out.push(occ);
  }
  return out;
}

function expand(event, winStart, winEnd) {
  if (!event.start || event.start.dateOnly) return [];
  if (event.status === "CANCELLED") return [];
  const duration = event.end ? Math.max(0, event.end.ms - event.start.ms) : 0;
  const exset = new Set(event.exdates);
  const starts = event.rrule
    ? recurStarts(event.start.ms, event.rrule, winStart, winEnd, exset)
    : (exset.has(event.start.ms) ? [] : [event.start.ms]);
  const out = [];
  for (const s of starts) {
    if (s >= winStart && s < winEnd) {
      out.push({ start: s, end: s + duration, summary: event.summary || "(no title)" });
    }
  }
  return out;
}

// ---- Loading ----

async function loadEvents(urls) {
  const { winStart, winEnd } = windowBounds();
  const responses = await Promise.allSettled(
    urls.map((url) =>
      fetch(url, { credentials: "omit" }).then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.text();
      }),
    ),
  );

  const all = [];
  let anyOk = false;
  let anyErr = false;
  responses.forEach((res, i) => {
    if (res.status !== "fulfilled") {
      anyErr = true;
      return;
    }
    anyOk = true;
    try {
      const calendar = parseCalendarName(res.value) || hostnameOf(urls[i]);
      for (const ev of parseEvents(res.value)) {
        for (const occ of expand(ev, winStart, winEnd)) {
          occ.calendar = calendar;
          all.push(occ);
        }
      }
    } catch {
      anyErr = true;
    }
  });

  const seen = new Set();
  const events = all
    .filter((e) => {
      const key = `${e.start}|${e.summary}|${e.calendar}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.start - b.start);
  return { events, anyOk, anyErr };
}

// ---- Storage ----

async function getUrls() {
  const data = await chrome.storage.sync.get(STORAGE_KEY);
  return (data[STORAGE_KEY] ?? []).filter(Boolean);
}

function setUrls(urls) {
  return chrome.storage.sync.set({ [STORAGE_KEY]: urls });
}

// ---- Rendering ----

if (typeof module !== "undefined") {
  module.exports = { parseEvents, expand, windowBounds, parseIcsDate, parseCalendarName, MORNING_CUTOFF_HOUR };
}

if (typeof document !== "undefined" && typeof chrome !== "undefined") {
  const agenda = document.getElementById("agenda");
  const agendaList = agenda.querySelector(".agenda-list");
  const agendaStatus = agenda.querySelector(".agenda-status");
  const dialog = document.getElementById("agenda-dialog");
  const urlsField = dialog.querySelector(".agenda-urls");

  function formatTime(ms) {
    return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  function setStatus(text) {
    agendaStatus.textContent = text;
    agendaStatus.hidden = !text;
  }

  function renderEvents(events) {
    agendaList.replaceChildren();
    events.forEach((event) => {
      const item = document.createElement("li");
      item.className = "agenda-item";

      const time = document.createElement("div");
      time.className = "agenda-time";
      const start = document.createElement("span");
      start.className = "agenda-start";
      start.textContent = formatTime(event.start);
      const end = document.createElement("span");
      end.className = "agenda-end";
      end.textContent = formatTime(event.end);
      time.append(start, end);

      const name = document.createElement("span");
      name.className = "agenda-name";
      name.textContent = event.summary;

      const calendar = document.createElement("span");
      calendar.className = "agenda-calendar";
      calendar.textContent = event.calendar;

      item.append(time, name, calendar);
      agendaList.appendChild(item);
    });
  }

  async function refreshAgenda() {
    const urls = await getUrls();
    if (urls.length === 0) {
      agenda.hidden = true;
      return;
    }
    agenda.hidden = false;
    setStatus("Loading…");
    const { events, anyOk, anyErr } = await loadEvents(urls);
    renderEvents(events);
    if (!anyOk) {
      setStatus("Couldn’t load any calendars.");
      return;
    }
    if (events.length === 0) {
      setStatus(anyErr ? "No upcoming events (some calendars failed)." : "No upcoming events.");
      return;
    }
    setStatus(anyErr ? "Some calendars failed to load." : "");
  }

  document.querySelector(".agenda-settings").addEventListener("click", async () => {
    urlsField.value = (await getUrls()).join("\n");
    dialog.showModal();
  });

  dialog.addEventListener("close", async () => {
    if (dialog.returnValue !== "save") return;
    const urls = urlsField.value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    await setUrls(urls);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes[STORAGE_KEY]) refreshAgenda();
  });

  refreshAgenda();
  setInterval(refreshAgenda, REFRESH_MS);
}
