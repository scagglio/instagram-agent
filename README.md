# Headless Instagram Agent

An Instagram account that runs itself. On a schedule, GitHub Actions wakes up and:

1. Picks the next content pillar from your brief
2. Has Claude draft a post, then has a second Claude call review it against your rules
3. Renders a swipeable carousel (cover hook, numbered content slides, closing call to action) as 1080x1350 images from a template, with no Canva or design tool needed
4. Publishes it through the official Instagram Graph API
5. Logs the post so it never repeats itself

**Cost:** about $0 to run. Claude usage is roughly a cent or two per post with Haiku. GitHub Actions is free for public repos. The Meta API is free.

---

## Ground rules (read first)

- A human must create the accounts once. Do not try to automate account creation, following, liking or commenting. That violates Meta's rules and gets accounts banned. This project only does one thing: publish your own posts through the official API.
- Your repo must be **public** (Instagram has to download the image from a public URL). Your code, captions and history will be visible. Your secrets will not be.
- With no human reviewing posts, you are accepting some risk. The reviewer step, your rules, and a weekly glance at the account reduce it but do not remove it.
- Disclose AI use. Meta's Content Publishing API added support for self-disclosing AI-generated content at publish time. Check the current Content Publishing docs for the exact parameter and add it to the `media` call in `publish.js`. It is also good practice to say so in your bio.

---

## Part 1: Create the accounts (once, by hand)

1. **Facebook profile.** You need a real Facebook profile to own a Page and a Meta developer account. Use your own.
2. **Facebook Page** for the brand: Facebook > Pages > Create.
3. **Instagram account** for the brand. In the Instagram app: Settings > Account type and tools > Switch to professional account (Business or Creator).
4. **Link them.** Instagram app > Edit profile > Page (or Page settings > Linked accounts) and connect the Page.
5. Fill out the profile completely (photo, bio, a few manual posts if you like). Brand-new empty accounts that only post automated content look suspicious.

## Part 2: Meta developer app and tokens

All of this works in Safari on iPhone. Menus on developers.facebook.com change often, so labels may differ slightly.

1. Go to **developers.facebook.com**, log in, and register as a developer if prompted.
2. **Create App**, type **Business**. Name it anything.
3. Open **App settings > Basic** and note your **App ID** and **App Secret**. Keep the secret private.
4. Open **Tools > Graph API Explorer**. Select your app.
5. Click **Generate Access Token** and tick these permissions: `instagram_basic`, `instagram_content_publish`, `pages_show_list`, `pages_read_engagement`. Approve the prompts and select your Page and Instagram account when asked. (While your app is in Development mode you can use these on your own accounts without app review.)
6. Copy the token. This is your short-lived user token.

**Turn it into a token that never expires:**

7. Exchange it for a long-lived user token. Paste this into Safari (fill in the capitals):

   `https://graph.facebook.com/v26.0/oauth/access_token?grant_type=fb_exchange_token&client_id=APP_ID&client_secret=APP_SECRET&fb_exchange_token=SHORT_LIVED_TOKEN`

   Copy `access_token` from the response.

8. Get your Page token:

   `https://graph.facebook.com/v26.0/me/accounts?access_token=LONG_LIVED_USER_TOKEN`

   Find your Page in the result. Copy its **`id`** (Page ID) and its **`access_token`** (Page token). If your Page is missing, you skipped selecting it in step 5, or your Page lives in a Business portfolio and you also need the `business_management` permission.

9. **Verify it never expires.** Open **developers.facebook.com/tools/debug/accesstoken**, paste the Page token, and confirm it says **Expires: Never**. A Page token derived from a long-lived user token should not expire, and that is what makes this headless. If it shows an expiry date, you will need to repeat steps 4-8 before that date.

10. Get your Instagram Business ID:

    `https://graph.facebook.com/v26.0/PAGE_ID?fields=instagram_business_account&access_token=PAGE_TOKEN`

    Copy the `id` inside `instagram_business_account`.

You now have:
- `IG_ACCESS_TOKEN` = the Page token
- `IG_BUSINESS_ID` = the Instagram Business ID

Never paste these into chats, screenshots, or the repo. They only go into GitHub Secrets.

## Part 3: Anthropic API key

1. Go to **console.anthropic.com** and sign in.
2. **Billing:** add a few dollars of credit and set a monthly spend limit.
3. **API Keys > Create Key.** Copy it immediately (shown once). This is `ANTHROPIC_API_KEY`.

## Part 4: GitHub repo

1. Create a new repository and set it to **Public**.
2. Add the files from this project. On iPhone the easiest way:
   - In Safari on github.com open your repo > **Add file > Upload files** and select these files from the Files app: `package.json`, `account.json`, `generate.js`, `publish.js`, `history.json`, `.gitignore`, `README.md`. Commit.
   - The workflow lives in a folder, so use **Add file > Create new file**, type the name `.github/workflows/post.yml` (typing the slashes creates the folders), paste the contents of `post.yml`, and commit.
