// scripts/generate.js
//
// Reads config/parameters.json, asks the Claude API for a caption + hashtags,
// asks the Canva API to render an image from a brand template, and writes
// both into content/post.json + content/post-image.jpg for publish.js to use.
//
// Required environment variables:
//   ANTHROPIC_API_KEY
//   CANVA_API_TOKEN

const fs = require("fs");
const path = require("path");

const params = require("../config/parameters.json");

const CONTENT_DIR = path.join(__dirname, "..", "content");
if (!fs.existsSync(CONTENT_DIR)) fs.mkdirSync(CONTENT_DIR, { recursive: true });

async function generateCaption() {
  const prompt =
    `Write an Instagram caption for the brand "${params.brand}". ` +
    `Topic: ${params.topic}. Tone: ${params.tone}. ` +
    `Include a call to action about "${params.callToAction}" and ` +
    `${params.hashtagCount} relevant hashtags. ` +
    `Respond with ONLY valid JSON, no other text, in this exact shape: ` +
    `{"caption": "...", "hashtags": ["...", "..."], "altText": "..."}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      // Check console.anthropic.com for the current recommended model string
      // before relying on this long-term — model names change over time.
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    throw new Error(`Claude API error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const rawText = data.content.find((block) => block.type === "text")?.text || "";

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error(`Could not parse Claude's response as JSON:\n${rawText}`);
  }

  return parsed; // { caption, hashtags, altText }
}

async function generateImage() {
  // Canva's Connect API renders a design from a Brand Template using an
  // "autofill" job, then you export the finished design as an image.
  // Docs: https://www.canva.dev/docs/connect/api-reference/autofills/
  //       https://www.canva.dev/docs/connect/api-reference/exports/
  //
  // This assumes your brand template has fields named "headline" and
  // "subhead" — adjust the field names below to match your actual template.

  const headers = {
    Authorization: `Bearer ${process.env.CANVA_API_TOKEN}`,
    "Content-Type": "application/json",
  };

  // 1. Kick off the autofill job
  const autofillRes = await fetch("https://api.canva.com/rest/v1/autofills", {
    method: "POST",
    headers,
    body: JSON.stringify({
      brand_template_id: params.canvaTemplateId,
      data: {
        headline: { type: "text", text: params.product },
        subhead: { type: "text", text: params.topic },
      },
    }),
  });
  if (!autofillRes.ok) {
    throw new Error(`Canva autofill error: ${autofillRes.status} ${await autofillRes.text()}`);
  }
  const autofillJob = await autofillRes.json();
  const jobId = autofillJob.job.id;

  // 2. Poll until the design is ready
  let designId;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const statusRes = await fetch(`https://api.canva.com/rest/v1/autofills/${jobId}`, { headers });
    const statusData = await statusRes.json();
    if (statusData.job.status === "success") {
      designId = statusData.job.result.design.id;
      break;
    }
    if (statusData.job.status === "failed") {
      throw new Error(`Canva autofill job failed: ${JSON.stringify(statusData.job.error)}`);
    }
  }
  if (!designId) throw new Error("Canva autofill job timed out.");

  // 3. Export the finished design as a JPEG
  const exportRes = await fetch("https://api.canva.com/rest/v1/exports", {
    method: "POST",
    headers,
    body: JSON.stringify({ design_id: designId, format: { type: "jpg" } }),
  });
  const exportJob = await exportRes.json();
  const exportJobId = exportJob.job.id;

  let downloadUrl;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const statusRes = await fetch(`https://api.canva.com/rest/v1/exports/${exportJobId}`, { headers });
    const statusData = await statusRes.json();
    if (statusData.job.status === "success") {
      downloadUrl = statusData.job.urls[0];
      break;
    }
    if (statusData.job.status === "failed") {
      throw new Error(`Canva export job failed: ${JSON.stringify(statusData.job.error)}`);
    }
  }
  if (!downloadUrl) throw new Error("Canva export job timed out.");

  // 4. Also save a local copy for your own records. The Graph API call in
  // publish.js uses downloadUrl directly (it needs a public URL, and Canva's
  // export link is publicly fetchable for a limited time) — that only works
  // if generate.js and publish.js run in the same job, back to back, as in
  // the sample workflow below.
  const imageRes = await fetch(downloadUrl);
  const imageBuffer = Buffer.from(await imageRes.arrayBuffer());
  const imagePath = path.join(CONTENT_DIR, "post-image.jpg");
  fs.writeFileSync(imagePath, imageBuffer);

  return { imagePath, imageUrl: downloadUrl };
}

async function main() {
  console.log("Generating caption...");
  const { caption, hashtags, altText } = await generateCaption();

  console.log("Generating image...");
  const { imagePath, imageUrl } = await generateImage();

  const fullCaption = `${caption}\n\n${hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ")}`;

  const post = {
    caption: fullCaption,
    altText,
    imagePath,
    imageUrl,
    createdAt: new Date().toISOString(),
  };

  fs.writeFileSync(path.join(CONTENT_DIR, "post.json"), JSON.stringify(post, null, 2));
  console.log("Wrote content/post.json and content/post-image.jpg");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
