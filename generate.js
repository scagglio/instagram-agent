// generate.js  (infographic carousel version)
//
// Headless content generation for snappy, swipeable infographic carousels:
//   1. Picks the next content pillar (rotates through account.json)
//   2. Asks Claude for a carousel: a hook cover, numbered content slides (each with an icon,
//      an optional big stat callout and a tip), a "cheat sheet" summary slide, and a closing slide
//   3. Runs local sanity checks, then a second Claude call reviews the draft against your rules.
//      Rejected drafts are retried with the reviewer's feedback.
//   4. Renders every slide as a 1080x1350 JPEG from an SVG template (no design tool needed)
//   5. Writes post.json for publish.js
//
// Environment: ANTHROPIC_API_KEY (required), DRY_RUN ("true" writes to drafts/ instead of images/)
// Reels: set POST_FORMAT env (or "postFormat" in account.json) to carousel | reel | both.
// A reel is the same slides animated piece by piece (needs ffmpeg). Optional "reelPace" (default 0.62,
// lower = faster) and an optional reel-music.mp3 in the repo root.
// Optional in account.json:
//   "slideCount"   total slides including cover, cheat sheet and closing (5-10, default 7)
//   "hookStyle"    extra guidance for cover hooks
//   "pillarStyles" per-pillar writing guidance, keyed by the exact pillar name

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const os = require("os");
const { spawnSync } = require("child_process");

const account = require("./account.json");

const DRY_RUN = process.env.DRY_RUN === "true";
const HISTORY_PATH = path.join(__dirname, "history.json");
const TOTAL_SLIDES = Math.min(10, Math.max(5, Number(account.slideCount) || 7));
const CONTENT_COUNT = TOTAL_SLIDES - 3;
const FORMATS = ["carousel", "reel", "both"];
const POST_FORMAT = FORMATS.includes(process.env.POST_FORMAT)
  ? process.env.POST_FORMAT
  : FORMATS.includes(account.postFormat)
  ? account.postFormat
  : "carousel";
const WANT_CAROUSEL = POST_FORMAT !== "reel";
const WANT_REEL = POST_FORMAT !== "carousel"; // cover, cheat sheet and closing are the other three

function loadHistory() {
  return fs.existsSync(HISTORY_PATH) ? JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8")) : [];
}

// ---------- Icons ----------
// Simple line icons drawn in a 100x100 box. Claude picks a name per slide.

const ICONS = {
  layers: `<path d="M50 14 L88 34 L50 54 L12 34 Z"/><path d="M12 52 L50 72 L88 52"/><path d="M12 68 L50 88 L88 68"/>`,
  speed: `<path d="M16 72 A38 38 0 1 1 84 72"/><line x1="50" y1="62" x2="72" y2="34"/><circle cx="50" cy="62" r="6" fill="currentColor"/>`,
  thermometer: `<rect x="40" y="10" width="20" height="52" rx="10"/><circle cx="50" cy="74" r="15"/><line x1="50" y1="32" x2="50" y2="70"/>`,
  bed: `<path d="M8 66 L50 50 L92 66 L50 84 Z"/><path d="M32 40 q-7 -9 0 -18"/><path d="M50 34 q-7 -9 0 -18"/><path d="M68 40 q-7 -9 0 -18"/>`,
  fan: `<circle cx="50" cy="50" r="7"/><ellipse cx="50" cy="26" rx="10" ry="17"/><ellipse cx="50" cy="26" rx="10" ry="17" transform="rotate(90 50 50)"/><ellipse cx="50" cy="26" rx="10" ry="17" transform="rotate(180 50 50)"/><ellipse cx="50" cy="26" rx="10" ry="17" transform="rotate(270 50 50)"/>`,
  nozzle: `<rect x="26" y="10" width="48" height="30" rx="6"/><path d="M34 40 L45 66 H55 L66 40"/><line x1="50" y1="66" x2="50" y2="76"/><circle cx="50" cy="88" r="5" fill="currentColor"/>`,
  clock: `<circle cx="50" cy="50" r="38"/><polyline points="50,26 50,50 68,60"/>`,
  check: `<circle cx="50" cy="50" r="38"/><polyline points="30,52 44,66 71,34"/>`,
  warning: `<path d="M50 12 L91 84 H9 Z"/><line x1="50" y1="40" x2="50" y2="62"/><circle cx="50" cy="73" r="3" fill="currentColor"/>`,
  bulb: `<path d="M50 10 C72 10 82 34 68 52 C63 58 62 62 62 68 H38 C38 62 37 58 32 52 C18 34 28 10 50 10 Z"/><line x1="40" y1="80" x2="60" y2="80"/><line x1="44" y1="91" x2="56" y2="91"/>`,
  star: `<polygon points="50,9 61,38 92,38 67,57 77,89 50,70 23,89 33,57 8,38 39,38"/>`,
  cube: `<path d="M50 10 L88 31 V69 L50 90 L12 69 V31 Z"/><path d="M12 31 L50 52 L88 31"/><line x1="50" y1="52" x2="50" y2="90"/>`,
  spool: `<ellipse cx="50" cy="26" rx="32" ry="13"/><line x1="18" y1="26" x2="18" y2="74"/><line x1="82" y1="26" x2="82" y2="74"/><path d="M18 74 A32 13 0 0 0 82 74"/><ellipse cx="50" cy="26" rx="9" ry="4"/>`,
  brush: `<line x1="76" y1="12" x2="42" y2="54"/><path d="M42 54 C22 52 16 68 18 84 C34 86 50 80 50 62 Z"/>`,
  gift: `<rect x="14" y="40" width="72" height="46"/><rect x="8" y="26" width="84" height="16"/><line x1="50" y1="26" x2="50" y2="86"/><path d="M50 26 C32 4 18 22 50 26"/><path d="M50 26 C68 4 82 22 50 26"/>`,
  rocket: `<path d="M50 8 C72 24 74 54 62 74 H38 C26 54 28 24 50 8 Z"/><circle cx="50" cy="40" r="8"/><path d="M38 62 L22 82 L38 78"/><path d="M62 62 L78 82 L62 78"/>`,
  target: `<circle cx="50" cy="50" r="38"/><circle cx="50" cy="50" r="24"/><circle cx="50" cy="50" r="8" fill="currentColor"/>`,
  bolt: `<polygon points="58,6 22,56 46,56 40,94 78,42 54,42"/>`,
};
const ICON_NAMES = Object.keys(ICONS);

