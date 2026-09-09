import express from "express";
import crypto from "crypto";
import OpenAI from "openai";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const TIMEZONE = process.env.TIMEZONE || "Asia/Taipei";
const BOT_NAME = process.env.BOT_NAME || "J&L小管家";
const MODEL = process.env.OPENAI_MODEL || "gpt-5.6-luna";
const REASONING = process.env.AI_REASONING_EFFORT || "none";
const MAX_OUTPUT = Number(process.env.AI_MAX_OUTPUT_TOKENS || 400);

for (const key of ["LINE_CHANNEL_SECRET", "LINE_CHANNEL_ACCESS_TOKEN", "OPENAI_API_KEY", "APPS_SCRIPT_URL", "APPS_SCRIPT_TOKEN"]) {
  if (!process.env[key]) console.warn(`[WARN] Missing env: ${key}`);
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const identities = new Map();
const histories = new Map();
const IDENTITY_TTL = 6 * 60 * 60 * 1000;
const MAX_HISTORY = 4;

app.get("/", (_req, res) => res.type("text").send(`${BOT_NAME} v0.3 fast mode is running.`));
app.get("/health", (_req, res) => res.json({ ok: true, version: "0.3", fastMode: true, bot: BOT_NAME, model: MODEL, reasoning: REASONING }));

app.post("/webhook", express.text({ type: "*/*", limit: "2mb" }), (req, res) => {
  const raw = req.body || "";
  const signature = req.get("x-line-signature") || "";
  if (!verifySignature(raw, signature)) return res.status(401).send("Invalid signature");

  let body;
  try { body = JSON.parse(raw); }
  catch { return res.status(400).send("Invalid JSON"); }

  res.sendStatus(200);
  void handleWebhook(body).catch(err => console.error("handleWebhook error", err));
});

function verifySignature(raw, signature) {
  if (!process.env.LINE_CHANNEL_SECRET || !signature) return false;
  const expected = crypto.createHmac("sha256", process.env.LINE_CHANNEL_SECRET).update(raw).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function handleWebhook(body) {
  for (const event of Array.isArray(body.events) ? body.events : []) {
    try {
      if (event.type === "join") { await handleJoin(event); continue; }
      if (event.type !== "message" || event.message?.type !== "text") continue;
      await handleText(event);
    } catch (err) {
      console.error("Event error", event?.webhookEventId, err);
      if (event.replyToken) await reply(event.replyToken, friendlyError(err));
    }
  }
}

function friendlyError(err) {
  if (err?.status === 429 || err?.code === "insufficient_quota") return "AI 額度目前不足，請稍後再試。";
  return "剛剛有一顆小齒輪卡住了 ⚙️ 再試一次就好。";
}

async function handleJoin(event) {
  if (event.source?.type !== "group") return;
  const groupId = event.source.groupId;
  let groupName = "Jeffery × LULU";
  try {
    const info = await lineGet(`/v2/bot/group/${encodeURIComponent(groupId)}/summary`);
    groupName = info.groupName || groupName;
  } catch {}
  await backend("register_group", { group_id: groupId, group_name: groupName });
  await reply(event.replyToken,
    `👋 我是 ${BOT_NAME}，Jeffery × LULU 的共同生活小管家。\n\n` +
    `Jeffery 輸入「我是 Jeffery」\nLULU 輸入「我是 LULU」\n\n` +
    `之後可以直接說：\n・記得買衛生紙和牛奶\n・待辦：訂飯店\n・想去：台南某某咖啡\n・幫我們新增明天晚上 7 點吃燒肉`
  );
}

async function handleText(event) {
  const source = event.source || {};
  const groupId = source.type === "group" ? source.groupId : null;
  const userId = source.userId;
  if (!userId) return;

  const text = stripSelfMention(event.message).trim();
  const mentioned = isBotMentioned(event.message);
  if (!shouldHandle(text, mentioned, source.type)) return;

  const bind = text.match(/^我是\s*(Jeffery|LULU)\s*$/i);
  if (bind) {
    const name = bind[1].toLowerCase() === "lulu" ? "LULU" : "Jeffery";
    const profile = await getLineProfile(source, userId).catch(() => ({ displayName: "" }));
    const result = await backend("bind_user", { user_id: userId, name, display_name: profile.displayName || "", group_id: groupId || "" });
    if (result?.ok) {
      identities.set(userId, { boundName: name, displayName: profile.displayName || "", at: Date.now() });
      await reply(event.replyToken, `✅ 綁定完成！以後我知道你是 ${name} 了。`);
    } else {
      await reply(event.replyToken, result?.message || "這個身分目前無法綁定。");
    }
    return;
  }

  const identity = await getIdentity(source, userId);
  const ctx = {
    sourceType: source.type,
    groupId,
    targetId: groupId || userId,
    userId,
    boundName: identity.boundName,
    speaker: identity.boundName || identity.displayName || "未綁定使用者",
    text,
  };

  const fast = await fastCommand(ctx);
  if (fast) { await reply(event.replyToken, fast); return; }

  const result = await aiAssistant(ctx);
  if (result?.text) await replyWithCalendar(event.replyToken, result.text, result.calendarEvent);
}

async function getIdentity(source, userId) {
  const cached = identities.get(userId);
  if (cached && Date.now() - cached.at < IDENTITY_TTL) return cached;

  const user = await backend("get_user", { user_id: userId }).catch(() => ({ found: false }));
  if (user?.found) {
    const value = { boundName: user.name, displayName: user.name, at: Date.now() };
    identities.set(userId, value);
    return value;
  }

  const profile = await getLineProfile(source, userId).catch(() => ({ displayName: "" }));
  const value = { boundName: null, displayName: profile.displayName || "", at: Date.now() };
  identities.set(userId, value);
  return value;
}

async function fastCommand(ctx) {
  const t = ctx.text;
  let m;

  m = t.match(/^(?:幫我(?:們)?\s*)?(?:記得)?買\s*(.+)$/) || t.match(/^(?:採買|購物)\s*[:：]\s*(.+)$/);
  if (m) {
    if (!ctx.boundName) return needIdentity();
    const items = splitItems(m[1]);
    const added = [];
    for (const item of items) {
      const r = await backend("add_list_item", common(ctx, { list_type: "shopping", item, category: null, assigned_to: null, due_at: null, notes: null }));
      if (r?.ok) added.push(r.item || item);
    }
    return added.length ? `🛒 已加入採買清單\n${added.map(x => `□ ${x}`).join("\n")}` : "這次沒有成功加入採買清單。";
  }

  m = t.match(/^(?:待辦|todo)\s*[:：]\s*(.+)$/i);
  if (!m) {
    const x = t.match(/^記得(?:要)?\s*(繳|訂|帶|處理|做)\s*(.+)$/);
    if (x) m = [x[0], `${x[1]}${x[2]}`];
  }
  if (m) {
    if (!ctx.boundName) return needIdentity();
    const item = m[1].trim();
    const r = await backend("add_list_item", common(ctx, { list_type: "todo", item, category: null, assigned_to: null, due_at: null, notes: null }));
    return r?.ok ? `✅ 已加入共同待辦\n□ ${r.item || item}` : (r?.message || "這次沒有成功加入待辦。");
  }

  m = t.match(/^(想去|想吃|想買)\s*[:：]\s*(.+)$/);
  if (m) {
    if (!ctx.boundName) return needIdentity();
    const item = m[2].trim();
    const r = await backend("add_list_item", common(ctx, { list_type: "wishlist", item, category: m[1], assigned_to: null, due_at: null, notes: null }));
    return r?.ok ? `💛 已收藏到 Wishlist\n☆ ${r.item || item}` : (r?.message || "這次沒有成功收藏。");
  }

  m = t.match(/^(.+?)(?:已)?買(?:好)?了$/);
  if (m) return completeItem(ctx, "shopping", m[1].trim(), "🛒");
  m = t.match(/^(.+?)(?:完成了|做完了)$/);
  if (m) return completeItem(ctx, "todo", m[1].trim(), "✅");

  if (/(?:還有什麼.*(?:沒買|要買)|採買清單|購物清單)/.test(t)) {
    return formatList(await backend("list_items", { list_type: "shopping", status: "open", group_id: ctx.targetId }), "🛒 共同採買");
  }
  if (/(?:還有什麼.*(?:沒做|待辦)|待辦清單)/.test(t)) {
    return formatList(await backend("list_items", { list_type: "todo", status: "open", group_id: ctx.targetId }), "✅ 共同待辦");
  }
  if (/(?:有哪些|有什麼).*(?:想去|想吃|想買)|wishlist/i.test(t)) {
    return formatList(await backend("list_items", { list_type: "wishlist", status: "open", group_id: ctx.targetId }), "💛 Wishlist");
  }

  const rangeWord = (t.match(/(這週|本週|下週|這個月|本月)/) || [])[1];
  if (rangeWord && /(行程|安排)/.test(t)) {
    const range = dateRange(rangeWord);
    return formatEvents(await backend("list_events", { ...range, group_id: ctx.targetId }), rangeWord);
  }

  return null;
}

function needIdentity() { return "請先綁定身分：輸入「我是 Jeffery」或「我是 LULU」。"; }

function common(ctx, payload) {
  return { ...payload, created_by: ctx.boundName || ctx.speaker, actor: ctx.boundName || ctx.speaker, group_id: ctx.targetId };
}

function splitItems(s) {
  return String(s || "").split(/[、,，]|\s+和\s*|和(?=[\u4e00-\u9fffA-Za-z0-9])/).map(x => x.trim()).filter(Boolean).slice(0, 10);
}

async function completeItem(ctx, type, query, icon) {
  if (!ctx.boundName) return needIdentity();
  const r = await backend("complete_list_item", common(ctx, { list_type: type, query }));
  if (r?.ambiguous) return `我找到不只一個符合項目：\n${(r.candidates || []).map(x => `・${x.item}`).join("\n")}\n請再說得更明確一點。`;
  return r?.ok ? `${icon} 已完成：${r.item || query}` : (r?.message || "找不到這個尚未完成的項目。");
}

function formatList(r, title) {
  if (!r?.ok) return r?.message || `${title} 查詢失敗。`;
  const items = r.items || [];
  if (!items.length) return `${title}\n目前沒有未完成項目 ✨`;
  return `${title}（${items.length}）\n${items.slice(0, 20).map(x => `□ ${x.item}${x.assigned_to ? `｜${x.assigned_to}` : ""}`).join("\n")}`;
}

function formatEvents(r, label) {
  if (!r?.ok) return r?.message || "行程查詢失敗。";
  const events = r.events || [];
  if (!events.length) return `📅 ${label}目前沒有行程。`;
  return `📅 ${label}行程（${events.length}）\n${events.slice(0, 15).map(e => `・${e.start}｜${e.title}${e.location ? `｜📍${e.location}` : ""}`).join("\n")}`;
}

function dateRange(word) {
  const p = localDateParts();
  const today = new Date(Date.UTC(p.year, p.month - 1, p.day));
  const monday = new Date(today.getTime() - ((today.getUTCDay() + 6) % 7) * 86400000);
  let start, end;
  if (word === "下週") {
    start = new Date(monday.getTime() + 7 * 86400000);
    end = new Date(start.getTime() + 6 * 86400000);
  } else if (word === "這週" || word === "本週") {
    start = monday;
    end = new Date(start.getTime() + 6 * 86400000);
  } else {
    start = new Date(Date.UTC(p.year, p.month - 1, 1));
    end = new Date(Date.UTC(p.year, p.month, 0));
  }
  return { start_date: ymd(start), end_date: ymd(end) };
}

function localDateParts() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const m = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return { year: Number(m.year), month: Number(m.month), day: Number(m.day) };
}
function ymd(d) { return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`; }

function shouldHandle(text, mentioned, sourceType) {
  if (sourceType !== "group" || mentioned || /^我是\s*(Jeffery|LULU)\s*$/i.test(text)) return true;
  return [
    /幫我(們)?(記|新增|加入|安排|查|看)/,
    /記得(買|提醒|帶|繳|訂|做|處理)/,
    /(新增|加入|取消|修改).*(行程|約|聚餐|旅行|提醒)/,
    /^(採買|購物|待辦|想去|想吃|想買)\s*[:：]/,
    /(買了|完成了|做完了)\s*$/,
    /(這週|本週|下週|這個月|本月).*(行程|安排|空檔)/,
    /還有什麼(沒買|沒做|要買|待辦)/,
    /(採買|購物|待辦)清單/,
  ].some(re => re.test(text));
}

function isBotMentioned(message) {
  return Boolean(message?.mention?.mentionees?.some(m => m?.isSelf === true));
}

function stripSelfMention(message) {
  let text = String(message?.text || "");
  const mentions = (message?.mention?.mentionees || []).filter(m => m?.isSelf && Number.isInteger(m.index) && Number.isInteger(m.length)).sort((a, b) => b.index - a.index);
  for (const m of mentions) text = text.slice(0, m.index) + text.slice(m.index + m.length);
  return text.replace(/^\s*[,，:：-]?\s*/, "");
}

const STATIC_PROMPT = `你是 Jeffery 與 LULU 共用的 LINE 生活助理。請用繁體中文，簡潔自然。\n
行程、採買、待辦、Wishlist 的真實資料只能透過工具讀寫。工具失敗時不能假裝成功。\n
相對日期依台北時間。建立行程 start 使用 ISO 8601 +08:00；若沒有 end，傳 null。\n
如果使用者只說日期沒有時間，要先詢問時間。尚未綁定卻要修改資料，請要求輸入「我是 Jeffery」或「我是 LULU」。\n
查行程用 list_events，查清單用 list_items。工具回傳 ambiguous=true 時列出候選並詢問，不要自行決定。\n
回覆適合 LINE 閱讀，不要用 Markdown 表格，通常控制在 120 字內。`;

async function aiAssistant(ctx) {
  const key = ctx.groupId || ctx.userId;
  const history = histories.get(key) || [];
  let input = [
    { role: "developer", content: STATIC_PROMPT },
    { role: "developer", content: `現在時間：${taipeiNow()}。發話者：${ctx.speaker}${ctx.boundName ? "（已綁定）" : "（尚未綁定）"}。` },
    ...history,
    { role: "user", content: `${ctx.speaker}：${ctx.text}` },
  ];

  let text = "";
  let calendarEvent = null;
  for (let round = 0; round < 3; round++) {
    const response = await openai.responses.create({
      model: MODEL,
      reasoning: { effort: REASONING },
      text: { verbosity: "low" },
      max_output_tokens: MAX_OUTPUT,
      input,
      tools: TOOLS,
    });
    input.push(...response.output);
    const calls = response.output.filter(x => x.type === "function_call");
    if (!calls.length) { text = response.output_text?.trim() || ""; break; }

    for (const call of calls) {
      let args = {};
      try { args = JSON.parse(call.arguments || "{}"); } catch {}
      const r = await executeTool(call.name, args, ctx);
      if ((call.name === "create_event" || call.name === "update_event") && r?.ok && r?.calendar_url) calendarEvent = r;
      input.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(r) });
    }
  }

  if (!text) text = "我有收到，但這次沒有成功整理成回覆。再傳一次給我就好。";
  remember(key, { role: "user", content: `${ctx.speaker}：${ctx.text}` });
  remember(key, { role: "assistant", content: text });
  return { text, calendarEvent };
}

const nullableString = { type: ["string", "null"] };
const TOOLS = [
  { type: "function", name: "create_event", description: "Create a shared calendar event.", strict: true, parameters: { type: "object", properties: { title: { type: "string" }, start: { type: "string" }, end: nullableString, location: nullableString, notes: nullableString }, required: ["title", "start", "end", "location", "notes"], additionalProperties: false } },
  { type: "function", name: "list_events", description: "List shared events in an inclusive date range.", strict: true, parameters: { type: "object", properties: { start_date: { type: "string" }, end_date: { type: "string" } }, required: ["start_date", "end_date"], additionalProperties: false } },
  { type: "function", name: "update_event", description: "Update one future event.", strict: true, parameters: { type: "object", properties: { query: { type: "string" }, date: nullableString, new_title: nullableString, new_start: nullableString, new_end: nullableString, new_location: nullableString, new_notes: nullableString }, required: ["query", "date", "new_title", "new_start", "new_end", "new_location", "new_notes"], additionalProperties: false } },
  { type: "function", name: "cancel_event", description: "Cancel one future event.", strict: true, parameters: { type: "object", properties: { query: { type: "string" }, date: nullableString }, required: ["query", "date"], additionalProperties: false } },
  { type: "function", name: "add_list_item", description: "Add shopping, todo, or wishlist item.", strict: true, parameters: { type: "object", properties: { list_type: { type: "string", enum: ["shopping", "todo", "wishlist"] }, item: { type: "string" }, category: nullableString, assigned_to: nullableString, due_at: nullableString, notes: nullableString }, required: ["list_type", "item", "category", "assigned_to", "due_at", "notes"], additionalProperties: false } },
  { type: "function", name: "list_items", description: "List items.", strict: true, parameters: { type: "object", properties: { list_type: { type: "string", enum: ["shopping", "todo", "wishlist"] }, status: { type: "string", enum: ["open", "done", "all"] } }, required: ["list_type", "status"], additionalProperties: false } },
  { type: "function", name: "complete_list_item", description: "Complete one list item.", strict: true, parameters: { type: "object", properties: { list_type: { type: "string", enum: ["shopping", "todo", "wishlist"] }, query: { type: "string" } }, required: ["list_type", "query"], additionalProperties: false } },
];

async function executeTool(name, args, ctx) {
  if (["create_event", "update_event", "cancel_event", "add_list_item", "complete_list_item"].includes(name) && !ctx.boundName) {
    return { ok: false, error: "identity_required", message: needIdentity() };
  }
  const c = { created_by: ctx.boundName || ctx.speaker, actor: ctx.boundName || ctx.speaker, group_id: ctx.targetId };
  if (name === "create_event") return backend("create_event", { ...args, ...c });
  if (name === "list_events") return backend("list_events", { ...args, group_id: ctx.targetId });
  if (name === "update_event") return backend("update_event", { ...args, ...c });
  if (name === "cancel_event") return backend("cancel_event", { ...args, ...c });
  if (name === "add_list_item") return backend("add_list_item", { ...args, ...c });
  if (name === "list_items") return backend("list_items", { ...args, group_id: ctx.targetId });
  if (name === "complete_list_item") return backend("complete_list_item", { ...args, ...c });
  return { ok: false, error: "unknown_tool" };
}

async function backend(action, payload = {}) {
  const r = await fetch(process.env.APPS_SCRIPT_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: process.env.APPS_SCRIPT_TOKEN, action, payload }),
  });
  const raw = await r.text();
  let data;
  try { data = JSON.parse(raw); }
  catch { throw new Error(`Apps Script returned non-JSON (${r.status}): ${raw.slice(0, 250)}`); }
  if (!r.ok || (data?.ok === false && data?.error === "unauthorized")) throw new Error(data?.message || data?.error || `Apps Script ${r.status}`);
  return data;
}

async function getLineProfile(source, userId) {
  if (source.type === "group" && source.groupId) return lineGet(`/v2/bot/group/${encodeURIComponent(source.groupId)}/member/${encodeURIComponent(userId)}`);
  return lineGet(`/v2/bot/profile/${encodeURIComponent(userId)}`);
}
async function lineGet(path) {
  const r = await fetch(`https://api.line.me${path}`, { headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` } });
  if (!r.ok) throw new Error(`LINE GET ${r.status}: ${await r.text()}`);
  return r.json();
}

async function reply(token, text) {
  return replyMessages(token, [{ type: "text", text: trim(text) }]);
}
async function replyWithCalendar(token, text, eventData) {
  const messages = [{ type: "text", text: trim(text) }];
  const card = calendarCard(eventData);
  if (card) messages.push(card);
  return replyMessages(token, messages);
}
async function replyMessages(token, messages) {
  if (!token) return;
  const r = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ replyToken: token, messages: messages.slice(0, 5) }),
  });
  if (!r.ok) console.error("LINE reply failed", r.status, await r.text());
}

