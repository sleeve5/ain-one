import { useMemo, useRef, useState } from "react";
import Markdown from "markdown-to-jsx";
import type { NormalizedEvent } from "../../shared/contracts.js";
import { projectTrajectory, searchTrajectory, type TrajectoryRecord } from "./trajectory-model.js";

interface TrajectoryCanvasProps {
  language?: "zh" | "en";
  events?: NormalizedEvent[];
}

type DetailTab = "summary" | "raw" | "source";
type FocusRange = { start: number; end: number };
const TIMELINE_EDGE = 12;
const TIMELINE_BLOCK = 18;
const TIMELINE_GAP = 6;

export function TrajectoryCanvas({ language = "en", events = [] }: TrajectoryCanvasProps) {
  const zh = language === "zh";
  const [collapsedTurns, setCollapsedTurns] = useState(false);
  const [collapsedCalls, setCollapsedCalls] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>("summary");
  const [focusRange, setFocusRange] = useState<FocusRange | null>(null);
  const [detailsWidth, setDetailsWidth] = useState(520);
  const timelineDrag = useRef<{ pointerId: number; start: number; moved: boolean } | null>(null);
  const suppressTimelineClick = useRef(false);
  const detailsDrag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const model = useMemo(() => searchTrajectory(projectTrajectory(events), query), [events, query]);
  const records = model.turns.flatMap((turn) => turn.records);
  const selected = records.find((record) => record.id === selectedId) ?? null;
  const timeDomain = timelineDomain(records);
  const timelineWidth = timelineContentWidth(records.length);
  const calls = records.filter((record) => ["tool", "shell", "file"].includes(record.kind)).length;
  const timelinePoint = (clientX: number, element: HTMLElement) => {
    const box = element.getBoundingClientRect();
    return Math.max(0, Math.min(timelineWidth, clientX - box.left));
  };
  const selectRecord = (record: TrajectoryRecord) => {
    setSelectedId(record.id);
    setDetailTab("summary");
  };

  return (
    <section className="trajectory-canvas" data-testid="trajectory-canvas" aria-label="Trajectory Canvas">
      <div className="trajectory-canvas__toolbar">
        <button type="button" aria-pressed={!collapsedTurns} aria-label={collapsedTurns ? (zh ? "展开轮次" : "Expand turns") : (zh ? "收起轮次" : "Collapse turns")} onClick={() => setCollapsedTurns((value) => !value)}><span aria-hidden="true">{collapsedTurns ? "▸" : "▾"}</span>{zh ? "轮次" : "Turns"}</button>
        <button type="button" aria-pressed={!collapsedCalls} aria-label={collapsedCalls ? (zh ? "展开调用" : "Expand calls") : (zh ? "收起调用" : "Collapse calls")} onClick={() => setCollapsedCalls((value) => !value)}><span aria-hidden="true">{collapsedCalls ? "▸" : "▾"}</span>{zh ? "调用" : "Calls"}</button>
        <div className="trajectory-canvas__metrics" aria-label={zh ? "轨迹概览" : "Trajectory overview"}>
          <span><strong>{records.length}</strong> {zh ? "事件" : "Events"}</span>
          <span><strong>{model.turns.length}</strong> {zh ? "轮次" : "Turns"}</span>
          <span><strong>{calls}</strong> {zh ? "调用" : "Calls"}</span>
          {timeDomain.spanMs > 0 ? <span><strong>{formatDuration(timeDomain.spanMs)}</strong> {zh ? "时间跨度" : "Span"}</span> : null}
        </div>
        <label className="trajectory-canvas__search"><span aria-hidden="true">⌕</span><input type="search" aria-label={zh ? "搜索轨迹" : "Search trajectory"} placeholder={zh ? "搜索" : "Search"} value={query} onChange={(event) => setQuery(event.currentTarget.value)} /></label>
      </div>
      <div className="trajectory-canvas__timeline" role="region" aria-label="Trajectory timeline">
        <div className="trajectory-canvas__lanes"><span>{zh ? "输入" : "Input"}</span><span>Agent</span><span>{zh ? "工具" : "Tools"}</span><span>{zh ? "系统" : "System"}</span></div>
        <div
          className="trajectory-canvas__track"
          data-testid="trajectory-track"
          tabIndex={0}
          onKeyDown={(event) => { if (event.key === "Escape") setFocusRange(null); }}
        >
          <div
            className="trajectory-canvas__track-content"
            data-testid="trajectory-track-content"
            style={{ width: timelineWidth }}
            onPointerDown={(event) => {
              if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
              const start = timelinePoint(event.clientX, event.currentTarget);
              timelineDrag.current = { pointerId: event.pointerId, start, moved: false };
              setFocusRange({ start, end: start });
            }}
            onPointerMove={(event) => {
              const drag = timelineDrag.current;
              if (!drag || drag.pointerId !== event.pointerId) return;
              const point = timelinePoint(event.clientX, event.currentTarget);
              if (Math.abs(point - drag.start) >= 3) drag.moved = true;
              setFocusRange({ start: Math.min(drag.start, point), end: Math.max(drag.start, point) });
            }}
            onPointerUp={(event) => { const drag = timelineDrag.current; if (drag?.pointerId === event.pointerId) { suppressTimelineClick.current = drag.moved; timelineDrag.current = null; } }}
            onDoubleClick={(event) => { if ((event.target as HTMLElement).closest("button")) return; timelineDrag.current = null; setFocusRange(null); }}
          >
            {focusRange ? <div className="trajectory-canvas__selection" style={{ left: focusRange.start, width: Math.max(2, focusRange.end - focusRange.start) }} /> : null}
            {records.map((record) => {
              const position = timelinePosition(record, records);
              return <button key={record.id} type="button" data-kind={record.kind} data-error={record.error || undefined} data-selected={focusRange ? inRange(position.start, position.end, focusRange) : undefined} aria-label={`${record.title}: ${record.summary}`} style={{ left: position.start, width: TIMELINE_BLOCK }} onClick={() => { if (suppressTimelineClick.current) { suppressTimelineClick.current = false; return; } setFocusRange(null); selectRecord(record); }} />;
            })}
          </div>
        </div>
      </div>
      {focusRange ? <div className="trajectory-canvas__range" role="status" aria-label="Selected time range"><span>{zh ? "时间选区" : "Time range"}: {formatRange(focusRange, records, language)}</span><button type="button" onClick={() => setFocusRange(null)}>{zh ? "清除" : "Clear"}</button></div> : null}
      <div className="trajectory-canvas__body">
        <div className="trajectory-canvas__ledger">
          {records.length === 0 ? <div className="trajectory-canvas__empty">{zh ? "当前会话还没有轨迹" : "No trajectory in this conversation"}</div> : <table aria-label={zh ? "轨迹记录" : "Trajectory ledger"}><tbody>{model.turns.flatMap((turn) => {
            if (collapsedTurns) return [<tr key={turn.id} className="trajectory-row trajectory-row--collapsed"><td><span className="trajectory-row__turn">{zh ? `轮次 ${turn.number}` : `Turn ${turn.number}`}</span></td><td>{turn.records.length} {zh ? "条记录" : "records"}</td></tr>];
            return turn.records.filter((record) => !collapsedCalls || !["reasoning", "tool", "shell", "file"].includes(record.kind)).map((record, index) => {
              const position = timelinePosition(record, records);
              const timestamp = formatClock(record.createdAt, language);
              return <tr key={record.id} role="row" tabIndex={0} aria-selected={selected?.id === record.id} aria-label={`${record.kind.toUpperCase()}, ${record.title} ${record.summary}`} data-kind={record.kind} data-error={record.error || undefined} data-turn-start={index === 0 || undefined} data-timeline-focus={focusRange ? (inRange(position.start, position.end, focusRange) ? "inside" : "outside") : undefined} onClick={() => selectRecord(record)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") selectRecord(record); }}><td><span className="trajectory-row__rail" />{index === 0 ? <span className="trajectory-row__turn">{zh ? `轮次 ${turn.number}` : `Turn ${turn.number}`}</span> : null}<span className={`trajectory-row__tag trajectory-row__tag--${record.kind}`}>{record.kind === "assistant" ? "ASSISTANT" : record.kind.toUpperCase()}</span></td><td><span>{record.title !== record.kind.toUpperCase() ? <strong>{record.title}</strong> : null}{record.title !== record.kind.toUpperCase() ? "  " : null}{record.summary}</span><time dateTime={record.createdAt} title={`${timestamp} · ${Intl.DateTimeFormat().resolvedOptions().timeZone}`}>{timestamp}</time></td></tr>;
            });
          })}</tbody></table>}
        </div>
        {selected ? <aside className="trajectory-details" aria-label="Event details" style={{ width: detailsWidth }}><div className="trajectory-details__resize" role="separator" aria-label={zh ? "调整事件详情宽度" : "Resize event details"} aria-orientation="vertical" tabIndex={0} onPointerDown={(event) => { detailsDrag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: detailsWidth }; }} onPointerMove={(event) => { const drag = detailsDrag.current; if (!drag || drag.pointerId !== event.pointerId) return; setDetailsWidth(Math.max(320, Math.min(720, drag.startWidth + drag.startX - event.clientX))); }} onPointerUp={(event) => { if (detailsDrag.current?.pointerId === event.pointerId) detailsDrag.current = null; }} onKeyDown={(event) => { if (event.key === "ArrowLeft") setDetailsWidth((width) => Math.min(720, width + 16)); if (event.key === "ArrowRight") setDetailsWidth((width) => Math.max(320, width - 16)); }} /><header><div><span className={`trajectory-row__tag trajectory-row__tag--${selected.kind}`}>{selected.kind.toUpperCase()}</span>{hasDistinctTitle(selected) ? <strong>{selected.title}</strong> : null}</div><button type="button" aria-label={zh ? "关闭详情" : "Close details"} onClick={() => setSelectedId(null)}>×</button></header><div className="trajectory-details__tabs" role="tablist">{detailTabs(zh).map((tab) => <button key={tab.id} role="tab" aria-selected={detailTab === tab.id} onClick={() => setDetailTab(tab.id)}>{tab.label}</button>)}</div><div className="trajectory-details__content" role="tabpanel" aria-label={detailTabs(zh).find((tab) => tab.id === detailTab)?.label}>{detailContent(selected, detailTab, zh)}</div></aside> : null}
      </div>
    </section>
  );
}

