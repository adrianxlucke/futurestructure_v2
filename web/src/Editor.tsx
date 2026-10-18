import { useEffect, useRef, useState } from "react";
import {
  supabase, organize, onSorted, isSorting, needsSorting, signedUrls, uploadImage, cachedUrl,
  type Block, type NoteRow, type Topic,
} from "./lib";

const SAVE_DELAY = 700;
const SORT_DELAY = 45_000; // sort after 45 s without typing

type Props = {
  noteId: string | null;
  uid: string;
  onChanged: (row: NoteRow) => void;
  onDeleted: (id: string) => void;
  onOpenTopic: (topicId: string) => void;
};

// Walk the editor DOM into ordered text / image blocks.
function serialize(root: HTMLElement) {
  const blocks: Block[] = [];
  let buf = "";
  const isBlock = (el: Element) => /^(DIV|P|LI|H[1-6]|UL|OL|BLOCKQUOTE)$/.test(el.tagName);
  const nl = () => { if (buf && !buf.endsWith("\n")) buf += "\n"; };
  const flush = () => { if (buf.trim()) blocks.push({ t: "text", v: buf.trim() }); buf = ""; };
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) { buf += n.textContent ?? ""; return; }
    if (!(n instanceof Element)) return;
    if (n.tagName === "IMG") {
      const path = n.getAttribute("data-path");
      if (path) { flush(); blocks.push({ t: "img", path }); }
      return;
    }
    if (n.tagName === "BR") { buf += "\n"; return; }
    if (isBlock(n)) nl();
    n.childNodes.forEach(walk);
    if (isBlock(n)) nl();
  };
  root.childNodes.forEach(walk);
  flush();
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("img").forEach((img) => img.removeAttribute("src"));
  const text = blocks.filter((b) => b.t === "text").map((b) => (b as { v: string }).v).join("\n\n");
  const hasImg = blocks.some((b) => b.t === "img");
  return { html: clone.innerHTML, blocks, text, empty: !text.trim() && !hasImg };
}

// Move loose leading text into its own <div> so the title styling hits the real first line.
function wrapFirstLine(root: HTMLElement) {
  const first = root.firstChild;
  if (!first || (first instanceof Element && first.tagName === "DIV")) return;
  const div = document.createElement("div");
  while (root.firstChild && !(root.firstChild instanceof Element && /^(DIV|P|BR)$/.test(root.firstChild.tagName))) {
    div.appendChild(root.firstChild);
  }
  if (root.firstChild instanceof Element && root.firstChild.tagName === "BR") root.firstChild.remove();
  if (div.childNodes.length) root.insertBefore(div, root.firstChild);
}