// Draw an icon at (x, y) with the given pixel size and color
function icon(name, x, y, size, color, opts = {}) {
  const body = ICONS[name] || ICONS.star;
  const sw = opts.strokeWidth || 6;
  const op = opts.opacity == null ? 1 : opts.opacity;
  return `<g transform="translate(${x} ${y}) scale(${size / 100})" color="${color}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" opacity="${op}">${body}</g>`;
}

// ---------- Claude ----------

class ParseError extends Error {}

async function callClaude(system, user, maxTokens = 3000) {
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
  const recent = history.slice(-30).map((h) => `- ${h.headline}`).join("\n") || "(none yet)";

  const system =
    `You run an Instagram account with no human editor, so every post must be safe to publish exactly as written.\n\n` +
    briefText();

  const style = (account.pillarStyles || {})[pillar];
  const slideGuidance = style || "One concrete, actionable idea per slide, in an order that builds.";

  const user =
    `Write the next swipeable infographic carousel (${TOTAL_SLIDES} slides in total: a cover, ${CONTENT_COUNT} content slides, a cheat sheet, and a closing slide).\n` +
    `Content pillar for this post: ${pillar}\n` +
    `Today's date: ${new Date().toISOString().slice(0, 10)}\n\n` +
    `Recent posts (do not repeat or closely paraphrase these):\n${recent}\n` +
    (feedback ? `\nYour previous draft was rejected. Reason: ${feedback}\nFix this in the new draft.\n` : "") +
    `\nThe goal is a post people cannot scroll past and want to save. Make it snappy: short, punchy, concrete, with real numbers where they are genuinely useful.\n\n` +
    `Structure:\n` +
    `- cover.headline: a gripping hook that makes the reader feel they MUST swipe. Use a counterintuitive claim, a curiosity gap that promises a specific payoff, vivid stakes, or a pointed question. Be specific. Never use label-style titles like "Top 5 tips". The hook must be honest: the slides have to deliver on it, with no fake urgency or fear-mongering.${account.hookStyle ? " Extra hook guidance: " + account.hookStyle : ""}\n` +
    `- hookOptions: first write 5 candidate cover headlines, then make cover.headline the strongest one.\n` +
    `- cover.highlight: one or two words copied exactly from the headline that carry the most punch.\n` +
    `- cover.kicker: a short banner line above the headline in the style of "SMALL SETTINGS. BIG DIFFERENCE." (max 6 words, two short sentences work well).\n` +
    `- cover.icon: one icon name for the topic.\n` +
    `- slides: exactly ${CONTENT_COUNT} content slides. ${slideGuidance} Each has:\n` +
    `    title (max 6 words, will be shown in capitals),\n` +
    `    body (max 28 words, plain and concrete),\n` +
    `    stat (optional, max 12 characters, a big number callout such as "0.12 mm" or "50-60 mm/s". Include one whenever the idea has a useful number, otherwise leave it as an empty string),\n` +
    `    statLabel (max 5 words describing the stat, empty if no stat),\n` +
    `    icon (one icon name),\n` +
    `    tip (max 16 words, a practical pro tip for this slide).\n` +
    `- cheat: a cheat sheet that sums the post up. cheat.title (max 5 words), cheat.items: between 4 and 6 items, each with label (max 4 words) and value (max 14 characters, such as "0.12 mm" or "Tree" or "Clean first").\n` +
    `- closing: headline (max 8 words), body (max 20 words) inviting the reader to save, share or comment, and tagline (max 8 words, an upbeat sign-off such as "MASTER THE BASICS. PRINT LIKE A PRO."). No links and no mention of a shop.\n` +
    `- caption: the first line hooks the reader. Keep it short. End with a question that invites comments.\n\n` +
    `Numbers: use only widely accepted typical starting-point values (layer heights, speeds, temperature ranges, ratios), given as ranges where possible. Never invent statistics, test results or measurements, and never state a number as a guarantee. Where material-specific temperatures matter, say to follow the filament maker's range instead of giving one.\n\n` +
    `Allowed icon names: ${ICON_NAMES.join(", ")}\n\n` +
    `Requirements:\n` +
    `- cover.headline max 8 words, cover.subhead max 16 words\n` +
    `- all slide text is plain text with no emoji and no hashtags\n` +
    `- caption max ${account.captionMaxWords} words, a few emoji are fine\n` +
    `- hashtags: exactly ${account.hashtagCount}, relevant, no spaces\n\n` +
    `Respond with ONLY valid JSON in this exact shape:\n` +
    `{"hookOptions":["","","","",""],"cover":{"headline":"","highlight":"","kicker":"","subhead":"","icon":""},` +
    `"slides":[{"title":"","body":"","stat":"","statLabel":"","icon":"","tip":""}],` +
    `"cheat":{"title":"","items":[{"label":"","value":""}]},` +
    `"closing":{"headline":"","body":"","tagline":""},"caption":"","hashtags":[]}`;

  return parseJson(await callClaude(system, user));
}

