import { describe, expect, test } from "bun:test";
import { commandData } from "../src/command.js";

describe("submit command schema", () => {
  test("includes optional share_to_instagram boolean option", () => {
    const submit = commandData.find((command) => command.name === "submit");

    expect(submit).toBeDefined();
    const option = submit?.options?.find((entry) => entry.name === "share_to_instagram");

    expect(option?.type).toBe(5);
    expect(option?.required).toBeFalsy();
    expect(submit?.description).toContain("Mōchirīī");
    expect(option?.description).toContain("Mōchirīī");
    expect(submit?.description).not.toContain("Mochirii");
    expect(option?.description).not.toContain("Mochirii");
  });
});
