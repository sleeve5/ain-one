import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  use: {
    ...devices["Desktop Edge"],
    channel: "msedge",
  },
});
