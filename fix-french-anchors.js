/**
 * One-time migration: translate English anchor text in French blog posts.
 *
 * What it does:
 *   - Fetches all posts where language = 'fr'
 *   - Extracts every <a> tag's display text per post
 *   - Sends unique anchor texts to Claude in one API call to identify which
 *     are English and get their French translations
 *   - Replaces anchor text inside <a> tags only — hrefs are never touched
 *   - PATCHes only rows whose content actually changed
 *
 * Usage:
 *   node fix-french-anchors.js            # live run
 *   DRY_RUN=1 node fix-french-anchors.js  # preview only, no writes
 */

const Anthropic = require("@anthropic-ai/sdk");

const SUPABASE_URL = "https://dgrvojmeztdkoorljwrk.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRncnZvam1lenRka29vcmxqd3JrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU4MzE1MzYsImV4cCI6MjA5MTQwNzUzNn0.Gs32Z4cOEJsxiDARRIZs2i9SAQ-LunnECXmrt9F46ZE";
const DRY_RUN      = process.env.DRY_RUN === "1";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Supabase helpers ─────────────────────────────────────────────────────────

const HEADERS = {
  "Content-Type": "application/json",
  "apikey": SUPABASE_KEY,
  "Authorization": `Bearer ${SUPABASE_KEY}`,
  "Prefer": "return=minimal",
};

async function fetchFrenchPosts() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/blog_posts?select=id,keyword,content&language=eq.fr&order=id.asc`,
    { headers: HEADERS }
  );
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function updatePostContent(id, content) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/blog_posts?id=eq.${id}`, {
    method: "PATCH",
    headers: HEADERS,
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error(`PATCH ${id} failed: ${res.status} ${await res.text()}`);
}

// ─── Anchor extraction ────────────────────────────────────────────────────────

function extractAnchors(html) {
  const anchors = new Set();
  const re = /<a\b[^>]*>([^<]+)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const text = m[1].trim();
    if (text) anchors.add(text);
  }
  return [...anchors];
}

// ─── Claude translation ───────────────────────────────────────────────────────

/**
 * Ask Claude which of the provided anchor texts are in English and translate
 * them to French. Returns a map of { englishText: frenchTranslation }.
 * Already-French anchors are omitted from the result.
 */
async function translateEnglishAnchors(anchorTexts) {
  if (anchorTexts.length === 0) return {};

  const list = anchorTexts.map((t, i) => `${i + 1}. "${t}"`).join("\n");

  const prompt = `You are a French translation assistant. Below is a list of link anchor texts from a French-language blog about locksmith and garage door services in Montreal.

Some anchors are already in French, some are in English. Your task:
1. Identify which ones are in English.
2. Translate ONLY the English ones to natural French.
3. Return a JSON object mapping each English original (exact string, as given) to its French translation.
4. Do NOT include anchors that are already in French.
5. If all are already French, return {}.
6. Return ONLY the JSON object, no explanation, no markdown fences.

Anchor texts:
${list}`;

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = message.content[0].text.trim();

  try {
    return JSON.parse(raw);
  } catch {
    // Strip any accidental markdown fences and retry
    const cleaned = raw.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "").trim();
    return JSON.parse(cleaned);
  }
}

// ─── Content patching ─────────────────────────────────────────────────────────

/**
 * Replace anchor display text for every entry in the translations map.
 * Only the text between > and </a> is touched; hrefs are never modified.
 */
function applyTranslations(html, translations) {
  let result = html;
  let changed = false;

  for (const [english, french] of Object.entries(translations)) {
    if (!french || english === french) continue;

    // Escape special regex characters in the English text
    const escaped = english.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const before = result;
    result = result.replace(
      new RegExp(`(<a\\b[^>]*>)${escaped}(<\\/a>)`, "gi"),
      (_, open, close) => `${open}${french}${close}`
    );
    if (result !== before) changed = true;
  }

  return { html: result, changed };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nFrench anchor-text migration  |  dry_run=${DRY_RUN}\n`);

  const posts = await fetchFrenchPosts();
  console.log(`Found ${posts.length} French posts\n`);

  let fixed = 0, skipped = 0;

  for (const post of posts) {
    if (!post.content) { skipped++; continue; }

    const anchors = extractAnchors(post.content);
    if (anchors.length === 0) { skipped++; continue; }

    // Ask Claude which anchors are English and get translations
    const translations = await translateEnglishAnchors(anchors);
    const translationCount = Object.keys(translations).length;

    if (translationCount === 0) {
      console.log(`  OK  id=${post.id}  keyword="${post.keyword}" — all anchors already French`);
      skipped++;
      continue;
    }

    // Log what will change
    console.log(`\n[${DRY_RUN ? "DRY" : "FIX"}] id=${post.id}  keyword="${post.keyword}"`);
    for (const [en, fr] of Object.entries(translations)) {
      console.log(`       "${en}"  →  "${fr}"`);
    }

    const { html: newContent, changed } = applyTranslations(post.content, translations);

    if (!changed) {
      console.log(`       (no regex match found in content — skipping)`);
      skipped++;
      continue;
    }

    if (!DRY_RUN) {
      await updatePostContent(post.id, newContent);
    }

    fixed++;
  }

  console.log(`\nDone — fixed: ${fixed}, skipped: ${skipped}`);
  if (DRY_RUN && fixed > 0) {
    console.log("Run without DRY_RUN=1 to apply changes.");
  }
}

main().catch(err => { console.error(err); process.exit(1); });
