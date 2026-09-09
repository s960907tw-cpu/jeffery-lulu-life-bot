import express from "express";
import crypto from "crypto";
import OpenAI from "openai";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const TIMEZONE = process.env.TIMEZONE || "Asia/Taipei";
const BOT_NAME = process.env.BOT_NAME || "J&L小管家";
const MODEL = process.env.OPENAI_MODEL || "gpt-5.6-luna";

const requiredEnv = [
  "LINE_CHANNEL_SECRET",
  "LINE_CHANNEL_ACCESS_TOKEN",
  "OPENAI_API_KEY",
  "APPS_SCRIPT_URL",
  "APPS_SCRIPT_TOKEN",
];

for (const key of requiredEnv) {
  if (!process.env[key]) console.warn(`[WARN] Missing env: ${key}`);
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Small, ephemeral conversation context. Persistent life data lives in Google.
const histories = new Map();
const MAX_HISTORY_MESSAGES = 10;

app.get("/", (_req, res) => res.type("text").send(`${BOT_NAME} is running.`));
app.get("/health", (_req, res) => res.json({ ok: true, bot: BOT_NAME, model: MODEL }));

// Keep raw JSON text so the LINE signature can be verified against the exact body.
app.post("/webhook", express.text({ type: "*/*", limit: "2mb" }), (req, res) => {
  const rawBody = req.body || "";
  const signature = req.get("x-line-signature") || "";

  if (!verifyLineSignature(rawBody, signature)) {
    return res.status(401).send("Invalid signature");
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return res.status(400).send("Invalid JSON");
  }

  // LINE recommends quick webhook acknowledgement. Continue work asynchronously.
  res.sendStatus(200);
  void handleWebhook(body).catch((error) => console.error("handleWebhook error", error));
});

function verifyLineSignature(rawBody, signature) {
  if (!process.env.LINE_CHANNEL_SECRET || !signature) return false;
  const expected = crypto
    .createHmac("sha256", process.env.LINE_CHANNEL_SECRET)
    .update(rawBody)
    .digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function handleWebhook(body) {
  const events = Array.isArray(body.events) ? body.events : [];
  for (const event of events) {
    try {
      if (event.type === "join") {
        await handleJoin(event);
        continue;
      }
      if (event.type !== "message" || event.message?.type !== "text") continue;
      await handleTextMessage(event);
    } catch (error) {
      console.error("Event error", event?.webhookEventId, error);
      if (event.replyToken) {
        await safeReply(event.replyToken, "剛剛有一顆小齒輪卡住了 ⚙️ 再試一次就好。 ");
      }
    }
  }
}

async function handleJoin(event) {
  if (event.source?.type !== "group") return;
  const groupId = event.source.groupId;
  let groupName = "Jeffery × LULU";
  try {
    const summary = await lineGet(`/v2/bot/group/${encodeURIComponent(groupId)}/summary`);
    groupName = summary.groupName || groupName;
  } catch (error) {
    console.warn("Could not fetch group summary", error.message);
  }

  await backend("register_group", { group_id: groupId, group_name: groupName });

  await safeReply(
    event.replyToken,
    `👋 我是 ${BOT_NAME}，Jeffery × LULU 的共同生活小管家。\n\n先完成兩個身分綁定：\nJeffery 輸入「我是 Jeffery」\nLULU 輸入「我是 LULU」\n\n之後可以直接跟我說：\n・幫我們新增 9/19 19:00 吃燒肉\n・記得買衛生紙和牛奶\n・待辦：訂飯店\n・想去：台南某某咖啡\n・@我 這週我們有什麼行程？`
  );
}

async function handleTextMessage(event) {
  const source = event.source || {};
  const groupId = source.type === "group" ? source.groupId : null;
  const userId = source.userId;
  if (!userId) return;

  const originalText = String(event.message.text || "").trim();
  const text = stripSelfMention(event.message).trim();
  const mentioned = isBotMentioned(event.message);

  if (!shouldHandleMessage(text, mentioned, source.type)) return;

  if (groupId) {
    // Upsert group in case the join event was missed during setup.
    await backend("register_group", { group_id: groupId, group_name: "" }).catch(() => null);
  }

  const targetId = groupId || userId;
  const profile = await getLineProfile(source, userId).catch(() => ({ displayName: "" }));
  const userRecord = await backend("get_user", { user_id: userId }).catch(() => ({ found: false }));
  const boundName = userRecord?.found ? userRecord.name : null;

  const bindMatch = text.match(/^我是\s*(Jeffery|LULU)\s*$/i);
  if (bindMatch) {
    const name = bindMatch[1].toLowerCase() === "lulu" ? "LULU" : "Jeffery";
    const result = await backend("bind_user", {
      user_id: userId,
      name,
      display_name: profile.displayName || "",
      group_id: groupId || "",
    });

    if (result.ok) {
      await safeReply(event.replyToken, `✅ 綁定完成！以後我知道你是 ${name} 了。`);
    } else {
      await safeReply(event.replyToken, result.message || "這個身分目前無法綁定，請檢查是否已被另一個 LINE 帳號使用。");
    }
    return;
  }

  const ctx = {
    sourceType: source.type,
    groupId,
    targetId,
    userId,
    boundName,
    profileName: profile.displayName || "",
    speaker: boundName || profile.displayName || "未綁定使用者",
    originalText,
    text,
  };

  const reply = await runAssistant(ctx);
  if (reply?.text) {
    await safeReplyWithCalendar(event.replyToken, reply.text, reply.calendarEvent || null);
  }
}

function shouldHandleMessage(text, mentioned, sourceType) {
  if (sourceType !== "group") return true;
  if (mentioned) return true;
  if (/^我是\s*(Jeffery|LULU)\s*$/i.test(text)) return true;

  // Explicit life-management language can work without @mention.
  const functional = [
    /幫我(們)?(記|新增|加入|安排|查|看)/,
    /記得(買|提醒|帶|繳|訂)/,
    /(新增|加入|取消|修改).*(行程|約|聚餐|旅行|提醒)/,
    /^(採買|待辦|想去|想吃|想買)\s*[:：]/,
    /(買了|完成了|做完了)\s*$/,
    /(這週|本週|下週|這個月|本月).*(行程|安排|空檔)/,
    /還有什麼(沒買|沒做|要買|待辦)/,
  ];
  return functional.some((pattern) => pattern.test(text));
}

function isBotMentioned(message) {
  return Boolean(message?.mention?.mentionees?.some((m) => m?.isSelf === true));
}

function stripSelfMention(message) {
  let text = String(message?.text || "");
  const mentions = (message?.mention?.mentionees || [])
    .filter((m) => m?.isSelf === true && Number.isInteger(m.index) && Number.isInteger(m.length))
    .sort((a, b) => b.index - a.index);

  for (const m of mentions) {
    text = text.slice(0, m.index) + text.slice(m.index + m.length);
  }
  return text.replace(/^\s*[,，:：-]?\s*/, "");
}

async function runAssistant(ctx) {
  const key = ctx.groupId || ctx.userId;
  const history = histories.get(key) || [];
  const localNow = getTaipeiNowString();

  let input = [
    {
      role: "developer",
      content: buildSystemPrompt(ctx, localNow),
    },
    ...history,
    {
      role: "user",
      content: `${ctx.speaker}：${ctx.text}`,
    },
  ];

  let finalText = "";
  let calendarEvent = null;

  for (let round = 0; round < 4; round++) {
    const response = await openai.responses.create({
      model: MODEL,
      reasoning: { effort: "low" },
      input,
      tools: LIFE_TOOLS,
      max_output_tokens: 1000,
    });

    input.push(...response.output);
    const calls = response.output.filter((item) => item.type === "function_call");

    if (calls.length === 0) {
      finalText = response.output_text?.trim() || "";
      break;
    }

    for (const call of calls) {
      let args = {};
      try {
        args = JSON.parse(call.arguments || "{}");
      } catch {
        args = {};
      }

      const result = await executeTool(call.name, args, ctx);
      if ((call.name === "create_event" || call.name === "update_event") && result?.ok && result?.calendar_url) {
        calendarEvent = result;
      }
      input.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: JSON.stringify(result),
      });
    }
  }

  if (!finalText) finalText = "我有收到，但這次沒有成功整理成回覆。再傳一次給我就好。";

  pushHistory(key, { role: "user", content: `${ctx.speaker}：${ctx.text}` });
  pushHistory(key, { role: "assistant", content: finalText });
  return { text: finalText, calendarEvent };
}

