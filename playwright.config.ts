import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  workers: 1,
  use: {
    ...devices["Desktop Edge"],
    channel: "msedge",
  },
});