function timelineDomain(records: TrajectoryRecord[]): { start: number; end: number; spanMs: number } {
  const times = records.map((record) => Date.parse(record.createdAt)).filter(Number.isFinite);
  const start = times.length ? Math.min(...times) : 0;
  const end = times.length ? Math.max(...times) : start;
  return { start, end, spanMs: Math.max(0, end - start) };
}
function timelineContentWidth(recordCount: number): number {
  return TIMELINE_EDGE * 2 + recordCount * TIMELINE_BLOCK + Math.max(0, recordCount - 1) * TIMELINE_GAP;
}
function timelinePosition(record: TrajectoryRecord, records: TrajectoryRecord[]): { start: number; end: number } {
  const index = records.findIndex((candidate) => candidate.id === record.id);
  const start = TIMELINE_EDGE + Math.max(0, index) * (TIMELINE_BLOCK + TIMELINE_GAP);
  return { start, end: start + TIMELINE_BLOCK };
}
function inRange(start: number, end: number, range: FocusRange): boolean { return end >= range.start && start <= range.end; }
function formatDuration(milliseconds: number): string { return milliseconds < 1_000 ? `${milliseconds} ms` : `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 2 : 1)} s`; }
function formatClock(value: string, language: "zh" | "en"): string {
  const parts = new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en-US", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZoneName: "short" }).formatToParts(new Date(value));
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${read("month")}/${read("day")} ${read("hour")}:${read("minute")}:${read("second")} ${read("timeZoneName")}`.trim();
}
function formatRange(range: FocusRange, records: TrajectoryRecord[], language: "zh" | "en"): string {
  const selected = records.filter((record) => { const position = timelinePosition(record, records); return inRange(position.start, position.end, range); });
  if (selected.length === 0) return language === "zh" ? "无事件" : "No events";
  const first = selected[0];
  const last = selected[selected.length - 1];
  if (!first || !last || first.id === last.id) return first ? formatClock(first.createdAt, language) : "";
  return `${formatClock(first.createdAt, language)} – ${formatClock(last.createdAt, language)}`;
}
function detailTabs(zh: boolean): Array<{ id: DetailTab; label: string }> {
  return [
    { id: "summary", label: zh ? "摘要" : "Summary" },
    { id: "raw", label: zh ? "原始数据" : "Raw" },
    { id: "source", label: zh ? "来源" : "Source" },
  ];
}
function detailContent(record: TrajectoryRecord, tab: DetailTab, zh: boolean) {
  if (tab === "raw") return <pre>{JSON.stringify(record.sourceEvents.length > 1 ? record.sourceEvents : record.sourceEvents[0]?.payload ?? record.payload, null, 2)}</pre>;
  if (tab === "source") return <dl><Detail label={zh ? "事件 ID" : "Event ID"} value={record.id} /><Detail label={zh ? "事件类型" : "Event type"} value={record.sourceType} /><Detail label={zh ? "序号" : "Sequence"} value={String(record.index)} /><Detail label={zh ? "记录时间" : "Recorded at"} value={`${formatClock(record.createdAt, zh ? "zh" : "en")} · ${Intl.DateTimeFormat().resolvedOptions().timeZone}`} />{record.sourceEventIds.length > 1 ? <Detail label={zh ? "合并事件" : "Merged events"} value={record.sourceEventIds.join(", ")} /> : null}</dl>;
  return <dl className="trajectory-details__summary"><Detail label={zh ? "类型" : "Type"} value={record.kind} /><Detail label={zh ? "状态" : "Status"} value={record.error ? (zh ? "错误" : "Error") : String(record.payload.status ?? (zh ? "已记录" : "Recorded"))} />{record.durationMs !== null ? <Detail label={zh ? "耗时" : "Duration"} value={formatDuration(record.durationMs)} /> : null}{record.eventCount > 1 ? <Detail label={zh ? "源事件" : "Source events"} value={String(record.eventCount)} /> : null}<div className="trajectory-details__formatted"><dt>{zh ? "内容" : "Content"}</dt><dd><Markdown options={{ disableParsingRawHTML: true }}>{formattedContent(record, zh)}</Markdown></dd></div></dl>;
}
function Detail({ label, value }: { label: string; value: string }) { return <div><dt>{label}</dt><dd>{value}</dd></div>; }
function hasDistinctTitle(record: TrajectoryRecord): boolean { return record.title.trim().toUpperCase() !== record.kind.toUpperCase(); }
function formattedContent(record: TrajectoryRecord, zh: boolean): string {
  if (record.kind !== "shell") return record.summary;
  const command = stringValue(record.payload.command) ?? record.summary;
  const output = stringValue(record.payload.aggregated_output) ?? stringValue(record.payload.output) ?? stringValue(record.payload.result);
  return `**${zh ? "命令" : "Command"}**\n\n\`$ ${command}\`${output ? `\n\n**${zh ? "输出" : "Output"}**\n\n${output}` : ""}`;
}
function stringValue(value: unknown): string | null { return typeof value === "string" && value ? value : null; }
