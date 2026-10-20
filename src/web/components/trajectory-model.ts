import type { NormalizedEvent } from "../../shared/contracts.js";

export type TrajectoryRecordKind =
  | "user" | "assistant" | "reasoning" | "tool" | "shell"
  | "file" | "permission" | "warning" | "status";

export interface TrajectoryRecord {
  id: string;
  index: number;
  kind: TrajectoryRecordKind;
  title: string;
  summary: string;
  payload: Record<string, unknown>;
  createdAt: string;
  durationMs: number | null;
  error: boolean;
  eventCount: number;
  sourceEventIds: string[];
  sourceEvents: NormalizedEvent[];
  sourceType: NormalizedEvent["type"];
}
export interface TrajectoryTurn { id: string; number: number; records: TrajectoryRecord[]; }
export interface TrajectoryModel { turns: TrajectoryTurn[]; }

export function projectTrajectory(events: readonly NormalizedEvent[]): TrajectoryModel {
  const turns: TrajectoryTurn[] = [];
  let turn: TrajectoryTurn | null = null;
  const ensureTurn = (): TrajectoryTurn => {
    if (turn) return turn;
    turn = { id: `turn-${turns.length + 1}`, number: turns.length + 1, records: [] };
    turns.push(turn);
    return turn;
  };
  for (const event of events) {
    if (event.type === "queue_status") continue;
    if (event.type === "user_message" && turns.at(-1)?.records.length) turn = null;
    if (event.type === "usage") continue;
    const current = ensureTurn();
    const streamId = event.type === "assistant_message" ? stringValue(event.payload.streamId) : null;
    const streamed = streamId
      ? current.records.find((record) => record.kind === "assistant" && record.payload.streamId === streamId)
      : undefined;
    if (streamed) {
      const text = event.payload.delta === true
        ? `${stringValue(streamed.payload.text) ?? ""}${stringValue(event.payload.text) ?? ""}`
        : event.payload.text;
      streamed.id = event.id;
      streamed.index = event.sequence;
      streamed.payload = { ...streamed.payload, ...event.payload, text };
      if (event.payload.final === true) delete streamed.payload.delta;
      streamed.summary = summarize(event.type, streamed.payload);
      streamed.createdAt = event.createdAt;
      streamed.eventCount += 1;
      streamed.sourceEventIds.push(event.id);
      streamed.sourceEvents.push(event);
      continue;
    }
    const callId = event.type === "tool" ? stringValue(event.payload.id) ?? stringValue(event.payload.callId) : null;
    const existing = callId
      ? current.records.find((record) => record.kind === "tool" && (record.payload.id === callId || record.payload.callId === callId))
      : undefined;
    if (existing) {
      existing.payload = { ...existing.payload, ...event.payload };
      existing.summary = summarize(event.type, existing.payload);
      existing.error = isError(event.type, existing.payload);
      existing.durationMs = elapsed(existing.createdAt, event.createdAt);
      existing.eventCount += 1;
      existing.sourceEventIds.push(event.id);
      existing.sourceEvents.push(event);
      continue;
    }
    const kind = recordKind(event.type);
    current.records.push({
      id: event.id,
      index: event.sequence,
      kind,
      title: title(event.type, event.payload),
      summary: summarize(event.type, event.payload),
      payload: event.payload,
      createdAt: event.createdAt,
      durationMs: numberValue(event.payload.durationMs) ?? numberValue(event.payload.duration_ms),
      error: isError(event.type, event.payload),
      eventCount: 1,
      sourceEventIds: [event.id],
      sourceEvents: [event],
      sourceType: event.type,
    });
  }
  return { turns };
}

export function searchTrajectory(model: TrajectoryModel, query: string): TrajectoryModel {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return model;
  return {
    turns: model.turns.flatMap((turn) => {
      const records = turn.records.filter((record) =>
        `${record.title} ${record.summary} ${JSON.stringify(record.payload)}`.toLocaleLowerCase().includes(normalized));
      return records.length ? [{ ...turn, records }] : [];
    }),
  };
}

function recordKind(type: Exclude<NormalizedEvent["type"], "usage" | "queue_status">): TrajectoryRecordKind {
  if (type === "assistant_message") return "assistant";
  if (type === "user_message") return "user";
  if (type === "turn_status") return "status";
  return type;
}
function title(type: NormalizedEvent["type"], payload: Record<string, unknown>): string {
  if (type === "assistant_message") return "ASSISTANT";
  if (type === "user_message") return "USER";
  if (type === "turn_status") return "STATUS";
  if (type === "tool") return stringValue(payload.name) ?? "TOOL";
  if (type === "shell") return "SHELL";
  if (type === "file") return "FILE";
  return type.toUpperCase();
}
function summarize(type: NormalizedEvent["type"], payload: Record<string, unknown>): string {
  const direct = stringValue(payload.text) ?? stringValue(payload.summary) ?? stringValue(payload.message)
    ?? stringValue(payload.command) ?? stringValue(payload.path) ?? stringValue(payload.request);
  if (direct) return direct;
  if (type === "turn_status") return stringValue(payload.status) ?? "unknown";
  const selected = Object.fromEntries(Object.entries(payload).filter(([key]) => !["id", "callId"].includes(key)));
  return Object.keys(selected).length ? JSON.stringify(selected) : title(type, payload);
}
function isError(type: NormalizedEvent["type"], payload: Record<string, unknown>): boolean {
  if (type === "warning") return false;
  return payload.status === "failed" || payload.status === "error" || payload.error !== undefined;
}
function elapsed(start: string, end: string): number | null {
  const value = Date.parse(end) - Date.parse(start);
  return Number.isFinite(value) && value >= 0 ? value : null;
}
function stringValue(value: unknown): string | null { return typeof value === "string" && value ? value : null; }
function numberValue(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
