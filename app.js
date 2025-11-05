import 'dotenv/config';
import { App, ExpressReceiver } from "@slack/bolt";
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
  PORT = 3000,
} = process.env;

// Basic LinkedIn profile detector (people profiles). Expand later if needed.
const LI_REGEX = /https?:\/\/(?:www\.)?linkedin\.com\/in\/[A-Za-z0-9\-_%]+\/?/i;

// In-memory correlation map: clayRowId -> { channel, thread_ts, message_ts, liUrl }
// Replace with Redis/DB in production.
const tracker = new Map();

// Use ExpressReceiver to expose custom routes for Slack Events + Clay callback.
const receiver = new ExpressReceiver({
  signingSecret: SLACK_SIGNING_SECRET,
  endpoints: "/slack/events",
});

const bolt = new App({
  token: SLACK_BOT_TOKEN,
  receiver,
});

// Helper to post/update Slack messages
async function slackUpdate(client, channel, ts, text) {
  return axios.post("https://slack.com/api/chat.update", {
    channel, ts, text
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

    const text = message.text || "";
    const match = text.match(LI_REGEX);
    if (!match) return;

    const liUrl = match[0];

    // 1) Post placeholder in thread
    const placeholder = await client.chat.postMessage({
      channel: message.channel,
      thread_ts: message.ts,
      text: `Enriching ${liUrl} … one sec.`,
    });

    // 2) Send to Clay
    // Option A: Table Webhook (preferred for low code in Clay)
    if (CLAY_WEBHOOK_URL) {
      const payload = {
        linkedin_url: liUrl,
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
    }
    // Option B: Clay HTTP API (if you have row create endpoint & table id)
    else if (CLAY_API_BASE && CLAY_API_KEY) {
      // This is a placeholder; adapt if you use Clay's official API endpoints for rows.
      // Example POST {CLAY_API_BASE}/rows with { table_id, fields: { linkedin_url, callback_url, callback_token } }
      const createResp = await axios.post(`${CLAY_API_BASE}/rows`, {
        fields: {
          linkedin_url: liUrl,
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
      await slackUpdate(client, message.channel, placeholder.ts, "Clay configuration missing. Please set CLAY_WEBHOOK_URL or CLAY_API_BASE+CLAY_API_KEY.");
    }
  } catch (err) {
    console.error("handler error", err?.response?.data || err?.message || err);
  }
});

// Clay (or your automation after Clay completes) will call this with result data
receiver.router.use(bodyParser.json());

receiver.router.post("/clay/callback", async (req, res) => {
  try {
    const { callback_token, row_id, email, phone, fields } = req.body || {};

    if (callback_token !== BOT_CALLBACK_SECRET) {
      return res.status(401).send("Unauthorized");
    }

    const resultEmail = email || fields?.email || "—";
    const resultPhone = phone || fields?.phone || "—";

    // Find original Slack message
    const key = row_id && tracker.has(row_id)
      ? row_id
      : Array.from(tracker.keys())[0]; // fallback if bot restarted

    const meta = tracker.get(key);
    if (!meta) {
      // Still return 200 so Clay doesn't retry forever
      return res.status(200).send("No tracker entry (bot may have restarted).");
    }

    const { channel, message_ts, liUrl } = meta;
    const text = `Results for ${liUrl}\n• Email: ${resultEmail}\n• Phone: ${resultPhone}`;

    await slackUpdate(null, channel, message_ts, text);
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