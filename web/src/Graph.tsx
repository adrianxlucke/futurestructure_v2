import { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D, { type ForceGraphMethods, type NodeObject } from "react-force-graph-2d";
import { supabase, onSorted, signedUrls, shortDate, type Snippet, type Topic } from "./lib";

type GNode = Topic & { count: number; x?: number; y?: number };
type GLink = { source: string; target: string };

type Props = {
  focusId: string | null;
  onOpenNote: (id: string) => void;
  onFocus: (id: string | null) => void;
};

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export default function Graph({ focusId, onOpenNote, onFocus }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const fg = useRef<ForceGraphMethods<NodeObject<GNode>> | undefined>(undefined);
  const [size, setSize] = useState({ w: 600, h: 600 });
  const [nodes, setNodes] = useState<GNode[]>([]);
  const [links, setLinks] = useState<GLink[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState("");

  async function load() {
    const [{ data: t }, { data: l }, { data: s }] = await Promise.all([
      supabase.from("topics").select("id,name,summary"),
      supabase.from("topic_links").select("a,b"),
      supabase.from("snippets").select("topic_id"),
    ]);
    const counts = new Map<string, number>();
    for (const r of s ?? []) counts.set(r.topic_id, (counts.get(r.topic_id) ?? 0) + 1);
    setNodes((prev) => {
      const old = new Map(prev.map((n) => [n.id, n]));
      return (t ?? []).map((x) => ({ ...old.get(x.id), ...x, count: counts.get(x.id) ?? 0 }));
    });
    setLinks((l ?? []).map((x) => ({ source: x.a, target: x.b })));
    setLoaded(true);
  }

  useEffect(() => { load(); return onSorted(load); }, []);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // neighbours of the selected topic
  const neighbours = useMemo(() => {
    const set = new Set<string>();
    if (!focusId) return set;
    for (const l of links) {
      const a = typeof l.source === "object" ? (l.source as GNode).id : l.source;
      const b = typeof l.target === "object" ? (l.target as GNode).id : l.target;
      if (a === focusId) set.add(b);
      if (b === focusId) set.add(a);
    }
    return set;
  }, [focusId, links]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? new Set(nodes.filter((n) => n.name.toLowerCase().includes(q)).map((n) => n.id)) : null;
  }, [query, nodes]);

  // centre on the focused topic
  useEffect(() => {
    if (!focusId) return;
    const t = window.setTimeout(() => {
      const n = nodes.find((x) => x.id === focusId);
      if (n?.x != null && n.y != null) { fg.current?.centerAt(n.x, n.y, 500); fg.current?.zoom(2.2, 500); }
    }, 350);
    return () => window.clearTimeout(t);
  }, [focusId, nodes]);

  const data = useMemo(() => ({ nodes, links }), [nodes, links]);
  const focus = nodes.find((n) => n.id === focusId) ?? null;

  const colors = {
    node: cssVar("--node") || "#8a8a8a",
    accent: cssVar("--accent") || "#e0a526",
    text: cssVar("--text") || "#222",
    faint: cssVar("--faint") || "#999",
    line: cssVar("--line") || "#ccc",
  };

  return (
    <div className="graph-view">
      <div className="graph-canvas" ref={box}>
        <input className="graph-search" placeholder="Find topic" value={query} onChange={(e) => setQuery(e.target.value)} />
        {loaded && nodes.length === 0 && (
          <div className="empty">Your graph is empty. Write a few notes — they get sorted into topics here automatically.</div>
        )}
        <ForceGraph2D
          ref={fg}
          width={size.w}
          height={size.h}
          graphData={data}
          backgroundColor="rgba(0,0,0,0)"
          cooldownTicks={120}
          nodeRelSize={4}
          nodeVal={(n) => 1 + n.count}
          linkColor={(l) => {
            const a = typeof l.source === "object" ? (l.source as GNode).id : l.source;
            const b = typeof l.target === "object" ? (l.target as GNode).id : l.target;
            return focusId && (a === focusId || b === focusId) ? colors.accent : colors.line;
          }}
          linkWidth={1}
          onNodeClick={(n) => onFocus(n.id === focusId ? null : n.id)}
          onBackgroundClick={() => onFocus(null)}
          nodeCanvasObject={(n, ctx, scale) => {
            const r = 3 + Math.sqrt(n.count) * 2.4;
            const isFocus = n.id === focusId;
            const dim = (focusId && !isFocus && !neighbours.has(n.id)) || (matches && !matches.has(n.id));
            ctx.globalAlpha = dim ? 0.25 : 1;
            ctx.beginPath();
            ctx.arc(n.x!, n.y!, r, 0, 2 * Math.PI);
            ctx.fillStyle = isFocus || matches?.has(n.id) ? colors.accent : colors.node;
            ctx.fill();
            const fontSize = Math.max(11 / scale, 2.5);
            if (scale > 0.9 || isFocus || n.count > 2) {
              ctx.font = `${isFocus ? 600 : 400} ${fontSize}px -apple-system, system-ui, sans-serif`;
              ctx.textAlign = "center";
              ctx.textBaseline = "top";
              ctx.fillStyle = colors.text;
              ctx.fillText(n.name, n.x!, n.y! + r + 2 / scale);
            }
            ctx.globalAlpha = 1;
          }}
          nodePointerAreaPaint={(n, color, ctx) => {
            const r = 3 + Math.sqrt(n.count) * 2.4 + 4;
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(n.x!, n.y!, r, 0, 2 * Math.PI);
            ctx.fill();
          }}
        />
      </div>
      {focus && (
        <TopicPanel
          topic={focus}
          related={nodes.filter((n) => neighbours.has(n.id))}
          onOpenNote={onOpenNote}
          onFocus={onFocus}
        />
      )}
    </div>
  );
}

function TopicPanel({ topic, related, onOpenNote, onFocus }: {
  topic: GNode; related: GNode[]; onOpenNote: (id: string) => void; onFocus: (id: string | null) => void;
}) {
  const [snips, setSnips] = useState<Snippet[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data } = await supabase.from("snippets").select("*").eq("topic_id", topic.id).order("created_at", { ascending: false });
      if (!alive) return;
      setSnips((data ?? []) as Snippet[]);
      const paths = (data ?? []).flatMap((s) => s.image_paths as string[]);
      if (paths.length) { const u = await signedUrls(paths); if (alive) setUrls(u); }
    })();
    return () => { alive = false; };
  }, [topic.id, topic.count]);

  return (
    <aside className="topic-panel">
      <div className="topic-head">
        <div>
          <h2>{topic.name}</h2>
          {topic.summary && <p className="muted">{topic.summary}</p>}
        </div>
        <button className="icon-btn" onClick={() => onFocus(null)} aria-label="Close">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M6 6l12 12M18 6 6 18"/></svg>
        </button>
      </div>
      {related.length > 0 && (
        <div className="related">
          {related.map((r) => <button key={r.id} className="chip" onClick={() => onFocus(r.id)}>{r.name}</button>)}
        </div>
      )}
      <div className="snips">
        {snips.map((s) => (
          <article key={s.id} className="snip">
            <div className="snip-gist">{s.gist}</div>
            {s.text && <div className="snip-text">{s.text}</div>}
            {s.image_paths.map((p) => urls[p] && <img key={p} src={urls[p]} alt="" />)}
            <button className="link" onClick={() => onOpenNote(s.note_id)}>Open note · {shortDate(s.created_at)}</button>
          </article>
        ))}
      </div>
    </aside>
  );
}
