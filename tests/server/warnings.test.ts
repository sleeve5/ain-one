import { describe, expect, it, vi } from "vitest";
import { createWarningFilter } from "../setup/warnings.js";

describe("SQLite warning filter", () => {
  it("forwards unrelated ExperimentalWarnings that mention SQLite", () => {
    const forwarded = vi.fn();
    const emitWarning = createWarningFilter(forwarded);

    emitWarning("SQLite cache is stale", "ExperimentalWarning");

    expect(forwarded).toHaveBeenCalledWith(
      "SQLite cache is stale",
      "ExperimentalWarning",
    );
  });
});