3. **Settings > Secrets and variables > Actions > New repository secret.** Add three secrets, named exactly:
   - `ANTHROPIC_API_KEY`
   - `IG_ACCESS_TOKEN`
   - `IG_BUSINESS_ID`
4. **Settings > Actions > General > Workflow permissions:** choose **Read and write permissions** and save.

## Part 5: Define the account

Edit `account.json`. Replace every line marked `EXAMPLE - REPLACE`:

- `handle`: your Instagram handle (shown on the image)
- `niche`, `audience`, `voice`: who the account is for and how it sounds
- `contentPillars`: 4-6 recurring themes. The agent rotates through them.
- `rules` and `bannedTopics`: your guardrails. Be strict. The reviewer enforces these.
- `design`: colors for the image template. Do not put double quotes inside `fontFamily`.
- `model`: Haiku is cheap and fine. For better writing, try `claude-sonnet-5-5` (still only a few cents per post).


### Carousel settings (optional)

Posts are swipeable carousels by default: a cover with a hook, numbered content slides, and a closing slide that invites people to save, share and follow. Add this line to `account.json` to change the length:

```json
  "slideCount": 6,
```

`slideCount` is the total number of slides including the cover and the closing slide. Allowed values are 3 to 10 and the default is 6. Carousels get more swipes and saves than single images, which is what Instagram rewards.

## Part 6: Test with dry runs (do this several times)

1. **Actions tab > Post to Instagram > Run workflow.** Leave **Draft only** checked.
2. When it finishes, open the run and look at the **Summary**. You will see a row of slide previews and the caption. Nothing is posted.
3. Adjust `account.json` until the drafts are consistently good. Run 5-10 dry runs.

## Part 7: First live post

1. **Run workflow** again, this time **uncheck** Draft only.
2. Check Instagram. If it appears, your tokens and setup are good.

## Part 8: Go fully headless

1. **Settings > Secrets and variables > Actions > Variables tab > New repository variable.**
   Name: `AUTO_POST`, Value: `true`.
2. That is it. Scheduled runs now post for real. The default schedule is Mon/Wed/Fri at 15:00 UTC. Change the `cron` line in `.github/workflows/post.yml` to taste (times are UTC and GitHub may run a few minutes late).
3. To pause everything, delete the `AUTO_POST` variable (scheduled runs go back to drafts) or disable the workflow in the Actions tab.

---

## Keeping it running

- **Failure alerts:** GitHub > Settings > Notifications > Actions. Turn on emails for failed workflows so you know when a run breaks.
- **Look at the account weekly** for the first month, then monthly.
- **Token problems:** a password change, removing the app, or Meta security checks can invalidate the token. The run will fail with "error 190". Repeat Part 2 steps 4-10 and update the `IG_ACCESS_TOKEN` secret.
- **API versions:** the scripts use Graph API `v26.0`, current as of October 2026. Meta retires old versions roughly two years after release. To change it without editing code, add `GRAPH_API_VERSION` as an env value in the workflow.
- **Inactivity:** GitHub can disable scheduled workflows in repos with no activity for 60 days. The agent's own commits should keep it active, but if posts ever stop, check the Actions tab and re-enable the workflow.
- **Credits:** if your Anthropic credit runs out, runs fail. Set up auto-reload or watch the balance.
- **Repo growth:** each post adds a ~150 KB image. At 3 posts a week that is roughly 25 MB a year, which is fine.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| "Image URL never became reachable" | Repo is not public, or the push step failed |
| Error 190 | Token invalid or expired. Redo Part 2 |
| Permission errors (#10, #200) | A permission was not granted in step 5, or the Page/Instagram was not selected |
| Page missing from `/me/accounts` | You did not select it when generating the token, or you need `business_management` |
| "No acceptable draft after 3 attempts" | Your rules conflict with your niche, or are too strict. Loosen them or raise `maxAttempts` |
| Text looks wrong or boxes appear instead of letters | Font missing. Keep the "Install fonts" step in the workflow |
| Push rejected in workflow | Workflow permissions not set to read and write (Part 4, step 4) |
| "Commit images" step fails on a re-run | Use **Run workflow** for a fresh run instead of **Re-run jobs** |

## Files

| File | Purpose |
|---|---|
| `account.json` | Your brand brief, rules and design |
| `generate.js` | Drafts, reviews and renders the carousel slides |
| `publish.js` | Posts to Instagram (or writes a dry-run preview) |
| `history.json` | Log of published posts, used to avoid repeats |
| `.github/workflows/post.yml` | The schedule and pipeline |
| `drafts/`, `images/` | Created automatically by the workflow |
