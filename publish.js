// publish.js  (carousel + reel version)
//
// Reads post.json (written by generate.js) and publishes it to Instagram via the Meta Graph API.
//   - carousel: swipeable slides (or a single photo if there is only one image)
//   - reel:     the animated MP4, uploaded directly to Instagram (falls back to a public URL)
// post.json "formats" says which to publish. Each format is saved to history.json as soon as it
// succeeds, so a failure in one format never causes the other to be posted twice.
// In DRY_RUN mode nothing is posted; a preview is written to the Actions job summary.
//
// Environment: IG_ACCESS_TOKEN, IG_BUSINESS_ID (unless DRY_RUN), DRY_RUN, GRAPH_API_VERSION (optional)

const fs = require("fs");
const path = require("path");

const VERSION = process.env.GRAPH_API_VERSION || "v26.0";
const BASE = `https://graph.facebook.com/${VERSION}`;
const DRY_RUN = process.env.DRY_RUN === "true";
const HISTORY_PATH = path.join(__dirname, "history.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function graph(method, endpoint, params = {}) {
  const all = { ...params, access_token: process.env.IG_ACCESS_TOKEN };
  let res;
  if (method === "GET") {
    res = await fetch(`${BASE}/${endpoint}?${new URLSearchParams(all)}`);
  } else {
    res = await fetch(`${BASE}/${endpoint}`, { method, body: new URLSearchParams(all) });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const err = data.error || {};
    if (err.code === 190) {
      throw new Error(
        "Instagram access token is invalid or expired (error 190). Generate a new token and update the IG_ACCESS_TOKEN secret.\n" +
          JSON.stringify(err)
      );
    }
    throw new Error(`Graph API error on ${method} ${endpoint}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function waitForUrl(url, typePrefix) {
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(url);
      if (res.ok && (res.headers.get("content-type") || "").startsWith(typePrefix)) return;
    } catch {
      // retry
    }
    await sleep(5000);
  }
  throw new Error(`File URL never became reachable: ${url}. Is the repository public?`);
}

async function waitFinished(containerId, label, tries = 24) {
  let status = "IN_PROGRESS";
  for (let i = 0; i < tries; i++) {
    const s = await graph("GET", containerId, { fields: "status_code" });
    status = s.status_code;
    if (status === "FINISHED") return;
    if (status === "ERROR" || status === "EXPIRED") throw new Error(`${label} failed with status ${status}`);
    await sleep(5000);
  }
  throw new Error(`${label} was not ready in time (last status ${status})`);
}

async function createCarouselItem(igId, imageUrl, altText) {
  const base = { image_url: imageUrl, is_carousel_item: "true" };
  try {
    return await graph("POST", `${igId}/media`, { ...base, alt_text: altText.slice(0, 900) });
  } catch (err) {
    console.log(`  Retrying without alt text: ${err.message.slice(0, 200)}`);
    return await graph("POST", `${igId}/media`, base);
  }
}

function rawUrl(repo, branch, file) {
  return `https://raw.githubusercontent.com/${repo}/${branch}/${file}`;
}

function logHistory(post, extra) {
  const history = fs.existsSync(HISTORY_PATH) ? JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8")) : [];
  history.push({
    date: new Date().toISOString(),
    pillar: post.pillar,
    headline: post.headline,
    subhead: post.subhead,
    caption: post.caption,
    ...extra,
  });
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
}

async function permalinkOf(id) {
  try {
    return (await graph("GET", id, { fields: "permalink" })).permalink || "";
  } catch {
    return "";
  }
}

async function publishCarousel(post, igId, repo, branch) {
  const files = post.imageFiles || [post.imageFile];
  const altTexts = post.altTexts || [post.altText || ""];
  const urls = files.map((f) => rawUrl(repo, branch, f));
  for (const u of urls) await waitForUrl(u, "image/");

  let creationId;
  if (urls.length === 1) {
    const c = await graph("POST", `${igId}/media`, {
      image_url: urls[0],
      caption: post.caption,
      alt_text: (altTexts[0] || "").slice(0, 900),
    });
    await waitFinished(c.id, "Image container");
    creationId = c.id;
  } else {
    console.log(`Creating ${urls.length} carousel items...`);
    const childIds = [];
    for (const [i, u] of urls.entries()) {
      const child = await createCarouselItem(igId, u, altTexts[i] || "");
      childIds.push(child.id);
      console.log(`  Item ${i + 1}/${urls.length}: ${child.id}`);
    }
    for (const [i, id] of childIds.entries()) await waitFinished(id, `Carousel item ${i + 1}`);
    const carousel = await graph("POST", `${igId}/media`, {
      media_type: "CAROUSEL",
      children: childIds.join(","),
      caption: post.caption,
    });
    await waitFinished(carousel.id, "Carousel container");
    creationId = carousel.id;
  }
  const published = await graph("POST", `${igId}/media_publish`, { creation_id: creationId });
  const permalink = await permalinkOf(published.id);
  console.log(`Carousel published! ${published.id} ${permalink}`);
  logHistory(post, { format: "carousel", imageFiles: files, mediaId: published.id, permalink });
}

// Upload the MP4 bytes straight to Instagram (no public URL needed)
async function uploadResumable(containerId, uri, filePath) {
  const buf = fs.readFileSync(filePath);
  const res = await fetch(uri || `https://rupload.facebook.com/ig-api-upload/${VERSION}/${containerId}`, {
    method: "POST",
    headers: {
      Authorization: `OAuth ${process.env.IG_ACCESS_TOKEN}`,
      offset: "0",
      file_size: String(buf.length),
    },
    body: buf,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    throw new Error(`Resumable upload failed (${res.status}): ${JSON.stringify(data)}`);
  }
}

async function publishReel(post, igId, repo, branch, shareToFeed) {
  const videoPath = path.join(__dirname, post.reelFile);
  const coverUrl = post.reelCover ? rawUrl(repo, branch, post.reelCover) : null;
  const base = { media_type: "REELS", caption: post.caption };
  if (shareToFeed === false) base.share_to_feed = "false";

  let containerId;
  try {
    console.log("Creating reel container (direct upload)...");
    let c;
    try {
      c = await graph("POST", `${igId}/media`, { ...base, upload_type: "resumable", ...(coverUrl ? { cover_url: coverUrl } : {}) });
    } catch (e) {
      console.log(`  Retrying without cover: ${e.message.slice(0, 200)}`);
      c = await graph("POST", `${igId}/media`, { ...base, upload_type: "resumable" });
    }
    await uploadResumable(c.id, c.uri, videoPath);
    containerId = c.id;
  } catch (err) {
    console.log(`Direct upload failed, trying public URL instead: ${err.message.slice(0, 300)}`);
    const videoUrl = rawUrl(repo, branch, post.reelFile);
    await waitForUrl(videoUrl, "video/").catch(() => console.log("  Video URL content-type check failed; trying anyway."));
    const c = await graph("POST", `${igId}/media`, { ...base, video_url: videoUrl });
    containerId = c.id;
  }
  await waitFinished(containerId, "Reel container", 60);
  const published = await graph("POST", `${igId}/media_publish`, { creation_id: containerId });
  const permalink = await permalinkOf(published.id);
  console.log(`Reel published! ${published.id} ${permalink}`);
  logHistory(post, { format: "reel", reelFile: post.reelFile, mediaId: published.id, permalink });
}

async function main() {
  const post = JSON.parse(fs.readFileSync(path.join(__dirname, "post.json"), "utf8"));
  const repo = process.env.GITHUB_REPOSITORY;
  const branch = process.env.GITHUB_REF_NAME;
  if (!repo || !branch) throw new Error("GITHUB_REPOSITORY / GITHUB_REF_NAME not set. Run this inside GitHub Actions.");

  const formats = post.formats || ["carousel"];
  const wantCarousel = formats.includes("carousel");
  const wantReel = formats.includes("reel");

  if (DRY_RUN) {
    let md = `## Draft preview (NOT posted)\n\n**Pillar:** ${post.pillar}\n\n**Formats:** ${formats.join(" + ")}\n\n`;
    if (wantCarousel) {
      const files = post.imageFiles || [post.imageFile];
      md += files.map((f) => `<img src="${rawUrl(repo, branch, f)}" width="200">`).join(" ") + "\n\n";
    }
    if (wantReel) {
      md +=
        `**Reel:** ${post.reelSeconds}s. Download the \`reel-preview\` artifact from this run to watch it, or open ` +
        `[the file](https://github.com/${repo}/blob/${branch}/${post.reelFile}).\n\n` +
        (post.reelCover ? `<img src="${rawUrl(repo, branch, post.reelCover)}" width="200">\n\n` : "");
    }
    md += `**Caption:**\n\n\`\`\`text\n${post.caption}\n\`\`\`\n`;
    console.log(md);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
    return;
  }

  const igId = process.env.IG_BUSINESS_ID;
  if (!igId || !process.env.IG_ACCESS_TOKEN) throw new Error("IG_BUSINESS_ID or IG_ACCESS_TOKEN is not set");

  const errors = [];
  if (wantCarousel) {
    try {
      await publishCarousel(post, igId, repo, branch);
    } catch (e) {
      console.error("Carousel failed:", e.message);
      errors.push(e);
    }
  }
  if (wantReel) {
    try {
      // When both are posted, keep the reel out of the grid feed to avoid a duplicate look
      await publishReel(post, igId, repo, branch, wantCarousel ? false : true);
    } catch (e) {
      console.error("Reel failed:", e.message);
      errors.push(e);
    }
  }
  if (errors.length) throw new Error(`${errors.length} format(s) failed. See the log above.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
