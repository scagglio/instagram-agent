// generate.js
//
// Headless content generation:
//   1. Picks the next content pillar (rotates through account.json)
//   2. Asks Claude to draft a post (headline, subhead, caption, hashtags, alt text)
//   3. Runs local sanity checks, then a second Claude call that reviews the draft
//      against your rules. Rejected drafts are retried with the reviewer's feedback.
//   4. Renders a 1080x1350 JPEG from an SVG template (no external design tool needed)
//   5. Writes post.json for publish.js
//
// Environment: ANTHROPIC_API_KEY (required), DRY_RUN ("true" writes to drafts/ instead of images/)

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const account = require("./account.json");

const DRY_RUN = process.env.DRY_RUN === "true";
const HISTORY_PATH = path.join(__dirname, "history.json");

function loadHistory() {
  return fs.existsSync(HISTORY_PATH) ? JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8")) : [];
}

// ---------- Claude ----------

async function callClaude(system, user, maxTokens = 900) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: account.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.content.filter((b) => b.type === "text").map((b) => b.text).join("");
}

function parseJson(text) {
  const cleaned = text.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object found in response");
  return JSON.parse(cleaned.slice(start, end + 1));
}

function briefText() {
  return [
    `Handle: ${account.handle}`,
    `Niche: ${account.niche}`,
    `Audience: ${account.audience}`,
    `Voice: ${account.voice}`,
    `Rules:\n${account.rules.map((r) => `- ${r}`).join("\n")}`,
    `Never post about:\n${account.bannedTopics.map((t) => `- ${t}`).join("\n")}`,
  ].join("\n\n");
}

async function draftPost(pillar, history, feedback) {
  const recent =
    history.slice(-30).map((h) => `- ${h.headline}`).join("\n") || "(none yet)";

  const system =
    `You run an Instagram account with no human editor, so every post must be safe to publish exactly as written.\n\n` +
    briefText();

  const user =
    `Write the next post.\n` +
    `Content pillar for this post: ${pillar}\n` +
    `Today's date: ${new Date().toISOString().slice(0, 10)}\n\n` +
    `Recent posts (do not repeat or closely paraphrase these):\n${recent}\n` +
    (feedback ? `\nYour previous draft was rejected. Reason: ${feedback}\nFix this in the new draft.\n` : "") +
    `\nRequirements:\n` +
    `- headline: max 8 words, plain text, no emoji, no hashtags\n` +
    `- subhead: max 16 words, plain text, no emoji\n` +
    `- caption: max ${account.captionMaxWords} words, a few emoji are fine, end with a short call to action or question\n` +
    `- hashtags: exactly ${account.hashtagCount}, relevant, no spaces\n` +
    `- altText: one sentence describing the image (a text graphic showing the headline and subhead)\n\n` +
    `Respond with ONLY valid JSON in this exact shape:\n` +
    `{"headline":"","subhead":"","caption":"","hashtags":[],"altText":""}`;

  return parseJson(await callClaude(system, user));
}

function validate(p) {
  if (!p || typeof p !== "object") return "Draft was not a JSON object";
  for (const k of ["headline", "subhead", "caption", "altText"]) {
    if (typeof p[k] !== "string" || !p[k].trim()) return `Missing or empty field: ${k}`;
  }
  if (!Array.isArray(p.hashtags) || p.hashtags.length === 0) return "hashtags must be a non-empty array";
  const words = (s) => s.trim().split(/\s+/).length;
  if (words(p.headline) > 8) return "headline is longer than 8 words";
  if (words(p.subhead) > 16) return "subhead is longer than 16 words";
  if (words(p.caption) > account.captionMaxWords + 10) return `caption is longer than ${account.captionMaxWords} words`;
  if (/\p{Extended_Pictographic}/u.test(p.headline + p.subhead)) return "headline/subhead must not contain emoji";
  return null;
}

async function reviewPost(post) {
  const system =
    `You are a strict content reviewer for an Instagram account that publishes with no human approval. ` +
    `Reject anything that could embarrass the account or harm someone.\n\n` +
    briefText();

  const user =
    `Review this draft post:\n${JSON.stringify(post, null, 2)}\n\n` +
    `Approve only if ALL of these are true:\n` +
    `- It follows every rule and avoids every banned topic above.\n` +
    `- It contains no invented statistics, quotes, studies, or news, and no risky factual claims.\n` +
    `- It matches the stated voice and audience.\n` +
    `- It is not offensive, misleading, or spammy.\n\n` +
    `Respond with ONLY valid JSON: {"approved": true or false, "reason": "one sentence"}`;

  return parseJson(await callClaude(system, user, 300));
}

