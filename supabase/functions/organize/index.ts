// Splits one note into topic parts and files them into the user's topic graph.
// POST { note_id }  (Authorization: Bearer <user jwt>)
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const MODELS = (Deno.env.get("OPENROUTER_MODELS") ?? "openai/gpt-6-luna,anthropic/claude-haiku-5.5")
  .split(",").map((s) => s.trim()).filter(Boolean);
const MAX_IMAGES = 8;

const SYSTEM = `You file raw, messy personal notes into a knowledge graph of topics.
A note may contain several unrelated subjects and screenshots. Split it into parts where the subject actually changes, and assign each part to one topic.

Rules
- A topic is a subject the person would want to find again later: a project, venture idea, company, person, plan, or field of knowledge. Name it in 2-5 words, in the language of the note.
- Reuse an existing topic whenever the part clearly fits it. Create a new topic only when none fits.
- Avoid topics that are too broad ("Business", "Ideas", "Notes", "Misc") or too narrow (a single one-off sentence).
- Keep consecutive lines about the same subject together in one part. Most short notes are exactly one part.
- An image belongs to the part whose text it illustrates. A standalone screenshot becomes its own part, filed by what it shows.
- "text": copy the part's text exactly as written. Do not rewrite, summarise, translate or add anything. Empty string for an image-only part.
- "gist": one short line saying what the part is, in the note's language (describe what a screenshot shows).
- "related": up to 3 topics (existing ids like "T4", or names of new topics from this answer) that are genuinely about a related subject. Not merely because they appear in the same note.
- Skip empty or meaningless fragments.

Answer with JSON only:
{"parts":[{"topic":"T3" or null,"new_topic":{"name":"...","summary":"one line on what this topic covers"} or null,"gist":"...","text":"...","images":[1],"related":["T4"]}]}
Exactly one of "topic" / "new_topic" must be set per part.`;