function buildSystemPrompt(ctx, localNow) {
  return `你是「${BOT_NAME}」，Jeffery 與 LULU 共用的 LINE 生活助理。\n
現在時間：${localNow}（${TIMEZONE}，UTC+8）。\n發話者：${ctx.speaker}${ctx.boundName ? "（已綁定）" : "（尚未綁定）"}。\n
你的任務：\n1. 自然聊天時，用繁體中文、簡潔、溫暖、有一點幽默感，不要過度插話。\n2. 行程、採買、待辦、想去/想吃/想買清單，必須使用工具讀寫真實資料。\n3. 絕對不要在工具失敗時說「已完成」「已新增」。只有工具回傳 ok=true 才能確認成功。\n4. 使用者用「今天、明天、下週六」等相對日期時，依上面的台北時間換算。\n5. 建立有時間的行程時，start 使用 ISO 8601 +08:00，例如 2026-09-19T19:00:00+08:00。若沒有結束時間，end 傳 null，系統預設 2 小時。\n6. 如果使用者只說日期但完全沒有時間，先簡短詢問時間，不要擅自填一個時刻。\n7. 若尚未綁定身分卻要新增/修改資料，請請他先輸入「我是 Jeffery」或「我是 LULU」。\n8. 查詢行程時，優先使用 list_events；查清單時使用 list_items。\n9. 「記得買」通常是 shopping；「要做/待辦」是 todo；「想去/想吃/想買」是 wishlist。\n10. 若工具回傳 ambiguous=true，列出候選並請使用者指定，不要自行刪除或修改。\n11. 回覆適合 LINE 閱讀，不要用複雜 Markdown 表格。`;
}