function calendarCard(e) {
  if (!e?.calendar_url) return null;
  return {
    type: "flex", altText: `📅 ${e.title || "Jeffery × LULU 共同行程"}`,
    contents: {
      type: "bubble",
      body: { type: "box", layout: "vertical", spacing: "md", contents: [
        { type: "text", text: "JEFFERY × LULU", size: "xs", weight: "bold" },
        { type: "text", text: e.title || "共同行程", size: "xl", weight: "bold", wrap: true },
        { type: "text", text: `🕒 ${e.start || ""}`, size: "sm", wrap: true },
        ...(e.location ? [{ type: "text", text: `📍 ${e.location}`, size: "sm", wrap: true }] : []),
        { type: "text", text: "🔔 前一天 + 前 1 小時提醒", size: "xs", wrap: true },
      ] },
      footer: { type: "box", layout: "vertical", contents: [{ type: "button", style: "primary", action: { type: "uri", label: "開啟 Google 行事曆", uri: e.calendar_url } }] },
    },
  };
}

function remember(key, item) {
  const h = histories.get(key) || [];
  h.push(item);
  while (h.length > MAX_HISTORY) h.shift();
  histories.set(key, h);
}
function taipeiNow() {
  return new Intl.DateTimeFormat("zh-TW", { timeZone: TIMEZONE, dateStyle: "full", timeStyle: "medium", hourCycle: "h23" }).format(new Date());
}
function trim(s) { const x = String(s || "").trim(); return x.length <= 4900 ? x : x.slice(0, 4890) + "\n…"; }

app.listen(PORT, () => console.log(`${BOT_NAME} v0.3 fast mode listening on port ${PORT}`));
