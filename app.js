import 'dotenv/config';
import Bolt from "@slack/bolt";
const { App, ExpressReceiver } = Bolt;
import express from "express";
import bodyParser from "body-parser";
import axios from "axios";

const {
  SLACK_BOT_TOKEN,
  SLACK_SIGNING_SECRET,
  ALLOWED_CHANNEL,
  CLAY_WEBHOOK_URL,
  CLAY_API_BASE,
  CLAY_API_KEY,
  BOT_CALLBACK_SECRET,
  PUBLIC_BASE_URL,
  ENRICH_KEYWORD = "enrich",
  RATE_LIMIT_PER_MIN = "1",
  RATE_LIMIT_WINDOW_MS = "60000",
  PORT = 3000,
} = process.env;

// ---------- Config ----------
const ENRICH = ENRICH_KEYWORD.toLowerCase();
const PER_MIN = parseInt(RATE_LIMIT_PER_MIN, 10);
const WINDOW_MS = parseInt(RATE_LIMIT_WINDOW_MS, 10);

// Basic LinkedIn profile detector (people profiles). Expand later if needed.
const LI_REGEX = /https?:\/\/(?:www\.)?linkedin\.com\/in\/[A-Za-z0-9\-_%]+\/?/i;

// In-memory correlation map: clayRowId -> { channel, thread_ts, message_ts, liUrl }
// Replace with Redis/DB in production.
const tracker = new Map();

// ---- Per-user rate limit store: userId -> [timestamps] ----
const userRate = new Map();
function userAllowed(userId) {
  const now = Date.now();
  const windowStart = now - WINDOW_MS;
  const arr = userRate.get(userId) || [];
  const recent = arr.filter(t => t >= windowStart);
  if (recent.length >= PER_MIN) {
    userRate.set(userId, recent);
    return false;
  }
  recent.push(now);
  userRate.set(userId, recent);
  return true;
}
// light cleanup
setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS * 2;
  for (const [user, ts] of userRate.entries()) {
    const kept = ts.filter(t => t >= cutoff);
    if (kept.length) userRate.set(user, kept);
    else userRate.delete(user);
  }
}, WINDOW_MS).unref?.();

// Use ExpressReceiver to expose custom routes for Slack Events + Clay callback.
const receiver = new ExpressReceiver({
  signingSecret: SLACK_SIGNING_SECRET,
  endpoints: "/slack/events",
});

const bolt = new App({
  token: SLACK_BOT_TOKEN,
  receiver,
});

// Helper to post/update Slack messages (no unfurls)
async function slackUpdate(client, channel, ts, text, blocks) {
  return axios.post("https://slack.com/api/chat.update", {
    channel,
    ts,
    text,
    blocks,
    unfurl_links: false,
    unfurl_media: false,
  }, {
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, "Content-Type": "application/json" },
    timeout: 15000
  });
}

