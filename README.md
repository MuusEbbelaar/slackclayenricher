# Slack ↔ Clay LinkedIn Enricher Bot

Pastes a LinkedIn **people** profile URL into a specific Slack channel → bot sends it to **Clay**, waits for enrichment to complete via **callback**, and updates the thread with **email** and **phone**.

## What you need

- **Slack app** (Bot) installed to your workspace
- **Public HTTPS** URL (for Slack Events + Clay callback)
- **Clay table** with a **Webhook source** (preferred) that enriches `linkedin_url` → `email`, `phone`

## Slack setup

1. Create an app (from scratch) in Slack.
2. Bot token scopes:
   - `chat:write`
   - `channels:history`
3. Event Subscriptions:
   - Enable, set Request URL: `https://YOUR_DOMAIN/slack/events`
   - Subscribe to `message.channels`
4. Install the app, note:
   - **Bot User OAuth Token** → `SLACK_BOT_TOKEN`
   - **Signing Secret** → `SLACK_SIGNING_SECRET`
5. Grab your **channel ID** where this should work → `ALLOWED_CHANNEL`.

## Clay setup (Webhook option)

1. Create a table with a **Webhook** source. Copy the **webhook URL** → `CLAY_WEBHOOK_URL`.
2. Add column `linkedin_url` (string).
3. Add enrichers to produce `email` and `phone`.
4. When enrichment finishes, configure Clay (or a simple Make/Pipedream step right after Clay) to **POST** to your bot:

```
POST {PUBLIC_BASE_URL}/clay/callback
Content-Type: application/json

{
  "callback_token": "{BOT_CALLBACK_SECRET}",
  "row_id": "<clay_row_id>",
  "email": "jane@company.com",
  "phone": "+31 6 12 34 56 78"
}
```

> If your Clay flow cannot call webhooks directly, send the finished row to Make/Pipedream and forward to the callback URL.

## Environment

Copy `.env.example` to `.env` and fill in values.

```
SLACK_BOT_TOKEN=
SLACK_SIGNING_SECRET=
ALLOWED_CHANNEL=
PUBLIC_BASE_URL=
CLAY_WEBHOOK_URL=
CLAY_API_KEY=
BOT_CALLBACK_SECRET=
PORT=3000
```

## Run locally

```bash
npm install
npm run dev
# expose with ngrok or Cloudflared:
# ngrok http 3000
```

Set your Slack **Request URL** to `https://<public>/slack/events` and Clay callback to `https://<public>/clay/callback`.

## Docker

```bash
docker build -t slack-clay-enricher .
docker run -p 3000:3000 --env-file .env slack-clay-enricher
```

## Notes

- The bot currently detects `linkedin.com/in/` people-profile URLs. Extend the regex for companies if needed.
- Results are posted as a **threaded** update to keep channels clean.
- The app stores correlation in memory; use Redis/DB in production.
- Be mindful of **PII**; consider a private channel or masking.