const LIFE_TOOLS = [
  {
    type: "function",
    name: "create_event",
    description: "Create a shared calendar event for Jeffery and LULU.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        start: { type: "string", description: "ISO 8601 datetime with +08:00" },
        end: { type: ["string", "null"], description: "ISO 8601 datetime or null" },
        location: { type: ["string", "null"] },
        notes: { type: ["string", "null"] },
      },
      required: ["title", "start", "end", "location", "notes"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "list_events",
    description: "List shared calendar events in a date range.",
    parameters: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "YYYY-MM-DD" },
        end_date: { type: "string", description: "YYYY-MM-DD inclusive" },
      },
      required: ["start_date", "end_date"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "update_event",
    description: "Update one existing future calendar event. Query should identify its title; date can narrow the match.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        date: { type: ["string", "null"], description: "YYYY-MM-DD or null" },
        new_title: { type: ["string", "null"] },
        new_start: { type: ["string", "null"], description: "ISO 8601 datetime or null" },
        new_end: { type: ["string", "null"], description: "ISO 8601 datetime or null" },
        new_location: { type: ["string", "null"] },
        new_notes: { type: ["string", "null"] },
      },
      required: ["query", "date", "new_title", "new_start", "new_end", "new_location", "new_notes"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "cancel_event",
    description: "Cancel one future event. If multiple events match, do not cancel and return candidates.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        date: { type: ["string", "null"], description: "YYYY-MM-DD or null" },
      },
      required: ["query", "date"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "add_list_item",
    description: "Add an item to shopping, todo, or wishlist.",
    parameters: {
      type: "object",
      properties: {
        list_type: { type: "string", enum: ["shopping", "todo", "wishlist"] },
        item: { type: "string" },
        category: { type: ["string", "null"] },
        assigned_to: { type: ["string", "null"], description: "Jeffery, LULU, both, or null" },
        due_at: { type: ["string", "null"], description: "ISO 8601 datetime or null" },
        notes: { type: ["string", "null"] },
      },
      required: ["list_type", "item", "category", "assigned_to", "due_at", "notes"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "list_items",
    description: "List shopping, todo, or wishlist items.",
    parameters: {
      type: "object",
      properties: {
        list_type: { type: "string", enum: ["shopping", "todo", "wishlist"] },
        status: { type: "string", enum: ["open", "done", "all"] },
      },
      required: ["list_type", "status"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "complete_list_item",
    description: "Mark one shopping or todo item as completed. Can also mark a wishlist item as done/visited.",
    parameters: {
      type: "object",
      properties: {
        list_type: { type: "string", enum: ["shopping", "todo", "wishlist"] },
        query: { type: "string" },
      },
      required: ["list_type", "query"],
      additionalProperties: false,
    },
    strict: true,
  },
];

async function executeTool(name, args, ctx) {
  const mutating = new Set(["create_event", "update_event", "cancel_event", "add_list_item", "complete_list_item"]);
  if (mutating.has(name) && !ctx.boundName) {
    return {
      ok: false,
      error: "identity_required",
      message: "請先綁定身分：輸入「我是 Jeffery」或「我是 LULU」。",
    };
  }

  const common = {
    created_by: ctx.boundName || ctx.speaker,
    actor: ctx.boundName || ctx.speaker,
    group_id: ctx.targetId,
  };

  switch (name) {
    case "create_event":
      return backend("create_event", { ...args, ...common });
    case "list_events":
      return backend("list_events", { ...args, group_id: ctx.targetId });
    case "update_event":
      return backend("update_event", { ...args, ...common });
    case "cancel_event":
      return backend("cancel_event", { ...args, ...common });
    case "add_list_item":
      return backend("add_list_item", { ...args, ...common });
    case "list_items":
      return backend("list_items", { ...args, group_id: ctx.targetId });
    case "complete_list_item":
      return backend("complete_list_item", { ...args, ...common });
    default:
      return { ok: false, error: "unknown_tool", name };
  }
}

async function backend(action, payload = {}) {
  const response = await fetch(process.env.APPS_SCRIPT_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: process.env.APPS_SCRIPT_TOKEN,
      action,
      payload,
    }),
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Apps Script returned non-JSON (${response.status}): ${text.slice(0, 300)}`);
  }
  if (!response.ok || data?.ok === false && data?.error === "unauthorized") {
    throw new Error(data?.message || data?.error || `Apps Script error ${response.status}`);
  }
  return data;
}

async function getLineProfile(source, userId) {
  if (source.type === "group" && source.groupId) {
    return lineGet(`/v2/bot/group/${encodeURIComponent(source.groupId)}/member/${encodeURIComponent(userId)}`);
  }
  return lineGet(`/v2/bot/profile/${encodeURIComponent(userId)}`);
}

async function lineGet(path) {
  const response = await fetch(`https://api.line.me${path}`, {
    headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
  });
  if (!response.ok) throw new Error(`LINE GET ${path}: ${response.status} ${await response.text()}`);
  return response.json();
}

