// generate.js  (carousel version)
//
// Headless content generation for swipeable carousel posts:
//   1. Picks the next content pillar (rotates through account.json)
//   2. Asks Claude to draft a carousel: cover hook, N content slides, closing call to action,
//      plus a caption and hashtags
//   3. Runs local sanity checks, then a second Claude call that reviews the draft against
//      your rules. Rejected drafts are retried with the reviewer's feedback.
//   4. Renders each slide as a 1080x1350 JPEG from an SVG template
//   5. Writes post.json for publish.js
//
// Environment: ANTHROPIC_API_KEY (required), DRY_RUN ("true" writes to drafts/ instead of images/)
// Optional in account.json: "slideCount" (total slides including cover and closing, 3-10, default 6)

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const account = require("./account.json");

const DRY_RUN = process.env.DRY_RUN === "true";
const HISTORY_PATH = path.join(__dirname, "history.json");
const TOTAL_SLIDES = Math.min(10, Math.max(3, Number(account.slideCount) || 6));
const CONTENT_COUNT = TOTAL_SLIDES - 2; // cover and closing are the other two

function loadHistory() {
  return fs.existsSync(HISTORY_PATH) ? JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8")) : [];
}

// ---------- Claude ----------

class ParseError extends Error {}

async function callClaude(system, user, maxTokens = 1500) {
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
  if (start === -1 || end === -1) throw new ParseError("No JSON object found in the response");
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (err) {
    throw new ParseError(`Invalid JSON: ${err.message}`);
  }
}

function list(items) {
  return (items || []).map((r) => `- ${r}`).join("\n") || "- (none)";
}

function briefText() {
  return [
    `Handle: ${account.handle}`,
    `Niche: ${account.niche}`,
    `Audience: ${account.audience}`,
    `Voice: ${account.voice}`,
    `Rules:\n${list(account.rules)}`,
    `Never post about:\n${list(account.bannedTopics)}`,
  ].join("\n\n");
}

async function draftPost(pillar, history, feedback) {
  const recent =
    history.slice(-30).map((h) => `- ${h.headline}`).join("\n") || "(none yet)";

  const system =
    `You run an Instagram account with no human editor, so every post must be safe to publish exactly as written.\n\n` +
    briefText();

  const user =
    `Write the next swipeable carousel post (${TOTAL_SLIDES} slides in total).\n` +
    `Content pillar for this post: ${pillar}\n` +
    `Today's date: ${new Date().toISOString().slice(0, 10)}\n\n` +
    `Recent posts (do not repeat or closely paraphrase these):\n${recent}\n` +
    (feedback ? `\nYour previous draft was rejected. Reason: ${feedback}\nFix this in the new draft.\n` : "") +
    `\nStructure:\n` +
    `- cover: a scroll-stopping hook. Use curiosity, a common mistake, or a specific benefit. Avoid generic titles like "3D Printing Tips".\n` +
    `- slides: exactly ${CONTENT_COUNT} content slides. One concrete, actionable idea per slide, in an order that builds. Each has a short title and a one to two sentence body.\n` +
    `- closing: a final slide that invites the reader to save, share or comment. No links, no mention of a shop.\n` +
    `- caption: the first line hooks the reader. Keep it short. End with a question that invites comments.\n\n` +
    `Requirements:\n` +
    `- cover.headline max 8 words, cover.subhead max 16 words\n` +
    `- each slide title max 8 words, each slide body max 30 words\n` +
    `- closing.headline max 8 words, closing.body max 20 words\n` +
    `- all slide text is plain text with no emoji and no hashtags\n` +
    `- caption max ${account.captionMaxWords} words, a few emoji are fine\n` +
    `- hashtags: exactly ${account.hashtagCount}, relevant, no spaces\n\n` +
    `Respond with ONLY valid JSON in this exact shape:\n` +
    `{"cover":{"headline":"","subhead":""},"slides":[{"title":"","body":""}],"closing":{"headline":"","body":""},"caption":"","hashtags":[]}`;

  return parseJson(await callClaude(system, user));
}

