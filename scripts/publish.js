// scripts/publish.js
//
// Reads content/post.json (written by generate.js) and publishes it to
// Instagram via the Meta Graph API. Must run in the same job as generate.js,
// right after it, since it relies on the image URL still being valid.
//
// Required environment variables:
//   IG_ACCESS_TOKEN
//   IG_BUSINESS_ID

const fs = require("fs");
const path = require("path");

const GRAPH_API_VERSION = "v19.0"; // check developers.facebook.com for the current version

async function main() {
  const igId = process.env.IG_BUSINESS_ID;
  const token = process.env.IG_ACCESS_TOKEN;
  if (!igId || !token) {
    throw new Error("Missing IG_BUSINESS_ID or IG_ACCESS_TOKEN environment variable.");
  }

  const postPath = path.join(__dirname, "..", "content", "post.json");
  if (!fs.existsSync(postPath)) {
    throw new Error("content/post.json not found — run generate.js first.");
  }
  const post = JSON.parse(fs.readFileSync(postPath, "utf8"));

  console.log("Creating media container...");
  const containerUrl =
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${igId}/media?` +
    `image_url=${encodeURIComponent(post.imageUrl)}` +
    `&caption=${encodeURIComponent(post.caption)}` +
    `&access_token=${encodeURIComponent(token)}`;

  const containerRes = await fetch(containerUrl, { method: "POST" });
  const containerData = await containerRes.json();
  if (!containerRes.ok) {
    throw new Error(`Failed to create media container: ${JSON.stringify(containerData)}`);
  }
  console.log("Container created:", containerData.id);

  console.log("Publishing...");
  const publishUrl =
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${igId}/media_publish?` +
    `creation_id=${containerData.id}` +
    `&access_token=${encodeURIComponent(token)}`;

  const publishRes = await fetch(publishUrl, { method: "POST" });
  const publishData = await publishRes.json();
  if (!publishRes.ok) {
    throw new Error(`Failed to publish: ${JSON.stringify(publishData)}`);
  }

  console.log("Published! Media ID:", publishData.id);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