const words = (s) => String(s || "").trim().split(/\s+/).filter(Boolean).length;
const isStr = (v) => typeof v === "string" && v.trim().length > 0;
const optStr = (v) => (typeof v === "string" ? v.trim() : "");

function validate(p) {
  if (!p || typeof p !== "object") return "Draft was not a JSON object";

  if (!p.cover || !isStr(p.cover.headline) || !isStr(p.cover.subhead)) return "cover needs a headline and subhead";
  if (words(p.cover.headline) > 8) return "cover headline is longer than 8 words";
  if (words(p.cover.subhead) > 16) return "cover subhead is longer than 16 words";
  if (words(p.cover.kicker) > 7) return "cover kicker is longer than 6 words";

  if (!Array.isArray(p.slides) || p.slides.length !== CONTENT_COUNT) {
    return `slides must be an array of exactly ${CONTENT_COUNT} items`;
  }
  for (const [i, s] of p.slides.entries()) {
    const n = i + 1;
    if (!s || !isStr(s.title) || !isStr(s.body)) return `slide ${n} needs a title and body`;
    if (words(s.title) > 7) return `slide ${n} title is longer than 6 words`;
    if (words(s.body) > 30) return `slide ${n} body is longer than 28 words`;
    if (optStr(s.stat).length > 14) return `slide ${n} stat is longer than 12 characters`;
    if (words(s.statLabel) > 6) return `slide ${n} statLabel is longer than 5 words`;
    if (words(s.tip) > 18) return `slide ${n} tip is longer than 16 words`;
  }

  if (!p.cheat || !isStr(p.cheat.title) || words(p.cheat.title) > 6) return "cheat needs a title of at most 5 words";
  if (!Array.isArray(p.cheat.items) || p.cheat.items.length < 4 || p.cheat.items.length > 6) {
    return "cheat.items must have between 4 and 6 items";
  }
  for (const [i, it] of p.cheat.items.entries()) {
    if (!it || !isStr(it.label) || !isStr(it.value)) return `cheat item ${i + 1} needs a label and a value`;
    if (words(it.label) > 5) return `cheat item ${i + 1} label is longer than 4 words`;
    if (it.value.trim().length > 16) return `cheat item ${i + 1} value is longer than 14 characters`;
  }

  if (!p.closing || !isStr(p.closing.headline) || !isStr(p.closing.body)) return "closing needs a headline and body";
  if (words(p.closing.headline) > 8) return "closing headline is longer than 8 words";
  if (words(p.closing.body) > 22) return "closing body is longer than 20 words";
  if (words(p.closing.tagline) > 9) return "closing tagline is longer than 8 words";

  if (!isStr(p.caption)) return "caption is missing";
  if (words(p.caption) > account.captionMaxWords + 10) return `caption is longer than ${account.captionMaxWords} words`;
  if (!Array.isArray(p.hashtags) || p.hashtags.length === 0) return "hashtags must be a non-empty array";

  const allText = [
    p.cover.headline, p.cover.subhead, p.cover.kicker,
    ...p.slides.flatMap((s) => [s.title, s.body, s.stat, s.statLabel, s.tip]),
    p.cheat.title, ...p.cheat.items.flatMap((it) => [it.label, it.value]),
    p.closing.headline, p.closing.body, p.closing.tagline,
  ].map((t) => String(t || "")).join(" ");
  if (/\p{Extended_Pictographic}/u.test(allText)) return "slide text must not contain emoji";
  if (/[–—]/.test(allText + " " + p.caption) && (account.rules || []).some((r) => /em dash/i.test(r))) {
    return "text contains an em dash or en dash; use commas or periods instead";
  }
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
    `- Every number is a widely accepted typical starting-point value or range for 3D printing (not a made-up measurement), and is not presented as a guarantee.\n` +
    `- The advice is accurate and safe to follow, and the cheat sheet matches what the slides say.\n` +
    `- Any prediction or forward-looking statement is hedged and never presented as certain.\n` +
    `- The cover hook is honest: the slides deliver what it promises, with no fake urgency or exaggeration.\n` +
    `- It matches the stated voice and audience, and is not offensive, misleading, or spammy.\n\n` +
    `Respond with ONLY valid JSON: {"approved": true or false, "reason": "one sentence"}`;

  return parseJson(await callClaude(system, user, 300));
}

