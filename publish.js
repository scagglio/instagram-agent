// publish.js
//
// Reads post.json (written by generate.js) and publishes it to Instagram via the
// Meta Graph API. In DRY_RUN mode it only writes a preview to the GitHub Actions
// job summary and does not post anything.
//
// Environment:
//   IG_ACCESS_TOKEN, IG_BUSINESS_ID   (required unless DRY_RUN)
//   DRY_RUN                           "true" = preview only
//   GRAPH_API_VERSION                 optional override (default v26.0)
//   GITHUB_REPOSITORY, GITHUB_REF_NAME are provided automatically by GitHub Actions

const fs = require("fs");
const path = require("path");

const VERSION = process.env.GRAPH_API_VERSION || "v26.0";
const BASE = `https://graph.facebook.com/${VERSION}`;
const DRY_RUN = process.env.DRY_RUN === "true";
const HISTORY_PATH = path.join(__dirname, "history.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function graph(method, endpoint, params = {}) {
  const token = process.env.IG_ACCESS_TOKEN;
  const all = { ...params, access_token: token };
  let res;
  if (method === "GET") {
    res = await fetch(`${BASE}/${endpoint}?${new URLSearchParams(all)}`);
  } else {
    // Sent as a form body so the token never appears in a URL
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

async function waitForImage(url) {
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(url);
      if (res.ok && (res.headers.get("content-type") || "").startsWith("image/")) return;
    } catch {
      // retry
    }
    await sleep(5000);
  }
  throw new Error(`Image URL never became reachable: ${url}. Is the repository public?`);
}

async function main() {
  const post = JSON.parse(fs.readFileSync(path.join(__dirname, "post.json"), "utf8"));
  const repo = process.env.GITHUB_REPOSITORY;
  const branch = process.env.GITHUB_REF_NAME;
  if (!repo || !branch) {
    throw new Error("GITHUB_REPOSITORY / GITHUB_REF_NAME not set. This script is meant to run inside GitHub Actions.");
  }

  const imageUrl = `https://raw.githubusercontent.com/${repo}/${branch}/${post.imageFile}`;
  console.log(`Waiting for image: ${imageUrl}`);
  await waitForImage(imageUrl);

  if (DRY_RUN) {
    const md =
      `## Draft preview (NOT posted)\n\n` +
      `![preview](${imageUrl})\n\n` +
      `**Pillar:** ${post.pillar}\n\n` +
      `**Alt text:** ${post.altText}\n\n` +
      `**Caption:**\n\n\`\`\`text\n${post.caption}\n\`\`\`\n`;
    console.log(md);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
    return;
  }

  const igId = process.env.IG_BUSINESS_ID;
  if (!igId || !process.env.IG_ACCESS_TOKEN) {
    throw new Error("IG_BUSINESS_ID or IG_ACCESS_TOKEN is not set");
  }

  console.log("Creating media container...");
  const container = await graph("POST", `${igId}/media`, {
    image_url: imageUrl,
    caption: post.caption,
    alt_text: post.altText,
  });

  let status = "IN_PROGRESS";
  for (let i = 0; i < 20; i++) {
    const s = await graph("GET", container.id, { fields: "status_code" });
    status = s.status_code;
    console.log(`Container status: ${status}`);
    if (status === "FINISHED") break;
    if (status === "ERROR" || status === "EXPIRED") {
      throw new Error(`Container failed with status ${status}`);
    }
    await sleep(5000);
  }
  if (status !== "FINISHED") throw new Error("Container was not ready in time");

  console.log("Publishing...");
  const published = await graph("POST", `${igId}/media_publish`, { creation_id: container.id });

  let permalink = "";
  try {
    permalink = (await graph("GET", published.id, { fields: "permalink" })).permalink || "";
  } catch {
    // permalink is nice-to-have
  }
  console.log(`Published! Media ID: ${published.id} ${permalink}`);

  const history = fs.existsSync(HISTORY_PATH) ? JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8")) : [];
  history.push({
    date: new Date().toISOString(),
    pillar: post.pillar,
    headline: post.headline,
    subhead: post.subhead,
    caption: post.caption,
    imageFile: post.imageFile,
    mediaId: published.id,
    permalink,
  });
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