// Listen to channel messages and trigger on LinkedIn URLs
bolt.message(async ({ message, client, logger }) => {
  try {
    if (!("text" in message)) return;
    if (ALLOWED_CHANNEL && message.channel !== ALLOWED_CHANNEL) return;

    // per-user rate limit
    const userId = message.user;
    if (!userAllowed(userId)) {
      await client.chat.postEphemeral({
        channel: message.channel,
        user: userId,
        text: `⏳ Rate limit: max ${PER_MIN} per ${Math.round(WINDOW_MS/1000)}s. Try again soon.`,
      });
      return;
    }

    const textRaw = message.text || "";
    const text = textRaw.toLowerCase();

    // extract only LinkedIn URL (people profile)
    const match = textRaw.match(LI_REGEX);
    if (!match) return;

    // require the keyword (case-insensitive)
    if (!text.includes(ENRICH)) return;

    const liUrl = match[0];

    // 1) Post placeholder in thread (no unfurls)
    const placeholder = await client.chat.postMessage({
      channel: message.channel,
      thread_ts: message.ts,
      text: `Enriching ${liUrl} … one sec.`,
      unfurl_links: false,
      unfurl_media: false,
    });

    // 2) Send to Clay
    if (CLAY_WEBHOOK_URL) {
      const payload = {
        linkedin_url: liUrl,
        // add stateless identifiers so callback can update even after restarts
        slack_channel: message.channel,
        slack_message_ts: placeholder.ts,
        callback_url: `${PUBLIC_BASE_URL}/clay/callback`,
        callback_token: BOT_CALLBACK_SECRET
      };
      const headers = { "Content-Type": "application/json" };
      if (CLAY_API_KEY) headers.Authorization = `Bearer ${CLAY_API_KEY}`;

      const clayResp = await axios.post(CLAY_WEBHOOK_URL, payload, { headers, timeout: 30000 });
      const rowId = clayResp.data?.id || clayResp.data?.row_id || clayResp.data?.rowId || null;

      tracker.set(rowId || `${message.channel}:${placeholder.ts}`, {
        channel: message.channel,
        thread_ts: message.ts,
        message_ts: placeholder.ts,
        liUrl,
      });
    } else if (CLAY_API_BASE && CLAY_API_KEY) {
      // Example skeleton for direct Clay API usage
      const createResp = await axios.post(`${CLAY_API_BASE}/rows`, {
        fields: {
          linkedin_url: liUrl,
          slack_channel: message.channel,
          slack_message_ts: placeholder.ts,
          callback_url: `${PUBLIC_BASE_URL}/clay/callback`,
          callback_token: BOT_CALLBACK_SECRET
        }
      }, {
        headers: { Authorization: `Bearer ${CLAY_API_KEY}`, "Content-Type": "application/json" },
        timeout: 30000
      });
      const rowId = createResp.data?.id;
      tracker.set(rowId || `${message.channel}:${placeholder.ts}`, {
        channel: message.channel,
        thread_ts: message.ts,
        message_ts: placeholder.ts,
        liUrl,
      });
    } else {
      await slackUpdate(null, message.channel, placeholder.ts,
        "Clay configuration missing. Please set CLAY_WEBHOOK_URL or CLAY_API_BASE+CLAY_API_KEY.");
    }
  } catch (err) {
    console.error("handler error", err?.response?.data || err?.message || err);
  }
});

// Clay (or your automation after Clay completes) will call this with result data
receiver.router.use(bodyParser.json());

receiver.router.post("/clay/callback", async (req, res) => {
  try {
    const {
      callback_token,
      row_id,
      email,
      phone,
      fields,
      slack_channel,
      slack_message_ts,
      channel,
      message_ts,
      linkedin_url
    } = req.body || {};

    if (callback_token !== BOT_CALLBACK_SECRET) {
      return res.status(401).send("Unauthorized");
    }

    const resultEmail = email || fields?.email || "—";
    const resultPhone = phone || fields?.phone || "—";
    const liUrl = linkedin_url || fields?.linkedin_url || "";

    // Prefer stateless direct params from Clay
    const updateChannel = channel || slack_channel;
    const updateTs = message_ts || slack_message_ts;

    if (updateChannel && updateTs) {
      const text = `Results for ${liUrl ? `<${liUrl}|LinkedIn profile>` : "this profile"}\n• Email: ${resultEmail}\n• Phone: ${resultPhone}`;
      await slackUpdate(null, updateChannel, updateTs, text);
      if (row_id) tracker.delete(row_id);
      return res.status(200).send("ok");
    }

    // Fallback to in-memory tracker if direct params missing
    const key = row_id && tracker.has(row_id)
      ? row_id
      : Array.from(tracker.keys())[0];

    const meta = key && tracker.get(key);
    if (!meta) {
      return res.status(200).send("No tracker/channel/ts; bot may have restarted.");
    }

    const text = `Results for ${meta.liUrl ? `<${meta.liUrl}|LinkedIn profile>` : "this profile"}\n• Email: ${resultEmail}\n• Phone: ${resultPhone}`;
    await slackUpdate(null, meta.channel, meta.message_ts, text);
    tracker.delete(key);
    res.status(200).send("ok");
  } catch (e) {
    console.error("callback error", e?.response?.data || e?.message || e);
    res.status(500).send("error");
  }
});

receiver.router.get("/healthz", (_req, res) => res.status(200).send("ok"));

(async () => {
  await bolt.start(PORT);
  console.log(`⚡️ Slack app running on :${PORT}`);
})();
