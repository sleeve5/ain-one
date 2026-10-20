import { describe, expect, it, vi } from "vitest";
import type { GraphProject } from "../../src/shared/contracts.js";
import { createHttpAinOneApi } from "../../src/web/api.js";

const graph: GraphProject = {
  id: "g1", projectId: "p1", name: "Loop", description: "", createdAt: "now", updatedAt: "now",
  definition: { nodes: [], edges: [], start: [], end: [] }, viewport: { x: 0, y: 0, zoom: 1 }, positions: {},
};

describe("Graph HTTP client", () => {
  it("loads, saves, renames, archives, forks, runs, cancels, and deletes graphs", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); calls.push({ url, method: init?.method ?? "GET" });
      if (url.endsWith("/runs") && (init?.method ?? "GET") === "GET") return json({ runs: [] });
      if (url.endsWith("/runs")) return json({ run: { id: "r1", graphId: "g1", status: "running" } }, 202);
      if (url.includes("graph-runs/r1") && !url.endsWith("cancel")) return json({ run: { id: "r1", status: "completed" }, nodeRuns: [], events: [] });
      if (url.endsWith("cancel")) return json({ cancelled: true });
      if ((init?.method ?? "GET") === "DELETE") return new Response(null, { status: 204 });
      if (url.endsWith("/fork")) return json({ graph: { ...graph, id: "g2" } }, 201);
      if ((init?.method ?? "GET") === "PUT") return json({ graph });
      return json(url.includes("projects") ? { graphs: [graph] } : { graph, latestRun: null });
    });
    const api = createHttpAinOneApi({ token: "token", fetchFn: fetchFn as typeof fetch });

    expect(await api.listGraphs("p1")).toEqual([graph]);
    expect(await api.getGraph("g1")).toMatchObject({ graph });
    await api.saveGraph(graph);
    await api.renameGraph!("g1", "Pipeline");
    await api.archiveGraph!("g1", true);
    await api.forkGraph!("g1");
    await api.listGraphRuns!("g1");
    expect((await api.runGraph("g1", "draft")).id).toBe("r1");
    await api.getGraphRun("r1");
    await api.cancelGraphRun("r1");
    await api.deleteGraphRun!("r1");
    await api.deleteGraph("g1");
    expect(calls.map((call) => call.method)).toEqual(["GET", "GET", "PUT", "PUT", "PUT", "POST", "GET", "POST", "GET", "POST", "DELETE", "DELETE"]);
  });
});

function json(body: unknown, status = 200): Response { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }
