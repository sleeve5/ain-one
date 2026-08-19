import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["tests/server/**/*.test.ts", "tests/shared/**/*.test.ts"],
          setupFiles: ["tests/setup/warnings.ts"],
        },
      },
      {
        test: {
          name: "web",
          environment: "jsdom",
          include: ["tests/web/**/*.test.tsx"],
          setupFiles: ["tests/setup/web.ts"],
        },
      },
    ],
  },
});
