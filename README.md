# Instagram Agent

A parameter-driven agent that generates an Instagram caption (Claude API) and
image (Canva brand template), then publishes the post via the Meta Graph API
on a GitHub Actions schedule.

## Setup

1. **Instagram / Meta**
   - Convert your Instagram account to a Business or Creator account, linked
     to a Facebook Page.
   - Create an app at developers.facebook.com, add the Instagram Graph API
     product, and generate a long-lived access token with the
     `instagram_content_publish` permission.
   - Find your Instagram Business Account ID via the Graph API Explorer.

2. **Canva**
   - Build a brand template in Canva with the fields you want to vary (this
     project assumes fields named `headline` and `subhead` — adjust
     `scripts/generate.js` to match your actual field names).
   - Publish it as a Brand Template and copy its template ID into
     `config/parameters.json`.
   - Generate a Canva API access token from your Canva developer settings.

3. **Repo secrets** — under Settings > Secrets and variables > Actions, add:
   - `ANTHROPIC_API_KEY`
   - `CANVA_API_TOKEN`
   - `IG_ACCESS_TOKEN`
   - `IG_BUSINESS_ID`

4. **Edit `config/parameters.json`** with your brand, topic, tone, and Canva
   template ID for the next post.

5. **Test manually** before trusting the schedule: go to the Actions tab,
   select "Post to Instagram", and click "Run workflow".

## Local testing

```bash
npm install
ANTHROPIC_API_KEY=... CANVA_API_TOKEN=... npm run generate
IG_ACCESS_TOKEN=... IG_BUSINESS_ID=... npm run publish
```

## Notes

- Long-lived Meta tokens expire after ~60 days — set a reminder to refresh.
- Model names and Graph API versions in the scripts should be double-checked
  against current docs before relying on this long-term.
- Consider adding a manual-approval step (e.g. posting the draft to a private
  Slack channel first) before fully trusting auto-publish.