function buildCalendarFlexMessage(eventData) {
  if (!eventData?.calendar_url) return null;
  const locationContents = eventData.location
    ? [{ type: "text", text: `📍 ${eventData.location}`, size: "sm", wrap: true }]
    : [];
  return {
    type: "flex",
    altText: `📅 ${eventData.title || "Jeffery × LULU 共同行程"}`,
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: "JEFFERY × LULU", size: "xs", weight: "bold" },
          { type: "text", text: eventData.title || "共同行程", size: "xl", weight: "bold", wrap: true },
          { type: "text", text: `🕒 ${eventData.start || ""}`, size: "sm", wrap: true },
          ...locationContents,
          { type: "text", text: "🔔 前一天 + 前 1 小時提醒", size: "xs", wrap: true },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "button",
            style: "primary",
            action: {
              type: "uri",
              label: "開啟 Google 行事曆",
              uri: eventData.calendar_url,
            },
          },
        ],
      },
    },
  };
}

async function safeReplyWithCalendar(replyToken, text, eventData) {
  const messages = [{ type: "text", text: trimLineText(text) }];
  const calendarCard = buildCalendarFlexMessage(eventData);
  if (calendarCard) messages.push(calendarCard);
  return safeReplyMessages(replyToken, messages);
}

async function safeReplyMessages(replyToken, messages) {
  if (!replyToken || !Array.isArray(messages) || !messages.length) return;
  try {
    const response = await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ replyToken, messages: messages.slice(0, 5) }),
    });
    if (!response.ok) console.error("LINE reply failed", response.status, await response.text());
  } catch (error) {
    console.error("LINE reply error", error);
  }
}

async function safeReply(replyToken, text) {
  if (!replyToken || !text) return;
  return safeReplyMessages(replyToken, [{ type: "text", text: trimLineText(text) }]);
}

function pushHistory(key, item) {
  const history = histories.get(key) || [];
  history.push(item);
  while (history.length > MAX_HISTORY_MESSAGES) history.shift();
  histories.set(key, history);
}

function getTaipeiNowString() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second} (${map.weekday})`;
}

function trimLineText(text) {
  const clean = String(text).trim();
  return clean.length <= 4900 ? clean : clean.slice(0, 4890) + "\n…";
}

app.listen(PORT, () => console.log(`${BOT_NAME} listening on port ${PORT}`));