// ---------- Image rendering ----------

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function wrap(text, maxChars) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const w of words) {
    if (!line) line = w;
    else if ((line + " " + w).length <= maxChars) line += " " + w;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function fitHeadline(text) {
  for (const size of [112, 96, 84, 72, 60]) {
    const maxChars = Math.floor(840 / (size * 0.66));
    const lines = wrap(text, maxChars);
    if (lines.length <= 5 && lines.every((l) => l.length <= maxChars)) return { size, lines };
  }
  const size = 52;
  return { size, lines: wrap(text, Math.floor(840 / (size * 0.66))) };
}

function buildSvg(post) {
  const W = 1080;
  const H = 1350;
  const M = 90;
  const { background, text, accent, fontFamily } = account.design;

  const head = fitHeadline(post.headline);
  const lineH = Math.round(head.size * 1.15);
  const headTop = 340;
  const headSvg = head.lines
    .map(
      (l, i) =>
        `<text x="${M}" y="${headTop + i * lineH}" font-size="${head.size}" font-weight="700" fill="${text}">${esc(l)}</text>`
    )
    .join("");

  const subTop = headTop + (head.lines.length - 1) * lineH + 90;
  const subSvg = wrap(post.subhead, 30)
    .map(
      (l, i) =>
        `<text x="${M}" y="${subTop + i * 62}" font-size="46" fill="${text}" fill-opacity="0.85">${esc(l)}</text>`
    )
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${background}"/>
  <circle cx="${W - 60}" cy="${H - 120}" r="420" fill="${accent}" fill-opacity="0.12"/>
  <rect x="${M}" y="150" width="140" height="14" rx="7" fill="${accent}"/>
  <g font-family="${fontFamily}">
    ${headSvg}
    ${subSvg}
    <text x="${M}" y="${H - 110}" font-size="40" font-weight="700" fill="${accent}">${esc(account.handle)}</text>
  </g>
</svg>`;
}

async function renderImage(post, outPath) {
  await sharp(Buffer.from(buildSvg(post))).jpeg({ quality: 92 }).toFile(outPath);
}

// ---------- Main ----------

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");

  const history = loadHistory();
  const pillar = account.contentPillars[history.length % account.contentPillars.length];
  console.log(`Pillar: ${pillar}`);

  let approved = null;
  let feedback = "";

  for (let attempt = 1; attempt <= account.maxAttempts; attempt++) {
    console.log(`Draft attempt ${attempt}/${account.maxAttempts}...`);
    let candidate;
    try {
      candidate = await draftPost(pillar, history, feedback);
    } catch (err) {
      feedback = `Your response could not be parsed as valid JSON (${err.message}).`;
      console.log(`  Unparseable draft: ${err.message}`);
      continue;
    }

    const problem = validate(candidate);
    if (problem) {
      feedback = problem;
      console.log(`  Failed local checks: ${problem}`);
      continue;
    }

    const review = await reviewPost(candidate);
    if (review.approved === true) {
      approved = candidate;
      console.log("  Approved by reviewer.");
      break;
    }
    feedback = review.reason || "Reviewer rejected the draft.";
    console.log(`  Rejected by reviewer: ${feedback}`);
  }

  if (!approved) {
    throw new Error(`No acceptable draft after ${account.maxAttempts} attempts. Last problem: ${feedback}`);
  }

  const hashtags = approved.hashtags
    .slice(0, account.hashtagCount)
    .map((h) => String(h).replace(/[^\p{L}\p{N}_]/gu, ""))
    .filter(Boolean)
    .map((h) => `#${h}`);
  const fullCaption = `${approved.caption.trim()}\n\n${hashtags.join(" ")}`;

  const dir = DRY_RUN ? "drafts" : "images";
  fs.mkdirSync(path.join(__dirname, dir), { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  const imageFile = `${dir}/post-${stamp}.jpg`;
  await renderImage(approved, path.join(__dirname, imageFile));

  const post = {
    pillar,
    headline: approved.headline.trim(),
    subhead: approved.subhead.trim(),
    caption: fullCaption,
    altText: approved.altText.trim(),
    imageFile,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(__dirname, "post.json"), JSON.stringify(post, null, 2));
  console.log(`Wrote post.json and ${imageFile}`);
}

module.exports = { buildSvg, renderImage };

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
