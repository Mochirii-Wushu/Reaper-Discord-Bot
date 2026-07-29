import {
  currentStreak,
  customIdForVoteDate,
  dateInTimeZone,
  parseVoteLinksFromText,
  parseVoteLinksJson,
  voteDateFromCustomId,
} from "./vote-reminders.ts";

Deno.test("parseVoteLinksFromText reads marked markdown and plain HTTPS links", () => {
  const links = parseVoteLinksFromText(`
    ignore https://example.com/ignored
    [vote-links]
    [Top Site](https://votes.example.com/server)
    Second Site - https://second.example.com/path
  `);

  if (links.length !== 2) {
    throw new Error(`Expected 2 links, received ${links.length}.`);
  }
  if (links[0].label !== "Top Site") {
    throw new Error(`Unexpected first label: ${links[0].label}.`);
  }
  if (links[1].label !== "Second Site") {
    throw new Error(`Unexpected second label: ${links[1].label}.`);
  }
});

Deno.test("parseVoteLinksJson accepts configured link arrays", () => {
  const links = parseVoteLinksJson(JSON.stringify({
    links: [
      { label: "Configured", url: "https://configured.example.com/server" },
      { label: "Duplicate", url: "https://configured.example.com/server" },
      { label: "Unsafe", url: "http://unsafe.example.com/server" },
    ],
  }));

  if (links.length !== 1) {
    throw new Error(`Expected 1 normalized link, received ${links.length}.`);
  }
  if (links[0].label !== "Configured") {
    throw new Error(`Unexpected label: ${links[0].label}.`);
  }
});

Deno.test("vote custom IDs round-trip valid vote dates only", () => {
  const customId = customIdForVoteDate("2026-06-09");
  if (voteDateFromCustomId(customId) !== "2026-06-09") {
    throw new Error("Expected valid vote date.");
  }
  if (voteDateFromCustomId("vote_done:not-a-date") !== null) {
    throw new Error("Invalid dates must not parse.");
  }
});

Deno.test("currentStreak counts backward from today", () => {
  const streak = currentStreak(
    ["2026-06-09", "2026-06-08", "2026-06-06"],
    "2026-06-09",
  );
  if (streak !== 2) throw new Error(`Expected streak 2, received ${streak}.`);
});

Deno.test("dateInTimeZone uses the configured local date", () => {
  const date = dateInTimeZone(
    new Date("2026-06-09T16:00:00.000Z"),
    "America/Los_Angeles",
  );
  if (date !== "2026-06-09") throw new Error(`Unexpected local date: ${date}.`);
});