// Flatten a draft into an ordered list of slides
function slidesFrom(p) {
  const pickIcon = (name, fallback) => (ICONS[name] ? name : fallback);
  const fallbackIcons = ["layers", "target", "bolt", "check", "star", "cube"];
  return [
    {
      kind: "cover",
      title: p.cover.headline.trim(),
      body: p.cover.subhead.trim(),
      highlight: optStr(p.cover.highlight),
      kicker: optStr(p.cover.kicker),
      icon: pickIcon(p.cover.icon, "rocket"),
    },
    ...p.slides.map((s, i) => ({
      kind: "content",
      title: s.title.trim(),
      body: s.body.trim(),
      stat: optStr(s.stat),
      statLabel: optStr(s.statLabel),
      tip: optStr(s.tip),
      icon: pickIcon(s.icon, fallbackIcons[i % fallbackIcons.length]),
    })),
    {
      kind: "cheat",
      title: p.cheat.title.trim(),
      items: p.cheat.items.map((it) => ({ label: it.label.trim(), value: it.value.trim() })),
    },
    {
      kind: "closing",
      title: p.closing.headline.trim(),
      body: p.closing.body.trim(),
      tagline: optStr(p.closing.tagline),
    },
  ];
}

function altTextFor(slide) {
  if (slide.kind === "cheat") {
    return `${slide.title}. ` + slide.items.map((it) => `${it.label}: ${it.value}`).join(". ") + ".";
  }
  const parts = [slide.title, slide.stat && `${slide.stat} ${slide.statLabel || ""}`.trim(), slide.body, slide.tip && `Tip: ${slide.tip}`];
  return parts.filter(Boolean).join(". ");
}

// ---------- Image rendering ----------

const W = 1080;
const H = 1350;
const M = 90;
const UP = 0.78; // approximate character width / font size for bold capitals
const LO = 0.58; // for regular lowercase text

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

// Largest font size whose wrapped text fits within maxLines
function fitText(text, sizes, maxWidth, maxLines, factor) {
  for (const size of sizes) {
    const maxChars = Math.floor(maxWidth / (size * factor));
    const lines = wrap(text, maxChars);
    if (lines.length <= maxLines && lines.every((l) => l.length <= maxChars)) return { size, lines };
  }
  const size = sizes[sizes.length - 1];
  return { size, lines: wrap(text, Math.floor(maxWidth / (size * factor))) };
}

// Largest single-line size that fits
function fitOneLine(text, sizes, maxWidth, factor) {
  for (const size of sizes) if (text.length * size * factor <= maxWidth) return size;
  return sizes[sizes.length - 1];
}

function textBlock(lines, x, y, size, lineHeight, attrs, anchor) {
  const a = anchor ? ` text-anchor="${anchor}"` : "";
  return lines
    .map((l, i) => `<text x="${x}" y="${y + i * lineHeight}" font-size="${size}"${a} ${attrs}>${esc(l)}</text>`)
    .join("\n    ");
}

// Headline lines with words listed in `highlight` drawn in the accent color
function headlineBlock(lines, x, y, size, lineHeight, baseFill, accent, highlight) {
  const clean = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const hl = new Set(String(highlight || "").split(/\s+/).map(clean).filter(Boolean));
  return lines
    .map((line, i) => {
      const spans = line
        .split(" ")
        .map((w) => (hl.has(clean(w)) ? `<tspan fill="${accent}">${esc(w)}</tspan>` : esc(w)))
        .join(" ");
      return `<text x="${x}" y="${y + i * lineHeight}" font-size="${size}" font-weight="700" fill="${baseFill}">${spans}</text>`;
    })
    .join("\n    ");
}
// A "stage" controls how much of a slide is visible. The carousel always renders the final stage
// (ALL). Reels render each slide several times with more of it revealed each time, so the
// finished video builds each slide up piece by piece.
const ALL = 99;