const words = (s) => String(s).trim().split(/\s+/).filter(Boolean).length;
const isStr = (v) => typeof v === "string" && v.trim().length > 0;

function validate(p) {
  if (!p || typeof p !== "object") return "Draft was not a JSON object";
  if (!p.cover || !isStr(p.cover.headline) || !isStr(p.cover.subhead)) return "cover needs a headline and subhead";
  if (!Array.isArray(p.slides) || p.slides.length !== CONTENT_COUNT) {
    return `slides must be an array of exactly ${CONTENT_COUNT} items`;
  }
  for (const [i, s] of p.slides.entries()) {
    if (!s || !isStr(s.title) || !isStr(s.body)) return `slide ${i + 1} needs a title and body`;
    if (words(s.title) > 8) return `slide ${i + 1} title is longer than 8 words`;
    if (words(s.body) > 30) return `slide ${i + 1} body is longer than 30 words`;
  }
  if (!p.closing || !isStr(p.closing.headline) || !isStr(p.closing.body)) return "closing needs a headline and body";
  if (!isStr(p.caption)) return "caption is missing";
  if (!Array.isArray(p.hashtags) || p.hashtags.length === 0) return "hashtags must be a non-empty array";
  if (words(p.cover.headline) > 8) return "cover headline is longer than 8 words";
  if (words(p.cover.subhead) > 16) return "cover subhead is longer than 16 words";
  if (words(p.closing.headline) > 8) return "closing headline is longer than 8 words";
  if (words(p.closing.body) > 20) return "closing body is longer than 20 words";
  if (words(p.caption) > account.captionMaxWords + 10) return `caption is longer than ${account.captionMaxWords} words`;
  const slideText = slidesFrom(p).map((s) => s.title + " " + s.body).join(" ");
  if (/\p{Extended_Pictographic}/u.test(slideText)) return "slide text must not contain emoji";
  return null;
}

async function reviewPost(post) {
  const system =
    `You are a strict content reviewer for an Instagram account that publishes with no human approval. ` +
    `Reject anything that could embarrass the account or harm someone.\n\n` +
    briefText();

  const user =
    `Review this draft carousel post:\n${JSON.stringify(post, null, 2)}\n\n` +
    `Approve only if ALL of these are true:\n` +
    `- It follows every rule and avoids every banned topic above.\n` +
    `- It contains no invented statistics, quotes, studies, or news, and no risky factual claims.\n` +
    `- The advice is accurate and safe to follow.\n` +
    `- It matches the stated voice and audience.\n` +
    `- It is not offensive, misleading, or spammy.\n\n` +
    `Respond with ONLY valid JSON: {"approved": true or false, "reason": "one sentence"}`;

  return parseJson(await callClaude(system, user, 300));
}

// Flatten a draft into an ordered list of slides: cover, content slides, closing
function slidesFrom(p) {
  return [
    { kind: "cover", title: p.cover.headline.trim(), body: p.cover.subhead.trim() },
    ...p.slides.map((s) => ({ kind: "content", title: s.title.trim(), body: s.body.trim() })),
    { kind: "closing", title: p.closing.headline.trim(), body: p.closing.body.trim() },
  ];
}

// ---------- Image rendering ----------

