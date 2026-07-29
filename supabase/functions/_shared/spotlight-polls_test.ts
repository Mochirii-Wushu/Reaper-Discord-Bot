import {
  buildCandidateSnapshots,
  buildDiscordPollPayload,
  SPOTLIGHT_POLL_DURATION_HOURS,
  SPOTLIGHT_POLL_MAX_ANSWER_LENGTH,
} from "./spotlight-polls.ts";

function activeProfile(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    display_name: `Member ${index}`,
    discord_user_id: `1000000000000000${String(index).padStart(2, "0")}`,
    discord_username: `member${index}`,
    member_status: "active",
    has_required_discord_roles: true,
    discord_verified_at: new Date().toISOString(),
    ...overrides,
  };
}

Deno.test("spotlight candidate snapshots cap native poll candidates at 10", () => {
  const profiles = Array.from(
    { length: 14 },
    (_, index) => activeProfile(index + 1),
  );
  const candidates = buildCandidateSnapshots(profiles, (items) => items);
  if (candidates.length !== 10) {
    throw new Error(`Expected 10 candidates, got ${candidates.length}.`);
  }
  const uniqueUsers = new Set(
    candidates.map((candidate) => candidate.discordUserId),
  );
  if (uniqueUsers.size !== 10) {
    throw new Error("Expected unique Discord users.");
  }
});

Deno.test("spotlight candidate snapshots exclude the configured Twills account", () => {
  const profiles = [
    activeProfile(1, {
      id: "00000000-0000-4000-8000-999999999999",
      display_name: "Renamed leader profile",
    }),
    activeProfile(2, {
      discord_user_id: "900000000000000012",
      display_name: "Renamed Discord account",
    }),
    activeProfile(3, { display_name: "Eligible member" }),
  ];
  const candidates = buildCandidateSnapshots(profiles, (items) => items);

  if (candidates.length !== 1) {
    throw new Error(`Expected 1 candidate, got ${candidates.length}.`);
  }
  if (candidates[0].displayName !== "Eligible member") {
    throw new Error(`Unexpected candidate: ${candidates[0].displayName}`);
  }
  if (
    candidates.some((candidate) =>
      candidate.memberProfileId === "00000000-0000-4000-8000-999999999999" ||
      candidate.discordUserId === "900000000000000012"
    )
  ) {
    throw new Error(
      "Configured Twills account must not be eligible for spotlight polls.",
    );
  }
});

Deno.test("spotlight candidate labels are Discord poll safe", () => {
  const profiles = [
    activeProfile(1, {
      display_name:
        "A very very very very very very very very very long guildie name @everyone",
    }),
    activeProfile(2, { display_name: "Same Name", discord_username: "first" }),
    activeProfile(3, { display_name: "Same Name", discord_username: "second" }),
  ];
  const candidates = buildCandidateSnapshots(profiles, (items) => items);

  for (const candidate of candidates) {
    if (candidate.answerLabel.length > SPOTLIGHT_POLL_MAX_ANSWER_LENGTH) {
      throw new Error(`Label too long: ${candidate.answerLabel}`);
    }
    if (candidate.answerLabel.includes("@")) {
      throw new Error(
        `Label should not preserve mention characters: ${candidate.answerLabel}`,
      );
    }
  }

  if (
    !candidates[1].answerLabel.includes("(first)") ||
    !candidates[2].answerLabel.includes("(second)")
  ) {
    throw new Error(
      "Duplicate display names should include a safe disambiguator.",
    );
  }
});

Deno.test("spotlight poll payload is native single-choice poll", () => {
  const candidates = buildCandidateSnapshots([
    activeProfile(1),
    activeProfile(2),
  ], (items) => items);
  const payload = buildDiscordPollPayload(candidates);
  const poll = payload.poll as Record<string, unknown>;

  if (poll.duration !== SPOTLIGHT_POLL_DURATION_HOURS) {
    throw new Error("Unexpected poll duration.");
  }
  if (poll.allow_multiselect !== false) {
    throw new Error("Poll must be single-choice.");
  }
  const answers = poll.answers as unknown[];
  if (!Array.isArray(answers) || answers.length !== 2) {
    throw new Error("Expected two poll answers.");
  }
  if (
    JSON.stringify(payload.allowed_mentions) !== JSON.stringify({ parse: [] })
  ) {
    throw new Error("Poll message must suppress mentions.");
  }
});