function coverSvg(slide, d, st, reel) {
  const { text, accent } = d;
  let out = "";

  // Big faint hero icon behind the text
  out += icon(slide.icon, 520, 690, 560, accent, { strokeWidth: 5, opacity: 0.13 });

  // Kicker banner
  let y0;
  if (slide.kicker) {
    const kick = slide.kicker.toUpperCase();
    const size = fitOneLine(kick, [40, 36, 32, 28, 24], 820, UP);
    out += `<rect x="${M}" y="100" width="${W - 2 * M}" height="92" rx="20" fill="${accent}" fill-opacity="0.1" stroke="${accent}" stroke-opacity="0.7" stroke-width="3"/>`;
    out += `<text x="${W / 2}" y="${100 + 46 + size * 0.35}" font-size="${size}" font-weight="700" fill="${text}" text-anchor="middle" letter-spacing="1">${esc(kick)}</text>`;
    y0 = 300;
  } else {
    out += `<rect x="${M}" y="150" width="140" height="14" rx="7" fill="${accent}"/>`;
    y0 = 330;
  }

  const head = fitText(slide.title.toUpperCase(), [118, 106, 94, 82, 70], W - 2 * M, 5, UP);
  const lh = Math.round(head.size * 1.12);
  const endY = y0 + head.size * 0.8 + (head.lines.length - 1) * lh;
  if (st >= 2) out += headlineBlock(head.lines, M, y0 + head.size * 0.8, head.size, lh, text, accent, slide.highlight);

  if (st >= 3) {
    const sub = fitText(slide.body, [48, 44, 40], W - 2 * M, 4, LO);
    out += textBlock(sub.lines, M, endY + 105, sub.size, Math.round(sub.size * 1.35), `fill="${text}" fill-opacity="0.88"`);
  }

  // Handle, plus a swipe cue on carousels only
  out += `<text x="${M}" y="${H - 112}" font-size="40" font-weight="700" fill="${accent}">${esc(account.handle)}</text>`;
  if (!reel) {
    out += `<text x="${W - M - 90}" y="${H - 112}" font-size="38" font-weight="700" fill="${accent}" text-anchor="end">SWIPE</text>
    <path d="M${W - M - 70} ${H - 124} H${W - M} M${W - M - 24} ${H - 148} L${W - M} ${H - 124} L${W - M - 24} ${H - 100}" stroke="${accent}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
  }
  return out;
}

function contentSvg(slide, n, d, st) {
  const { background, text, accent } = d;
  let out = "";

  // Outer panel
  out += `<rect x="40" y="40" width="${W - 80}" height="1190" rx="40" fill="${text}" fill-opacity="0.04" stroke="${accent}" stroke-opacity="0.4" stroke-width="3"/>`;

  // Number badge
  out += `<rect x="${M}" y="92" width="96" height="96" rx="20" fill="${accent}"/>
    <text x="${M + 48}" y="${92 + 48 + 25}" font-size="70" font-weight="700" fill="${background}" text-anchor="middle">${n}</text>`;

  // Title (uppercase, up to 2 lines), vertically centred on the badge
  const title = fitText(slide.title.toUpperCase(), [62, 56, 50, 44, 38], 600, 2, UP);
  const tlh = Math.round(title.size * 1.12);
  const ty = 140 - ((title.lines.length - 1) * tlh) / 2 + title.size * 0.35;
  out += textBlock(title.lines, M + 126, Math.round(ty), title.size, tlh, `font-weight="700" fill="${text}"`);

  // Small icon top right
  out += `<circle cx="${W - 150}" cy="140" r="56" fill="none" stroke="${accent}" stroke-opacity="0.65" stroke-width="3"/>`;
  out += icon(slide.icon, W - 150 - 30, 110, 60, accent, { strokeWidth: 6 });

  out += `<line x1="${M}" y1="226" x2="${W - M}" y2="226" stroke="${text}" stroke-opacity="0.15" stroke-width="2"/>`;

  // Visual panel: big stat callout, or a large icon when there is no stat
  if (st >= 2) {
    out += `<rect x="${M}" y="256" width="${W - 2 * M}" height="330" rx="30" fill="${accent}" fill-opacity="0.07" stroke="${accent}" stroke-opacity="0.25" stroke-width="2"/>`;
    if (slide.stat) {
      const size = fitOneLine(slide.stat, [170, 148, 128, 108, 90, 74], W - 2 * M - 80, 0.68);
      out += `<text x="${W / 2}" y="${256 + 165 + size * 0.33}" font-size="${size}" font-weight="700" fill="${accent}" text-anchor="middle">${esc(slide.stat)}</text>`;
      if (slide.statLabel) {
        const ls = fitOneLine(slide.statLabel.toUpperCase(), [38, 34, 30, 26], W - 2 * M - 80, UP);
        out += `<text x="${W / 2}" y="${256 + 275}" font-size="${ls}" font-weight="700" fill="${text}" fill-opacity="0.75" text-anchor="middle" letter-spacing="2">${esc(slide.statLabel.toUpperCase())}</text>`;
      }
    } else {
      out += icon(slide.icon, W / 2 - 120, 256 + 45, 240, accent, { strokeWidth: 5 });
    }
  }

  // Body
  if (st >= 3) {
    const body = fitText(slide.body, [58, 54, 50, 46, 42, 38], W - 2 * M, 5, LO);
    out += textBlock(body.lines, M, 676, body.size, Math.round(body.size * 1.36), `fill="${text}" fill-opacity="0.93"`);
  }

  // Tip box
  if (slide.tip && st >= 4) {
    out += `<rect x="${M}" y="975" width="${W - 2 * M}" height="215" rx="28" fill="${accent}" fill-opacity="0.1" stroke="${accent}" stroke-opacity="0.55" stroke-width="3"/>`;
    out += icon("bulb", M + 30, 1030, 76, accent, { strokeWidth: 6 });
    out += `<text x="${M + 140}" y="1030" font-size="28" font-weight="700" fill="${accent}" letter-spacing="3">PRO TIP</text>`;
    const tip = fitText(slide.tip, [40, 36, 32, 29], W - 2 * M - 170, 2, LO);
    out += textBlock(tip.lines, M + 140, 1084, tip.size, Math.round(tip.size * 1.3), `fill="${text}" fill-opacity="0.95"`);
  }
  return out;
}

function cheatSvg(slide, d, st) {
  const { background, text, accent } = d;
  let out = "";

  out += `<rect x="40" y="40" width="${W - 80}" height="1190" rx="40" fill="${text}" fill-opacity="0.04" stroke="${accent}" stroke-opacity="0.4" stroke-width="3"/>`;
  out += `<rect x="${M}" y="100" width="140" height="14" rx="7" fill="${accent}"/>`;

  const title = fitText(slide.title.toUpperCase(), [72, 66, 60, 54, 46], W - 2 * M, 2, UP);
  const tlh = Math.round(title.size * 1.12);
  out += textBlock(title.lines, M, 175 + title.size * 0.6, title.size, tlh, `font-weight="700" fill="${text}"`);

  // Grid of up to 3 rows x 2 columns
  const items = slide.items;
  const rows = Math.ceil(items.length / 2);
  const gridTop = 370;
  const gridH = 800;
  const gap = 28;
  const cellH = Math.min(280, Math.floor((gridH - (rows - 1) * gap) / rows));
  const usedH = rows * cellH + (rows - 1) * gap;
  const top = gridTop + Math.floor((gridH - usedH) / 2);
  const colW = 440;
  const xs = [M - 10, M - 10 + colW + 40];

  items.forEach((it, i) => {
    if (st < i + 2) return; // cells appear one by one in reels
    const r = Math.floor(i / 2);
    const c = i % 2;
    const lastAlone = i === items.length - 1 && items.length % 2 === 1;
    const x = lastAlone ? xs[0] : xs[c];
    const w = lastAlone ? 2 * colW + 40 : colW;
    const y = top + r * (cellH + gap);

    out += `<rect x="${x}" y="${y}" width="${w}" height="${cellH}" rx="28" fill="${text}" fill-opacity="0.05" stroke="${accent}" stroke-opacity="0.4" stroke-width="3"/>`;
    out += `<rect x="${x + 24}" y="${y + 24}" width="64" height="64" rx="14" fill="${accent}"/>
    <text x="${x + 56}" y="${y + 24 + 32 + 17}" font-size="46" font-weight="700" fill="${background}" text-anchor="middle">${i + 1}</text>`;

    const label = fitText(it.label.toUpperCase(), [32, 29, 26, 23], w - 24 - 64 - 24 - 24, 2, UP);
    const llh = Math.round(label.size * 1.15);
    const ly = y + 56 - ((label.lines.length - 1) * llh) / 2 + label.size * 0.35;
    out += textBlock(label.lines, x + 108, Math.round(ly), label.size, llh, `font-weight="700" fill="${text}" fill-opacity="0.9"`);

    const vsize = fitOneLine(it.value, [84, 74, 64, 54, 46, 38], w - 56, 0.68);
    out += `<text x="${x + w / 2}" y="${y + cellH - 62 + vsize * 0.15}" font-size="${vsize}" font-weight="700" fill="${accent}" text-anchor="middle">${esc(it.value)}</text>`;
  });

  if (st >= items.length + 2) {
    out += `<text x="${W / 2}" y="1200" font-size="28" fill="${text}" fill-opacity="0.65" text-anchor="middle">Starting points. Adjust for your printer and material.</text>`;
  }
  return out;
}

function closingSvg(slide, d, st) {
  const { background, text, accent } = d;
  let out = "";
  out += `<rect x="${M}" y="150" width="140" height="14" rx="7" fill="${accent}"/>`;

  const head = fitText(slide.title.toUpperCase(), [100, 90, 80, 70, 60], W - 2 * M, 4, UP);
  const lh = Math.round(head.size * 1.12);
  out += textBlock(head.lines, M, 300 + head.size * 0.6, head.size, lh, `font-weight="700" fill="${text}"`);
  const endY = 300 + head.size * 0.6 + (head.lines.length - 1) * lh;

  const sub = fitText(slide.body, [48, 44, 40], W - 2 * M, 4, LO);
  const slh = Math.round(sub.size * 1.35);
  if (st >= 2) out += textBlock(sub.lines, M, endY + 90, sub.size, slh, `fill="${text}" fill-opacity="0.88"`);

  if (st >= 3) {
    const btnY = Math.min(endY + 90 + (sub.lines.length - 1) * slh + 80, 930);
    out += `<rect x="${M}" y="${btnY}" width="${W - 2 * M}" height="120" rx="60" fill="${accent}"/>
    <text x="${W / 2}" y="${btnY + 77}" font-size="48" font-weight="700" fill="${background}" text-anchor="middle">FOLLOW ${esc(account.handle.toUpperCase())}</text>`;

    if (slide.tagline) {
      out += `<rect x="${M}" y="1100" width="${W - 2 * M}" height="110" rx="24" fill="${accent}" fill-opacity="0.1" stroke="${accent}" stroke-opacity="0.6" stroke-width="3"/>`;
      out += icon("star", M + 28, 1128, 54, accent, { strokeWidth: 6 });
      const tagLines = slide.tagline.toUpperCase().split(/(?<=[.!?])\s+/).filter(Boolean).slice(0, 2);
      const longest = Math.max(...tagLines.map((l) => l.length));
      const ts = fitOneLine("x".repeat(longest), [42, 38, 34, 30, 26], W - 2 * M - 150, UP);
      const tlh = Math.round(ts * 1.2);
      const startY = 1155 - ((tagLines.length - 1) * tlh) / 2 + ts * 0.35;
      out += textBlock(tagLines, M + 105, Math.round(startY), ts, tlh, `font-weight="700" fill="${text}"`);
    }
  }
  return out;
}

// The slide's drawing (everything inside the outer <svg>), in a 1080x1350 coordinate space
function slideInner(slide, index, total, opts = {}) {
  const st = opts.stage == null ? ALL : opts.stage;
  const reel = !!opts.reel;
  const { background, text, accent, fontFamily } = account.design;
  const glows = [
    [W - 60, H - 120],
    [90, H - 260],
    [W - 90, 260],
    [140, 300],
  ];
  const [gx, gy] = glows[index % glows.length];

  let body;
  if (slide.kind === "cover") body = coverSvg(slide, account.design, st, reel);
  else if (slide.kind === "content") body = contentSvg(slide, index, account.design, st);
  else if (slide.kind === "cheat") body = cheatSvg(slide, account.design, st);
  else body = closingSvg(slide, account.design, st);

  // Footer on content slides: handle + counter
  let footer = "";
  if (slide.kind === "content" || slide.kind === "cheat") {
    const contentTotal = total - 3;
    const label = slide.kind === "content" ? `${index} / ${contentTotal}` : "SAVE THIS";
    footer = `<text x="${M}" y="${H - 80}" font-size="32" fill="${text}" fill-opacity="0.7">${esc(account.handle)}</text>
    <text x="${W - M}" y="${H - 80}" font-size="32" fill="${text}" fill-opacity="0.7" text-anchor="end" letter-spacing="1">${label}</text>`;
  }

  // Progress bar: slide position on carousels, elapsed video time on reels
  const frac = opts.progress == null ? (index + 1) / total : opts.progress;
  const trackW = W - 2 * M;
  const progress = `
    <rect x="${M}" y="${H - 52}" width="${trackW}" height="8" rx="4" fill="${text}" fill-opacity="0.2"/>
    <rect x="${M}" y="${H - 52}" width="${Math.max(8, Math.round(trackW * frac))}" height="8" rx="4" fill="${accent}"/>`;

  return `<rect width="${W}" height="${H}" fill="${background}"/>
  <circle cx="${gx}" cy="${gy}" r="420" fill="${accent}" fill-opacity="0.08"/>
  <g font-family="${fontFamily}">
    ${body}
    ${footer}
  </g>
  ${progress}`;
}

function buildSlideSvg(slide, index, total) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  ${slideInner(slide, index, total)}
</svg>`;
}

// 9:16 reel frame: the slide is scaled down and centred inside Instagram's safe zone, which keeps
// it clear of the top bar, the caption area at the bottom and the button column on the right.
const RW = 1080;
const RH = 1920;
const REEL_SCALE = 0.88;
const REEL_X = 10;
const REEL_Y = 330;

function buildReelFrameSvg(slide, index, total, opts) {
  const { background, accent } = account.design;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${RW}" height="${RH}" viewBox="0 0 ${RW} ${RH}">
  <rect width="${RW}" height="${RH}" fill="${background}"/>
  <circle cx="900" cy="1720" r="520" fill="${accent}" fill-opacity="0.06"/>
  <circle cx="120" cy="200" r="380" fill="${accent}" fill-opacity="0.05"/>
  <g transform="translate(${REEL_X} ${REEL_Y}) scale(${REEL_SCALE})">
  ${slideInner(slide, index, total, { ...opts, reel: true })}
  </g>
</svg>`;
}

async function renderSlide(slide, index, total, outPath) {
  await sharp(Buffer.from(buildSlideSvg(slide, index, total))).jpeg({ quality: 92 }).toFile(outPath);
}

// ---------- Reel ----------

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// Seconds each stage of a slide stays on screen (stage 1 first). Longer text stays longer.
function stagePlan(slide) {
  const pace = Number(account.reelPace) > 0 ? Number(account.reelPace) : 0.62;
  let plan;
  if (slide.kind === "cover") {
    plan = [0.5, 1.3, clamp(words(slide.body) / 4 + 0.8, 1.6, 3)];
  } else if (slide.kind === "content") {
    const bodyHold = clamp(words(slide.body) / 4.2 + 0.6, 1.8, 4.5);
    plan = slide.tip
      ? [0.5, 0.8, bodyHold, clamp(words(slide.tip) / 4.2 + 0.8, 1.8, 3.5)]
      : [0.5, 0.8, bodyHold + 0.8];
  } else if (slide.kind === "cheat") {
    plan = [0.6, ...slide.items.map(() => 0.45), 2.6];
  } else {
    plan = [0.8, 1.4, 2.4];
  }
  return plan.map((s) => Math.max(0.25, +(s * pace).toFixed(2)));
}

function ffmpegAvailable() {
  const r = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
  return !r.error && r.status === 0;
}

// Renders every stage of every slide as a 1080x1920 still, then stitches them into an MP4.
// Returns { seconds, bytes } and writes the video to videoPath and the cover still to coverPath.
async function renderReel(slides, videoPath, coverPath) {
  if (!ffmpegAvailable()) throw new Error("ffmpeg is not installed (the workflow installs it with apt-get)");

  const plans = slides.map(stagePlan);
  const total = plans.reduce((a, p) => a + p.reduce((x, y) => x + y, 0), 0);
  if (total > 85) throw new Error(`Reel would be ${total.toFixed(0)}s, over the 90s Reel limit. Lower slideCount or set a smaller reelPace.`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reel-"));
  try {
    const listLines = [];
    let elapsed = 0;
    let n = 0;
    let lastFile = "";
    for (const [i, slide] of slides.entries()) {
      for (const [s, secs] of plans[i].entries()) {
        elapsed += secs;
        const file = path.join(tmp, `f${String(++n).padStart(4, "0")}.jpg`);
        const svg = buildReelFrameSvg(slide, i, slides.length, { stage: s + 1, progress: elapsed / total });
        await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toFile(file);
        listLines.push(`file '${file}'`, `duration ${secs}`);
        lastFile = file;
        // The cover's last stage doubles as the Reel thumbnail
        if (i === 0 && s === plans[i].length - 1 && coverPath) fs.copyFileSync(file, coverPath);
      }
    }
    listLines.push(`file '${lastFile}'`); // concat needs the final frame repeated
    const listPath = path.join(tmp, "list.txt");
    fs.writeFileSync(listPath, listLines.join("\n") + "\n");

    // Optional soundtrack: drop a royalty-free file named reel-music.mp3 in the repo root.
    const musicPath = path.join(__dirname, "reel-music.mp3");
    const hasMusic = fs.existsSync(musicPath);
    const audioInput = hasMusic
      ? ["-stream_loop", "-1", "-i", musicPath]
      : ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"];
    const audioFilter = hasMusic
      ? `afade=t=in:st=0:d=0.5,afade=t=out:st=${Math.max(0, total - 1).toFixed(2)}:d=1,volume=0.8`
      : "anull";

    const args = [
      "-y", "-loglevel", "error",
      "-f", "concat", "-safe", "0", "-i", listPath,
      ...audioInput,
      "-vf", "fps=30,format=yuv420p",
      "-af", audioFilter,
      "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-profile:v", "high",
      "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
      "-movflags", "+faststart",
      "-t", total.toFixed(2),
      videoPath,
    ];
    const r = spawnSync("ffmpeg", args, { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`ffmpeg failed: ${(r.stderr || "").slice(0, 600)}`);
    return { seconds: +total.toFixed(1), bytes: fs.statSync(videoPath).size, music: hasMusic };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------- Main ----------

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");

  const history = loadHistory();
  const pillars = account.contentPillars;
  // Live runs rotate through the pillars in order. Dry runs pick a random one, because
  // dry runs are not logged to history and would otherwise always show the first pillar.
  const pillar = DRY_RUN
    ? pillars[Math.floor(Math.random() * pillars.length)]
    : pillars[history.length % pillars.length];
  console.log(`Pillar: ${pillar} | Slides: ${TOTAL_SLIDES} | Format: ${POST_FORMAT}`);

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
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  const post = {
    pillar,
    headline: slides[0].title,
    subhead: slides[0].body,
    caption: fullCaption,
    formats: [],
    altTexts: slides.map(altTextFor),
    createdAt: new Date().toISOString(),
  };

  // Carousel images
  if (WANT_CAROUSEL) {
    const dir = DRY_RUN ? "drafts" : "images";
    fs.mkdirSync(path.join(__dirname, dir), { recursive: true });
    const imageFiles = [];
    for (const [i, slide] of slides.entries()) {
      const file = `${dir}/post-${stamp}-s${String(i + 1).padStart(2, "0")}.jpg`;
      await renderSlide(slide, i, slides.length, path.join(__dirname, file));
      imageFiles.push(file);
    }
    post.imageFiles = imageFiles;
    post.formats.push("carousel");
    console.log(`Rendered ${imageFiles.length} carousel slides in ${dir}/`);
  }

  // Reel video
  if (WANT_REEL) {
    const dir = DRY_RUN ? "reels-drafts" : "reels";
    fs.mkdirSync(path.join(__dirname, dir), { recursive: true });
    const reelFile = `${dir}/reel-${stamp}.mp4`;
    const reelCover = `${dir}/reel-${stamp}-cover.jpg`;
    try {
      const info = await renderReel(slides, path.join(__dirname, reelFile), path.join(__dirname, reelCover));
      post.reelFile = reelFile;
      post.reelCover = reelCover;
      post.reelSeconds = info.seconds;
      post.formats.push("reel");
      console.log(`Rendered reel: ${reelFile} (${info.seconds}s, ${(info.bytes / 1048576).toFixed(1)} MB${info.music ? ", with music" : ", silent"})`);
    } catch (err) {
      if (!WANT_CAROUSEL) throw err; // reel-only mode has nothing to fall back to
      console.log(`WARNING: reel could not be rendered, posting the carousel only. ${err.message}`);
    }
  }

  fs.writeFileSync(path.join(__dirname, "post.json"), JSON.stringify(post, null, 2));
  console.log(`Wrote post.json (formats: ${post.formats.join(", ")})`);
}

module.exports = { buildSlideSvg, buildReelFrameSvg, renderSlide, renderReel, stagePlan, slidesFrom, validate, main, ICON_NAMES };

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