const W = 1080;
const H = 1350;
const M = 90;
const TEXT_WIDTH = W - 2 * M - 60; // 930 minus a safety margin

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function wrap(text, maxChars) {
  const ws = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const w of ws) {
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

// Pick the largest font size whose wrapped text fits within maxLines
function fitText(text, sizes, maxWidth, maxLines, factor) {
  for (const size of sizes) {
    const maxChars = Math.floor(maxWidth / (size * factor));
    const lines = wrap(text, maxChars);
    if (lines.length <= maxLines && lines.every((l) => l.length <= maxChars)) return { size, lines };
  }
  const size = sizes[sizes.length - 1];
  return { size, lines: wrap(text, Math.floor(maxWidth / (size * factor))) };
}

function textBlock(lines, x, y, size, lineHeight, attrs) {
  return lines
    .map((l, i) => `<text x="${x}" y="${y + i * lineHeight}" font-size="${size}" ${attrs}>${esc(l)}</text>`)
    .join("\n    ");
}

function buildSlideSvg(slide, index, total) {
  const { background, text, accent, fontFamily } = account.design;
  const glows = [
    [W - 60, H - 120],
    [90, H - 260],
    [W - 90, 260],
    [140, 300],
  ];
  const [gx, gy] = glows[index % glows.length];

  let body = "";
  let endY = 0;

  if (slide.kind === "cover") {
    const head = fitText(slide.title, [120, 104, 92, 80, 68], TEXT_WIDTH, 5, 0.66);
    const lh = Math.round(head.size * 1.15);
    body += textBlock(head.lines, M, 360, head.size, lh, `font-weight="700" fill="${text}"`);
    endY = 360 + (head.lines.length - 1) * lh;
    const sub = fitText(slide.body, [48, 44, 40], TEXT_WIDTH, 4, 0.58);
    body += textBlock(sub.lines, M, endY + 90, sub.size, Math.round(sub.size * 1.35), `fill="${text}" fill-opacity="0.85"`);
    // Swipe hint
    body += `
    <text x="${W - M - 90}" y="${H - 112}" font-size="38" font-weight="700" fill="${accent}" text-anchor="end">Swipe</text>
    <path d="M${W - M - 70} ${H - 124} H${W - M} M${W - M - 24} ${H - 148} L${W - M} ${H - 124} L${W - M - 24} ${H - 100}" stroke="${accent}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
  } else if (slide.kind === "content") {
    body += `<rect x="60" y="130" width="${W - 120}" height="${H - 330}" rx="40" fill="${text}" fill-opacity="0.05"/>`;
    body += `<circle cx="${M + 55}" cy="250" r="55" fill="${accent}"/>
    <text x="${M + 55}" y="272" font-size="64" font-weight="700" fill="${background}" text-anchor="middle">${index}</text>`;
    const title = fitText(slide.title, [78, 70, 62, 54], TEXT_WIDTH, 3, 0.66);
    const tlh = Math.round(title.size * 1.15);
    body += textBlock(title.lines, M, 450, title.size, tlh, `font-weight="700" fill="${text}"`);
    endY = 450 + (title.lines.length - 1) * tlh;
    const txt = fitText(slide.body, [50, 46, 42, 38], TEXT_WIDTH, 8, 0.58);
    body += textBlock(txt.lines, M, endY + 90, txt.size, Math.round(txt.size * 1.4), `fill="${text}" fill-opacity="0.88"`);
    body += `
    <text x="${M}" y="${H - 112}" font-size="34" fill="${text}" fill-opacity="0.7">${esc(account.handle)}</text>
    <text x="${W - M}" y="${H - 112}" font-size="34" fill="${text}" fill-opacity="0.7" text-anchor="end">${index} / ${total - 2}</text>`;
  } else {
    const head = fitText(slide.title, [104, 92, 80, 68], TEXT_WIDTH, 4, 0.66);
    const lh = Math.round(head.size * 1.15);
    body += textBlock(head.lines, M, 380, head.size, lh, `font-weight="700" fill="${text}"`);
    endY = 380 + (head.lines.length - 1) * lh;
    const sub = fitText(slide.body, [48, 44, 40], TEXT_WIDTH, 4, 0.58);
    const slh = Math.round(sub.size * 1.35);
    body += textBlock(sub.lines, M, endY + 90, sub.size, slh, `fill="${text}" fill-opacity="0.85"`);
    const btnY = Math.min(endY + 90 + (sub.lines.length - 1) * slh + 90, H - 330);
    body += `
    <rect x="${M}" y="${btnY}" width="${W - 2 * M}" height="120" rx="60" fill="${accent}"/>
    <text x="${W / 2}" y="${btnY + 77}" font-size="48" font-weight="700" fill="${background}" text-anchor="middle">Follow ${esc(account.handle)}</text>`;
  }

  // Progress bar along the bottom of every slide
  const trackW = W - 2 * M;
  const progress = `
    <rect x="${M}" y="${H - 64}" width="${trackW}" height="8" rx="4" fill="${text}" fill-opacity="0.2"/>
    <rect x="${M}" y="${H - 64}" width="${Math.round((trackW * (index + 1)) / total)}" height="8" rx="4" fill="${accent}"/>`;

  const accentBar =
    slide.kind === "content"
      ? ""
      : `<rect x="${M}" y="150" width="140" height="14" rx="7" fill="${accent}"/>`;

  const coverHandle =
    slide.kind === "cover"
      ? `<text x="${M}" y="${H - 112}" font-size="40" font-weight="700" fill="${accent}">${esc(account.handle)}</text>`
      : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${background}"/>
  <circle cx="${gx}" cy="${gy}" r="420" fill="${accent}" fill-opacity="0.08"/>
  ${accentBar}
  <g font-family="${fontFamily}">
    ${body}
    ${coverHandle}
  </g>
  ${progress}
</svg>`;
}

async function renderSlide(slide, index, total, outPath) {
  await sharp(Buffer.from(buildSlideSvg(slide, index, total))).jpeg({ quality: 92 }).toFile(outPath);
}

// ---------- Main ----------

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");

  const history = loadHistory();
  const pillars = account.contentPillars;
  const pillar = pillars[history.length % pillars.length];
  console.log(`Pillar: ${pillar} | Slides: ${TOTAL_SLIDES}`);

  let approved = null;
  let feedback = "";

  for (let attempt = 1; attempt <= account.maxAttempts; attempt++) {
    console.log(`Draft attempt ${attempt}/${account.maxAttempts}...`);
    let candidate;
    try {
      candidate = await draftPost(pillar, history, feedback);
    } catch (err) {
      if (!(err instanceof ParseError)) throw err; // real problems (bad key, missing config) should fail loudly
      feedback = `Your response could not be parsed (${err.message}). Respond with only the JSON object.`;
      console.log(`  Unparseable draft: ${err.message}`);
      continue;
    }

    const problem = validate(candidate);
    if (problem) {
      feedback = problem;
      console.log(`  Failed local checks: ${problem}`);
      continue;
    }

    let review;
    try {
      review = await reviewPost(candidate);
    } catch (err) {
      if (!(err instanceof ParseError)) throw err;
      feedback = "The reviewer could not evaluate the draft. Keep it simple and within the rules.";
      console.log(`  Unparseable review: ${err.message}`);
      continue;
    }
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

  const slides = slidesFrom(approved);
  const dir = DRY_RUN ? "drafts" : "images";
  fs.mkdirSync(path.join(__dirname, dir), { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");

  const imageFiles = [];
  for (const [i, slide] of slides.entries()) {
    const file = `${dir}/post-${stamp}-s${String(i + 1).padStart(2, "0")}.jpg`;
    await renderSlide(slide, i, slides.length, path.join(__dirname, file));
    imageFiles.push(file);
  }

  const post = {
    pillar,
    headline: slides[0].title,
    subhead: slides[0].body,
    caption: fullCaption,
    imageFiles,
    altTexts: slides.map((s) => `${s.title}. ${s.body}`),
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(__dirname, "post.json"), JSON.stringify(post, null, 2));
  console.log(`Wrote post.json and ${imageFiles.length} slide images in ${dir}/`);
}

module.exports = { buildSlideSvg, renderSlide, slidesFrom, validate, main };

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
