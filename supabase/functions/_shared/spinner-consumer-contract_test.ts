import {
  normalizeParticipants,
  sha256Hex,
  SPINNER_DISCORD_CHANNEL_KEY,
} from "./spinner-consumer-contract.ts";

Deno.test("spinner consumer contract preserves the semantic outbox channel key", () => {
  if (SPINNER_DISCORD_CHANNEL_KEY !== "raffle_spins") {
    throw new Error("Unexpected spinner outbox channel key.");
  }
});

Deno.test("spinner consumer contract normalizes an immutable roster snapshot", () => {
  const participants = normalizeParticipants([
    {
      version: 1,
      id: "00000000-0000-4000-8000-000000000001",
      displayName: "  Mōchī  ",
    },
    {
      version: 1,
      id: "00000000-0000-4000-8000-000000000002",
      displayName: "Guildie",
    },
  ]);
  if (participants[0].displayName !== "Mōchī" || participants.length !== 2) {
    throw new Error("Spinner participant normalization drifted.");
  }
});

Deno.test("spinner consumer contract rejects duplicate normalized names", () => {
  let rejected = false;
  try {
    normalizeParticipants([
      {
        version: 1,
        id: "00000000-0000-4000-8000-000000000001",
        displayName: "Guildie",
      },
      {
        version: 1,
        id: "00000000-0000-4000-8000-000000000002",
        displayName: "GUILDIE",
      },
    ]);
  } catch (error) {
    rejected = error instanceof TypeError;
  }
  if (!rejected) {
    throw new Error("Duplicate normalized names must fail closed.");
  }
});

Deno.test("spinner consumer contract hashing remains deterministic", async () => {
  const digest = await sha256Hex("Mōchirīī");
  if (
    !/^[0-9a-f]{64}$/u.test(digest) || digest !== await sha256Hex("Mōchirīī")
  ) {
    throw new Error("Spinner hashing drifted.");
  }
});
