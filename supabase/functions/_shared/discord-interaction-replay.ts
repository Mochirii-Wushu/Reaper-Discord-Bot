export const DISCORD_INTERACTION_REPLAY_CONTRACT =
  "discord-interaction-replay.v1";

export type DiscordInteractionReplayClaim =
  | { status: "acquired"; leaseToken: string }
  | { status: "duplicate-complete" }
  | { status: "duplicate-in-flight" }
  | { status: "unavailable" };

export type DiscordInteractionReplayAdapter = {
  bindingStatus: "dormant-unbound" | "durable-bound";
  claim(input: {
    contract: typeof DISCORD_INTERACTION_REPLAY_CONTRACT;
    interactionId: string;
  }): Promise<DiscordInteractionReplayClaim>;
  complete(input: {
    contract: typeof DISCORD_INTERACTION_REPLAY_CONTRACT;
    interactionId: string;
    leaseToken: string;
  }): Promise<boolean>;
  recordFailure(input: {
    contract: typeof DISCORD_INTERACTION_REPLAY_CONTRACT;
    interactionId: string;
    leaseToken: string;
  }): Promise<void>;
};

export type DiscordInteractionReplayResult<T> =
  | { status: "executed"; value: T }
  | { status: "duplicate-complete" }
  | { status: "retry-later" }
  | { status: "unavailable" };

export class DiscordInteractionReplayCompletionUncertainError extends Error {
  constructor() {
    super("Discord interaction replay completion is uncertain.");
    this.name = "DiscordInteractionReplayCompletionUncertainError";
  }
}

const LEASE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,256}$/u;

export async function executeReplayProtected<T>(
  adapter: DiscordInteractionReplayAdapter,
  interactionId: string,
  effect: () => Promise<T>,
): Promise<DiscordInteractionReplayResult<T>> {
  if (adapter.bindingStatus !== "durable-bound") {
    return { status: "unavailable" };
  }

  let claim: DiscordInteractionReplayClaim;
  try {
    claim = await adapter.claim({
      contract: DISCORD_INTERACTION_REPLAY_CONTRACT,
      interactionId,
    });
  } catch {
    return { status: "unavailable" };
  }

  if (claim.status === "duplicate-complete") {
    return { status: "duplicate-complete" };
  }
  if (claim.status === "duplicate-in-flight") {
    return { status: "retry-later" };
  }
  if (claim.status === "unavailable") {
    return { status: "unavailable" };
  }
  if (!LEASE_TOKEN_PATTERN.test(claim.leaseToken)) {
    return { status: "unavailable" };
  }

  let value: T;
  try {
    value = await effect();
  } catch (error) {
    try {
      await adapter.recordFailure({
        contract: DISCORD_INTERACTION_REPLAY_CONTRACT,
        interactionId,
        leaseToken: claim.leaseToken,
      });
    } catch {
      // Preserve the original effect failure. The durable lease must not be
      // released by this coordinator, so an uncertain effect is never retried.
    }
    throw error;
  }

  try {
    const completed = await adapter.complete({
      contract: DISCORD_INTERACTION_REPLAY_CONTRACT,
      interactionId,
      leaseToken: claim.leaseToken,
    });
    if (!completed) {
      throw new DiscordInteractionReplayCompletionUncertainError();
    }
  } catch (error) {
    if (error instanceof DiscordInteractionReplayCompletionUncertainError) {
      throw error;
    }
    throw new DiscordInteractionReplayCompletionUncertainError();
  }

  return { status: "executed", value };
}

export const dormantDiscordInteractionReplayAdapter:
  DiscordInteractionReplayAdapter = {
    bindingStatus: "dormant-unbound",
    async claim() {
      return { status: "unavailable" };
    },
    async complete() {
      return false;
    },
    async recordFailure() {},
  };
