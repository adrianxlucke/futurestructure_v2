import { lazy, Suspense, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase, organize, needsSorting, noteTitle, notePreview, shortDate, type NoteRow } from "./lib";
import Editor from "./Editor";
const Graph = lazy(() => import("./Graph"));

type View = "note" | "list" | "graph";

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);
  if (session === undefined) return null;
  if (!session) return <Login />;
  return <Notes uid={session.user.id} />;
}

function Notes({ uid }: { uid: string }) {
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [editorKey, setEditorKey] = useState(0);
  const [view, setView] = useState<View>("note");
  const [focusTopic, setFocusTopic] = useState<string | null>(null);

  // load list, then quietly sort anything left unsorted
  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("notes")
        .select("id,html,text,updated_at,processed_at,process_error")
        .order("updated_at", { ascending: false }).limit(500);
      const rows = (data ?? []) as NoteRow[];
      setNotes(rows);
      for (const n of rows.filter(needsSorting)) await organize(n.id);
    })();
  }, []);

  function upsert(row: NoteRow) {
    setNotes((ns) => [row, ...ns.filter((n) => n.id !== row.id)]);
  }
  function open(id: string | null) {
    setCurrent(id);
    setEditorKey((k) => k + 1);
    setView("note");
  }
  function openTopic(id: string) {
    setFocusTopic(id);
    setView("graph");
  }

  const list = (
    <nav className="list">
      {notes.map((n) => (
        <button key={n.id} className={"list-item" + (n.id === current && view === "note" ? " active" : "")} onClick={() => open(n.id)}>
          <div className="li-title">{noteTitle(n.text, n.html.includes("data-path"))}</div>
          <div className="li-sub"><span>{shortDate(n.updated_at)}</span> {notePreview(n.text)}</div>
        </button>
      ))}
      {notes.length === 0 && <p className="muted pad">No notes yet.</p>}
    </nav>
  );

  const icons = {
    list: <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 6h16M4 12h16M4 18h10"/></svg>,
    graph: <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="6" cy="7" r="2.5"/><circle cx="18" cy="6" r="2"/><circle cx="12" cy="17" r="3"/><path d="M8 8.5l2.5 6M16.5 7.5l-3 7M8.5 7h7.5"/></svg>,
    compose: <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6"/><path d="m17.5 3.5 3 3L12 15H9v-3z"/></svg>,
  };

  return (
    <div className={"app view-" + view}>
      <aside className="sidebar">
        <header className="bar">
          <span className="brand">Notes</span>
          <span className="spacer" />
          <button className={"icon-btn" + (view === "graph" ? " on" : "")} onClick={() => setView(view === "graph" ? "note" : "graph")} title="Graph" aria-label="Graph">{icons.graph}</button>
          <button className="icon-btn" onClick={() => open(null)} title="New note" aria-label="New note">{icons.compose}</button>
        </header>
        {list}
        <button className="signout" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </aside>

      <main className="main">
        <header className="bar mobile-only">
          <button className="icon-btn" onClick={() => setView(view === "list" ? "note" : "list")} aria-label="Notes">{icons.list}</button>
          <span className="spacer" />
          <button className={"icon-btn" + (view === "graph" ? " on" : "")} onClick={() => setView(view === "graph" ? "note" : "graph")} aria-label="Graph">{icons.graph}</button>
          <button className="icon-btn" onClick={() => open(null)} aria-label="New note">{icons.compose}</button>
        </header>
        {view === "list" && <div className="mobile-list">{list}</div>}
        {view === "note" && (
          <Editor
            key={editorKey}
            noteId={current}
            uid={uid}
            onChanged={(row) => { upsert(row); setCurrent(row.id); }}
            onDeleted={(id) => {
              setNotes((ns) => ns.filter((n) => n.id !== id));
              setCurrent((c) => { if (c === id) { setEditorKey((k) => k + 1); return null; } return c; });
            }}
            onOpenTopic={openTopic}
          />
        )}
        {view === "graph" && <Suspense fallback={null}><Graph focusId={focusTopic} onFocus={setFocusTopic} onOpenNote={(id) => open(id)} /></Suspense>}
      </main>
    </div>
  );
}

function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"in" | "up">("in");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg("");
    if (mode === "up") {
      const { error } = await supabase.auth.signUp({ email, password });
      if (error) { setMsg(error.message); setBusy(false); return; }
    }
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setMsg(error.message === "Email not confirmed" ? "This email isn't enabled for this app." : error.message);
    setBusy(false);
  }

  return (
    <div className="login">
      <form onSubmit={submit}>
        <h1>FutureStructure</h1>
        <p className="muted">Just write. Structure happens on its own.</p>
        <input type="email" placeholder="Email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input type="password" placeholder="Password" autoComplete={mode === "up" ? "new-password" : "current-password"} minLength={8}
          value={password} onChange={(e) => setPassword(e.target.value)} required />
        <button className="primary" disabled={busy}>{mode === "in" ? "Sign in" : "Create account"}</button>
        {msg && <p className="error">{msg}</p>}
        <button type="button" className="link" onClick={() => setMode(mode === "in" ? "up" : "in")}>
          {mode === "in" ? "First time here? Create your account" : "Have an account? Sign in"}
        </button>
      </form>
    </div>
  );
}