type Block = { t: "text"; v: string } | { t: "img"; path: string };
type Part = {
  topic?: string | null;
  new_topic?: { name?: string; summary?: string } | null;
  gist?: string;
  text?: string;
  images?: number[];
  related?: string[];
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // --- who is calling
    const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const { data: u } = await admin.auth.getUser(token);
    const user = u?.user;
    if (!user) return json({ error: "not signed in" }, 401);
    const { data: member } = await admin.from("members").select("email").eq("email", (user.email ?? "").toLowerCase()).maybeSingle();
    if (!member) return json({ error: "not allowed" }, 403);

    const { note_id } = await req.json();
    const { data: note } = await admin.from("notes").select("*").eq("id", note_id).eq("user_id", user.id).maybeSingle();
    if (!note) return json({ error: "note not found" }, 404);

    const blocks: Block[] = Array.isArray(note.blocks) ? note.blocks : [];
    const hasText = blocks.some((b) => b.t === "text" && b.v.trim().length > 1);
    const imgBlocks = blocks.filter((b): b is { t: "img"; path: string } => b.t === "img");

    const finish = async (error: string | null) => {
      await admin.from("notes").update({ processed_at: note.updated_at, process_error: error }).eq("id", note.id).eq("updated_at", note.updated_at);
    };

    // empty note: nothing to file
    if (!hasText && imgBlocks.length === 0) {
      await admin.from("snippets").delete().eq("note_id", note.id);
      await admin.rpc("prune_topics", { uid: user.id });
      await finish(null);
      return json({ parts: 0 });
    }

    const apiKey = Deno.env.get("OPENROUTER_API_KEY");
    if (!apiKey) return json({ error: "OPENROUTER_API_KEY missing" }, 500);

    // --- existing topics, with short ids for the model
    const { data: topics } = await admin.from("topics").select("id,name,summary").eq("user_id", user.id).order("created_at");
    const byShort = new Map<string, string>();
    const topicLines = (topics ?? []).map((t, i) => {
      byShort.set(`T${i + 1}`, t.id);
      return `T${i + 1}: ${t.name}${t.summary ? " — " + t.summary : ""}`;
    });

    // --- note content in order, images inline
    const content: unknown[] = [{
      type: "text",
      text: `Existing topics:\n${topicLines.length ? topicLines.join("\n") : "(none yet)"}\n\nThe note:`,
    }];
    let imgNo = 0;
    const imgPaths: string[] = [];
    for (const b of blocks) {
      if (b.t === "text") {
        if (b.v.trim()) content.push({ type: "text", text: b.v });
      } else if (imgNo < MAX_IMAGES) {
        const { data: file } = await admin.storage.from("images").download(b.path);
        if (!file) continue;
        imgNo++;
        imgPaths.push(b.path);
        const b64 = encodeBase64(new Uint8Array(await file.arrayBuffer()));
        content.push({ type: "text", text: `[Image ${imgNo}]` });
        content.push({ type: "image_url", image_url: { url: `data:${file.type || "image/png"};base64,${b64}` } });
      }
    }

    // --- ask the model
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://futurestructure-v2.vercel.app",
        "X-Title": "FutureStructure v2",
      },
      body: JSON.stringify({
        models: MODELS,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content }],
      }),
    });
    const out = await r.json();
    const raw: string = out?.choices?.[0]?.message?.content ?? "";
    let parts: Part[] = [];
    try {
      const m = raw.match(/\{[\s\S]*\}/);
      parts = JSON.parse(m ? m[0] : raw).parts ?? [];
    } catch {
      await finish("AI answer unreadable");
      return json({ error: "AI answer unreadable", detail: out?.error ?? raw.slice(0, 300) }, 502);
    }

    // --- write: replace this note's snippets
    await admin.from("snippets").delete().eq("note_id", note.id);

    const nameToId = new Map<string, string>();
    for (const t of topics ?? []) nameToId.set(t.name.trim().toLowerCase(), t.id);

    const resolve = async (p: Part): Promise<string | null> => {
      if (p.topic && byShort.has(p.topic)) return byShort.get(p.topic)!;
      const name = p.new_topic?.name?.trim();
      if (!name) return null;
      const key = name.toLowerCase();
      if (nameToId.has(key)) return nameToId.get(key)!;
      const { data: t } = await admin.from("topics")
        .insert({ user_id: user.id, name, summary: p.new_topic?.summary ?? "" }).select("id").single();
      if (!t) return null;
      nameToId.set(key, t.id);
      return t.id;
    };

    const snippetRows = [];
    const partTopic: (string | null)[] = [];
    for (const [i, p] of parts.entries()) {
      const tid = await resolve(p);
      partTopic.push(tid);
      if (!tid) continue;
      snippetRows.push({
        user_id: user.id,
        note_id: note.id,
        topic_id: tid,
        gist: (p.gist ?? "").slice(0, 300),
        text: p.text ?? "",
        image_paths: (p.images ?? []).map((n) => imgPaths[n - 1]).filter(Boolean),
        position: i,
      });
    }
    if (snippetRows.length) await admin.from("snippets").insert(snippetRows);

    // --- links between related topics
    const links = new Set<string>();
    for (const [i, p] of parts.entries()) {
      const a = partTopic[i];
      if (!a) continue;
      for (const ref of (p.related ?? []).slice(0, 3)) {
        const b = byShort.get(ref) ?? nameToId.get(String(ref).trim().toLowerCase());
        if (!b || b === a) continue;
        links.add(a < b ? `${a}|${b}` : `${b}|${a}`);
      }
    }
    if (links.size) {
      await admin.from("topic_links").upsert(
        [...links].map((k) => { const [a, b] = k.split("|"); return { user_id: user.id, a, b }; }),
        { onConflict: "a,b", ignoreDuplicates: true },
      );
    }

    await admin.rpc("prune_topics", { uid: user.id });
    await finish(null);
    return json({ parts: snippetRows.length });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
