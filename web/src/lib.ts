import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(
  "https://cuogaekavsiqdmqhyxff.supabase.co",
  "sb_publishable_3jlETw9pR6zQ4rn1mK5dZg_rjh2TYKf",
);

export type Block = { t: "text"; v: string } | { t: "img"; path: string };

export type NoteRow = {
  id: string;
  html: string;
  text: string;
  updated_at: string;
  processed_at: string | null;
  process_error: string | null;
};

export type Topic = { id: string; name: string; summary: string };
export type Snippet = {
  id: string;
  note_id: string;
  topic_id: string;
  gist: string;
  text: string;
  image_paths: string[];
  created_at: string;
};

export function noteTitle(text: string, hasImg = false) {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean);
  return line ? line.slice(0, 80) : hasImg ? "Image" : "New note";
}

export function notePreview(text: string) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return (lines[1] ?? "").slice(0, 80);
}

export function shortDate(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const days = Math.floor((new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 864e5);
  if (days === 0) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString([], { weekday: "long" });
  return d.toLocaleDateString([], { day: "2-digit", month: "2-digit", year: "2-digit" });
}

export function needsSorting(n: Pick<NoteRow, "updated_at" | "processed_at">) {
  return !n.processed_at || new Date(n.processed_at) < new Date(n.updated_at);
}

// ---- signed image URLs (private bucket), cached
const urlCache = new Map<string, string>();
export function cachedUrl(path: string) {
  return urlCache.get(path);
}
export function rememberUrl(path: string, url: string) {
  urlCache.set(path, url);
}
export async function signedUrls(paths: string[]) {
  const missing = [...new Set(paths)].filter((p) => !urlCache.has(p));
  if (missing.length) {
    const { data } = await supabase.storage.from("images").createSignedUrls(missing, 60 * 60 * 6);
    for (const r of data ?? []) if (r.signedUrl && r.path) urlCache.set(r.path, r.signedUrl);
  }
  return Object.fromEntries(paths.map((p) => [p, urlCache.get(p) ?? ""]));
}

export async function uploadImage(file: File, uid: string) {
  const ext = (file.type.split("/")[1] || "png").replace("jpeg", "jpg");
  const path = `${uid}/${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from("images").upload(path, file, { contentType: file.type || "image/png" });
  if (error) throw error;
  rememberUrl(path, URL.createObjectURL(file));
  return path;
}

// ---- background sorting: one request per note at a time
const inFlight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
export function onSorted(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
export function isSorting(id: string) {
  return inFlight.has(id);
}
export function organize(noteId: string): Promise<void> {
  const running = inFlight.get(noteId);
  if (running) return running;
  const p = (async () => {
    try {
      await supabase.functions.invoke("organize", { body: { note_id: noteId } });
    } catch {
      /* stays unsorted; retried on next app start */
    } finally {
      inFlight.delete(noteId);
      listeners.forEach((l) => l());
    }
  })();
  inFlight.set(noteId, p);
  listeners.forEach((l) => l());
  return p;
}
