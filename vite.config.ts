import { defineConfig, type Plugin, type UserConfig, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { startServer } from "./src/server/main.js";

export default defineConfig(async ({ command }) => {
  if (command === "build") {
    return { plugins: react() } satisfies UserConfig;
  }

  const webPort = resolveWebPort(process.env.AIN_ONE_WEB_PORT);
  const webOrigin = `http://127.0.0.1:${webPort}`;
  const api = await startServer({ allowedOrigins: [webOrigin] });

  const controlPlanePlugin: Plugin = {
    name: "ain-one-control-plane",
    transformIndexHtml: {
      order: "pre",
      handler() {
        return [
          {
            tag: "meta",
            attrs: { name: "ain-one-token", content: api.token },
            injectTo: "head",
          },
        ];
      },
    },
    configureServer(server: ViteDevServer) {
      server.httpServer?.once("close", () => {
        void api.stop();
      });
    },
  };

  return {
    plugins: [
      ...react(),
      controlPlanePlugin,
    ],
    server: {
      host: "127.0.0.1",
      port: webPort,
      strictPort: true,
      proxy: {
        "/api": {
          target: api.url,
        },
      },
    },
  } satisfies UserConfig;
});

function readPort(value: string | undefined, fallback: number): number {
  const parsed = value ? Number.parseInt(value, 10) : fallback;
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : fallback;
}

export function resolveWebPort(
  configuredPort: string | undefined,
  argv: string[] = process.argv,
): number {
  const inlinePort = argv.findLast((argument) => argument.startsWith("--port="))?.slice(7);
  const portIndex = argv.findLastIndex((argument) => argument === "--port");
  const cliPort = inlinePort ?? (portIndex >= 0 ? argv[portIndex + 1] : undefined);
  return readPort(cliPort ?? configuredPort, 5173);
}
