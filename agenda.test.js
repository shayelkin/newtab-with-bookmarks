// SPDX-License-Identifier: MIT
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseEvents, expand, parseIcsDate, parseCalendarName } = require("./agenda.js");

function ical(...events) {
  return ["BEGIN:VCALENDAR", ...events, "END:VCALENDAR"].join("\r\n");
}

function vevent(props) {
  return ["BEGIN:VEVENT", ...props, "END:VEVENT"].join("\r\n");
}

// Collect agenda entries from raw ICS within [winStart, winEnd].
function agenda(text, winStart, winEnd) {
  return parseEvents(text)
    .flatMap((e) => expand(e, winStart, winEnd))
    .sort((a, b) => a.start - b.start);
}

const WIN_START = Date.UTC(2026, 5, 2, 10, 0, 0);
const WIN_END = Date.UTC(2026, 5, 2, 20, 0, 0);

test("orders timed events by start and skips all-day events", () => {
  const text = ical(
    vevent(["DTSTART:20260602T150000Z", "DTEND:20260602T160000Z", "SUMMARY:Later"]),
    vevent(["DTSTART:20260602T120000Z", "DTEND:20260602T130000Z", "SUMMARY:Earlier"]),
    vevent(["DTSTART;VALUE=DATE:20260602", "DTEND;VALUE=DATE:20260603", "SUMMARY:AllDay"]),
  );
  const events = agenda(text, WIN_START, WIN_END);
  assert.deepEqual(events.map((e) => e.summary), ["Earlier", "Later"]);
  assert.equal(events[0].start, Date.UTC(2026, 5, 2, 12, 0, 0));
});

test("converts TZID wall-clock times to UTC", () => {
  // 12:00 in America/New_York (EDT, UTC-4) is 16:00 UTC.
  const text = ical(
    vevent(["DTSTART;TZID=America/New_York:20260602T120000", "DTEND;TZID=America/New_York:20260602T130000", "SUMMARY:NY"]),
  );
  const [event] = agenda(text, WIN_START, WIN_END);
  assert.equal(event.start, Date.UTC(2026, 5, 2, 16, 0, 0));
});

test("excludes events outside the window", () => {
  const text = ical(
    vevent(["DTSTART:20260602T080000Z", "DTEND:20260602T083000Z", "SUMMARY:TooEarly"]),
    vevent(["DTSTART:20260602T223000Z", "DTEND:20260602T230000Z", "SUMMARY:TooLate"]),
  );
  assert.equal(agenda(text, WIN_START, WIN_END).length, 0);
});

test("excludes an in-progress event that started before the window", () => {
  const text = ical(
    vevent(["DTSTART:20260602T093000Z", "DTEND:20260602T103000Z", "SUMMARY:Ongoing"]),
  );
  assert.equal(agenda(text, WIN_START, WIN_END).length, 0);
});

test("expands a daily recurrence into the window", () => {
  const text = ical(
    vevent(["DTSTART:20260101T120000Z", "DTEND:20260101T123000Z", "RRULE:FREQ=DAILY", "SUMMARY:Standup"]),
  );
  const events = agenda(text, WIN_START, WIN_END);
  assert.equal(events.length, 1);
  assert.equal(events[0].start, Date.UTC(2026, 5, 2, 12, 0, 0));
});

test("EXDATE removes a recurrence instance", () => {
  const text = ical(
    vevent([
      "DTSTART:20260101T120000Z", "DTEND:20260101T123000Z",
      "RRULE:FREQ=DAILY", "EXDATE:20260602T120000Z", "SUMMARY:Skipped",
    ]),
  );
  assert.equal(agenda(text, WIN_START, WIN_END).length, 0);
});

test("COUNT bounds a recurrence so old series do not reach the window", () => {
  const text = ical(
    vevent(["DTSTART:20260101T120000Z", "DTEND:20260101T123000Z", "RRULE:FREQ=DAILY;COUNT=2", "SUMMARY:Brief"]),
  );
  assert.equal(agenda(text, WIN_START, WIN_END).length, 0);
});

test("weekly BYDAY recurrence lands on the right weekday", () => {
  // 2026-06-02 is a Tuesday.
  const text = ical(
    vevent(["DTSTART:20260106T120000Z", "DTEND:20260106T123000Z", "RRULE:FREQ=WEEKLY;BYDAY=TU", "SUMMARY:Weekly"]),
  );
  const events = agenda(text, WIN_START, WIN_END);
  assert.equal(events.length, 1);
  assert.equal(events[0].start, Date.UTC(2026, 5, 2, 12, 0, 0));
});

test("UNTIL stops a recurrence before the window", () => {
  const text = ical(
    vevent(["DTSTART:20260101T120000Z", "DTEND:20260101T123000Z", "RRULE:FREQ=DAILY;UNTIL=20260201T000000Z", "SUMMARY:Ended"]),
  );
  assert.equal(agenda(text, WIN_START, WIN_END).length, 0);
});

test("unfolds wrapped lines and unescapes summary text", () => {
  const text = ical(
    vevent(["DTSTART:20260602T120000Z", "DTEND:20260602T123000Z", "SUMMARY:Lunch with Bob\\, T", " ed and friends"]),
  );
  const [event] = agenda(text, WIN_START, WIN_END);
  assert.equal(event.summary, "Lunch with Bob, Ted and friends");
});

test("CANCELLED events are skipped", () => {
  const text = ical(
    vevent(["DTSTART:20260602T120000Z", "DTEND:20260602T123000Z", "STATUS:CANCELLED", "SUMMARY:Off"]),
  );
  assert.equal(agenda(text, WIN_START, WIN_END).length, 0);
});

test("parseCalendarName reads X-WR-CALNAME", () => {
  const text = ["BEGIN:VCALENDAR", "X-WR-CALNAME:Work\\, Personal", "END:VCALENDAR"].join("\r\n");
  assert.equal(parseCalendarName(text), "Work, Personal");
});

test("parseCalendarName returns null when absent", () => {
  assert.equal(parseCalendarName(ical()), null);
});

test("parseIcsDate flags date-only values as all-day", () => {
  assert.equal(parseIcsDate("20260602", { VALUE: "DATE" }).dateOnly, true);
  assert.equal(parseIcsDate("20260602T120000Z", {}).dateOnly, false);
});