export default function Editor({ noteId, uid, onChanged, onDeleted, onOpenTopic }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const idRef = useRef<string | null>(noteId);
  const rowRef = useRef<NoteRow | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const saveTimer = useRef<number | undefined>(undefined);
  const sortTimer = useRef<number | undefined>(undefined);
  const dirty = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [status, setStatus] = useState<"idle" | "pending" | "sorting">("idle");
  const [loaded, setLoaded] = useState(noteId === null);
  const [isEmpty, setIsEmpty] = useState(noteId === null);

  // ---------- load
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!noteId) { resetEmpty(); ref.current?.focus(); return; }
      const { data } = await supabase.from("notes").select("id,html,text,updated_at,processed_at,process_error").eq("id", noteId).single();
      if (!alive || !data || !ref.current) return;
      rowRef.current = data as NoteRow;
      ref.current.innerHTML = data.html;
      wrapFirstLine(ref.current);
      resetEmpty();
      await hydrateImages();
      setLoaded(true);
      refreshMeta();
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- leave: save, then sort or drop empty note
  useEffect(() => {
    const leave = () => {
      window.clearTimeout(saveTimer.current);
      window.clearTimeout(sortTimer.current);
      const wasDirty = dirty.current;
      const run = wasDirty ? save() : Promise.resolve();
      run.then(async () => {
        const id = idRef.current;
        const row = rowRef.current;
        if (!id || !row) return;
        if (!row.text.trim() && !row.html.includes("data-path")) {
          await supabase.from("notes").delete().eq("id", id);
          await supabase.rpc("prune_my_topics");
          onDeleted(id);
        } else if (needsSorting(row)) {
          organize(id);
        }
      });
    };
    const onHide = () => { if (document.visibilityState === "hidden" && idRef.current) {
      window.clearTimeout(saveTimer.current);
      const run = dirty.current ? save() : Promise.resolve();
      run.then(() => { if (idRef.current && rowRef.current && needsSorting(rowRef.current)) organize(idRef.current); });
    } };
    document.addEventListener("visibilitychange", onHide);
    return () => { document.removeEventListener("visibilitychange", onHide); leave(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => onSorted(() => refreshMeta()), []); // eslint-disable-line react-hooks/exhaustive-deps

  async function hydrateImages() {
    const imgs = [...(ref.current?.querySelectorAll<HTMLImageElement>("img[data-path]") ?? [])];
    const urls = await signedUrls(imgs.map((i) => i.dataset.path!));
    imgs.forEach((i) => { i.src = urls[i.dataset.path!] || ""; });
  }

  async function refreshMeta() {
    const id = idRef.current;
    if (!id) return;
    if (isSorting(id)) setStatus("sorting");
    const [{ data: row }, { data: snips }] = await Promise.all([
      supabase.from("notes").select("id,html,text,updated_at,processed_at,process_error").eq("id", id).maybeSingle(),
      supabase.from("snippets").select("topic_id, topics(id,name,summary)").eq("note_id", id).order("position"),
    ]);
    if (row && !dirty.current) rowRef.current = row as NoteRow;
    const seen = new Map<string, Topic>();
    for (const s of (snips ?? []) as unknown as { topics: Topic | null }[]) if (s.topics) seen.set(s.topics.id, s.topics);
    setTopics([...seen.values()]);
    setStatus(isSorting(id) ? "sorting" : row && needsSorting(row as NoteRow) ? "pending" : "idle");
  }

  // ---------- save
  function save() {
    queue.current = queue.current.then(async () => {
      if (!ref.current) return;
      dirty.current = false;
      const { html, blocks, text, empty } = serialize(ref.current);
      const now = new Date().toISOString();
      if (!idRef.current) {
        if (empty) return;
        const { data } = await supabase.from("notes").insert({ html, blocks, text, updated_at: now })
          .select("id,html,text,updated_at,processed_at,process_error").single();
        if (data) { idRef.current = data.id; rowRef.current = data as NoteRow; onChanged(data as NoteRow); }
      } else {
        const { data } = await supabase.from("notes").update({ html, blocks, text, updated_at: now }).eq("id", idRef.current)
          .select("id,html,text,updated_at,processed_at,process_error").single();
        if (data) { rowRef.current = data as NoteRow; onChanged(data as NoteRow); }
      }
      setStatus((s) => (s === "sorting" ? s : "pending"));
    });
    return queue.current;
  }

  // keep every line inside a <div> so the first line can be styled as the title
  function resetEmpty() {
    const el = ref.current;
    if (!el) return;
    if (el.innerHTML === "" || el.innerHTML === "<br>") {
      el.innerHTML = "<div><br></div>";
      const r = document.createRange();
      r.setStart(el.firstChild!, 0);
      r.collapse(true);
      const sel = window.getSelection();
      if (document.activeElement === el) { sel?.removeAllRanges(); sel?.addRange(r); }
    }
    setIsEmpty(!el.textContent?.trim() && !el.querySelector("img"));
  }

  function changed() {
    resetEmpty();
    dirty.current = true;
    window.clearTimeout(saveTimer.current);
    window.clearTimeout(sortTimer.current);
    saveTimer.current = window.setTimeout(save, SAVE_DELAY);
    sortTimer.current = window.setTimeout(async () => {
      if (dirty.current) await save();
      if (idRef.current) organize(idRef.current);
    }, SORT_DELAY);
  }

  // ---------- images
  function insertNode(node: Node) {
    const el = ref.current!;
    const sel = window.getSelection();
    let range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    if (!range || !el.contains(range.commonAncestorContainer)) {
      range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
    }
    range.deleteContents();
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  async function addImages(files: File[]) {
    for (const f of files.filter((f) => f.type.startsWith("image/"))) {
      const img = document.createElement("img");
      img.src = URL.createObjectURL(f);
      img.className = "uploading";
      const wrap = document.createElement("div");
      wrap.appendChild(img);
      insertNode(wrap);
      const after = document.createElement("div");
      after.appendChild(document.createElement("br"));
      wrap.after(after);
      try {
        const path = await uploadImage(f, uid);
        img.dataset.path = path;
        img.src = cachedUrl(path) ?? img.src;
        img.className = "";
      } catch {
        wrap.remove();
        alert("Image upload failed");
      }
      changed();
    }
  }

  function onPaste(e: React.ClipboardEvent) {
    const files = [...e.clipboardData.files];
    if (files.some((f) => f.type.startsWith("image/"))) {
      e.preventDefault();
      addImages(files);
      return;
    }
    const text = e.clipboardData.getData("text/plain");
    if (text) {
      e.preventDefault();
      document.execCommand("insertText", false, text);
    }
  }

  function onDrop(e: React.DragEvent) {
    const files = [...e.dataTransfer.files];
    if (files.length) { e.preventDefault(); addImages(files); }
  }

  async function remove() {
    const id = idRef.current;
    if (!id) { if (ref.current) ref.current.innerHTML = ""; return; }
    if (!confirm("Delete this note?")) return;
    window.clearTimeout(saveTimer.current);
    window.clearTimeout(sortTimer.current);
    dirty.current = false;
    idRef.current = null;
    rowRef.current = null;
    await supabase.from("notes").delete().eq("id", id);
    await supabase.rpc("prune_my_topics");
    onDeleted(id);
  }

  return (
    <div className="editor-wrap">
      <div className="editor-tools">
        <span className="editor-date">
          {rowRef.current ? new Date(rowRef.current.updated_at).toLocaleString([], { dateStyle: "long", timeStyle: "short" }) : ""}
        </span>
        <button className="icon-btn" title="Add image" onClick={() => fileInput.current?.click()} aria-label="Add image">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/></svg>
        </button>
        <button className="icon-btn" title="Delete note" onClick={remove} aria-label="Delete note">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>
        </button>
        <input ref={fileInput} type="file" accept="image/*" multiple hidden
          onChange={(e) => { addImages([...(e.target.files ?? [])]); e.target.value = ""; }} />
      </div>
      <div
        ref={ref}
        className={"editor" + (loaded ? "" : " loading") + (isEmpty ? " is-empty" : "")}
        contentEditable
        suppressContentEditableWarning
        data-placeholder="Start typing…"
        onInput={changed}
        onPaste={onPaste}
        onDrop={onDrop}
        spellCheck
      />
      <div className="filed">
        {status === "sorting" && <span className="muted">Sorting into your graph…</span>}
        {status !== "sorting" && topics.length > 0 && (
          <>
            <span className="muted">Filed under</span>
            {topics.map((t) => (
              <button key={t.id} className="chip" onClick={() => onOpenTopic(t.id)}>{t.name}</button>
            ))}
            {status === "pending" && <span className="muted"> · update pending</span>}
          </>
        )}
        {status === "pending" && topics.length === 0 && <span className="muted">Gets sorted in the background</span>}
      </div>
    </div>
  );
}
