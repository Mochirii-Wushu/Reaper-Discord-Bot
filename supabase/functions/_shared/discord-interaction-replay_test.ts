import {
  type DiscordInteractionReplayAdapter,
  DiscordInteractionReplayCompletionUncertainError,
  executeReplayProtected,
} from "./discord-interaction-replay.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function adapter(
  overrides: Partial<DiscordInteractionReplayAdapter> = {},
): DiscordInteractionReplayAdapter {
  return {
    bindingStatus: "durable-bound",
    async claim() {
      return {
        status: "acquired",
        leaseToken: "synthetic_lease_0001",
      };
    },
    async complete() {
      return true;
    },
    async recordFailure() {},
    ...overrides,
  };
}

Deno.test("interaction replay executes once and completes the exact lease", async () => {
  const events: string[] = [];
  const result = await executeReplayProtected(
    adapter({
      async claim(input) {
        events.push(`claim:${input.interactionId}`);
        return { status: "acquired", leaseToken: "synthetic_lease_0001" };
      },
      async complete(input) {
        events.push(`complete:${input.interactionId}:${input.leaseToken}`);
        return true;
      },
    }),
    "900000000000000001",
    async () => {
      events.push("effect");
      return "ok";
    },
  );
  assert(result.status === "executed" && result.value === "ok", "execute");
  assert(
    JSON.stringify(events) === JSON.stringify([
      "claim:900000000000000001",
      "effect",
      "complete:900000000000000001:synthetic_lease_0001",
    ]),
    "claim/effect/complete ordering drifted",
  );
});

for (
  const [claimStatus, resultStatus] of [
    ["duplicate-complete", "duplicate-complete"],
    ["duplicate-in-flight", "retry-later"],
    ["unavailable", "unavailable"],
  ] as const
) {
  Deno.test(`interaction replay ${claimStatus} never reaches effects`, async () => {
    let effects = 0;
    const result = await executeReplayProtected(
      adapter({
        async claim() {
          return { status: claimStatus };
        },
      }),
      "900000000000000001",
      async () => {
        effects += 1;
        return "unsafe";
      },
    );
    assert(result.status === resultStatus, "claim classification drifted");
    assert(effects === 0, "duplicate or unavailable claim reached an effect");
  });
}

Deno.test("interaction replay dormant and claim failures fail closed", async () => {
  let effects = 0;
  for (
    const candidate of [
      adapter({ bindingStatus: "dormant-unbound" }),
      adapter({
        async claim() {
          throw new Error("synthetic claim failure");
        },
      }),
      adapter({
        async claim() {
          return { status: "acquired", leaseToken: "short" };
        },
      }),
    ]
  ) {
    const result = await executeReplayProtected(
      candidate,
      "900000000000000001",
      async () => {
        effects += 1;
        return "unsafe";
      },
    );
    assert(result.status === "unavailable", "failure must be unavailable");
  }
  assert(effects === 0, "a fail-closed replay case reached an effect");
});

Deno.test("interaction replay preserves an effect failure and retains its lease", async () => {
  const original = new Error("synthetic effect crash");
  let completed = 0;
  let failures = 0;
  let observed: unknown;
  try {
    await executeReplayProtected(
      adapter({
        async complete() {
          completed += 1;
          return true;
        },
        async recordFailure() {
          failures += 1;
          throw new Error("synthetic failure-record crash");
        },
      }),
      "900000000000000001",
      async () => {
        throw original;
      },
    );
  } catch (error) {
    observed = error;
  }
  assert(observed === original, "the original effect failure was overwritten");
  assert(failures === 1, "effect failure was not recorded exactly once");
  assert(completed === 0, "a failed effect completed its replay claim");
});

for (const completionMode of ["false", "throw"] as const) {
  Deno.test(`interaction replay ${completionMode} completion is uncertain`, async () => {
    let effects = 0;
    let observed: unknown;
    try {
      await executeReplayProtected(
        adapter({
          async complete() {
            if (completionMode === "throw") {
              throw new Error("synthetic completion crash");
            }
            return false;
          },
        }),
        "900000000000000001",
        async () => {
          effects += 1;
          return "effect-complete";
        },
      );
    } catch (error) {
      observed = error;
    }
    assert(effects === 1, "completion uncertainty must follow one effect");
    assert(
      observed instanceof DiscordInteractionReplayCompletionUncertainError,
      "completion uncertainty must have a fixed error type",
    );
  });
}
