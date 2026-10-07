import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  downloadContentFromMessage,
  getContentType,
  proto,
  generateWAMessageFromContent,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import settings from './settings.js';
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import path from 'path';
import os from 'os';
import axios from 'axios';
import yts from 'yt-search';
import { Innertube, UniversalCache } from 'youtubei.js';
import Facebook from 'facebook-dl';
import * as DDG from 'duck-duck-scrape';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import http from 'http';
import { URL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = pino({ level: "silent" });
const phone = String(settings.PAIRING_NUMBER || "").replace(/\D/g, "");
let reconnectTimer = null;
let pairingReady = false;
let latestPairingCode = '';
let pairingServerStarted = false;
let ownerWelcomed = false;
const processedMessages = new Set();
const execFileAsync = promisify(execFile);

const AUTO_REPLY_TEXT = String(settings.AUTO_REPLY_TEXT || "𝑯𝒚 𝒌𝒐𝒎𝒅𝒂 𝒉𝒐𝒅𝒊𝒏 𝒊𝒏𝒏𝒘𝒅𝒂");
const AUTO_REPLY_STATE_FILE = path.join(__dirname, "auto_reply_state.json");
let autoReplyState = {};
const RUNTIME_SETTINGS_FILE = path.join(__dirname, "runtime_settings.json");
const GROUP_SETTINGS_FILE = path.join(__dirname, "group_settings.json");
const WARNINGS_FILE = path.join(__dirname, "group_warnings.json");
const BUG_REPORTS_FILE = path.join(__dirname, "bug_reports.json");
let groupSettings = {};
let groupWarnings = {};
const spamTracker = new Map();
const DEFAULT_BADWORDS = ["scam", "free money", "porn", "xxx"];
const INBOX_BADWORDS_FILE = path.join(__dirname, "inbox_badwords.json");
let inboxBadWords = [];

const ECONOMY_FILE = path.join(__dirname, "economy.json");
const PREMIUM_FILE = path.join(__dirname, "premium_users.json");
const STATS_FILE = path.join(__dirname, "bot_stats.json");
const BLOCKED_USERS_FILE = path.join(__dirname, "blocked_users.json");
const COMMAND_LOG_FILE = path.join(__dirname, "command_history.json");
let blockedUsers = loadJsonFile(BLOCKED_USERS_FILE, {});
let commandHistory = loadJsonFile(COMMAND_LOG_FILE, []);
let economy = {};
let premiumUsers = {};
let botStats = { messages: 0, commands: 0, groups: {}, users: {}, startedAt: Date.now() };
const floodTracker = new Map();
const PROFILE_FILE = path.join(__dirname, "profiles.json");
const MUSIC_QUEUE_FILE = path.join(__dirname, "music_queues.json");
let profiles = {};
let musicQueues = {};
function loadUserFeatures() { profiles = loadJsonFile(PROFILE_FILE, {}); musicQueues = loadJsonFile(MUSIC_QUEUE_FILE, {}); }
function saveUserFeatures() { saveJsonFile(PROFILE_FILE, profiles); saveJsonFile(MUSIC_QUEUE_FILE, musicQueues); }
function getProfile(jid) { if (!profiles[jid]) profiles[jid] = { name: "", bio: "", createdAt: Date.now() }; return profiles[jid]; }
function profileLevel(jid) { return getWallet(jid).level; }
async function downloadSongForQuery(query) {
  let url = query, title = "song";
  if (!/^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(query)) { const search = await yts(query); const video = search.videos?.[0]; if (!video?.url) throw new Error("YT_NOT_FOUND"); url = video.url; title = video.title || title; }
  if (settings.MEDIA_API_URL) { try { const m = await cobaltDownload(url, "audio"); if (m?.buffer?.length) return { buffer:m.buffer, mime:"audio/mpeg", fileName:m.filename || "song.mp3", title }; } catch {} }
  const id = extractYouTubeId(url); if (!id) throw new Error("YOUTUBE_ID_NOT_FOUND");
  try { const buffer = await youtubeAudioDownload(id); return { buffer, mime:"audio/mp4", fileName:`${String(title).replace(/[\\/:*?"<>|]/g,"_").slice(0,80)}.m4a`, title }; }
  catch { const f = await invidiousAudioDownload(id); return { buffer:f.buffer, mime:f.mime, fileName:`${String(title).replace(/[\\/:*?"<>|]/g,"_").slice(0,80)}.${f.extension}`, title }; }
}
loadUserFeatures();

function loadJsonFile(file, fallback) { try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback; } catch { return fallback; } }
function saveJsonFile(file, data) { try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch {} }
function loadAdvancedData() { economy = loadJsonFile(ECONOMY_FILE, {}); premiumUsers = loadJsonFile(PREMIUM_FILE, {}); botStats = loadJsonFile(STATS_FILE, botStats); if (!botStats.startedAt) botStats.startedAt = Date.now(); }
function getWallet(jid) { if (!economy[jid]) economy[jid] = { coins: 0, xp: 0, level: 1, lastDaily: 0, lastWork: 0 }; return economy[jid]; }
function levelForXp(xp) { return Math.max(1, Math.floor(Math.sqrt(Number(xp || 0) / 100)) + 1); }
function addXp(jid, amount=5) { const w=getWallet(jid); w.xp += amount; const old=w.level; w.level=levelForXp(w.xp); saveJsonFile(ECONOMY_FILE,economy); return {wallet:w, leveled:w.level>old}; }
function isPremium(jid) { const x=premiumUsers[jid]; return !!x && (!x.expiresAt || x.expiresAt > Date.now()); }
function formatDuration(ms) { let s=Math.floor(ms/1000), d=Math.floor(s/86400); s%=86400; let h=Math.floor(s/3600); s%=3600; let m=Math.floor(s/60); s%=60; return `${d}d ${h}h ${m}m ${s}s`; }

async function askSachiAI(prompt) {
  if (!settings.AI_API_URL || !settings.AI_API_KEY) throw new Error("AI_NOT_CONFIGURED");
  const r = await axios.post(settings.AI_API_URL, {
    model: settings.AI_MODEL,
    messages: [
      { role: "system", content: "You are SACHi, a friendly WhatsApp AI assistant. Answer clearly and concisely. If the user writes Sinhala, reply naturally in Sinhala. Do not claim you can perform actions you cannot actually perform." },
      { role: "user", content: String(prompt || "").trim() }
    ]
  }, {
    headers: { Authorization: `Bearer ${settings.AI_API_KEY}`, "Content-Type": "application/json" },
    timeout: 30000
  });
  return r.data?.choices?.[0]?.message?.content || r.data?.answer || "No AI response.";
}

function getSachiMentionPrompt(msg, body) {
  const text = String(body || "").trim();
  const mentioned = msg?.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
  const botId = String(msg?.key?.participant || "");
  const botMentioned = mentioned.some(j => String(j).split(":")[0] === botId.split(":")[0]);
  if (botMentioned) {
    return text.replace(/@[0-9]+/g, "").replace(/sachi[-_ ]?md/ig, "").trim();
  }
  const m = text.match(/^sachi(?:[-_ ]?md)?[\s,:-]+(.+)$/is);
  return m ? m[1].trim() : "";
}



async function ffmpegConvert(input, output, extraArgs = []) {
  await execFileAsync("ffmpeg", ["-y", "-i", input, ...extraArgs, output], { timeout: 30000 });
}

function safeCalc(expr) {
  const clean = String(expr || "").replace(/,/g, "").trim();
  if (!clean || !/^[0-9+\-*/%().\s^]+$/.test(clean)) throw new Error("INVALID_EXPRESSION");
  const js = clean.replace(/\^/g, "**");
  // eslint-disable-next-line no-new-func
  const value = Function(`"use strict"; return (${js})`)();
  if (!Number.isFinite(value)) throw new Error("INVALID_RESULT");
  return value;
}

function loadRuntimeSettings() {
  try {
    if (fs.existsSync(RUNTIME_SETTINGS_FILE)) {
      const x = JSON.parse(fs.readFileSync(RUNTIME_SETTINGS_FILE, "utf8"));
      if (x && typeof x === "object") Object.assign(settings, x);
    }
  } catch (e) { console.warn("[SETTINGS] Could not load runtime settings:", e?.message || e); }
  try {
    if (fs.existsSync(GROUP_SETTINGS_FILE)) {
      const x = JSON.parse(fs.readFileSync(GROUP_SETTINGS_FILE, "utf8"));
      if (x && typeof x === "object") groupSettings = x;
    }
    if (fs.existsSync(WARNINGS_FILE)) {
      const x = JSON.parse(fs.readFileSync(WARNINGS_FILE, "utf8"));
      if (x && typeof x === "object") groupWarnings = x;
    }
  } catch (e) { console.warn("[GROUP SETTINGS] Could not load:", e?.message || e); }
}

function saveRuntimeSettings() {
  try {
    const keys = ["AUTO_REACT","AUTO_READ","AUTO_STATUS","AUTO_REPLY_DAILY","ANTI_DELETE","BOT_MODE","PREFIX","VIEW_ONCE_OPEN_NOTIFY","VIEW_ONCE_AUTO_INBOX","VIEW_ONCE_NOTIFY_SCOPE","EDIT_NOTIFY","EDIT_NOTIFY_SCOPE","DELETE_NOTIFY_SCOPE","INBOX_ANTI_BADWORD"];
    const data = {}; for (const k of keys) data[k] = settings[k];
    fs.writeFileSync(RUNTIME_SETTINGS_FILE, JSON.stringify(data, null, 2));
  } catch (e) { console.error("[SETTINGS] Save failed:", e?.message || e); }
}

function saveGroupSettings() {
  try { fs.writeFileSync(GROUP_SETTINGS_FILE, JSON.stringify(groupSettings, null, 2)); }
  catch (e) { console.error("[GROUP SETTINGS] Save failed:", e?.message || e); }
}
function saveGroupWarnings() {
  try { fs.writeFileSync(WARNINGS_FILE, JSON.stringify(groupWarnings, null, 2)); }
  catch (e) { console.error("[WARNINGS] Save failed:", e?.message || e); }
}
function getGroupSettings(jid) {
  if (!groupSettings[jid]) groupSettings[jid] = { welcome: false, goodbye: false, antilink: false, antispam: false, antibadword: false, antimention: false, anticaps: false, antiflood: false, raidmode: false, aimod: false, smartai: false, warnlimit: 3, rules: "" };
  const cfg = groupSettings[jid];
  if (typeof cfg.antibadword !== "boolean") cfg.antibadword = false;
  if (!Number.isFinite(Number(cfg.warnlimit))) cfg.warnlimit = 3;
  if (typeof cfg.rules !== "string") cfg.rules = "";
  return cfg;
}
function getWarningCount(groupJid, userJid) {
  return Number(groupWarnings[groupJid]?.[userJid] || 0);
}
function setWarningCount(groupJid, userJid, count) {
  if (!groupWarnings[groupJid]) groupWarnings[groupJid] = {};
  if (count <= 0) delete groupWarnings[groupJid][userJid];
  else groupWarnings[groupJid][userJid] = count;
  saveGroupWarnings();
}
function getBadWords(cfg) {
  const custom = Array.isArray(cfg.badwords) ? cfg.badwords : [];
  return [...new Set([...DEFAULT_BADWORDS, ...custom].map(x => String(x).trim().toLowerCase()).filter(Boolean))];
}
function containsBadWord(text, cfg) {
  const normalized = String(text || "").toLowerCase();
  return getBadWords(cfg).find(w => normalized.includes(w));
}
function getInboxBadWords() {
  return [...new Set([...DEFAULT_BADWORDS, ...inboxBadWords]
    .map(x => String(x).trim().toLowerCase()).filter(Boolean))];
}
function containsInboxBadWord(text) {
  const normalized = String(text || "").toLowerCase();
  return getInboxBadWords().find(w => normalized.includes(w));
}
function saveInboxBadWords() {
  try { fs.writeFileSync(INBOX_BADWORDS_FILE, JSON.stringify(inboxBadWords, null, 2)); }
  catch (e) { console.error("[INBOX BADWORDS] Save failed:", e?.message || e); }
}
function loadInboxBadWords() {
  try {
    const x = fs.existsSync(INBOX_BADWORDS_FILE) ? JSON.parse(fs.readFileSync(INBOX_BADWORDS_FILE, "utf8")) : [];
    inboxBadWords = Array.isArray(x) ? x : [];
  } catch { inboxBadWords = []; }
}

loadRuntimeSettings();
loadInboxBadWords();
loadAdvancedData();

function sriLankaDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Colombo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function loadAutoReplyState() {
  try {
    if (fs.existsSync(AUTO_REPLY_STATE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(AUTO_REPLY_STATE_FILE, "utf8"));
      if (parsed && typeof parsed === "object") autoReplyState = parsed;
    }
  } catch (err) {
    console.warn("[AUTO-REPLY] Could not load state:", err?.message || err);
    autoReplyState = {};
  }
}

function saveAutoReplyState() {
  try {
    fs.writeFileSync(AUTO_REPLY_STATE_FILE, JSON.stringify(autoReplyState, null, 2));
  } catch (err) {
    console.error("[AUTO-REPLY] Could not save state:", err?.message || err);
  }
}

function shouldSendDailyAutoReply(jid) {
  const key = String(jid || "").split("@")[0].split(":")[0];
  if (!key) return false;
  const today = sriLankaDate();
  if (autoReplyState[key] === today) return false;
  autoReplyState[key] = today;
  saveAutoReplyState();
  return true;
}

loadAutoReplyState();
// Recent-message cache used for legitimate recovery of messages the bot has
// already received. Kept bounded to avoid unbounded memory growth.
const recentMessages = new Map();
const MAX_CACHED_MESSAGES = 500;

function cacheMessage(msg) {
  const id = msg?.key?.id;
  if (!id || !msg?.message) return;
  recentMessages.set(id, { msg, at: Date.now() });
  if (recentMessages.size > MAX_CACHED_MESSAGES) {
    const oldest = recentMessages.keys().next().value;
    if (oldest) recentMessages.delete(oldest);
  }
}

function messageType(m) {
  const x = unwrap(m);
  return getContentType(x);
}

function reactionTargetId(msg) {
  const x = msg?.message?.reactionMessage;
  return x?.key?.id || '';
}

function reactionText(msg) {
  return msg?.message?.reactionMessage?.text || '';
}

function isViewOnceMessage(msg) {
  const raw = msg?.message || {};
  return !!(raw.viewOnceMessage || raw.viewOnceMessageV2 ||
    raw.imageMessage?.viewOnce || raw.videoMessage?.viewOnce ||
    raw.viewOnceMessageExtension);
}

function normalizeNotifyScope(value, fallback = "both") {
  const v = String(value || "").toLowerCase().trim();
  return ["inbox", "group", "both"].includes(v) ? v : fallback;
}

function notifyScopeAllows(scope, chatJid) {
  const s = normalizeNotifyScope(scope);
  const isGroup = String(chatJid || "").endsWith("@g.us");
  if (s === "both") return true;
  return s === "group" ? isGroup : !isGroup;
}

const viewOnceOpenForwarded = new Set();

function isReadStatus(status) {
  // Baileys WAMessageStatus: ERROR=0, PENDING=1, SERVER_ACK=2,
  // DELIVERY_ACK=3, READ=4, PLAYED=5. View-once photos/videos use READ.
  return Number(status) === 4 || Number(status) === 5;
}

async function forwardViewOnceToOwner(sock, ownerJid, cached, reason = "Opened") {
  const id = cached?.key?.id;
  if (!id || viewOnceOpenForwarded.has(id)) return false;
  if (!isViewOnceMessage(cached)) return false;
  const raw = unwrap(cached.message);
  const type = getContentType(raw);
  if (type !== "imageMessage" && type !== "videoMessage") return false;
  const media = await downloadCachedMedia(cached);
  if (!media) return false;
  const chat = cached?.key?.remoteJid || "unknown";
  const sender = String(cached?.key?.participant || chat).split("@")[0].split(":")[0];
  const caption = `👁️ ${settings.BOT_NAME} — View-Once ${reason}\n👤 From: ${sender}\n📍 Chat: ${chat}\n🆔 ${id}\n${settings.FOOTER}`;
  if (media.type === "imageMessage") await sock.sendMessage(ownerJid, { image: media.buffer, caption });
  else await sock.sendMessage(ownerJid, { video: media.buffer, caption });
  viewOnceOpenForwarded.add(id);
  if (viewOnceOpenForwarded.size > 1000) {
    const first = viewOnceOpenForwarded.values().next().value;
    if (first) viewOnceOpenForwarded.delete(first);
  }
  console.log(`[VIEW-ONCE OPEN] ${id} (${reason}) -> ${ownerJid}`);
  return true;
}

async function autoSaveIncomingViewOnceToOwner(sock, ownerJid, msg) {
  try {
    if (!settings.VIEW_ONCE_AUTO_INBOX || !msg?.message || msg.key?.fromMe) return false;
    if (!isViewOnceMessage(msg)) return false;
    const remote = msg.key?.remoteJid || "";
    if (remote === "status@broadcast") return false;
    const type = messageType(msg);
    if (type !== "imageMessage" && type !== "videoMessage") return false;
    const media = await downloadCachedMedia(msg);
    if (!media) return false;
    const sender = String(msg.key?.participant || remote).split("@")[0].split(":")[0];
    const caption = `💾 ${settings.BOT_NAME} — AUTO VIEW-ONCE SAVE\n👤 From: ${sender}\n📍 Chat: ${remote}\n🆔 ${msg.key?.id || "unknown"}\n${settings.FOOTER}`;
    if (media.type === "imageMessage") await sock.sendMessage(ownerJid, { image: media.buffer, caption });
    else await sock.sendMessage(ownerJid, { video: media.buffer, caption });
    console.log(`[VIEW-ONCE AUTO] ${msg.key?.id || "unknown"} -> ${ownerJid}`);
    return true;
  } catch (e) {
    console.error("[VIEW-ONCE AUTO ERROR]", e?.message || e);
    return false;
  }
}

async function downloadCachedMedia(msg) {
  const x = unwrap(msg?.message);
  const type = getContentType(x);
  if (type === 'imageMessage') {
    return { type, buffer: await toBuffer(await downloadContentFromMessage(x.imageMessage, 'image'), 15 * 1024 * 1024), source: x.imageMessage };
  }
  if (type === 'videoMessage') {
    return { type, buffer: await toBuffer(await downloadContentFromMessage(x.videoMessage, 'video'), 20 * 1024 * 1024), source: x.videoMessage };
  }
  if (type === 'audioMessage') {
    return { type, buffer: await toBuffer(await downloadContentFromMessage(x.audioMessage, 'audio'), 20 * 1024 * 1024), source: x.audioMessage };
  }
  return null;
}

function cachedMessageSummary(msg) {
  const x = unwrap(msg?.message);
  const text = textOf(msg?.message);
  const type = getContentType(x);
  return { type, text, x };
}

function jidLabel(jid) {
  const s = String(jid || 'unknown');
  if (s === 'unknown') return s;
  if (s.endsWith('@g.us')) return 'Group';
  return `+${s.split('@')[0].split(':')[0].replace(/^\+/, '')}`;
}

// For delete-for-everyone protocol messages, the envelope key identifies the
// user/device that issued the revoke. In groups, participant is the deleter;
// in private chats, fromMe means the bot/owner deleted it, otherwise the chat
// peer is the deleter. This lets the owner see who actually performed delete.
function getDeleteActor(protocol, envelopeKey, deletedMsg, ownerJid) {
  const remote = envelopeKey?.remoteJid || deletedMsg?.key?.remoteJid || 'unknown';
  if (String(remote).endsWith('@g.us')) {
    return envelopeKey?.participant || deletedMsg?.key?.participant || 'unknown';
  }
  if (envelopeKey?.fromMe) return ownerJid || 'owner';
  return remote;
}

function deletedMessageHeader(deletedMsg, actorJid, protocolKeyId) {
  const chat = deletedMsg?.key?.remoteJid || 'unknown';
  const sender = deletedMsg?.key?.participant || deletedMsg?.key?.remoteJid || 'unknown';
  const type = cachedMessageSummary(deletedMsg).type || 'message';
  const scope = String(chat).endsWith('@g.us') ? '👥 Group' : '👤 Inbox';
  return `╭━━〔 🗑️ ${settings.BOT_NAME} 〕━━╮\n│\n│ 🚨 𝗗𝗘𝗟𝗘𝗧𝗘𝗗 𝗠𝗘𝗦𝗦𝗔𝗚𝗘\n│\n│ 👤 Deleted by : ${jidLabel(actorJid)}\n│ 📨 Sent by    : ${jidLabel(sender)}\n│ ${scope}\n│ 💬 Type       : ${type}\n│ 🆔 ID         : ${protocolKeyId || deletedMsg?.key?.id || 'unknown'}\n│\n╰━━━━━━━━━━━━━━━━━━━━╯`;
}

async function sendDeletedMessageToOwner(sock, ownerJid, deletedMsg, actorJid, protocolKeyId) {
  const summary = cachedMessageSummary(deletedMsg);
  const media = await downloadCachedMedia(deletedMsg);
  const header = deletedMessageHeader(deletedMsg, actorJid, protocolKeyId);
  if (media) {
    const caption = `${header}\n\n╭─〔 ♻️ RECOVERED CONTENT 〕─╮\n│ ${summary.text || '[media message]'}\n╰━━━━━━━━━━━━━━━━━━━━╯\n\n${settings.FOOTER}`;
    if (media.type === 'imageMessage') await sock.sendMessage(ownerJid, { image: media.buffer, caption });
    else if (media.type === 'videoMessage') await sock.sendMessage(ownerJid, { video: media.buffer, caption });
    else if (media.type === 'audioMessage') await sock.sendMessage(ownerJid, { audio: media.buffer, mimetype: media.source?.mimetype || 'audio/mp4', caption });
    return true;
  }
  const body = summary.text || '[media/message]';
  await sendBotText(sock, ownerJid, `${header}\n\n╭─〔 ♻️ RECOVERED CONTENT 〕─╮\n│ ${body}\n╰━━━━━━━━━━━━━━━━━━━━╯\n\n${settings.FOOTER}`);
  return true;
}

async function sendOwnerRecoveredMessage(sock, ownerJid, sourceMsg, label, extraText = '') {
  const summary = cachedMessageSummary(sourceMsg);
  const media = await downloadCachedMedia(sourceMsg);
  const remote = sourceMsg?.key?.remoteJid || 'unknown';
  const sender = sourceMsg?.key?.participant || sourceMsg?.key?.remoteJid || 'unknown';
  const senderText = String(sender).split('@')[0].split(':')[0];
  const header = `╭━━〔 👑 ${settings.BOT_NAME} 〕━━╮\n│\n│ ${label}\n│ 📍 Chat: ${remote}\n│ 👤 From: ${senderText}\n${extraText ? `│ ${extraText}\n` : ''}│\n╰━━━━━━━━━━━━━━━━━━━━╯`;
  if (media) {
    const caption = `${header}\n${settings.FOOTER}`;
    if (media.type === 'imageMessage') await sock.sendMessage(ownerJid, { image: media.buffer, caption });
    else if (media.type === 'videoMessage') await sock.sendMessage(ownerJid, { video: media.buffer, caption });
    else if (media.type === 'audioMessage') await sock.sendMessage(ownerJid, { audio: media.buffer, mimetype: media.source?.mimetype || 'audio/mp4', caption });
    return true;
  }
  await sendBotText(sock, ownerJid, `${header}\n${summary.text || '[media/message]'}\n\n${settings.FOOTER}`);
  return true;
}

function unwrap(m) {
  return m?.ephemeralMessage?.message ||
    m?.viewOnceMessage?.message ||
    m?.viewOnceMessageV2?.message ||
    m?.documentWithCaptionMessage?.message || m;
}

function textOf(m) {
  const x = unwrap(m);
  return (x?.conversation ||
    x?.extendedTextMessage?.text ||
    x?.imageMessage?.caption ||
    x?.videoMessage?.caption ||
    x?.documentMessage?.caption || "").trim();
}


async function sendBotText(sock, jid, text, quotedOptions = {}) {
  const clean = String(text ?? "");
  // Keep self-chat replies simple. This avoids rich-message decoding issues
  // that can show "Waiting for this message" on the phone's Message Yourself chat.
  return sock.sendMessage(jid, { text: clean }, quotedOptions);
}

async function sendMenuButtons(sock, jid, text, buttons, quotedOptions = {}) {
  // Buttons disabled: send the section as normal text only.
  return sendBotText(sock, jid, String(text || ""), quotedOptions);
}
async function sendImageWithButtons(sock, jid, imagePath, caption, buttons, quotedOptions = {}) {
  if (fs.existsSync(imagePath)) {
    return sock.sendMessage(jid, { image: fs.readFileSync(imagePath), caption: String(caption || "") }, quotedOptions);
  }
  return sendBotText(sock, jid, String(caption || ""), quotedOptions);
}

function quoteOptionsSafe(options) {
  // Buttons sent as a follow-up should not quote a potentially rich image message
  // in self-chat, which can trigger WhatsApp's "Waiting for this message" state.
  return options || {};
}

function buttonIdOf(m) {
  const x = unwrap(m);
  const nativeParams = x?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
  let nativeId = "";
  if (nativeParams) {
    try {
      const parsed = JSON.parse(nativeParams);
      nativeId = parsed?.id || parsed?.selected_id || parsed?.button_id || "";
    } catch {
      nativeId = "";
    }
  }
  return String(
    x?.buttonsResponseMessage?.selectedButtonId ||
    x?.templateButtonReplyMessage?.selectedId ||
    x?.listResponseMessage?.singleSelectReply?.selectedRowId ||
    nativeId ||
    ""
  ).trim();
}

function quotedOf(m) {
  const x = unwrap(m);
  return x?.extendedTextMessage?.contextInfo?.quotedMessage ||
    x?.imageMessage?.contextInfo?.quotedMessage ||
    x?.videoMessage?.contextInfo?.quotedMessage ||
    x?.documentMessage?.contextInfo?.quotedMessage || null;
}

async function toBuffer(stream, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > maxBytes) throw new Error("MEDIA_TOO_LARGE");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function cobaltDownload(sourceUrl, mode = "auto") {
  const apiUrl = String(settings.MEDIA_API_URL || "").trim().replace(/\/$/, "");
  if (!apiUrl) return null;

  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json"
  };
  if (settings.MEDIA_API_KEY) headers.Authorization = `Api-Key ${settings.MEDIA_API_KEY}`;

  const payload = {
    url: sourceUrl,
    downloadMode: mode,
    audioFormat: "mp3",
    audioBitrate: "128",
    videoQuality: "720",
    filenameStyle: "basic",
    youtubeVideoCodec: "h264"
  };

  const result = await axios.post(apiUrl, payload, {
    headers, timeout: 45000, maxContentLength: 2 * 1024 * 1024
  });
  const data = result?.data || {};
  if (data.status === "error") {
    throw new Error(`MEDIA_API_${data.error?.code || "FAILED"}`);
  }
  if (data.status !== "redirect" && data.status !== "tunnel") {
    throw new Error(`MEDIA_API_UNSUPPORTED_${data.status || "UNKNOWN"}`);
  }
  if (!data.url) throw new Error("MEDIA_API_NO_URL");

  const file = await axios.get(data.url, {
    responseType: "arraybuffer",
    timeout: 60000,
    maxContentLength: settings.MAX_MEDIA_MB * 1024 * 1024
  });
  const mime = String(file.headers?.["content-type"] || file.headers?.["Content-Type"] || "").split(";")[0].trim();
  const filename = data.filename || `sachi-media-${Date.now()}.${mode === "audio" ? "mp3" : (mime.includes("audio") ? "mp3" : mime.includes("image") ? "jpg" : "mp4")}`;
  return {
    buffer: Buffer.from(file.data),
    filename,
    mime: mime || (/\.(mp3|m4a|ogg|opus|wav)$/i.test(filename) ? "audio/mpeg" : /\.(jpg|jpeg|png|webp|gif)$/i.test(filename) ? "image/jpeg" : "video/mp4")
  };
}


let youtubeClientPromise = null;

async function getYoutubeClient() {
  if (!youtubeClientPromise) {
    youtubeClientPromise = Innertube.create({
      cache: new UniversalCache(false),
      lang: "en",
      location: "US"
    }).catch(err => {
      youtubeClientPromise = null;
      throw err;
    });
  }
  return youtubeClientPromise;
}

function extractYouTubeId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") return u.pathname.slice(1).split("/")[0] || null;
    if (u.searchParams.get("v")) return u.searchParams.get("v");
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts[0] === "shorts" || parts[0] === "embed" || parts[0] === "live") return parts[1] || null;
  } catch {}
  return null;
}


// Fallback downloader for current YouTube login/rate-limit failures.
// Uses the public Invidious API list and downloads an available audio stream.
// No YouTube cookies or account credentials are stored by the bot.
let invidiousInstancesPromise = null;

async function getInvidiousInstances() {
  if (!invidiousInstancesPromise) {
    invidiousInstancesPromise = axios.get("https://api.invidious.io/instances.json", {
      timeout: 12000,
      maxContentLength: 1024 * 1024,
      headers: { Accept: "application/json" }
    }).then(r => {
      const rows = Array.isArray(r.data) ? r.data : [];
      return rows
        .map(row => {
          const host = Array.isArray(row) ? row[0] : null;
          const meta = Array.isArray(row) ? row[1] : {};
          return host && meta?.api === true && /^https:\/\//i.test(`https://${host}`)
            ? `https://${host}`
            : null;
        })
        .filter(Boolean)
        .slice(0, 8);
    }).catch(() => []).finally(() => {
      // Refresh the list periodically instead of keeping dead instances forever.
      setTimeout(() => { invidiousInstancesPromise = null; }, 10 * 60 * 1000).unref?.();
    });
  }
  return invidiousInstancesPromise;
}

async function invidiousAudioDownload(videoId) {
  const configured = String(settings.INVIDIOUS_INSTANCE || "").trim().replace(/\/$/, "");
  const discovered = await getInvidiousInstances();
  const instances = [...new Set([configured, ...discovered].filter(Boolean))];

  let lastError = null;
  for (const base of instances) {
    try {
      const response = await axios.get(`${base}/api/v1/videos/${encodeURIComponent(videoId)}`, {
        timeout: 15000,
        maxContentLength: 3 * 1024 * 1024,
        headers: { Accept: "application/json" }
      });
      const data = response?.data || {};
      const candidates = [
        ...(Array.isArray(data.adaptiveFormats) ? data.adaptiveFormats : []),
        ...(Array.isArray(data.formatStreams) ? data.formatStreams : [])
      ].filter(x => x?.url);

      // Prefer an audio-only MP4/WebM stream. Fall back to a low-size
      // progressive stream if the instance does not expose adaptive audio.
      const audio = candidates
        .filter(x => /^audio\//i.test(String(x.type || "")))
        .sort((a, b) => Number(b.bitrate || 0) - Number(a.bitrate || 0))[0];

      const progressive = candidates
        .filter(x => !/^audio\//i.test(String(x.type || "")))
        .sort((a, b) => Number(a.width || 9999) - Number(b.width || 9999))[0];

      const selected = audio || progressive;
      if (!selected?.url) throw new Error("INVIDIOUS_NO_STREAM");

      const file = await axios.get(selected.url, {
        responseType: "arraybuffer",
        timeout: 60000,
        maxContentLength: settings.MAX_MEDIA_MB * 1024 * 1024,
        headers: { "User-Agent": "Mozilla/5.0" }
      });

      const buffer = Buffer.from(file.data);
      if (!buffer.length) throw new Error("INVIDIOUS_EMPTY_STREAM");

      const mime = String(selected.type || "").split(";")[0] || "audio/mp4";
      return {
        buffer,
        mime: /^audio\//i.test(mime) ? mime : "audio/mp4",
        extension: /webm/i.test(mime) ? "webm" : "m4a"
      };
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error("INVIDIOUS_UNAVAILABLE");
}

async function youtubeAudioDownload(videoId) {
  const youtube = await getYoutubeClient();
  const stream = await youtube.download(videoId, {
    type: "audio",
    quality: "best",
    format: "mp4"
  });
  if (!stream || typeof stream.getReader !== "function") {
    throw new Error("YOUTUBE_STREAM_UNAVAILABLE");
  }

  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.length) {
        total += value.length;
        if (total > settings.MAX_MEDIA_MB * 1024 * 1024) {
          throw new Error("MEDIA_TOO_LARGE");
        }
        chunks.push(Buffer.from(value));
      }
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }

  const buffer = Buffer.concat(chunks);
  if (!buffer.length) throw new Error("EMPTY_AUDIO");
  return buffer;
}

async function connect() {
  console.log("[SACHi-MD] Initializing WhatsApp connection...");
  const { state, saveCreds } =
    await useMultiFileAuthState(settings.SESSION_DIR);

  console.log("\n========================================");
  console.log(` ${settings.BOT_NAME} STARTING`);
  console.log(` Owner   : ${settings.OWNER_NAME}`);
  console.log(` Number  : ${phone}`);
  console.log(` Session : ${state.creds.registered ? "REGISTERED" : "NEW"}`);
  console.log("========================================\n");

  const sockOptions = {
    auth: state,
    logger,
    printQRInTerminal: false,
    markOnlineOnConnect: true,
    syncFullHistory: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000
  };
  // IMPORTANT: do not set a custom browser tuple for pairing-code mode.
  // WhatsApp validates the companion platform more strictly for phone pairing.
  const sock = makeWASocket(sockOptions);

  // WhatsApp now represents the account's own chat with a LID on some
  // linked-device sessions. Keep both identities so self-chat commands are
  // recognized even when remoteJid is @lid.
  let ownPhoneJid = `${phone}@s.whatsapp.net`;
  let ownLidJid = "";

  // Apply configured bot DP automatically after connecting.
  async function applyBotDP() {
    try {
      if (!settings.BOT_DP_URL) return;
      const response = await axios.get(settings.BOT_DP_URL, {
        responseType: "arraybuffer",
        timeout: 20000,
        maxContentLength: 5 * 1024 * 1024
      });
      if (response?.data?.length) {
        await sock.updateProfilePicture(sock.user?.id, Buffer.from(response.data));
        console.log("[SACHi-MD] Bot DP updated from settings.");
      }
    } catch (e) {
      console.error("[BOT DP ERROR]", e?.message || e);
    }
  }

  sock.ev.on("creds.update", async () => {
    try { await saveCreds(); } catch (e) {
      console.error("[AUTH SAVE ERROR]", e?.message || e);
    }
  });

  let pairingRequested = false;
  let lastQr = "";

  async function requestPairing() {
    if (state.creds.registered) return null;
    if (pairingRequested) return latestPairingCode || null;
    if (!phone || phone.length < 8) {
      console.error("[PAIRING ERROR] Invalid PAIRING_NUMBER in settings.js");
      return;
    }

    pairingRequested = true;
    try {
      // requestPairingCode must be triggered after the socket emits qr.
      const code = await sock.requestPairingCode(phone);
      const pretty = String(code).replace(/(.{4})/g, "$1-").replace(/-$/, "");
      latestPairingCode = pretty;

      console.log("\n========================================");
      console.log("        SACHi-MD PAIRING CODE");
      console.log(`             ${pretty}`);
      console.log("========================================");
      console.log("WhatsApp > Settings > Linked devices");
      console.log("Link a device > Link with phone number instead");
      console.log(`Enter: ${pretty}`);
      console.log("========================================\n");
      return pretty;
    } catch (err) {
      pairingRequested = false;
      console.error("[PAIRING ERROR]", err?.message || err);
      // The next qr event means the socket is ready again.
      throw err;
    }
  }

  function saveCommandLog(entry) {
    commandHistory.unshift({ ...entry, time: new Date().toISOString() });
    commandHistory = commandHistory.slice(0, 500);
    saveJsonFile(COMMAND_LOG_FILE, commandHistory);
  }
  function adminKeyOk(req) {
    const apiKey = String(process.env.WEB_API_KEY || "");
    return !apiKey || String(req.headers["x-api-key"] || "") === apiKey;
  }
  function json(res, status, data) { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(data)); }
  async function readBody(req) {
    return await new Promise((resolve, reject) => { let d=""; req.on("data", c => { d += c; if (d.length > 1e6) req.destroy(); }); req.on("end", () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } }); req.on("error", reject); });
  }
  function runtimeConfig() {
    const r = loadJsonFile(RUNTIME_SETTINGS_FILE, {});
    return { ...r, PREFIX: r.PREFIX ?? settings.PREFIX, AUTO_REPLY: r.AUTO_REPLY ?? settings.AUTO_REPLY, AUTO_REACT: r.AUTO_REACT ?? settings.AUTO_REACT, AUTO_READ: r.AUTO_READ ?? settings.AUTO_READ, AUTO_STATUS: r.AUTO_STATUS ?? settings.AUTO_STATUS, ANTI_DELETE: r.ANTI_DELETE ?? settings.ANTI_DELETE, EDIT_NOTIFY: r.EDIT_NOTIFY ?? settings.EDIT_NOTIFY, VIEW_ONCE_NOTIFY: r.VIEW_ONCE_NOTIFY ?? settings.VIEW_ONCE_NOTIFY, VIEW_ONCE_AUTO_INBOX: r.VIEW_ONCE_AUTO_INBOX ?? settings.VIEW_ONCE_AUTO_INBOX, INBOX_ANTI_BADWORD: r.INBOX_ANTI_BADWORD ?? settings.INBOX_ANTI_BADWORD, PUBLIC_MODE: r.PUBLIC_MODE ?? settings.PUBLIC_MODE, AI_ENABLED: r.AI_ENABLED ?? settings.AI_ENABLED };
  }

  function startPairingApi() {
    if (pairingServerStarted) return;
    pairingServerStarted = true;
    const port = Number(process.env.PORT || 20064);
    const server = http.createServer(async (req, res) => {
      const origin = req.headers.origin || "*";
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
      const u = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      if (u.pathname === "/" || u.pathname === "/index.html") {
        try { const html=fs.readFileSync(path.join(__dirname,"index.html"),"utf8"); res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"}); return res.end(html); } catch { return json(res,500,{ok:false,error:"WEB_UNAVAILABLE"}); }
      }
      if (u.pathname === "/api/health") return json(res,200,{ok:true,connected:!!sock.user?.id,pairingReady,uptime:formatDuration(Date.now()-Number(botStats.startedAt||Date.now())),uptimeSeconds:Math.floor((Date.now()-Number(botStats.startedAt||Date.now()))/1000),version:"V8"});
      if (!adminKeyOk(req)) return json(res,401,{ok:false,error:"INVALID_API_KEY"});
      if (u.pathname === "/api/pair" && req.method === "GET") {
        const requested=String(u.searchParams.get("phone")||"").replace(/\D/g,"");
        if (!requested || requested!==phone) return json(res,400,{ok:false,error:"PHONE_NOT_ALLOWED"});
        if (state.creds.registered) return json(res,409,{ok:false,error:"ALREADY_CONNECTED"});
        try { if(!pairingReady){const started=Date.now();while(!pairingReady&&Date.now()-started<30000) await new Promise(r=>setTimeout(r,500));} const code=await requestPairing(); return json(res,200,{ok:true,phone:requested,code}); } catch(e){return json(res,500,{ok:false,error:e?.message||"PAIRING_FAILED"});}
      }
      if (u.pathname === "/api/admin/state" && req.method === "GET") return json(res,200,{ok:true,connected:!!sock.user?.id,settings:runtimeConfig(),stats:botStats,users:Object.entries(botStats.users||{}).map(([jid,count])=>({jid,count,premium:isPremium(jid)})),blocked:Object.keys(blockedUsers),commands:commandHistory.slice(0,100)});
      if (u.pathname === "/api/admin/settings" && req.method === "POST") { const b=await readBody(req); const current=loadJsonFile(RUNTIME_SETTINGS_FILE,{}); const allowed=["PREFIX","AUTO_REPLY","AUTO_REACT","AUTO_READ","AUTO_STATUS","ANTI_DELETE","EDIT_NOTIFY","VIEW_ONCE_NOTIFY","VIEW_ONCE_AUTO_INBOX","INBOX_ANTI_BADWORD","PUBLIC_MODE","AI_ENABLED","BOT_NAME","OWNER_NAME","FOOTER","MEDIA_LIMIT"]; for(const k of allowed) if(k in b) current[k]=b[k]; saveJsonFile(RUNTIME_SETTINGS_FILE,current); return json(res,200,{ok:true,settings:runtimeConfig()}); }
      if (u.pathname === "/api/admin/block" && req.method === "POST") { const b=await readBody(req); const n=String(b.number||"").replace(/\D/g,""); if(!n) return json(res,400,{ok:false,error:"NUMBER_REQUIRED"}); if(n===phone) return json(res,400,{ok:false,error:"OWNER_CANNOT_BE_BLOCKED"}); blockedUsers[n]={blockedAt:Date.now()}; saveJsonFile(BLOCKED_USERS_FILE,blockedUsers); return json(res,200,{ok:true,blocked:Object.keys(blockedUsers)}); }
      if (u.pathname === "/api/admin/unblock" && req.method === "POST") { const b=await readBody(req); const n=String(b.number||"").replace(/\D/g,""); delete blockedUsers[n]; saveJsonFile(BLOCKED_USERS_FILE,blockedUsers); return json(res,200,{ok:true,blocked:Object.keys(blockedUsers)}); }
      if (u.pathname === "/api/admin/action" && req.method === "POST") { const b=await readBody(req); const a=String(b.action||""); if(a==="restart"){json(res,200,{ok:true,message:"Restarting"}); setTimeout(()=>process.exit(0),300); return;} if(a==="stop"){json(res,200,{ok:true,message:"Stopping"}); try{await sock.logout();}catch{} return;} if(a==="start"){return json(res,200,{ok:true,message:"Bot process already running"});} return json(res,400,{ok:false,error:"UNKNOWN_ACTION"}); }
      return json(res,404,{ok:false,error:"NOT_FOUND"});
    });
    server.listen(port,"0.0.0.0",()=>console.log(`[SACHi-MD] Admin/Pairing API listening on port ${port}`));
  }

  startPairingApi();

  sock.ev.on("connection.update", async ({ connection, qr, lastDisconnect }) => {
    if (qr && !state.creds.registered) {
      pairingReady = true;
      console.log("[SACHi-MD] WhatsApp is ready for pairing.");

      // Show a compact QR as a fallback. Pairing code is printed from the
      // same ready event and is the preferred method on a single phone.
      if (qr !== lastQr) {
        lastQr = qr;
        console.log("\n[SACHi-MD] QR CODE (optional):");
        qrcode.generate(qr, { small: true });
        console.log("[SACHi-MD] Requesting phone pairing code...");
        await requestPairing();
      }
    }

    if (connection === "connecting") {
      console.log("[SACHi-MD] Connecting to WhatsApp...");
    }

    if (connection === "open") {
      ownPhoneJid = sock.user?.id || ownPhoneJid;
      ownLidJid = sock.user?.lid || "";
      console.log(`[SACHi-MD] CONNECTED as ${sock.user?.id || "WhatsApp"}`);
      console.log(`[SACHi-MD] Own LID: ${ownLidJid || "not reported"}`);
      console.log(`[SACHi-MD] Prefix: ${settings.PREFIX}`);
      await applyBotDP();
      console.log("[SACHi-MD] Commands ready: menu, numeric menu, owner, status, restart, shutdown, setprefix, mode, autoreply, autoreact, autoread, autostatus, antidelete, block, unblock, sachilvu, love, ship, joke, quote, truth, dare, media tools, group tools");
      // Owner welcome: send after a short delay so the WhatsApp session
      // is fully synchronized, then retry once if the first send fails.
      if (!ownerWelcomed && phone) {
        ownerWelcomed = true;
        const welcomeJid = `${phone}@s.whatsapp.net`;
        const welcomeText = `╭━━〔 👑 WELCOME OWNER 〕━━╮
│
│ 👋 Hello, ${settings.OWNER_NAME}!
│ 🟢 ${settings.BOT_NAME} is ONLINE
│ ⚡ Fast • Secure • Powerful
│
╰━━━━━━━━━━━━━━━━━━━━╯`;
        const welcomeButtons = [
          { id: "menu_home", text: "📖 Main Menu" },
          { id: "alive_cmd", text: "🟢 Alive" },
          { id: "owner_cmd", text: "👑 Owner" }
        ];
        setTimeout(async () => {
          try {
            const welcomeImage = path.join(__dirname, "menu_banner.jpg");
            await sendImageWithButtons(sock, welcomeJid, welcomeImage, welcomeText, welcomeButtons);
            console.log("[OWNER WELCOME] Sent.");
          } catch (e) {
            console.error("[OWNER WELCOME ERROR]", e?.message || e);
            ownerWelcomed = false;
            setTimeout(async () => {
              try {
                await sendBotText(sock, welcomeJid, welcomeText);
                ownerWelcomed = true;
                console.log("[OWNER WELCOME] Retry sent.");
              } catch (e2) {
                ownerWelcomed = false;
                console.error("[OWNER WELCOME RETRY ERROR]", e2?.message || e2);
              }
            }, 5000);
          }
        }, 2500);
      }
    }

    if (connection === "close") {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      console.log(`[SACHi-MD] Connection closed: ${statusCode || "unknown"}`);

      if (loggedOut) {
        console.log("[SACHi-MD] Logged out. Delete session/ and pair again.");
        return;
      }

      if (!reconnectTimer) {
        pairingRequested = false;
        lastQr = "";
        const delay = statusCode === 515 ? 500 : 3000;
        console.log(`[SACHi-MD] Reconnecting in ${delay}ms...`);
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect().catch(err => console.error("[RECONNECT ERROR]", err));
        }, delay);
      }
    }
  });

  // Some WhatsApp versions deliver delete-for-everyone as a message update
  // instead of a standalone protocol-message upsert. Handle both forms.
  sock.ev.on("group-participants.update", async (update) => {
    try {
      const cfg = getGroupSettings(update.id);
      if (!cfg.welcome && !cfg.goodbye) return;
      const metadata = await sock.groupMetadata(update.id);
      const action = update.action;
      for (const jid of update.participants || []) {
        const mention = `@${String(jid).split("@")[0]}`;
        if (action === "add" && cfg.welcome) {
          await sock.sendMessage(update.id, { text: `╭━━〔 👋 𝑾𝑬𝑳𝑪𝑶𝑴𝑬 〕━━╮\n│\n│ 💖 𝑾𝒆𝒍𝒄𝒐𝒎𝒆 ${mention}!\n│ 🌸 𝑾𝒆𝒍𝒄𝒐𝒎𝒆 𝒕𝒐: ${metadata.subject}\n│ 🤖 𝑷𝒐𝒘𝒆𝒓𝒆𝒅 𝒃𝒚 ${settings.BOT_NAME}\n│\n╰━━━━━━━━━━━━━━━━━━━━╯`, mentions: [jid] });
        } else if ((action === "remove" || action === "leave") && cfg.goodbye) {
          await sock.sendMessage(update.id, { text: `╭━━〔 👋 𝑮𝑶𝑶𝑫𝑩𝒀𝑬 〕━━╮\n│\n│ 💫 𝑮𝒐𝒐𝒅𝒃𝒚𝒆 ${mention}!\n│ 👋 𝑻𝒂𝒌𝒆 𝒄𝒂𝒓𝒆 & 𝒔𝒕𝒂𝒚 𝒔𝒂𝒇𝒆.\n│\n╰━━━━━━━━━━━━━━━━━━━━╯`, mentions: [jid] });
        }
      }
    } catch (e) { console.error("[GROUP PARTICIPANT ERROR]", e?.message || e); }
  });

  // Group read receipts are emitted separately. Only treat a receipt as the
  // bot opening the view-once message when the reader is one of the bot's own
  // JIDs.
  sock.ev.on("message-receipt.update", async (updates) => {
    if (!settings.VIEW_ONCE_OPEN_NOTIFY) return;
    const ownerJid = `${phone}@s.whatsapp.net`;
    const ownJids = new Set([ownerJid, ownLidJid].filter(Boolean).map(x => String(x).split(":")[0]));
    for (const entry of updates || []) {
      const key = entry?.key || {};
      const receipt = entry?.receipt || {};
      const reader = String(receipt.userJid || "").split(":")[0];
      if (!reader || !ownJids.has(reader)) continue;
      if (receipt.readTimestamp == null && receipt.playedTimestamp == null) continue;
      const cached = recentMessages.get(key.id)?.msg;
      if (!cached || !notifyScopeAllows(settings.VIEW_ONCE_NOTIFY_SCOPE, cached.key?.remoteJid)) continue;
      try { await forwardViewOnceToOwner(sock, ownerJid, cached, "Opened"); }
      catch (e) { console.error('[VIEW-ONCE GROUP OPEN ERROR]', e?.message || e); }
    }
  });

  sock.ev.on("messages.update", async (updates) => {
    for (const entry of updates || []) {
      try {
        const update = entry?.update || {};
        const protocol = update?.message?.protocolMessage;
        const editedPayload = update?.message?.editedMessage;
        const keyId = protocol?.key?.id || entry?.key?.id;
        const ownerJid = `${phone}@s.whatsapp.net`;

        // A READ/PLAYED update is the closest reliable signal that the bot
        // account opened a view-once message. Only forward cached view-once
        // media once, and respect the owner's inbox/group scope.
        if (isReadStatus(update.status) && keyId && settings.VIEW_ONCE_OPEN_NOTIFY) {
          const cached = recentMessages.get(keyId)?.msg;
          if (cached && notifyScopeAllows(settings.VIEW_ONCE_NOTIFY_SCOPE, cached.key?.remoteJid)) {
            try { await forwardViewOnceToOwner(sock, ownerJid, cached, "Opened"); }
            catch (e) { console.error('[VIEW-ONCE OPEN ERROR]', e?.message || e); }
          }
        }

        // Baileys v7 emits plaintext edits through messages.update as
        // update.message.editedMessage (not as protocolMessage). Forward the
        // edited content to the owner's inbox according to the selected scope.
        if (editedPayload?.message && settings.EDIT_NOTIFY && notifyScopeAllows(settings.EDIT_NOTIFY_SCOPE, entry?.key?.remoteJid)) {
          try {
            const editedMessage = { key: entry.key, message: editedPayload.message };
            await sendOwnerRecoveredMessage(sock, ownerJid, editedMessage, '✏️ Edited Message', `🆔 ${keyId || 'unknown'}`);
            console.log(`[EDIT-NOTIFY] ${keyId || 'unknown'} -> owner`);
          } catch (e) { console.error('[EDIT UPDATE ERROR]', e?.message || e); }
        }

        if (protocol?.type !== 0 || !protocol?.key?.id || !settings.ANTI_DELETE) continue;
        const deleted = recentMessages.get(protocol.key.id)?.msg;
        if (!deleted || !notifyScopeAllows(settings.DELETE_NOTIFY_SCOPE, deleted.key?.remoteJid)) continue;
        const actorJid = getDeleteActor(protocol, entry?.key, deleted, ownerJid);
        await sendDeletedMessageToOwner(sock, ownerJid, deleted, actorJid, protocol.key.id);
        console.log(`[ANTI-DELETE] Recovered update ${protocol.key.id} deletedBy=${actorJid}`);
        recentMessages.delete(protocol.key.id);
      } catch (e) {
        console.error('[MESSAGE UPDATE ERROR]', e?.message || e);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify" && type !== "append") return;

    for (const msg of messages) {
      if (!msg.message) continue;
      const chat = msg.key.remoteJid;
      const blockedNumber = String(msg.key.participant || chat || "").split("@")[0].split(":")[0];
      if (!msg.key.fromMe && blockedUsers[blockedNumber]) continue;
      const buttonId = buttonIdOf(msg.message);
      const body = textOf(msg.message) || buttonId;

      // Self-chat messages can arrive with a LID JID. Always reply to the
      // owner's normal phone-number JID, not sock.user.id (which can include
      // a device suffix such as user:device@s.whatsapp.net). This avoids
      // self-chat "Waiting for this message" / undecryptable outgoing replies.
      // Always use the configured owner phone JID for Message Yourself.
      // sock.user.id can contain a device suffix (user:device@s.whatsapp.net)
      // and some WhatsApp builds expose self-chat as a LID.
      const selfJid = phone ? `${phone}@s.whatsapp.net` : ownPhoneJid;
      const selfAltJid = msg.key?.remoteJidAlt || "";
      const normalizedChat = String(chat || "").split("@")[0].split(":")[0].replace(/\D/g, "");
      const normalizedPhone = phone.replace(/\D/g, "");
      const normalizedOwnLid = String(ownLidJid || "").split("@")[0].replace(/\D/g, "");
      const isOwnLid = !!(normalizedChat && normalizedOwnLid && normalizedChat === normalizedOwnLid);
      const isSelfChat = !!(msg.key.fromMe || isOwnLid || (normalizedChat && normalizedPhone && normalizedChat === normalizedPhone));
      // For self-chat, always target the account's phone JID. If WhatsApp supplied
      // an alternate PN, prefer that exact JID over an opaque @lid address.
      const replyChat = isSelfChat
        ? (selfAltJid && selfAltJid.endsWith("@s.whatsapp.net")
            ? `${selfAltJid.split("@")[0].split(":")[0]}@s.whatsapp.net`
            : selfJid)
        : chat;
      const quoteOptions = isSelfChat ? {} : { quoted: msg };

      // Prevent duplicate processing when WhatsApp delivers the same command
      // through more than one message-upsert batch.
      const messageId = msg.key.id;
      if (messageId && processedMessages.has(messageId)) continue;
      if (messageId) {
        processedMessages.add(messageId);
        if (processedMessages.size > 1000) {
          const first = processedMessages.values().next().value;
          processedMessages.delete(first);
        }
      }

      console.log(`[MESSAGE] type=${type} fromMe=${!!msg.key.fromMe} jid=${chat} body=${JSON.stringify(body)}`);
      if (!msg.key.fromMe && body) { botStats.messages = Number(botStats.messages||0)+1; const u=String(msg.key.participant||chat||""); botStats.users[u]=(botStats.users[u]||0)+1; if (chat?.endsWith("@g.us")) botStats.groups[chat]=(botStats.groups[chat]||0)+1; if (body.startsWith(String(settings.PREFIX))) botStats.commands=Number(botStats.commands||0)+1; if (body.startsWith(String(settings.PREFIX))) saveCommandLog({ jid:u, command:body.trim().split(/\s+/)[0], chat }); if (botStats.messages % 20 === 0) saveJsonFile(STATS_FILE, botStats); }

      // Daily first-message auto reply for private incoming chats.
      // Groups, broadcasts, status updates, and the bot owner's own messages
      // are intentionally excluded.
      const isPrivateIncoming =
        !!chat &&
        chat.endsWith("@s.whatsapp.net") &&
        !msg.key.fromMe &&
        !chat.endsWith("@g.us") &&
        chat !== "status@broadcast";

      // Group protection suite: anti-link, anti-spam, anti-badword + warnings/auto-kick.
      if (chat?.endsWith("@g.us") && !msg.key.fromMe && body) {
        const cfg = getGroupSettings(chat);
        const senderKey = String(msg.key.participant || "");
        let metadata = null;
        try { metadata = await sock.groupMetadata(chat); } catch {}
        const admins = (metadata?.participants || []).filter(p => p.admin === "admin" || p.admin === "superadmin");
        const isSenderAdmin = admins.some(p => String(p.id).split(":")[0] === senderKey.split(":")[0]);
        const botJid = String(sock.user?.id || "").split(":")[0];
        const botIsAdmin = admins.some(p => String(p.id).split(":")[0] === botJid);
        const warnAndMaybeKick = async (reason) => {
          if (!senderKey || isSenderAdmin) return false;
          try { await sock.sendMessage(chat, { delete: msg.key }); } catch {}
          const count = getWarningCount(chat, senderKey) + 1;
          const limit = Math.max(1, Number(cfg.warnlimit) || 3);
          if (count >= limit && botIsAdmin) {
            try { await sock.groupParticipantsUpdate(chat, [senderKey], "remove"); } catch {}
            setWarningCount(chat, senderKey, 0);
            await sock.sendMessage(chat, { text: `🚨 @${senderKey.split("@")[0]} removed.
🛡️ Reason: ${reason}
⚠️ Warning limit: ${limit}`, mentions: [senderKey] });
          } else {
            setWarningCount(chat, senderKey, count);
            await sock.sendMessage(chat, { text: `⚠️ @${senderKey.split("@")[0]} warning ${count}/${limit}.
🛡️ ${reason}${botIsAdmin ? "" : "\n❗ Make the bot an admin for auto-kick."}`, mentions: [senderKey] });
          }
          return true;
        };
        if (cfg.antilink && !isSenderAdmin && /https?:\/\/(?:chat\.whatsapp\.com|wa\.me|www\.|t\.me|instagram\.com|youtube\.com|youtu\.be|facebook\.com|fb\.watch|discord\.gg)/i.test(body)) {
          if (await warnAndMaybeKick("Links are disabled in this group.")) continue;
        }
        if (cfg.antibadword && !isSenderAdmin) {
          const bad = containsBadWord(body, cfg);
          if (bad && await warnAndMaybeKick(`Blocked word detected: ${bad}`)) continue;
        }
        if (cfg.aimod && !isSenderAdmin && body.length >= 8 && !body.startsWith(String(settings.PREFIX))) {
          try {
            const verdict = await askSachiAI(`You are a WhatsApp group safety moderator. Classify this message as SAFE or UNSAFE. UNSAFE means scam/phishing, malicious links, severe harassment, sexual exploitation, threats, or dangerous spam. Reply with exactly SAFE or UNSAFE. Message: ${body}`);
            if (/\bUNSAFE\b/i.test(verdict) && await warnAndMaybeKick("AI moderation flagged this message as unsafe.")) continue;
          } catch {}
        }
        if (cfg.antimention && !isSenderAdmin) {
          const mentions = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
          if (mentions.length >= 5 && await warnAndMaybeKick("Mass mention spam detected.")) continue;
        }
        if (cfg.anticaps && !isSenderAdmin) {
          const letters = String(body).replace(/[^A-Za-z]/g, "");
          if (letters.length >= 12 && letters === letters.toUpperCase() && /[A-Z]/.test(letters) && await warnAndMaybeKick("Excessive CAPS detected.")) continue;
        }
        if (cfg.antiflood && !isSenderAdmin) {
          const key = `flood:${chat}:${senderKey}`; const now=Date.now(); const arr=(floodTracker.get(key)||[]).filter(t=>now-t<5000); arr.push(now); floodTracker.set(key,arr);
          if (arr.length >= 5 && await warnAndMaybeKick("Message flood detected.")) { floodTracker.delete(key); continue; }
        }
        if (cfg.raidmode && !isSenderAdmin) {
          const key=`raid:${chat}`; const now=Date.now(); const arr=(floodTracker.get(key)||[]).filter(t=>now-t<15000); arr.push(now); floodTracker.set(key,arr);
          if (arr.length >= 12 && await warnAndMaybeKick("Raid protection triggered.")) { floodTracker.delete(key); continue; }
        }
        if (cfg.antispam) {
          const key = `${chat}:${senderKey}`; const now = Date.now();
          const arr = (spamTracker.get(key) || []).filter(t => now - t < 10000); arr.push(now); spamTracker.set(key, arr);
          if (arr.length >= 7 && !isSenderAdmin) {
            if (await warnAndMaybeKick("Spam detected (7+ messages in 10 seconds).")) { spamTracker.delete(key); continue; }
          }
        }
      }

      if (!msg.key.fromMe && body && chat && !body.startsWith(String(settings.PREFIX))) {
        const xpResult = addXp(String(msg.key.participant || chat), chat.endsWith("@g.us") ? 5 : 2);
        if (xpResult.leveled && chat.endsWith("@g.us")) { try { await sock.sendMessage(chat, { text: `🎉 @${String(msg.key.participant||"").split("@")[0]} reached *Level ${xpResult.wallet.level}*! 🆙`, mentions:[String(msg.key.participant||"")] }); } catch {} }
      }

      // Owner-controlled automatic reactions. React once to normal incoming
      // messages (not commands, reactions, status or the bot's own messages).
      if (settings.AUTO_REACT && chat && !msg.key.fromMe && chat !== "status@broadcast" && !msg.message?.reactionMessage && !msg.message?.protocolMessage) {
        try {
          const autoReactEmojis = ["❤️", "💖", "✨", "🔥", "🥰", "😊", "💫", "👍"];
          const emoji = autoReactEmojis[Math.floor(Math.random() * autoReactEmojis.length)];
          await sock.sendMessage(chat, { react: { text: emoji, key: msg.key } });
        } catch (err) {
          console.error("[AUTO-REACT ERROR]", err?.message || err);
        }
      }

      if (settings.AUTO_REPLY_DAILY && isPrivateIncoming && shouldSendDailyAutoReply(chat)) {
        try {
          await sendBotText(sock, chat, AUTO_REPLY_TEXT);
          console.log(`[AUTO-REPLY] Sent daily greeting to ${chat}`);
        } catch (err) {
          console.error("[AUTO-REPLY ERROR]", err?.message || err);
        }
      }

      // Cache messages the bot actually received so anti-delete/recovery can
      // restore them later. This does not fetch messages the bot never saw.
      cacheMessage(msg);

      // Automatically copy incoming view-once media to the owner inbox.
      // This is intentionally done immediately after receipt, because WhatsApp
      // may not emit a reliable READ/PLAYED receipt for view-once media.
      if (!msg.key.fromMe && settings.VIEW_ONCE_AUTO_INBOX && isViewOnceMessage(msg)) {
        try {
          const ownerJid = `${phone}@s.whatsapp.net`;
          await autoSaveIncomingViewOnceToOwner(sock, ownerJid, msg);
        } catch (e) { console.error('[VIEW-ONCE AUTO INBOX ERROR]', e?.message || e); }
      }

      // Handle reaction events before the normal text-command path. A reaction
      // to a view-once image/video that the bot already received can be used as
      // an explicit save action. The recovered media is sent to the owner chat.
      if (msg.message?.reactionMessage) {
        const target = msg.message.reactionMessage.key || {};
        const targetId = target.id || '';
        const targetJid = target.remoteJid || msg.key?.remoteJid || '';
        const reaction = reactionText(msg);

        // First use our local cache. If the reaction arrives after a reconnect
        // or the cache missed the event, ask Baileys for the original message.
        let cached = recentMessages.get(targetId)?.msg || null;
        if (!cached && typeof sock.loadMessage === 'function' && targetJid && targetId) {
          try {
            cached = await sock.loadMessage(targetJid, targetId);
          } catch (e) {
            console.error('[VIEW-ONCE REACTION LOAD ERROR]', e?.message || e);
          }
        }

        if (cached && settings.VIEW_ONCE_REACTION_NOTIFY) {
          const cachedType = messageType(cached);
          const isViewOnce = isViewOnceMessage(cached) || !!cached?.message?.viewOnceMessageV2Extension;
          const rawCached = unwrap(cached.message);
          const isMedia = cachedType === 'imageMessage' || cachedType === 'videoMessage' ||
            !!rawCached?.imageMessage?.viewOnce || !!rawCached?.videoMessage?.viewOnce;
          if (isViewOnce && isMedia) {
            try {
              const media = await downloadCachedMedia(cached);
              if (!media) throw new Error('VIEW_ONCE_MEDIA_DOWNLOAD_FAILED');
              const ownerJid = `${phone}@s.whatsapp.net`;
              const reactorJid = msg.key?.participant || msg.key?.remoteJid || target.participant || 'unknown';
              const reactor = msg.key?.fromMe ? `${settings.OWNER_NAME} (Owner)` : String(reactorJid).split('@')[0].split(':')[0];
              const caption = `💾 ${settings.BOT_NAME} — View-Once Reaction\nReaction: ${reaction || '👍'}\nReacted by: ${reactor}\nOriginal chat: ${cached.key?.remoteJid || targetJid || 'unknown'}\n${settings.FOOTER}`;
              if (media.type === 'imageMessage') await sock.sendMessage(ownerJid, { image: media.buffer, caption });
              else await sock.sendMessage(ownerJid, { video: media.buffer, caption });
              console.log(`[VIEW-ONCE REACTION] target=${targetId} reaction=${reaction || '👍'} fromMe=${!!msg.key?.fromMe} -> ${ownerJid}`);
            } catch (e) {
              console.error('[VIEW-ONCE REACTION ERROR]', e?.message || e);
            }
          } else {
            console.log(`[VIEW-ONCE REACTION] target=${targetId} found but not view-once media type=${cachedType}`);
          }
        } else {
          console.log(`[VIEW-ONCE REACTION] target=${targetId} original message not found`);
        }
        continue;
      }

      // Edited-message notification: WhatsApp sends edited content inside a
      // protocol message. Forward the edited message to the owner's inbox.
      const protocol = msg.message?.protocolMessage;
      const isEditedProtocol = !!(protocol && (protocol.type === 14 || protocol.type === 'MESSAGE_EDIT' || protocol.type === 'EDIT') && protocol.editedMessage);
      if (isEditedProtocol && settings.EDIT_NOTIFY && notifyScopeAllows(settings.EDIT_NOTIFY_SCOPE, msg.key?.remoteJid || protocol.key?.remoteJid)) {
        try {
          const editedMessage = {
            key: protocol.key || msg.key,
            message: protocol.editedMessage
          };
          const ownerJid = `${phone}@s.whatsapp.net`;
          await sendOwnerRecoveredMessage(sock, ownerJid, editedMessage, '✏️ Edited Message', `🆔 ${protocol.key?.id || msg.key?.id || 'unknown'}`);
          console.log(`[EDIT-NOTIFY] ${protocol.key?.id || msg.key?.id || 'unknown'} -> owner`);
        } catch (e) {
          console.error('[EDIT NOTIFY ERROR]', e?.message || e);
        }
        continue;
      }

      // Anti-delete: WhatsApp can deliver a revoke (delete-for-everyone)
      // protocol message. Recover only from our bounded cache of messages the
      // bot actually received earlier, then send the recovered content to owner.
      if (protocol?.type === 0 && protocol?.key?.id) {
        const deleted = recentMessages.get(protocol.key.id)?.msg;
        if (deleted && settings.ANTI_DELETE && notifyScopeAllows(settings.DELETE_NOTIFY_SCOPE, deleted.key?.remoteJid)) {
          try {
            const ownerJid = `${phone}@s.whatsapp.net`;
            const actorJid = getDeleteActor(protocol, msg.key, deleted, ownerJid);
            await sendDeletedMessageToOwner(sock, ownerJid, deleted, actorJid, protocol.key.id);
            console.log(`[ANTI-DELETE] Recovered ${protocol.key.id} deletedBy=${actorJid}`);
            recentMessages.delete(protocol.key.id);
          } catch (e) {
            console.error('[ANTI-DELETE ERROR]', e?.message || e);
          }
        }
        continue;
      }

      // Inbox anti-badword filter: this is separate from per-group anti-badword.
      // It applies only to private chats and never filters the owner/self-chat.
      if (!msg.key.fromMe && !isSelfChat && !chat?.endsWith("@g.us") && settings.INBOX_ANTI_BADWORD) {
        const blocked = containsInboxBadWord(body);
        if (blocked) {
          try { await sock.sendMessage(chat, { delete: msg.key }); } catch {}
          await sendBotText(sock, chat, `🚫 *INBOX ANTI-BADWORD*\n\nYour message contains a blocked word.\n⚠️ Detected: *${blocked}*\n\nPlease use respectful language.`, { quoted: msg });
          console.log(`[INBOX ANTI-BADWORD] ${blocked} from ${chat}`);
          continue;
        }
      }

      // WhatsApp can expose the owner/self-chat with a LID while sock.user.id
      // contains the phone JID. Comparing phone numbers alone can therefore
      // incorrectly reject self-chat commands.
      //
      // Menu navigation uses simple numbered replies.
      // Send 1-19 to open the corresponding menu section.
      const buttonMenuMap = {
        menu_owner: "1", menu_main: "2", menu_downloads: "3",
        menu_tools: "4", menu_settings: "5", menu_antidelete: "6",
        menu_viewonce: "7", menu_more: "8", menu_group: "9", menu_fun: "10", menu_utility: "11", menu_media: "12", menu_economy: "13", menu_premium: "14", menu_security: "15", menu_profile: "16", menu_music: "17", menu_ai: "18", menu_aimod: "19", menu_home: "",
        alive_cmd: "alive", owner_cmd: "owner", sachiya_cmd: "sachiya",
        ping_cmd: "ping"
      };
      const normalizedButton = buttonMenuMap[buttonId];
      const effectiveBody = normalizedButton !== undefined ? (normalizedButton ? `${settings.PREFIX}menu ${normalizedButton}` : `${settings.PREFIX}menu`) : body;
      const isNumberMenu = /^(?:[1-9]|1[0-9])$/.test(body);

      // SACHi AI Assistant: mention "SACHi" or directly mention the bot and ask a question.
      // Commands still take priority, so .ai / other commands work normally.
      if (chat && !msg.key.fromMe && !effectiveBody.startsWith(settings.PREFIX) && !isNumberMenu) {
        let aiPrompt = getSachiMentionPrompt(msg, body);
        if (!aiPrompt && chat.endsWith("@g.us") && getGroupSettings(chat).smartai) aiPrompt = String(body || "").trim();
        if (aiPrompt) {
          try {
            const answer = await askSachiAI(aiPrompt);
            await sendBotText(sock, replyChat, `🤖 *SACHi AI*\n\n${answer}`, quoteOptions);
          } catch (e) {
            const msgText = e?.message === "AI_NOT_CONFIGURED"
              ? "🤖 SACHi AI is not configured yet. Add AI_API_URL and AI_API_KEY in settings.js."
              : "❌ SACHi AI is temporarily unavailable. Please try again.";
            await sendBotText(sock, replyChat, msgText, quoteOptions);
          }
          continue;
        }
      }

      if (!chat || (!effectiveBody.startsWith(settings.PREFIX) && !isNumberMenu)) continue;

      let cmd;
      let args;
      if (isNumberMenu) {
        cmd = "menu";
        args = body;
      } else {
        const raw = effectiveBody.slice(settings.PREFIX.length).trim();
        const parts = raw.split(/\s+/);
        cmd = (parts.shift() || "").toLowerCase();
        args = parts.join(" ").trim();
      }
      const sender = String(msg.key.participant || msg.key.remoteJid || "")
        .split("@")[0].split(":")[0].replace(/\D/g, "");
      const ownerNumber = String(settings.OWNER_NUMBER).replace(/\D/g, "");
      const isOwner = isSelfChat || sender === ownerNumber;
      const publicAllowed = settings.BOT_MODE !== "private" || isOwner;

      try {
        if (!publicAllowed) {
          await sendBotText(sock, replyChat, "🔒 𝑺𝑨𝑪𝑯𝒊-𝑴𝑫 𝒊𝒔 𝒊𝒏 𝑷𝑹𝑰𝑽𝑨𝑻𝑬 𝑴𝑶𝑫𝑬.\n👑 𝑶𝒏𝒍𝒚 𝑶𝒘𝒏𝒆𝒓 𝒄𝒂𝒏 𝒖𝒔𝒆 𝒄𝒐𝒎𝒎𝒂𝒏𝒅𝒔.", quoteOptions);
          continue;
        }
        if (settings.AUTO_READ) {
          try { await sock.readMessages([msg.key]); } catch {}
        }
        // Owner inbox controls for the private-chat anti-badword filter.
        // Group anti-badword remains configured separately with the existing commands.
        if (!replyChat?.endsWith("@g.us") && ["antibadword", "addbadword", "delbadword", "badwords"].includes(cmd)) {
          if (!isOwner) {
            await sendBotText(sock, replyChat, "❌ Inbox anti-badword controls are owner-only. 👑", quoteOptions);
            continue;
          }
          if (cmd === "antibadword") {
            const mode = String(args || "").toLowerCase();
            if (!["on", "off"].includes(mode)) {
              await sendBotText(sock, replyChat, `Use: ${settings.PREFIX}antibadword on/off\n\nCurrent inbox status: ${settings.INBOX_ANTI_BADWORD ? "ON ✅" : "OFF ❌"}`, quoteOptions);
              continue;
            }
            settings.INBOX_ANTI_BADWORD = mode === "on";
            saveRuntimeSettings();
            await sendBotText(sock, replyChat, `╭━━〔 🛡️ INBOX ANTI-BADWORD 〕━━╮\n│\n│ 📊 Status : ${settings.INBOX_ANTI_BADWORD ? "ON ✅" : "OFF ❌"}\n│ 🔒 Scope  : Private inbox only\n│ 💾 Saved  : Permanently\n│\n╰━━━━━━━━━━━━━━━━━━━━╯`, quoteOptions);
          } else if (cmd === "addbadword") {
            if (!args) { await sendBotText(sock, replyChat, `Use: ${settings.PREFIX}addbadword <word>`, quoteOptions); continue; }
            const word = args.trim().toLowerCase();
            if (!inboxBadWords.some(w => String(w).toLowerCase() === word)) { inboxBadWords.push(word); saveInboxBadWords(); }
            await sendBotText(sock, replyChat, `✅ Inbox blocked word added: *${word}*\n\n🛡️ Filter: ${settings.INBOX_ANTI_BADWORD ? "ON" : "OFF"}`, quoteOptions);
          } else if (cmd === "delbadword") {
            if (!args) { await sendBotText(sock, replyChat, `Use: ${settings.PREFIX}delbadword <word>`, quoteOptions); continue; }
            const word = args.trim().toLowerCase();
            const before = inboxBadWords.length;
            inboxBadWords = inboxBadWords.filter(w => String(w).toLowerCase() !== word);
            saveInboxBadWords();
            await sendBotText(sock, replyChat, before === inboxBadWords.length ? `ℹ️ *${word}* was not in your custom inbox list.` : `✅ Removed inbox blocked word: *${word}*`, quoteOptions);
          } else if (cmd === "badwords") {
            const custom = inboxBadWords.length ? inboxBadWords.map(w => `• ${w}`).join("\n") : "• No custom words added yet.";
            await sendBotText(sock, replyChat, `🚫 *INBOX BLOCKED WORDS*\n\n🛡️ Status: ${settings.INBOX_ANTI_BADWORD ? "ON ✅" : "OFF ❌"}\n\n📌 Default protected words:\n• ${DEFAULT_BADWORDS.join("\n• ")}\n\n✏️ Your custom words:\n${custom}\n\nAdd: ${settings.PREFIX}addbadword <word>\nRemove: ${settings.PREFIX}delbadword <word>`, quoteOptions);
          }

        } else if (cmd === "setmenu") {
          if (!isOwner) {
            await sendBotText(sock, replyChat, "❌ 𝑶𝒏𝒍𝒚 𝑶𝒘𝒏𝒆𝒓 𝒄𝒂𝒏 𝒄𝒉𝒂𝒏𝒈𝒆 𝒕𝒉𝒆 𝒎𝒆𝒏𝒖 𝒊𝒎𝒂𝒈𝒆. 👑", quoteOptions);
            continue;
          }
          const quoted = quotedOf(msg.message);
          const media = unwrap(quoted);
          const mediaType = getContentType(media);
          if (mediaType !== "imageMessage" || !media?.imageMessage) {
            await sendBotText(sock, replyChat, `🖼️ *SET MENU IMAGE*\n\nReply to a photo and send: ${settings.PREFIX}setmenu\n\nExample:\n1️⃣ Send the photo\n2️⃣ Reply to that photo\n3️⃣ Type ${settings.PREFIX}setmenu`, quoteOptions);
            continue;
          }
          try {
            const buffer = await toBuffer(await downloadContentFromMessage(media.imageMessage, "image"), 10 * 1024 * 1024);
            if (!buffer?.length) throw new Error("EMPTY_IMAGE");
            const menuImage = path.join(__dirname, "menu_banner.jpg");
            fs.writeFileSync(menuImage, buffer);
            await sendBotText(sock, replyChat, `✅ *MENU IMAGE UPDATED!* 🎨\n\n🖼️ New image saved successfully.\n📌 Now ${settings.PREFIX}menu will use this image.\n\n♻️ To change it again, reply to another photo and send ${settings.PREFIX}setmenu.`, quoteOptions);
          } catch (e) {
            await sendBotText(sock, replyChat, `❌ Failed to update menu image.\n\nError: ${String(e?.message || e)}`, quoteOptions);
          }

        } else if (cmd === "menu" || cmd === "help") {
          const category = args.toLowerCase();
          let menuText;

          const title = (icon, name) => `╭━━━━━━━━〔 ${icon} 𝑺𝑨𝑪𝑯𝒊-𝑴𝑫 • ${name} 〕━━━━━━━━╮`;
          const line = `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯`;
          const mini = `│ ✦ 𝑷𝑹𝑬𝑴𝑰𝑼𝑴 • 𝑭𝑨𝑺𝑻 • 𝑷𝑶𝑾𝑬𝑹𝑭𝑼𝑳 • 𝑺𝑴𝑨𝑹𝑻 ✦`;

          if (category === "1" || category === "owner") {
            menuText = `${title("👑", "𝑶𝑾𝑵𝑬𝑹 𝑷𝑨𝑵𝑬𝑳")}
│
│ 👤 𝑶𝒘𝒏𝒆𝒓   : ${settings.OWNER_NAME}
│ 📱 𝑵𝒖𝒎𝒃𝒆𝒓  : +${settings.OWNER_NUMBER}
│ 🛡️ 𝑨𝒄𝒄𝒆𝒔𝒔  : 𝑶𝑾𝑵𝑬𝑹 𝑶𝑵𝑳𝒀
│
│ 🔹 ${settings.PREFIX}owner
│ 🔹 ${settings.PREFIX}botdp
│ 🔹 ${settings.PREFIX}setdp (reply photo)
│ 🔄 ${settings.PREFIX}restart
│ 🛑 ${settings.PREFIX}shutdown
│ 📊 ${settings.PREFIX}status
│ 🔧 ${settings.PREFIX}setprefix !
│ 📤 ${settings.PREFIX}send 947xxxxxxxxx <message>
│ 🔎 ${settings.PREFIX}info 947xxxxxxxxx
│ 🌐 ${settings.PREFIX}mode public/private
│
${mini}
${line}
${settings.FOOTER}`;
          } else if (category === "2" || category === "main") {
            menuText = `${title("⚙️", "𝑴𝑨𝑰𝑵 𝑪𝑶𝑴𝑴𝑨𝑵𝑫𝑺")}
│
│ 🟢 ${settings.PREFIX}alive
│ ⚡ ${settings.PREFIX}ping
│ 👤 ${settings.PREFIX}sachiya
│ 💖 ${settings.PREFIX}sachilvu
│ 👑 ${settings.PREFIX}owner
│ 🕒 ${settings.PREFIX}time
│ 📅 ${settings.PREFIX}date
│ ⏱️ ${settings.PREFIX}runtime
│ 📖 ${settings.PREFIX}menu
│ 💕 ${settings.PREFIX}love
│ 💘 ${settings.PREFIX}ship @user @user
│ 😂 ${settings.PREFIX}joke
│ ✨ ${settings.PREFIX}quote
│ 🎯 ${settings.PREFIX}truth / ${settings.PREFIX}dare
│
${mini}
${line}
${settings.FOOTER}`;
          } else if (category === "3" || category === "downloads") {
            menuText = `${title("🎵", "𝑫𝑶𝑾𝑵𝑳𝑶𝑨𝑫 𝑪𝑬𝑵𝑻𝑬𝑹")}
│
│ 🎶 ${settings.PREFIX}song <name>
│ ▶️ ${settings.PREFIX}yt <link/name>
│ 📘 ${settings.PREFIX}fb <link>
│
│ 📥 𝑨𝒖𝒅𝒊𝒐 • 𝑽𝒊𝒅𝒆𝒐 • 𝑴𝒆𝒅𝒊𝒂
│ ⚡ 𝑭𝒂𝒔𝒕 & 𝑺𝒊𝒎𝒑𝒍𝒆 𝑫𝒐𝒘𝒏𝒍𝒐𝒂𝒅𝒔
${line}
${settings.FOOTER}`;
          } else if (category === "4" || category === "search" || category === "tools") {
            menuText = `${title("🔎", "𝑺𝑬𝑨𝑹𝑪𝑯 & 𝑻𝑶𝑶𝑳𝑺")}
│
│ 🖼️ ${settings.PREFIX}photo <search>
│ ⚡ ${settings.PREFIX}ping
│ 🟢 ${settings.PREFIX}alive
│ 🕒 ${settings.PREFIX}time
│ 📅 ${settings.PREFIX}date
│ ⏱️ ${settings.PREFIX}runtime
│ 🆔 ${settings.PREFIX}id
│
│ 🔍 𝑺𝒎𝒂𝒓𝒕 𝑺𝒆𝒂𝒓𝒄𝒉 & 𝑸𝒖𝒊𝒄𝒌 𝑻𝒐𝒐𝒍𝒔
${line}
${settings.FOOTER}`;
          } else if (category === "5" || category === "settings" || category === "botsetting") {
            menuText = `${title("🛡️", "𝑩𝑶𝑻 𝑺𝑬𝑻𝑻𝑰𝑵𝑮𝑺")}
│
│ ⚙️ ${settings.PREFIX}botsetting
│ 📤 ${settings.PREFIX}send 947xxxxxxxxx <message>
│ 🚫 ${settings.PREFIX}block @user
│ 🔓 ${settings.PREFIX}unblock @user
│ 💖 ${settings.PREFIX}sachilvu
│ 👀 ${settings.PREFIX}autoread on/off
│ 📡 ${settings.PREFIX}autostatus on/off
│ 💫 ${settings.PREFIX}autoreact on/off 〔𝑶𝒘𝒏𝒆𝒓〕
│ 💬 ${settings.PREFIX}autoreply on/off 〔𝑶𝒘𝒏𝒆𝒓〕
│ 👀 ${settings.PREFIX}autoread on/off 〔𝑶𝒘𝒏𝒆𝒓〕
│ 📡 ${settings.PREFIX}autostatus on/off 〔𝑶𝒘𝒏𝒆𝒓〕
│ 🛡️ ${settings.PREFIX}antibadword on/off 〔𝑰𝒏𝒃𝒐𝒙〕
│ ➕ ${settings.PREFIX}addbadword <word> 〔𝑰𝒏𝒃𝒐𝒙〕
│ ➖ ${settings.PREFIX}delbadword <word> 〔𝑰𝒏𝒃𝒐𝒙〕
│ 📃 ${settings.PREFIX}badwords 〔𝑰𝒏𝒃𝒐𝒙〕
│ 🗑️ ${settings.PREFIX}antidelete on/off
│ ✏️ ${settings.PREFIX}editnotify inbox/group/both
│ 🗑️ ${settings.PREFIX}deletenotify inbox/group/both
│ 👁️ ${settings.PREFIX}viewonce inbox/group/both/on/off
│ 🖼️ ${settings.PREFIX}setdp (reply photo)
│ 🤖 ${settings.PREFIX}botdp
│
│ 🔐 𝑪𝒐𝒏𝒇𝒊𝒈𝒖𝒓𝒆 𝒀𝒐𝒖𝒓 𝑺𝑨𝑪𝑯𝒊-𝑴𝑫
${line}
${settings.FOOTER}`;
          } else if (category === "6" || category === "antidelete") {
            menuText = `${title("🗑️", "𝑨𝑵𝑻𝑰-𝑫𝑬𝑳𝑬𝑻𝑬")}
│
│ 📊 𝑺𝒕𝒂𝒕𝒖𝒔 : ${settings.ANTI_DELETE ? "𝑶𝑵 ✅" : "𝑶𝑭𝑭 ❌"}
│
│ 🟢 ${settings.PREFIX}antidelete on
│ 🔴 ${settings.PREFIX}antidelete off
│
│ ♻️ 𝑹𝒆𝒄𝒐𝒗𝒆𝒓 𝒔𝒖𝒑𝒑𝒐𝒓𝒕𝒆𝒅 𝒅𝒆𝒍𝒆𝒕𝒆𝒅 𝒎𝒆𝒔𝒔𝒂𝒈𝒆𝒔
${line}
${settings.FOOTER}`;
          } else if (category === "7" || category === "view-once" || category === "viewonce") {
            menuText = `${title("👁️", "𝑽𝑰𝑬𝑾-𝑶𝑵𝑪𝑬 𝑺𝑨𝑽𝑬")}
│
│ 📸 ${settings.PREFIX}vv (reply photo/video)
│ 👁️ ${settings.PREFIX}sv (reply view-once)
│
│ 💡 𝑺𝒂𝒗𝒆 𝒔𝒖𝒑𝒑𝒐𝒓𝒕𝒆𝒅 𝒗𝒊𝒆𝒘-𝒐𝒏𝒄𝒆 𝒎𝒆𝒅𝒊𝒂
│ 🔒 𝑼𝒔𝒆 𝒐𝒏𝒍𝒚 𝒘𝒊𝒕𝒉 𝒄𝒐𝒏𝒕𝒆𝒏𝒕 𝒚𝒐𝒖 𝒂𝒓𝒆 𝒂𝒍𝒍𝒐𝒘𝒆𝒅 𝒕𝒐 𝒔𝒂𝒗𝒆
${line}
${settings.FOOTER}`;
          } else if (category === "8" || category === "more" || category === "features") {
            menuText = `${title("📦", "𝑴𝑶𝑹𝑬 𝑭𝑬𝑨𝑻𝑼𝑹𝑬𝑺")}
│
│ 🎵 ${settings.PREFIX}song <name>
│ ▶️ ${settings.PREFIX}yt <link/name>
│ 📘 ${settings.PREFIX}fb <link>
│ 🖼️ ${settings.PREFIX}photo <search>
│ 👁️ ${settings.PREFIX}vv / ${settings.PREFIX}sv
│ 🕒 ${settings.PREFIX}time / ${settings.PREFIX}date
│ ⏱️ ${settings.PREFIX}runtime
│ 🆔 ${settings.PREFIX}id / ${settings.PREFIX}jid
│ ⚙️ ${settings.PREFIX}botsetting
│ 👥 ${settings.PREFIX}groupinfo / ${settings.PREFIX}tagall
│ 🚫 ${settings.PREFIX}block / ${settings.PREFIX}unblock
│ 💖 ${settings.PREFIX}sachilvu
│ 🐞 ${settings.PREFIX}bug <report>
│ 🔗 ${settings.PREFIX}link / ${settings.PREFIX}revoke
│
│ ✨ 𝑴𝒐𝒓𝒆 𝑺𝒎𝒂𝒓𝒕 𝑻𝒐𝒐𝒍𝒔 𝑹𝒆𝒂𝒅𝒚 𝑻𝒐 𝑼𝒔𝒆
${line}
${settings.FOOTER}`;
          } else if (category === "9" || category === "group" || category === "groups") {
            menuText = `${title("👥", "𝑮𝑹𝑶𝑼𝑷 𝑪𝑶𝑴𝑴𝑨𝑵𝑫𝑺")}
│
│ 📊 ${settings.PREFIX}groupinfo
│ 👑 ${settings.PREFIX}admins
│ 📢 ${settings.PREFIX}tagall / ${settings.PREFIX}hidetag
│ ⬆️ ${settings.PREFIX}promote @user
│ ⬇️ ${settings.PREFIX}demote @user
│ 🚫 ${settings.PREFIX}kick @user
│ ➕ ${settings.PREFIX}add 947xxxxxxxxx
│ 🔗 ${settings.PREFIX}link / ${settings.PREFIX}revoke
│ ✏️ ${settings.PREFIX}setname / ${settings.PREFIX}setdesc
│ 🔒 ${settings.PREFIX}mute / ${settings.PREFIX}unmute
│ 👋 ${settings.PREFIX}welcome on/off
│ 🚪 ${settings.PREFIX}goodbye on/off
│ 🔗 ${settings.PREFIX}antilink on/off
│ 🛡️ ${settings.PREFIX}antispam on/off
│ 🚫 ${settings.PREFIX}antibadword on/off
│ ⚠️ ${settings.PREFIX}warn @user
│ 📋 ${settings.PREFIX}warnings @user
│ ♻️ ${settings.PREFIX}resetwarn @user
│ ➕ ${settings.PREFIX}addbadword <word>
│ ➖ ${settings.PREFIX}delbadword <word>
│ 📃 ${settings.PREFIX}badwords
│ 📜 ${settings.PREFIX}setrules <text>
│ 📖 ${settings.PREFIX}rules
│ 🔢 ${settings.PREFIX}warnlimit 3
│
│ 🛡️ 𝑨𝒅𝒎𝒊𝒏-𝒐𝒏𝒍𝒚 𝒂𝒄𝒕𝒊𝒐𝒏𝒔 𝒂𝒓𝒆 𝒑𝒓𝒐𝒕𝒆𝒄𝒕𝒆𝒅
${line}
${settings.FOOTER}`;
          } else if (category === "10" || category === "fun") {
            menuText = `${title("😂", "𝑭𝑼𝑵 & 𝑮𝑨𝑴𝑬𝑺")}
│
│ 😂 ${settings.PREFIX}joke
│ ✨ ${settings.PREFIX}quote
│ 💘 ${settings.PREFIX}ship @user @user
│ 🎱 ${settings.PREFIX}8ball <question>
│ 🔥 ${settings.PREFIX}roast @user
│ 🎯 ${settings.PREFIX}truth / ${settings.PREFIX}dare
│ 🖼️ ${settings.PREFIX}meme
│ 💖 ${settings.PREFIX}love
│
${mini}
${line}
${settings.FOOTER}`;
          } else if (category === "11" || category === "utility") {
            menuText = `${title("🧰", "𝑼𝑻𝑰𝑳𝑰𝑻𝒀 𝑪𝑬𝑵𝑻𝑬𝑹")}
│
│ 🧮 ${settings.PREFIX}calc <expression>
│ 🌤️ ${settings.PREFIX}weather <city>
│ 🌐 ${settings.PREFIX}translate <lang> <text>
│ 📖 ${settings.PREFIX}define <word>
│ 🔗 ${settings.PREFIX}shorturl <url>
│ 📱 ${settings.PREFIX}qr <text>
│ 🔊 ${settings.PREFIX}tts <text>
│ 📸 ${settings.PREFIX}ss <url>
│ 🤖 ${settings.PREFIX}ai <question>
│
${mini}
${line}
${settings.FOOTER}`;
          } else if (category === "12" || category === "media") {
            menuText = `${title("🎬", "𝑴𝑬𝑫𝑰𝑨 𝑺𝑻𝑼𝑫𝑰𝑶")}
│
│ 🎵 ${settings.PREFIX}song <name>
│ ▶️ ${settings.PREFIX}yt <link/name>
│ 🎧 ${settings.PREFIX}spotify <url>
│ 🎵 ${settings.PREFIX}tiktok <url>
│ 📸 ${settings.PREFIX}igdl <url>
│ 📘 ${settings.PREFIX}fb <url>
│ 🧩 ${settings.PREFIX}sticker (reply media)
│ 🖼️ ${settings.PREFIX}toimg (reply sticker)
│ 🎧 ${settings.PREFIX}tomp3 (reply video/audio)
│
${mini}
${line}
${settings.FOOTER}`;
          } else if (category === "13" || category === "economy" || category === "games") {
            menuText = `${title("💰", "𝑬𝑪𝑶𝑵𝑶𝑴𝒀 & 𝑳𝑬𝑽𝑬𝑳𝑺")}\n│\n│ 💰 ${settings.PREFIX}balance\n│ 🎁 ${settings.PREFIX}daily\n│ 💼 ${settings.PREFIX}work\n│ 💸 ${settings.PREFIX}give @user 100\n│ 🏆 ${settings.PREFIX}level / ${settings.PREFIX}rank\n│ 🥇 ${settings.PREFIX}leaderboard\n│ 🛒 ${settings.PREFIX}shop\n│ 💎 ${settings.PREFIX}buy premium7\n│\n${mini}\n${line}\n${settings.FOOTER}`;
          } else if (category === "14" || category === "premium") {
            menuText = `${title("💎", "𝑷𝑹𝑬𝑴𝑰𝑼𝑴 & 𝑺𝑻𝑨𝑻𝑺")}\n│\n│ 💎 ${settings.PREFIX}premium\n│ 📊 ${settings.PREFIX}stats\n│ 🤖 ${settings.PREFIX}ai <question>\n│\n│ 👑 Owner: ${settings.PREFIX}addprem / ${settings.PREFIX}delprem / ${settings.PREFIX}premlist\n│\n${mini}\n${line}\n${settings.FOOTER}`;
          } else if (category === "15" || category === "security") {
            menuText = `${title("🛡️", "𝑨𝑫𝑽𝑨𝑵𝑪𝑬𝑫 𝑺𝑬𝑪𝑼𝑹𝑰𝑻𝒀")}\n│\n│ 🔗 ${settings.PREFIX}antilink on/off\n│ 🚨 ${settings.PREFIX}antispam on/off\n│ 🚫 ${settings.PREFIX}antibadword on/off\n│ 📢 ${settings.PREFIX}antimention on/off\n│ 🔠 ${settings.PREFIX}anticaps on/off\n│ 🌊 ${settings.PREFIX}antiflood on/off\n│ 🚨 ${settings.PREFIX}raidmode on/off\n│ 🤖 ${settings.PREFIX}aimod on/off\n│ 🧠 ${settings.PREFIX}smartai on/off\n│ ⚠️ ${settings.PREFIX}warnlimit 3\n│\n${mini}\n${line}\n${settings.FOOTER}`;
          } else if (category === "16" || category === "user" || category === "profile") {
            menuText = `${title("👤", "𝑼𝑺𝑬𝑹 𝑷𝑹𝑶𝑭𝑰𝑳𝑬") }\n│\n│ 👤 ${settings.PREFIX}profile\n│ ✏️ ${settings.PREFIX}profilename <name>\n│ 📝 ${settings.PREFIX}setbio <text>\n│ 🏅 ${settings.PREFIX}leveltitle\n│ ⭐ ${settings.PREFIX}level / ${settings.PREFIX}rank\n│ 💰 ${settings.PREFIX}balance\n│\n${mini}\n${line}\n${settings.FOOTER}`;
          } else if (category === "17" || category === "music" || category === "player") {
            menuText = `${title("🎧", "𝑴𝑼𝑺𝑰𝑪 𝑷𝑳𝑨𝒀𝑬𝑹") }\n│\n│ ▶️ ${settings.PREFIX}play <song>\n│ 📋 ${settings.PREFIX}queue\n│ ⏭️ ${settings.PREFIX}skip\n│ ⏸️ ${settings.PREFIX}pause\n│ ▶️ ${settings.PREFIX}resume\n│ 🎶 ${settings.PREFIX}nowplaying\n│\n${mini}\n${line}\n${settings.FOOTER}`;
          } else if (category === "18" || category === "ai" || category === "assistant") {
            menuText = `${title("🤖", "𝑺𝑴𝑨𝑹𝑻 𝑨𝑰") }\n│\n│ 🤖 ${settings.PREFIX}ai <question>\n│ 🧠 Mention *SACHi* for AI\n│ 💬 ${settings.PREFIX}profile\n│ 🛡️ Group ${settings.PREFIX}aimod on/off\n│ 🧠 Group ${settings.PREFIX}smartai on/off\n│\n${mini}\n${line}\n${settings.FOOTER}`;
          } else if (category === "19" || category === "aimod" || category === "securityai") {
            menuText = `${title("🛡️", "𝑨𝑰 𝑴𝑶𝑫𝑬𝑹𝑨𝑻𝑰𝑶𝑵") }\n│\n│ 🤖 ${settings.PREFIX}aimod on/off\n│ 🧠 ${settings.PREFIX}smartai on/off\n│ 🔗 ${settings.PREFIX}antilink on/off\n│ 🚨 ${settings.PREFIX}antispam on/off\n│ 🚫 ${settings.PREFIX}antibadword on/off\n│ ⚠️ ${settings.PREFIX}warnlimit 3\n│\n${mini}\n${line}\n${settings.FOOTER}`;
          } else {
            menuText = `╭━━━〔 👑 𝑺𝑨𝑪𝑯𝒊-𝑴𝑫 〕━━━╮
│
│  ✨ 𝑷𝑹𝑬𝑴𝑰𝑼𝑴 𝑾𝑯𝑨𝑻𝑺𝑨𝑷𝑷 𝑩𝑶𝑻
│  🟢 𝑺𝑻𝑨𝑻𝑼𝑺 : 𝑶𝑵𝑳𝑰𝑵𝑬
│  ⚡ 𝑷𝑹𝑬𝑭𝑰𝑿 : ${settings.PREFIX}
│  👋 𝑯𝒆𝒍𝒍𝒐 : ${settings.OWNER_NAME}
│
╰━━━━━━━━━━━━━━━━━━━━━━╯

╭━━〔 📚 𝑴𝑬𝑵𝑼 〕━━╮
│
│ ❶ 👑 𝑶𝒘𝒏𝒆𝒓 𝑷𝒂𝒏𝒆𝒍
│ ❷ ⚙️ 𝑴𝒂𝒊𝒏 𝑪𝒐𝒎𝒎𝒂𝒏𝒅𝒔
│ ❸ 🎵 𝑫𝒐𝒘𝒏𝒍𝒐𝒂𝒅 𝑪𝒆𝒏𝒕𝒆𝒓
│ ❹ 🔎 𝑺𝒆𝒂𝒓𝒄𝒉 & 𝑻𝒐𝒐𝒍𝒔
│ ❺ 🛡️ 𝑩𝒐𝒕 𝑺𝒆𝒕𝒕𝒊𝒏𝒈𝒔
│ ❻ 🗑️ 𝑨𝒏𝒕𝒊-𝑫𝒆𝒍𝒆𝒕𝒆
│ ❼ 👁️ 𝑽𝒊𝒆𝒘-𝑶𝒏𝒄𝒆
│ ❽ 📦 𝑴𝒐𝒓𝒆 𝑭𝒆𝒂𝒕𝒖𝒓𝒆𝒔
│ ❾ 👥 𝑮𝒓𝒐𝒖𝒑 𝑪𝒐𝒎𝒎𝒂𝒏𝒅𝒔
│
│ ❿ 😂 𝑭𝒖𝒏 & 𝑮𝒂𝒎𝒆𝒔
│ ⓫ 🧰 𝑼𝒕𝒊𝒍𝒊𝒕𝒚 𝑪𝒆𝒏𝒕𝒆𝒓
│ ⓬ 🎬 𝑴𝒆𝒅𝒊𝒂 𝑺𝒕𝒖𝒅𝒊𝒐
│ ⓭ 💰 𝑬𝒄𝒐𝒏𝒐𝒎𝒚 & 𝑳𝒆𝒗𝒆𝒍𝒔
│ ⓮ 💎 𝑷𝒓𝒆𝒎𝒊𝒖𝒎 & 𝑺𝒕𝒂𝒕𝒔
│ ⓯ 🛡️ 𝑨𝒅𝒗𝒂𝒏𝒄𝒆𝒅 𝑺𝒆𝒄𝒖𝒓𝒊𝒕𝒚
│ ⓰ 👤 𝑼𝒔𝒆𝒓 𝑷𝒓𝒐𝒇𝒊𝒍𝒆
│ ⓱ 🎧 𝑴𝒖𝒔𝒊𝒄 𝑷𝒍𝒂𝒚𝒆𝒓
│ ⓲ 🤖 𝑺𝒎𝒂𝒓𝒕 𝑨𝑰
│ ⓳ 🧠 𝑨𝑰 𝑴𝒐𝒅𝒆𝒓𝒂𝒕𝒊𝒐𝒏
│
╰━━━━━━━━━━━━━━━━━━━━╯

╭━━〔 ⚡ 𝑸𝑼𝑰𝑪𝑲 𝑨𝑪𝑪𝑬𝑺𝑺 〕━━╮
│ 📌 𝑹𝒆𝒑𝒍𝒚 𝒘𝒊𝒕𝒉 *❶–⓳* 𝒕𝒐 𝒐𝒑𝒆𝒏 𝒂 𝒄𝒂𝒕𝒆𝒈𝒐𝒓𝒚.
│ 🔹 𝑬𝒙𝒂𝒎𝒑𝒍𝒆 : ${settings.PREFIX}menu 7
│ 🔹 𝑯𝒐𝒎𝒆 : ${settings.PREFIX}menu
╰━━━━━━━━━━━━━━━━━━━━╯

💫 𝑭𝒂𝒔𝒕 • 𝑺𝒆𝒄𝒖𝒓𝒆 • 𝑷𝒐𝒘𝒆𝒓𝒇𝒖𝒍
✨ *𝑺𝑨𝑪𝑯𝒊-𝑴𝑫 • 𝑨𝒍𝒘𝒂𝒚𝒔 𝑾𝒊𝒕𝒉 𝒀𝒐𝒖* ✨
${settings.FOOTER}`;
          }

          const menuImage = path.join(__dirname, "menu_banner.jpg");

          if (fs.existsSync(menuImage)) {
            await sock.sendMessage(replyChat, { image: fs.readFileSync(menuImage), caption: menuText }, quoteOptions);
          } else {
            await sendBotText(sock, replyChat, menuText, quoteOptions);
          }
          // Buttons intentionally disabled. The menu is now a single image + text message.

        } else if (["time", "date"].includes(cmd)) {
          const now = new Date();
          const dateText = now.toLocaleDateString("en-GB", { timeZone: "Asia/Colombo", day: "2-digit", month: "2-digit", year: "numeric" });
          const timeText = now.toLocaleTimeString("en-US", { timeZone: "Asia/Colombo", hour: "2-digit", minute: "2-digit", second: "2-digit" });
          const text = cmd === "time"
            ? `🕒 *${settings.BOT_NAME} — TIME*\n\n🇱🇰 Sri Lanka Time : ${timeText}\n📅 Date : ${dateText}\n\n${settings.FOOTER}`
            : `📅 *${settings.BOT_NAME} — DATE*\n\n🇱🇰 Date : ${dateText}\n🕒 Time : ${timeText}\n\n${settings.FOOTER}`;
          await sock.sendMessage(replyChat, { text }, quoteOptions);

        } else if (cmd === "runtime" || cmd === "uptime") {
          const total = Math.floor(process.uptime());
          const d = Math.floor(total / 86400);
          const h = Math.floor((total % 86400) / 3600);
          const m = Math.floor((total % 3600) / 60);
          const sec = total % 60;
          await sock.sendMessage(replyChat, {
            text: `⏱️ *${settings.BOT_NAME} — RUNTIME*\n\n🟢 Online : ${d}d ${h}h ${m}m ${sec}s\n🚀 Status : ACTIVE\n\n${settings.FOOTER}`
          }, quoteOptions);

        } else if (cmd === "id" || cmd === "jid") {
          const jid = String(msg.key.remoteJid || "unknown");
          const participant = String(msg.key.participant || sender || "unknown");
          await sock.sendMessage(replyChat, {
            text: `🆔 *${settings.BOT_NAME} — CHAT INFO*\n\n💬 Chat JID : ${jid}\n👤 Sender : ${participant}\n\n${settings.FOOTER}`
          }, quoteOptions);

        } else if (cmd === "send") {
          // Owner-only direct sender: .send 947xxxxxxxxx <message>
          // Or reply to a message/media: .send 947xxxxxxxxx
          if (!isOwner) {
            await sendBotText(sock, replyChat, "❌ Owner only. 👑", quoteOptions);
            continue;
          }

          const rawParts = args.split(/\s+/).filter(Boolean);
          const rawNumber = String(rawParts.shift() || "").replace(/[^0-9]/g, "");
          let targetNumber = rawNumber;
          if (targetNumber.startsWith("0")) targetNumber = "94" + targetNumber.slice(1);
          else if (targetNumber.startsWith("7") && targetNumber.length === 9) targetNumber = "94" + targetNumber;
          if (!/^94[0-9]{9}$/.test(targetNumber)) {
            await sendBotText(sock, replyChat, `❌ Invalid number.\n\nUse: ${settings.PREFIX}send 947xxxxxxxxx <message>\nOr reply to a message/media and use: ${settings.PREFIX}send 947xxxxxxxxx`, quoteOptions);
            continue;
          }

          const targetJid = `${targetNumber}@s.whatsapp.net`;
          const sendText = rawParts.join(" ").trim();
          const quoted = quotedOf(msg.message);

          try {
            if (sendText) {
              await sendBotText(sock, targetJid, sendText);
            } else if (quoted) {
              const q = unwrap(quoted);
              const qType = getContentType(q);
              if (qType === "conversation") {
                await sendBotText(sock, targetJid, q.conversation);
              } else if (qType === "extendedTextMessage") {
                await sendBotText(sock, targetJid, q.extendedTextMessage?.text || "");
              } else if (qType === "imageMessage" || qType === "videoMessage" || qType === "audioMessage" || qType === "documentMessage" || qType === "stickerMessage") {
                const source = q[qType];
                const mediaType = qType === "imageMessage" ? "image" : qType === "videoMessage" ? "video" : qType === "audioMessage" ? "audio" : qType === "documentMessage" ? "document" : "sticker";
                const buffer = await toBuffer(await downloadContentFromMessage(source, mediaType), 25 * 1024 * 1024);
                if (qType === "imageMessage") await sock.sendMessage(targetJid, { image: buffer, caption: source.caption || "" });
                else if (qType === "videoMessage") await sock.sendMessage(targetJid, { video: buffer, caption: source.caption || "", mimetype: source.mimetype || "video/mp4" });
                else if (qType === "audioMessage") await sock.sendMessage(targetJid, { audio: buffer, mimetype: source.mimetype || "audio/ogg; codecs=opus", ptt: !!source.ptt });
                else if (qType === "documentMessage") await sock.sendMessage(targetJid, { document: buffer, mimetype: source.mimetype || "application/octet-stream", fileName: source.fileName || "file" });
                else await sock.sendMessage(targetJid, { sticker: buffer });
              } else {
                await sendBotText(sock, replyChat, "❌ That message type cannot be sent with .send yet.", quoteOptions);
                continue;
              }
            } else {
              await sendBotText(sock, replyChat, `❌ Add a message or reply to a message.\n\nExample: ${settings.PREFIX}send 94778936490 Hello`, quoteOptions);
              continue;
            }
            await sendBotText(sock, replyChat, `✅ Sent successfully to +${targetNumber}`);
          } catch (sendErr) {
            console.error("[SEND CMD]", sendErr);
            await sendBotText(sock, replyChat, `❌ Could not send to +${targetNumber}.\n${sendErr?.message || "Unknown error"}`, quoteOptions);
          }

        } else if (cmd === "getdp" || cmd === "dp") {
          // Get another WhatsApp contact's profile picture: .getdp 947xxxxxxxxx
          const raw = String(args || "").trim().split(/\s+/)[0] || "";
          let targetNumber = raw.replace(/[^0-9]/g, "");
          if (targetNumber.startsWith("0")) targetNumber = "94" + targetNumber.slice(1);
          else if (targetNumber.startsWith("7") && targetNumber.length === 9) targetNumber = "94" + targetNumber;

          if (!/^94[0-9]{9}$/.test(targetNumber)) {
            await sendBotText(sock, replyChat,
              `❌ Invalid number.\n\nUse: ${settings.PREFIX}getdp 947xxxxxxxxx`, quoteOptions);
            continue;
          }

          const targetJid = `${targetNumber}@s.whatsapp.net`;
          try {
            // Baileys respects the profile-photo visibility available to the bot account.
            const dpUrl = await sock.profilePictureUrl(targetJid, "image");
            if (!dpUrl) throw new Error("NO_PROFILE_PICTURE");

            const response = await axios.get(dpUrl, {
              responseType: "arraybuffer",
              timeout: 20000,
              maxContentLength: 10 * 1024 * 1024
            });
            const buffer = Buffer.from(response.data);

            await sock.sendMessage(replyChat, {
              image: buffer,
              caption: `🖼️ *PROFILE PICTURE*\n\n📱 +${targetNumber}\n${settings.FOOTER}`
            }, quoteOptions);
          } catch (dpErr) {
            console.error("[GETDP CMD]", dpErr);
            await sendBotText(sock, replyChat,
              `❌ Could not get the profile picture for +${targetNumber}.\n\nPossible reasons: the number is not on WhatsApp, their profile photo is private/unavailable, or WhatsApp did not return a photo.`,
              quoteOptions);
          }

        } else if (cmd === "info") {
          // Public/legitimate WhatsApp information only: registration and
          // profile-photo availability. No private messages, passwords,
          // location, or other private account data are accessed.
          const raw = String(args || "").trim().split(/\s+/)[0] || "";
          let targetNumber = raw.replace(/[^0-9]/g, "");
          if (targetNumber.startsWith("0")) targetNumber = "94" + targetNumber.slice(1);
          else if (targetNumber.startsWith("7") && targetNumber.length === 9) targetNumber = "94" + targetNumber;

          if (!/^94[0-9]{9}$/.test(targetNumber)) {
            await sendBotText(sock, replyChat,
              `❌ Invalid number.\n\nUse: ${settings.PREFIX}info 947xxxxxxxxx`, quoteOptions);
            continue;
          }

          const targetJid = `${targetNumber}@s.whatsapp.net`;
          try {
            let registered = false;
            try {
              const result = await sock.onWhatsApp(targetNumber);
              registered = Array.isArray(result) && result.some(x => x?.exists === true);
            } catch {}

            let hasPhoto = false;
            try {
              const dpUrl = await sock.profilePictureUrl(targetJid, "image");
              hasPhoto = !!dpUrl;
            } catch {}

            let statusAvailable = false;
            try {
              if (typeof sock.fetchStatus === "function" && registered) {
                const st = await sock.fetchStatus(targetJid);
                statusAvailable = !!(st && (st.status || st.setAt));
              }
            } catch {}

            const statusLine = statusAvailable
              ? "📝 Status      : Available to bot"
              : "📝 Status      : Not available";

            await sendBotText(sock, replyChat,
              `🔎 *WHATSAPP PUBLIC INFO*\\n\\n` +
              `📱 Number      : +${targetNumber}\\n` +
              `🟢 WhatsApp    : ${registered ? "Yes ✅" : "No / unavailable ❌"}\\n` +
              `🖼️ Profile DP  : ${hasPhoto ? "Available ✅" : "Unavailable 🔒"}\\n` +
              `${statusLine}\\n\\n` +
              `ℹ️ Only information available to this bot account is shown.\\n${settings.FOOTER}`,
              quoteOptions);
          } catch (infoErr) {
            console.error("[INFO CMD]", infoErr);
            await sendBotText(sock, replyChat,
              `❌ Could not retrieve public information for +${targetNumber}.\\n${infoErr?.message || "Unknown error"}`,
              quoteOptions);
          }

        } else if (cmd === "version") {
          await sock.sendMessage(replyChat, {
            text: `📦 *${settings.BOT_NAME}*\n\n⚡ Version : 2.0\n🟢 Status : Online\n🛡️ Mode : Stable\n\n${settings.FOOTER}`
          }, quoteOptions);

        } else if (cmd === "creator" || cmd === "dev") {
          await sendImageWithButtons(sock, replyChat, path.join(__dirname, "menu_banner.jpg"),
            `👨‍💻 *SACHi-MD CREATOR*\n\n✨ Create By : Sachiya\n👤 Name : Sachintha Gayan\n📍 From : Nikawartiya\n📱 Contact : +94778936490\n\n${settings.FOOTER}`,
            [
              { id: "menu_home", text: "📖 Menu" },
              { id: "alive_cmd", text: "🟢 Alive" },
              { id: "owner_cmd", text: "👑 Owner" }
            ], isSelfChat ? {} : quoteOptions);

        } else if (cmd === "botdp") {
          if (!isOwner) {
            await sock.sendMessage(replyChat, { text: "❌ Owner only." }, quoteOptions);
            continue;
          }
          const quoted = quotedOf(msg.message);
          const quotedMedia = unwrap(quoted);
          const quotedType = getContentType(quotedMedia);
          // .botdp with a replied image: use that image immediately.
          if (quotedType === "imageMessage") {
            try {
              const buffer = await toBuffer(await downloadContentFromMessage(quotedMedia.imageMessage, "image"), 8 * 1024 * 1024);
              await sock.updateProfilePicture(sock.user.id, buffer);
              await sock.sendMessage(replyChat, { text: `✅ ${settings.BOT_NAME} profile picture updated from your replied image.\n\n${settings.FOOTER}` }, quoteOptions);
            } catch (e) {
              await sock.sendMessage(replyChat, { text: `❌ Bot DP update failed: ${e?.message || e}` }, quoteOptions);
            }
            continue;
          }
          // .botdp <url>: update from a supplied image URL and persist it.
          const url = String(args || "").trim() || String(settings.BOT_DP_URL || "").trim();
          if (!url) {
            await sock.sendMessage(replyChat, { text: `🖼️ Reply to an image with ${settings.PREFIX}botdp OR use ${settings.PREFIX}botdp <image-url>` }, quoteOptions);
            continue;
          }
          try {
            const response = await axios.get(url, { responseType: "arraybuffer", timeout: 20000, maxContentLength: 5 * 1024 * 1024 });
            if (!response?.data?.length) throw new Error("Empty image response");
            await sock.updateProfilePicture(sock.user.id, Buffer.from(response.data));
            settings.BOT_DP_URL = url;
            saveRuntimeSettings();
            await sock.sendMessage(replyChat, { text: `✅ ${settings.BOT_NAME} profile picture updated.\n💾 URL saved for future restarts.\n\n${settings.FOOTER}` }, quoteOptions);
          } catch (e) {
            await sock.sendMessage(replyChat, { text: `❌ Bot DP update failed. Check the image URL or reply to a photo.\n\n${e?.message || e}` }, quoteOptions);
          }

        } else if (cmd === "owner") {
          const ownerText = `╭━━〔 👑 ${settings.BOT_NAME} 〕━━╮\n│\n│ 🌸 𝑾𝒆𝒍𝒄𝒐𝒎𝒆 𝑴𝒚 𝑪𝒉𝒊𝒆𝒇 👑💖\n│\n│ 👤 𝑶𝒘𝒏𝒆𝒓 : ${settings.OWNER_NAME}\n│ 📱 𝑵𝒖𝒎𝒃𝒆𝒓 : +${settings.OWNER_NUMBER}\n│\n│ 💎 𝑷𝒐𝒘𝒆𝒓 : 𝑭𝑼𝑳𝑳 𝑨𝑪𝑪𝑬𝑺𝑺\n│ 🛡️ 𝑺𝒕𝒂𝒕𝒖𝒔 : 𝑶𝑾𝑵𝑬𝑹 𝑶𝑵𝑳𝒀\n│ ⚡ 𝑺𝒕𝒂𝒕𝒆 : 𝑭𝑨𝑺𝑻 • 𝑺𝑬𝑪𝑼𝑹𝑬 • 𝑨𝑪𝑻𝑰𝑽𝑬\n│\n╰━━━〔 💖 𝑺𝑨𝑪𝑯𝒊-𝑴𝑫 〕━━━╯`;
          await sendImageWithButtons(sock, replyChat, path.join(__dirname, "menu_banner.jpg"), ownerText, [
            { id: "sachiya_cmd", text: "👤 Sachiya" },
            { id: "menu_home", text: "📖 Menu" },
            { id: "alive_cmd", text: "🟢 Alive" }
          ], isSelfChat ? {} : quoteOptions);

        } else if (cmd === "botsetting" || cmd === "settings") {
          await sock.sendMessage(replyChat, {
            text: `⚙️ ${settings.BOT_NAME} SETTINGS\n\n📖 Auto Read : ${settings.AUTO_READ ? "ON" : "OFF"}\n📢 Auto Status : ${settings.AUTO_STATUS ? "ON" : "OFF"}\n🛡️ Anti Delete : ${settings.ANTI_DELETE ? "ON" : "OFF"}\n🖼️ Bot DP : Configured\n📝 Footer : ${settings.FOOTER}\n\nOwner only: ${settings.PREFIX}autoread on/off\n${settings.PREFIX}autostatus on/off\n${settings.PREFIX}antidelete on/off\n\n${settings.FOOTER}`
          }, quoteOptions);

        } else if (["autoread", "autostatus", "antidelete"].includes(cmd)) {
          if (!isOwner) {
            await sock.sendMessage(replyChat, { text: "❌ Owner only." }, quoteOptions);
            continue;
          }
          const value = args.toLowerCase();
          if (!['on','off'].includes(value)) {
            await sock.sendMessage(replyChat, { text: `Use: ${settings.PREFIX}${cmd} on/off` }, quoteOptions);
            continue;
          }
          const key = cmd === "autoread" ? "AUTO_READ" : cmd === "autostatus" ? "AUTO_STATUS" : "ANTI_DELETE";
          settings[key] = value === "on";
          saveRuntimeSettings();
          await sock.sendMessage(replyChat, { text: `✅ ${cmd} ${settings[key] ? "enabled" : "disabled"}.` }, quoteOptions);

        } else if (cmd === "sachiya") {
          const sachiyaText = `╭━━〔 👤 SACHIYA 〕━━╮\n│\n│ 🧑 Name    : Sachintha Gayan\n│ 🎂 Age     : 17\n│ 📍 From    : Nikawartiya\n│ 📱 Contact : +94778936490\n│\n╰━━━━━━━━━━━━━━━━━━╯`;
          await sendImageWithButtons(sock, replyChat, path.join(__dirname, "menu_banner.jpg"), sachiyaText, [
            { id: "menu_home", text: "📖 Menu" },
            { id: "alive_cmd", text: "🟢 Alive" },
            { id: "owner_cmd", text: "👑 Owner" }
          ], isSelfChat ? {} : quoteOptions);

        } else if (cmd === "ping") {
          await sock.sendMessage(replyChat, {
            text: `🏓 Pong!\n${settings.BOT_NAME} is online.\n\n${settings.FOOTER}`
          }, quoteOptions);

        } else if (cmd === "setalive") {
          if (!isOwner) {
            await sendBotText(sock, replyChat, "❌ Owner only. 👑", quoteOptions);
            continue;
          }

          const quoted = quotedOf(msg.message);
          const media = unwrap(quoted);
          const type = getContentType(media);

          if (type !== "audioMessage") {
            await sendBotText(
              sock,
              replyChat,
              `🎙️ Reply to a WhatsApp voice note and use ${settings.PREFIX}setalive`,
              quoteOptions
            );
            continue;
          }

          const source = media.audioMessage;
          const mimetype = String(source?.mimetype || "").toLowerCase();
          if (!mimetype.includes("audio/ogg") || !mimetype.includes("opus")) {
            await sendBotText(
              sock,
              replyChat,
              "❌ Please reply to an OGG/Opus WhatsApp voice note. This keeps .alive as a proper voice note.",
              quoteOptions
            );
            continue;
          }

          const buffer = await toBuffer(
            await downloadContentFromMessage(source, "audio"),
            10 * 1024 * 1024
          );

          if (!buffer.length) {
            await sendBotText(sock, replyChat, "❌ Could not download the voice note.", quoteOptions);
            continue;
          }

          const aliveVoice = path.join(__dirname, "alive_voice.ogg");
          fs.writeFileSync(aliveVoice, buffer);
          await sendBotText(
            sock,
            replyChat,
            `✅ Alive voice updated!\nNow ${settings.PREFIX}alive will use this voice. 🎙️`,
            quoteOptions
          );

        } else if (cmd === "alive") {
          const aliveText = `╭━━〔 🟢 ${settings.BOT_NAME} — ALIVE 〕━━╮\n│\n│ 👋 HELLO THERE!\n│ ✨ ${settings.BOT_NAME} IS ALIVE NOW ✨\n│\n│ 🤖 Bot    : ${settings.BOT_NAME}\n│ 🟢 Status : ONLINE\n│ ⚡ Speed  : FAST & ACTIVE\n│ 🛡️ System : SECURE\n│\n╰━━━━━━━━━━━━━━━━━━━━━━╯`;
          await sendImageWithButtons(sock, replyChat, path.join(__dirname, "menu_banner.jpg"), aliveText, [
            { id: "menu_home", text: "📖 Main Menu" },
            { id: "ping_cmd", text: "⚡ Ping" },
            { id: "owner_cmd", text: "👑 Owner" }
          ], isSelfChat ? {} : quoteOptions);
          const aliveVoice = path.join(__dirname, "alive_voice.ogg");
          if (fs.existsSync(aliveVoice)) {
            await sock.sendMessage(replyChat, {
              audio: fs.readFileSync(aliveVoice),
              mimetype: "audio/ogg; codecs=opus",
              ptt: true
            }, isSelfChat ? {} : quoteOptions);
          }

        } else if (cmd === "song") {
          if (!args) {
            await sock.sendMessage(replyChat, { text: `Use: ${settings.PREFIX}song <song name>` }, quoteOptions);
            continue;
          }

          await sock.sendMessage(replyChat, { text: "⏳ Searching song..." }, quoteOptions);
          const search = await yts(args);
          const video = search.videos?.[0];
          if (!video?.url) throw new Error("SONG_NOT_FOUND");

          let apiMedia = null;
          if (settings.MEDIA_API_URL) {
            try {
              apiMedia = await cobaltDownload(video.url, "audio");
              console.log("[MEDIA API] .song downloaded via configured API");
            } catch (apiErr) {
              console.error("[MEDIA API .song]", apiErr?.message || apiErr);
            }
          }

          if (apiMedia?.buffer?.length) {
            await sock.sendMessage(replyChat, {
              audio: apiMedia.buffer,
              mimetype: "audio/mpeg",
              fileName: apiMedia.filename || `${String(video.title || "song").replace(/[\\/:*?"<>|]/g, "_").slice(0, 80)}.mp3`,
              ptt: false
            }, quoteOptions);
          } else {
            const videoId = video.videoId || extractYouTubeId(video.url);
            if (!videoId) throw new Error("YOUTUBE_ID_NOT_FOUND");

            let audio = null;
            let mime = "audio/mp4";
            let extension = "m4a";
            try {
              audio = await youtubeAudioDownload(videoId);
            } catch (primaryErr) {
              console.warn("[SONG] YouTube direct download failed; trying fallback:", primaryErr?.message || primaryErr);
              try {
                const fallback = await invidiousAudioDownload(videoId);
                audio = fallback.buffer;
                mime = fallback.mime;
                extension = fallback.extension;
                console.log("[SONG] Downloaded via Invidious fallback.");
              } catch (fallbackErr) {
                const primary = String(primaryErr?.message || primaryErr || "");
                const fallback = String(fallbackErr?.message || fallbackErr || "");
                throw new Error(`SONG_DOWNLOAD_FAILED: ${primary || fallback}`);
              }
            }

            await sock.sendMessage(replyChat, {
              audio,
              mimetype: mime,
              fileName: `${String(video.title || "song").replace(/[\\/:*?"<>|]/g, "_").slice(0, 80)}.${extension}`,
              ptt: false
            }, quoteOptions);
          }

        } else if (cmd === "yt") {
          if (!args) {
            await sock.sendMessage(replyChat, { text: `Use: ${settings.PREFIX}yt <YouTube link or search>` }, quoteOptions);
            continue;
          }

          await sock.sendMessage(replyChat, { text: "⏳ Getting YouTube audio..." }, quoteOptions);
          let url = args;
          let title = "YouTube audio";
          if (!/^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(args)) {
            const search = await yts(args);
            const video = search.videos?.[0];
            if (!video?.url) throw new Error("YT_NOT_FOUND");
            url = video.url;
            title = video.title || title;
          }

          if (settings.MEDIA_API_URL) {
            try {
              const apiMedia = await cobaltDownload(url, "audio");
              if (apiMedia?.buffer?.length) {
                await sock.sendMessage(replyChat, {
                  audio: apiMedia.buffer, mimetype: "audio/mpeg",
                  fileName: apiMedia.filename || `${String(title).replace(/[\\/:*?"<>|]/g, "_").slice(0, 80)}.mp3`, ptt: false
                }, quoteOptions);
                console.log("[MEDIA API] .yt downloaded via configured API");
                continue;
              }
            } catch (apiErr) {
              console.error("[MEDIA API .yt]", apiErr?.message || apiErr);
            }
          }

          const videoId = extractYouTubeId(url);
          if (!videoId) throw new Error("YOUTUBE_ID_NOT_FOUND");

          let audio = null;
          let mime = "audio/mp4";
          let extension = "m4a";
          try {
            audio = await youtubeAudioDownload(videoId);
          } catch (primaryErr) {
            console.warn("[YT] YouTube direct download failed; trying fallback:", primaryErr?.message || primaryErr);
            try {
              const fallback = await invidiousAudioDownload(videoId);
              audio = fallback.buffer;
              mime = fallback.mime;
              extension = fallback.extension;
              console.log("[YT] Downloaded via Invidious fallback.");
            } catch (fallbackErr) {
              const primary = String(primaryErr?.message || primaryErr || "");
              const fallback = String(fallbackErr?.message || fallbackErr || "");
              throw new Error(`YT_DOWNLOAD_FAILED: ${primary || fallback}`);
            }
          }

          await sock.sendMessage(replyChat, {
            audio,
            mimetype: mime,
            fileName: `${String(title).replace(/[\\/:*?"<>|]/g, "_").slice(0, 80)}.${extension}`,
            ptt: false
          }, quoteOptions);


        } else if (["restart","shutdown","setprefix","mode","autoreply","autoread","autostatus","antidelete","editnotify","deletenotify","viewonce","status","botstatus"].includes(cmd)) {
          if (!isOwner) { await sendBotText(sock, replyChat, "❌ 𝑶𝒏𝒍𝒚 𝑶𝒘𝒏𝒆𝒓 𝒄𝒂𝒏 𝒖𝒔𝒆 𝒕𝒉𝒊𝒔 𝒄𝒐𝒎𝒎𝒂𝒏𝒅 👑", quoteOptions); continue; }
          if (cmd === "restart") {
            await sendBotText(sock, replyChat, `♻️ 𝑹𝒆𝒔𝒕𝒂𝒓𝒕𝒊𝒏𝒈 ${settings.BOT_NAME}...`, quoteOptions);
            setTimeout(() => process.exit(0), 1200);
          } else if (cmd === "shutdown") {
            await sendBotText(sock, replyChat, `🛑 ${settings.BOT_NAME} 𝒊𝒔 𝒔𝒉𝒖𝒕𝒕𝒊𝒏𝒈 𝒅𝒐𝒘𝒏...`, quoteOptions);
            setTimeout(() => process.exit(0), 1200);
          } else if (cmd === "setprefix") {
            const np = String(args || "").trim();
            if (!np || np.length > 3) { await sendBotText(sock, replyChat, `Use: ${settings.PREFIX}setprefix !`, quoteOptions); continue; }
            settings.PREFIX = np; saveRuntimeSettings();
            await sendBotText(sock, replyChat, `✅ 𝑷𝒓𝒆𝒇𝒊𝒙 𝒄𝒉𝒂𝒏𝒈𝒆𝒅 𝒕𝒐: ${np}`, quoteOptions);
          } else if (cmd === "mode") {
            const mode = String(args || "").toLowerCase();
            if (!["public","private"].includes(mode)) { await sendBotText(sock, replyChat, `Use: ${settings.PREFIX}mode public/private`, quoteOptions); continue; }
            settings.BOT_MODE = mode; saveRuntimeSettings();
            await sendBotText(sock, replyChat, `⚙️ 𝑩𝒐𝒕 𝑴𝒐𝒅𝒆 : ${mode.toUpperCase()} ${mode === "public" ? "🌐" : "🔒"}`, quoteOptions);
          } else if (["editnotify", "deletenotify", "viewonce"].includes(cmd)) {
            const map = { editnotify: "EDIT_NOTIFY_SCOPE", deletenotify: "DELETE_NOTIFY_SCOPE", viewonce: "VIEW_ONCE_NOTIFY_SCOPE" };
            const key = map[cmd];
            const value = String(args || "").toLowerCase().trim();
            if (!value) {
              const current = cmd === "viewonce" ? `${settings.VIEW_ONCE_OPEN_NOTIFY ? "on" : "off"} / auto-inbox:${settings.VIEW_ONCE_AUTO_INBOX ? "on" : "off"} / ${normalizeNotifyScope(settings.VIEW_ONCE_NOTIFY_SCOPE)}` : normalizeNotifyScope(settings[key]);
              await sendBotText(sock, replyChat, `⚙️ ${cmd.toUpperCase()} : ${current}\n\nUse: ${settings.PREFIX}${cmd} inbox\n${settings.PREFIX}${cmd} group\n${settings.PREFIX}${cmd} both${cmd === "viewonce" ? `\n${settings.PREFIX}${cmd} on/off` : ""}`, quoteOptions);
              continue;
            }
            if (cmd === "viewonce" && ["on", "off"].includes(value)) {
              settings.VIEW_ONCE_OPEN_NOTIFY = value === "on";
            } else {
              const scope = normalizeNotifyScope(value, "");
              if (!scope) { await sendBotText(sock, replyChat, `❌ Use only: inbox, group, both`, quoteOptions); continue; }
              settings[key] = scope;
            }
            saveRuntimeSettings();
            await sendBotText(sock, replyChat, `✅ ${cmd.toUpperCase()} saved.\n📥 Inbox: ${normalizeNotifyScope(settings[key])}\n👁️ View-once open: ${settings.VIEW_ONCE_OPEN_NOTIFY ? "ON" : "OFF"}`, quoteOptions);
          } else if (["autoreply","autoread","autostatus","antidelete"].includes(cmd)) {
            const map = { autoreply:"AUTO_REPLY_DAILY", autoread:"AUTO_READ", autostatus:"AUTO_STATUS", antidelete:"ANTI_DELETE" };
            const mode = String(args || "").toLowerCase();
            if (!["on","off"].includes(mode)) { const k=map[cmd]; await sendBotText(sock, replyChat, `⚙️ ${cmd.toUpperCase()} : ${settings[k] ? "ON ✅" : "OFF ❌"}\nUse: ${settings.PREFIX}${cmd} on/off`, quoteOptions); continue; }
            settings[map[cmd]] = mode === "on"; saveRuntimeSettings();
            await sendBotText(sock, replyChat, `╭━━〔 ⚙️ ${cmd.toUpperCase()} 〕━━╮\n│\n│ 📊 𝑺𝒕𝒂𝒕𝒖𝒔 : ${mode === "on" ? "𝑶𝑵 ✅" : "𝑶𝑭𝑭 ❌"}\n│ 💾 𝑺𝒂𝒗𝒆𝒅 : 𝑷𝑬𝑹𝑴𝑨𝑵𝑬𝑵𝑻\n│\n╰━━━━━━━━━━━━━━━━━━━━╯`, quoteOptions);
          } else {
            let groups = 0; try { const g = await sock.groupFetchAllParticipating(); groups = Object.keys(g || {}).length; } catch {}
            const total = Math.floor(process.uptime()); const h=Math.floor(total/3600), m=Math.floor((total%3600)/60), sec=total%60;
            await sendBotText(sock, replyChat, `╭━━〔 👑 𝑺𝑨𝑪𝑯𝒊-𝑴𝑫 𝑺𝑻𝑨𝑻𝑼𝑺 〕━━╮\n│\n│ 🟢 𝑺𝒕𝒂𝒕𝒖𝒔 : 𝑶𝑵𝑳𝑰𝑵𝑬\n│ 👑 𝑶𝒘𝒏𝒆𝒓 : ${settings.OWNER_NAME}\n│ ⚡ 𝑴𝒐𝒅𝒆 : ${settings.BOT_MODE.toUpperCase()}\n│ 💫 𝑨𝒖𝒕𝒐𝑹𝒆𝒂𝒄𝒕 : ${settings.AUTO_REACT ? "ON 🟢" : "OFF 🔴"}\n│ 💬 𝑨𝒖𝒕𝒐𝑹𝒆𝒑𝒍𝒚 : ${settings.AUTO_REPLY_DAILY ? "ON 🟢" : "OFF 🔴"}\n│ 🗑️ 𝑨𝒏𝒕𝒊𝑫𝒆𝒍𝒆𝒕𝒆 : ${settings.ANTI_DELETE ? "ON 🟢" : "OFF 🔴"}\n│ 👥 𝑮𝒓𝒐𝒖𝒑𝒔 : ${groups}\n│ ⏱️ 𝑼𝒑𝒕𝒊𝒎𝒆 : ${h}h ${m}m ${sec}s\n│\n╰━━━━━━━━━━━━━━━━━━━━╯\n${settings.FOOTER}`, quoteOptions);
          }

        } else if (cmd === "autoreact") {
          if (!isOwner) {
            await sendBotText(sock, replyChat, "❌ 𝑶𝒏𝒍𝒚 𝑶𝒘𝒏𝒆𝒓 𝒄𝒂𝒏 𝒖𝒔𝒆 .autoreact 👑", quoteOptions);
            continue;
          }
          const mode = String(args || "").toLowerCase();
          if (!["on", "off"].includes(mode)) {
            await sendBotText(sock, replyChat, `💫 𝑨𝒖𝒕𝒐 𝑹𝒆𝒂𝒄𝒕 : ${settings.AUTO_REACT ? "𝑶𝑵 ✅" : "𝑶𝑭𝑭 ❌"}\n\nUse: ${settings.PREFIX}autoreact on/off\n\n👑 𝑶𝒘𝒏𝒆𝒓 𝑶𝒏𝒍𝒚`, quoteOptions);
            continue;
          }
          settings.AUTO_REACT = mode === "on";
          saveRuntimeSettings();
          await sendBotText(sock, replyChat, `╭━━〔 💫 𝑨𝑼𝑻𝑶 𝑹𝑬𝑨𝑪𝑻 〕━━╮\n│\n│ 📊 𝑺𝒕𝒂𝒕𝒖𝒔 : ${settings.AUTO_REACT ? "𝑶𝑵 ✅" : "𝑶𝑭𝑭 ❌"}\n│ 👑 𝑨𝒄𝒄𝒆𝒔𝒔 : 𝑶𝑾𝑵𝑬𝑹 𝑶𝑵𝑳𝒀\n│\n╰━━━━━━━━━━━━━━━━━━━━╯\n\n${settings.FOOTER}`, quoteOptions);

        } else if (["love","loveme"].includes(cmd)) {
          await sendBotText(sock, replyChat, `💖 𝑰 𝑳𝑶𝑽𝑬 𝒀𝑶𝑼 🥹💞\n\n💕 💗 💓 💖 💕\n🫶🏻 𝑭𝒐𝒓𝒆𝒗𝒆𝒓 & 𝑨𝒍𝒘𝒂𝒚𝒔 🫶🏻`, quoteOptions);
        } else if (cmd === "ship") {
          const mentions = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
          const a = mentions[0] ? `@${mentions[0].split("@")[0]}` : "𝑼𝒔𝒆𝒓 ❶"; const b = mentions[1] ? `@${mentions[1].split("@")[0]}` : "𝑼𝒔𝒆𝒓 ❷";
          await sock.sendMessage(replyChat, { text: `💘 𝑺𝑯𝑰𝑷 𝑴𝑬𝑻𝑬𝑹 💘\n\n${a} 💞 ${b}\n\n💗 𝑳𝒐𝒗𝒆 𝑺𝒄𝒐𝒓𝒆 : ${Math.floor(Math.random()*101)}% 🥰`, mentions }, quoteOptions);
        } else if (cmd === "joke") {
          const jokes=["😂 𝑾𝒉𝒚 𝒅𝒊𝒅 𝒕𝒉𝒆 𝒃𝒐𝒕 𝒈𝒐 𝒕𝒐 𝒔𝒄𝒉𝒐𝒐𝒍? 𝑻𝒐 𝒊𝒎𝒑𝒓𝒐𝒗𝒆 𝒊𝒕𝒔 𝒏𝒆𝒕𝒘𝒐𝒓𝒌! 😭","🤣 𝑴𝒚 𝑾𝒊-𝑭𝒊 𝒊𝒔 𝒎𝒚 𝒕𝒓𝒖𝒆 𝒍𝒐𝒗𝒆… 𝒊𝒕 𝒌𝒆𝒆𝒑𝒔 𝒅𝒊𝒔𝒄𝒐𝒏𝒏𝒆𝒄𝒕𝒊𝒏𝒈! 📶💔"];
          await sendBotText(sock, replyChat, jokes[Math.floor(Math.random()*jokes.length)], quoteOptions);
        } else if (cmd === "quote") {
          const quotes=["✨ 𝑩𝒆 𝒚𝒐𝒖𝒓𝒔𝒆𝒍𝒇; 𝒆𝒗𝒆𝒓𝒚𝒐𝒏𝒆 𝒆𝒍𝒔𝒆 𝒊𝒔 𝒂𝒍𝒓𝒆𝒂𝒅𝒚 𝒕𝒂𝒌𝒆𝒏.","🌙 𝑺𝒎𝒂𝒍𝒍 𝒔𝒕𝒆𝒑𝒔 𝒔𝒕𝒊𝒍𝒍 𝒎𝒐𝒗𝒆 𝒚𝒐𝒖 𝒇𝒐𝒓𝒘𝒂𝒓𝒅."];
          await sendBotText(sock, replyChat, quotes[Math.floor(Math.random()*quotes.length)], quoteOptions);
        } else if (cmd === "truth" || cmd === "dare") {
          const list = cmd === "truth" ? ["💭 𝑾𝒉𝒐 𝒅𝒐 𝒚𝒐𝒖 𝒕𝒉𝒊𝒏𝒌 𝒂𝒃𝒐𝒖𝒕 𝒕𝒉𝒆 𝒎𝒐𝒔𝒕?","💖 𝑾𝒉𝒂𝒕 𝒊𝒔 𝒚𝒐𝒖𝒓 𝒃𝒊𝒈𝒈𝒆𝒔𝒕 𝒅𝒓𝒆𝒂𝒎?"] : ["😎 𝑫𝒂𝒓𝒆: 𝑺𝒆𝒏𝒅 𝒂 𝒇𝒖𝒏𝒏𝒚 𝒔𝒆𝒍𝒇𝒊𝒆.","😂 𝑫𝒂𝒓𝒆: 𝑻𝒚𝒑𝒆 𝑰 𝑳𝑶𝑽𝑬 𝑾𝑨𝑻𝑺𝑨𝑷𝑷 10 𝒕𝒊𝒎𝒆𝒔."];
          await sendBotText(sock, replyChat, list[Math.floor(Math.random()*list.length)], quoteOptions);

        } else if (cmd === "sachilvu") {
          const loveText = `╭━━━〔 💖 𝑺𝑨𝑪𝑯𝑰𝑳𝑽𝑼 💖 〕━━━╮
│
│        💗 💗 💗 💗 💗
│
│      𝑰 𝑳𝑶𝑽𝑬 𝒀𝑶𝑼 🥹💖
│
│   💕 𝑰 𝑳𝑶𝑽𝑬 𝒀𝑶𝑼 💕
│  💞 𝑰 𝑳𝑶𝑽𝑬 𝒀𝑶𝑼 💞
│ 💓 𝑰 𝑳𝑶𝑽𝑬 𝒀𝑶𝑼 💓
│
│      🫶🏻 𝑭𝒐𝒓𝒆𝒗𝒆𝒓 & 𝑨𝒍𝒘𝒂𝒚𝒔 🫶🏻
│
╰━━━━━━━━━━━━━━━━━━━━━━╯
✨ ${settings.BOT_NAME} ✨`;
          await sendBotText(sock, replyChat, loveText, quoteOptions);

        } else if (cmd === "block" || cmd === "unblock") {
          if (!isOwner) {
            await sendBotText(sock, replyChat, "❌ 𝑶𝒘𝒏𝒆𝒓 𝑶𝒏𝒍𝒚.", quoteOptions);
            continue;
          }
          const targetFromContact = () => {
            const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
            if (mentioned.length) return mentioned[0];
            const quotedParticipant = msg.message?.extendedTextMessage?.contextInfo?.participant;
            if (quotedParticipant) return quotedParticipant;
            const first = args.split(/\s+/)[0] || "";
            const digits = first.replace(/\D/g, "");
            return digits.length >= 8 ? `${digits}@s.whatsapp.net` : "";
          };
          const target = targetFromContact();
          if (!target) {
            await sendBotText(sock, replyChat, `❌ 𝑼𝒔𝒆: ${settings.PREFIX}${cmd} @user  𝒐𝒓  ${settings.PREFIX}${cmd} 947xxxxxxxxx`, quoteOptions);
            continue;
          }
          await sock.updateBlockStatus(target, cmd === "block" ? "block" : "unblock");
          const number = String(target).split("@")[0];
          const resultText = cmd === "block"
            ? `╭━━〔 🚫 𝑩𝑳𝑶𝑪𝑲𝑬𝑫 〕━━╮\n│\n│ 👤 𝑵𝒖𝒎𝒃𝒆𝒓 : +${number}\n│ 🔒 𝑺𝒕𝒂𝒕𝒖𝒔  : 𝑩𝒍𝒐𝒄𝒌𝒆𝒅 ✅\n│\n╰━━━━━━━━━━━━━━━━━━╯`
            : `╭━━〔 🔓 𝑼𝑵𝑩𝑳𝑶𝑪𝑲𝑬𝑫 〕━━╮\n│\n│ 👤 𝑵𝒖𝒎𝒃𝒆𝒓 : +${number}\n│ 🔓 𝑺𝒕𝒂𝒕𝒖𝒔  : 𝑼𝒏𝒃𝒍𝒐𝒄𝒌𝒆𝒅 ✅\n│\n╰━━━━━━━━━━━━━━━━━━╯`;
          await sendBotText(sock, replyChat, `${resultText}\n\n${settings.FOOTER}`, quoteOptions);

        } else if (["8ball","roast","meme"].includes(cmd)) {
          if (cmd === "8ball") {
            const answers = ["🎱 Definitely yes.", "🎱 Probably.", "🎱 Ask again later.", "🎱 Not looking good.", "🎱 Absolutely not.", "🎱 The bot says: maybe 😏"];
            await sendBotText(sock, replyChat, `${answers[Math.floor(Math.random()*answers.length)]}\n\n❓ ${args || "Ask me a question."}`, quoteOptions);
          } else if (cmd === "roast") {
            const roasts = ["🔥 Bro is running on 1% battery and 0% logic.", "🔥 Your Wi‑Fi has more connection than your plans.", "🔥 Even the bot needs a software update after hearing that.", "🔥 Respectfully… that was a premium-level mistake 😂"];
            await sendBotText(sock, replyChat, roasts[Math.floor(Math.random()*roasts.length)], quoteOptions);
          } else {
            const r = await axios.get("https://api.imgflip.com/get_memes", { timeout: 10000 });
            const memes = r.data?.data?.memes || [];
            const meme = memes[Math.floor(Math.random()*memes.length)];
            if (!meme?.url) throw new Error("MEME_UNAVAILABLE");
            await sock.sendMessage(replyChat, { image: { url: meme.url }, caption: `😂 ${meme.name}\n\n${settings.FOOTER}` }, quoteOptions);
          }
        } else if (cmd === "calc") {
          const value = safeCalc(args);
          await sendBotText(sock, replyChat, `🧮 *Calculator*\n\n${args} = *${value}*`, quoteOptions);
        } else if (cmd === "weather") {
          if (!args) { await sendBotText(sock, replyChat, `Use: ${settings.PREFIX}weather Colombo`, quoteOptions); continue; }
          const r = await axios.get(`https://wttr.in/${encodeURIComponent(args)}?format=j1`, { timeout: 12000, headers: { "User-Agent": "SACHi-MD" } });
          const c = r.data?.current_condition?.[0];
          const area = r.data?.nearest_area?.[0];
          if (!c) throw new Error("WEATHER_UNAVAILABLE");
          await sendBotText(sock, replyChat, `🌤️ *WEATHER — ${area?.areaName?.[0]?.value || args}*\n\n🌡️ Temp: ${c.temp_C}°C\n🤔 Feels: ${c.FeelsLikeC}°C\n💧 Humidity: ${c.humidity}%\n💨 Wind: ${c.windspeedKmph} km/h\n☁️ ${c.weatherDesc?.[0]?.value || "Unknown"}`, quoteOptions);
        } else if (cmd === "translate") {
          const m = String(args).match(/^([a-zA-Z-]{2,10})\s+(.+)$/);
          if (!m) { await sendBotText(sock, replyChat, `Use: ${settings.PREFIX}translate si hello world`, quoteOptions); continue; }
          const r = await axios.get("https://translate.googleapis.com/translate_a/single", { params: { client:"gtx", sl:"auto", tl:m[1], dt:"t", q:m[2] }, timeout: 10000 });
          const out = (r.data?.[0] || []).map(x => x?.[0]).filter(Boolean).join("");
          await sendBotText(sock, replyChat, `🌐 *Translation → ${m[1]}*\n\n${out || "No translation found."}`, quoteOptions);
        } else if (cmd === "define") {
          if (!args) { await sendBotText(sock, replyChat, `Use: ${settings.PREFIX}define hello`, quoteOptions); continue; }
          const r = await axios.get(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(args)}`, { timeout: 10000 });
          const d = r.data?.[0]; const meanings = d?.meanings || [];
          const lines = meanings.slice(0,3).map(x => `• *${x.partOfSpeech || "word"}*: ${x.definitions?.[0]?.definition || ""}`).join("\n");
          await sendBotText(sock, replyChat, `📖 *${d?.word || args}*\n\n${lines || "No definition found."}`, quoteOptions);
        } else if (cmd === "shorturl") {
          if (!/^https?:\/\//i.test(args)) { await sendBotText(sock, replyChat, `Use: ${settings.PREFIX}shorturl https://example.com`, quoteOptions); continue; }
          const r = await axios.get(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(args)}`, { timeout: 10000 });
          await sendBotText(sock, replyChat, `🔗 *Short URL*\n\n${r.data}`, quoteOptions);
        } else if (cmd === "qr") {
          if (!args) { await sendBotText(sock, replyChat, `Use: ${settings.PREFIX}qr Hello`, quoteOptions); continue; }
          const r = await axios.get(`https://api.qrserver.com/v1/create-qr-code/?size=700x700&data=${encodeURIComponent(args)}`, { responseType:"arraybuffer", timeout:15000 });
          await sock.sendMessage(replyChat, { image: Buffer.from(r.data), caption: `📱 QR CODE\n\n${settings.FOOTER}` }, quoteOptions);
        } else if (cmd === "ss") {
          if (!/^https?:\/\//i.test(args)) { await sendBotText(sock, replyChat, `Use: ${settings.PREFIX}ss https://example.com`, quoteOptions); continue; }
          const r = await axios.get(`https://image.thum.io/get/width/1280/${args}`, { responseType:"arraybuffer", timeout:30000 });
          await sock.sendMessage(replyChat, { image: Buffer.from(r.data), caption: `📸 Screenshot\n${args}` }, quoteOptions);
        } else if (cmd === "tts") {
          if (!args) { await sendBotText(sock, replyChat, `Use: ${settings.PREFIX}tts Hello world`, quoteOptions); continue; }
          const tmp = path.join(os.tmpdir(), `sachi-tts-${Date.now()}.mp3`);
          const r = await axios.get(`https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=en&q=${encodeURIComponent(args)}`, { responseType:"arraybuffer", timeout:15000 });
          fs.writeFileSync(tmp, Buffer.from(r.data));
          await sock.sendMessage(replyChat, { audio: fs.readFileSync(tmp), mimetype:"audio/mpeg", ptt:true }, quoteOptions);
          try { fs.unlinkSync(tmp); } catch {}
        } else if (cmd === "ai") {
          if (!args) { await sendBotText(sock, replyChat, `Use: ${settings.PREFIX}ai <question>\n\nSet AI_API_URL + AI_API_KEY in settings.js for AI mode.`, quoteOptions); continue; }
          if (!settings.AI_API_URL || !settings.AI_API_KEY) { await sendBotText(sock, replyChat, `🤖 AI is ready but not configured.\n\nAdd AI_API_URL and AI_API_KEY to settings.js, then restart the bot.`, quoteOptions); continue; }
          const r = await axios.post(settings.AI_API_URL, { model: settings.AI_MODEL || "gpt-4o-mini", messages: [{ role:"user", content: args }] }, { timeout: 45000, headers: { Authorization:`Bearer ${settings.AI_API_KEY}`, "Content-Type":"application/json" } });
          const answer = r.data?.choices?.[0]?.message?.content || r.data?.output_text || "No response.";
          await sendBotText(sock, replyChat, `🤖 *AI*\n\n${answer}`, quoteOptions);
        } else if (["sticker","s"].includes(cmd)) {
          const quoted = quotedOf(msg.message); const media = unwrap(quoted); const type = getContentType(media);
          if (!media || !["imageMessage","videoMessage"].includes(type)) { await sendBotText(sock, replyChat, `🧩 Reply to an image/video with ${settings.PREFIX}sticker`, quoteOptions); continue; }
          const ext = type === "imageMessage" ? "jpg" : "mp4"; const input = path.join(os.tmpdir(), `sachi-${Date.now()}.${ext}`); const output = path.join(os.tmpdir(), `sachi-${Date.now()}.webp`);
          fs.writeFileSync(input, await toBuffer(await downloadContentFromMessage(media[type], type === "imageMessage" ? "image" : "video"), 12*1024*1024));
          await ffmpegConvert(input, output, ["-vf", "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=black@0", "-vcodec", "libwebp", "-loop", "0", "-preset", "default"]);
          await sock.sendMessage(replyChat, { sticker: fs.readFileSync(output) }, quoteOptions); for (const f of [input,output]) try{fs.unlinkSync(f)}catch{}
        } else if (cmd === "toimg") {
          const quoted = quotedOf(msg.message); const media = unwrap(quoted);
          if (getContentType(media) !== "stickerMessage") { await sendBotText(sock, replyChat, `Use: reply to a sticker with ${settings.PREFIX}toimg`, quoteOptions); continue; }
          const input = path.join(os.tmpdir(), `sachi-${Date.now()}.webp`); const output = path.join(os.tmpdir(), `sachi-${Date.now()}.png`);
          fs.writeFileSync(input, await toBuffer(await downloadContentFromMessage(media.stickerMessage, "sticker"), 12*1024*1024));
          await ffmpegConvert(input, output, ["-frames:v","1"]); await sock.sendMessage(replyChat,{image:fs.readFileSync(output),caption:settings.FOOTER},quoteOptions); for(const f of [input,output])try{fs.unlinkSync(f)}catch{}
        } else if (cmd === "tomp3") {
          const quoted = quotedOf(msg.message); const media = unwrap(quoted); const type = getContentType(media);
          if (!media || !["audioMessage","videoMessage"].includes(type)) { await sendBotText(sock, replyChat, `Use: reply to audio/video with ${settings.PREFIX}tomp3`, quoteOptions); continue; }
          const input = path.join(os.tmpdir(), `sachi-${Date.now()}.${type === "audioMessage" ? "ogg" : "mp4"}`); const output = path.join(os.tmpdir(), `sachi-${Date.now()}.mp3`);
          fs.writeFileSync(input, await toBuffer(await downloadContentFromMessage(media[type], type === "audioMessage" ? "audio" : "video"), 20*1024*1024));
          await ffmpegConvert(input, output, ["-vn","-codec:a","libmp3lame","-q:a","4"]); await sock.sendMessage(replyChat,{audio:fs.readFileSync(output),mimetype:"audio/mpeg",fileName:"sachi.mp3"},quoteOptions); for(const f of [input,output])try{fs.unlinkSync(f)}catch{}
        } else if (["tiktok","igdl","spotify"].includes(cmd)) {
          if (!args || !/^https?:\/\//i.test(args)) { await sendBotText(sock, replyChat, `Use: ${settings.PREFIX}${cmd} <url>`, quoteOptions); continue; }
          if (!settings.MEDIA_API_URL) { await sendBotText(sock, replyChat, `⚠️ ${cmd} needs MEDIA_API_URL in settings.js.`, quoteOptions); continue; }
          const media = await cobaltDownload(args, "auto");
          if (!media?.buffer?.length) throw new Error("MEDIA_DOWNLOAD_EMPTY");
          const mime = String(media.mime || "").toLowerCase();
          const fileName = media.filename || `${cmd}.${mime.startsWith("audio/") ? "mp3" : mime.startsWith("image/") ? "jpg" : "mp4"}`;
          const caption = `📥 ${cmd.toUpperCase()}\n\n${settings.FOOTER}`;
          if (mime.startsWith("audio/")) {
            await sock.sendMessage(replyChat, { audio: media.buffer, mimetype: mime, fileName, ptt: false }, quoteOptions);
          } else if (mime.startsWith("image/")) {
            await sock.sendMessage(replyChat, { image: media.buffer, mimetype: mime, fileName, caption }, quoteOptions);
          } else {
            await sock.sendMessage(replyChat, { video: media.buffer, mimetype: mime || "video/mp4", fileName, caption }, quoteOptions);
          }

        } else if (cmd === "bug" || cmd === "reportbug") {
          const report = String(args || "").trim();
          if (!report) {
            await sendBotText(sock, replyChat, `🐞 *SACHi-MD BUG REPORT*\n\nUse: ${settings.PREFIX}bug <describe the bug>\nExample: ${settings.PREFIX}bug .song command is not downloading`, quoteOptions);
            continue;
          }
          if (report.length < 5) {
            await sendBotText(sock, replyChat, "❌ Please give a little more detail about the bug.", quoteOptions);
            continue;
          }
          const reportId = `BUG-${Date.now().toString(36).toUpperCase()}`;
          let reports = [];
          try {
            if (fs.existsSync(BUG_REPORTS_FILE)) reports = JSON.parse(fs.readFileSync(BUG_REPORTS_FILE, "utf8")) || [];
          } catch { reports = []; }
          const senderNumber = sender || "unknown";
          const reportItem = {
            id: reportId,
            report,
            from: senderNumber,
            chat: replyChat,
            group: msg.key.remoteJid?.endsWith("@g.us") ? msg.key.remoteJid : null,
            createdAt: new Date().toISOString(),
            status: "open"
          };
          reports.push(reportItem);
          try {
            fs.writeFileSync(BUG_REPORTS_FILE, JSON.stringify(reports.slice(-200), null, 2));
          } catch (e) { console.warn("[BUG REPORT] save failed:", e?.message || e); }

          const ownerJid = `${ownerNumber}@s.whatsapp.net`;
          const ownerText = `🐞 *NEW SACHi-MD BUG REPORT*\n\n🆔 ID: ${reportId}\n👤 From: +${senderNumber}\n📍 Chat: ${msg.key.remoteJid?.endsWith("@g.us") ? "Group" : "Private"}\n\n📝 *Report:*\n${report}\n\n🕒 ${new Date().toLocaleString("en-LK")}`;
          try {
            if (ownerJid !== replyChat) await sendBotText(sock, ownerJid, ownerText);
          } catch (e) { console.warn("[BUG REPORT] owner notify failed:", e?.message || e); }
          await sendBotText(sock, replyChat, `╭━━〔 🐞 𝑩𝑼𝑮 𝑹𝑬𝑷𝑶𝑹𝑻𝑬𝑫 〕━━╮\n│\n│ 🆔 ID: ${reportId}\n│ ✅ Status: Sent to owner\n│\n│ Thank you for helping improve ${settings.BOT_NAME}!\n╰━━━━━━━━━━━━━━━━━━━━╯\n\n${settings.FOOTER}`, quoteOptions);

        } else if (cmd === "buglist" || cmd === "bugs") {
          if (!isOwner) {
            await sendBotText(sock, replyChat, "❌ Owner only.", quoteOptions);
            continue;
          }
          let reports = [];
          try {
            if (fs.existsSync(BUG_REPORTS_FILE)) reports = JSON.parse(fs.readFileSync(BUG_REPORTS_FILE, "utf8")) || [];
          } catch { reports = []; }
          const open = reports.filter(x => x.status !== "closed").slice(-10).reverse();
          if (!open.length) {
            await sendBotText(sock, replyChat, "🐞 No open bug reports.", quoteOptions);
            continue;
          }
          const text = `🐞 *OPEN BUG REPORTS*\n\n${open.map((x, i) => `${i + 1}. *${x.id}*\n   👤 +${x.from}\n   📝 ${String(x.report).slice(0, 220)}`).join("\n\n")}\n\nUse ${settings.PREFIX}buginfo <BUG-ID> for details.`;
          await sendBotText(sock, replyChat, text, quoteOptions);

        } else if (cmd === "buginfo") {
          if (!isOwner) {
            await sendBotText(sock, replyChat, "❌ Owner only.", quoteOptions);
            continue;
          }
          const id = String(args || "").trim().toUpperCase();
          let reports = [];
          try {
            if (fs.existsSync(BUG_REPORTS_FILE)) reports = JSON.parse(fs.readFileSync(BUG_REPORTS_FILE, "utf8")) || [];
          } catch { reports = []; }
          const item = reports.find(x => x.id === id);
          if (!item) {
            await sendBotText(sock, replyChat, `❌ Bug report not found.\nUse ${settings.PREFIX}buglist`, quoteOptions);
            continue;
          }
          await sendBotText(sock, replyChat, `🐞 *BUG DETAILS*\n\n🆔 ${item.id}\n👤 +${item.from}\n📍 ${item.group ? "Group" : "Private"}\n📌 Status: ${item.status}\n🕒 ${item.createdAt}\n\n📝 ${item.report}`, quoteOptions);

        } else if (["profile","me","setbio","profilename","leveltitle","music","play","queue","skip","pause","resume","nowplaying","volume"].includes(cmd)) {
          const senderJid = String(msg.key.participant || msg.key.remoteJid || "");
          if (["profile","me","setbio","profilename","leveltitle"].includes(cmd)) {
            const p = getProfile(senderJid);
            if (cmd === "setbio") { if (!args) { await sendBotText(sock, replyChat, `Use: ${settings.PREFIX}setbio <text>`, quoteOptions); continue; } p.bio = args.slice(0,250); saveUserFeatures(); await sendBotText(sock, replyChat, "✅ Bio updated.", quoteOptions); }
            else if (cmd === "profilename") { if (!args) { await sendBotText(sock, replyChat, `Use: ${settings.PREFIX}profilename <name>`, quoteOptions); continue; } p.name = args.slice(0,60); saveUserFeatures(); await sendBotText(sock, replyChat, "✅ Profile name updated.", quoteOptions); }
            else if (cmd === "leveltitle") { const titles=["Newbie","Rookie","Rising Star","Pro","Elite","Legend","SACHi Master"]; const lvl=profileLevel(senderJid); await sendBotText(sock, replyChat, `🏅 Level ${lvl} — *${titles[Math.min(titles.length-1,Math.floor(lvl/5))]}*`, quoteOptions); }
            else { const w=getWallet(senderJid); await sendBotText(sock, replyChat, `╭━━〔 👤 PROFILE 〕━━╮\n│\n│ 🪪 Name: ${p.name || "Not set"}\n│ 📝 Bio: ${p.bio || "Not set"}\n│ ⭐ Level: ${w.level}\n│ ✨ XP: ${w.xp}\n│ 🪙 Coins: ${w.coins}\n│ 💎 Premium: ${isPremium(senderJid)?"ACTIVE":"OFF"}\n│\n╰━━━━━━━━━━━━━━━━━━━━╯`, quoteOptions); }
          } else {
            if (!replyChat) continue; const q=musicQueues[replyChat] || {items:[], index:0, playing:false, title:""}; musicQueues[replyChat]=q;
            if (cmd === "play") { if (!args) { await sendBotText(sock, replyChat, `Use: ${settings.PREFIX}play <song name or YouTube URL>`, quoteOptions); continue; } q.items.push(args); saveUserFeatures(); await sendBotText(sock, replyChat, `🎵 Added to queue: *${args}*\n📋 Position: ${q.items.length}`, quoteOptions); if (!q.playing) { q.playing=true; try { const m=await downloadSongForQuery(q.items[q.index]); q.title=m.title; await sock.sendMessage(replyChat,{audio:m.buffer,mimetype:m.mime,fileName:m.fileName,ptt:false},quoteOptions); } catch(e) { q.items.shift(); q.playing=false; saveUserFeatures(); await sendBotText(sock,replyChat,"❌ Music download failed. Check MEDIA_API_URL or YouTube access.",quoteOptions); } saveUserFeatures(); } }
            else if (cmd === "queue") { await sendBotText(sock, replyChat, `🎶 *MUSIC QUEUE*\n\n${q.items.map((x,i)=>`${i===q.index?"▶️":"▫️"} ${i+1}. ${x}`).join("\n") || "Queue is empty."}`, quoteOptions); }
            else if (cmd === "skip") { if (!q.items.length) { await sendBotText(sock,replyChat,"🎵 Queue is empty.",quoteOptions); continue; } q.items.splice(q.index,1); if (!q.items.length) { q.index=0; q.playing=false; q.title=""; saveUserFeatures(); await sendBotText(sock,replyChat,"⏹️ Queue ended.",quoteOptions); continue; } q.index=Math.min(q.index,q.items.length-1); try { const m=await downloadSongForQuery(q.items[q.index]); q.title=m.title; await sock.sendMessage(replyChat,{audio:m.buffer,mimetype:m.mime,fileName:m.fileName,ptt:false},quoteOptions); } catch { await sendBotText(sock,replyChat,"❌ Next track failed.",quoteOptions); } saveUserFeatures(); }
            else if (cmd === "nowplaying" || cmd === "music") { await sendBotText(sock,replyChat,`🎧 *NOW PLAYING*\n\n${q.playing?q.title||q.items[q.index]:"Nothing playing"}\n📋 Queue: ${q.items.length}`,quoteOptions); }
            else { await sendBotText(sock,replyChat,`ℹ️ WhatsApp audio playback is message-based. Use ${settings.PREFIX}play, ${settings.PREFIX}queue, ${settings.PREFIX}skip, or ${settings.PREFIX}nowplaying.`,quoteOptions); }
          }
        } else if (["balance","bal","daily","work","give","shop","buy","level","xp","leaderboard","rank","ai","stats","premium","addprem","delprem","premlist","antimention","anticaps","antiflood","raidmode","aimod","smartai"].includes(cmd)) {
          const senderJid = String(msg.key.participant || msg.key.remoteJid || "");
          const wallet = getWallet(senderJid);
          if (["balance","bal"].includes(cmd)) { await sendBotText(sock, replyChat, `💰 *SACHi WALLET*\n\n🪙 Coins: *${wallet.coins}*\n⭐ XP: *${wallet.xp}*\n🏆 Level: *${wallet.level}*\n${isPremium(senderJid) ? "💎 Premium: ACTIVE" : ""}`, quoteOptions); }
          else if (cmd === "level" || cmd === "xp" || cmd === "rank") { const all=Object.entries(economy).sort((a,b)=>(b[1].xp||0)-(a[1].xp||0)); const rank=all.findIndex(([j])=>j===senderJid)+1; await sendBotText(sock, replyChat, `🏆 *YOUR RANK*\n\n⭐ XP: ${wallet.xp}\n📈 Level: ${wallet.level}\n🥇 Rank: #${rank || "-"}`, quoteOptions); }
          else if (cmd === "daily") { const now=Date.now(); if(now-wallet.lastDaily<86400000){ await sendBotText(sock,replyChat,"⏳ Daily reward already claimed. Try again tomorrow.",quoteOptions); continue; } wallet.lastDaily=now; wallet.coins+=500; addXp(senderJid,25); saveJsonFile(ECONOMY_FILE,economy); await sendBotText(sock,replyChat,"🎁 *DAILY REWARD*\n\n🪙 +500 coins\n⭐ +25 XP",quoteOptions); }
          else if (cmd === "work") { const now=Date.now(); if(now-wallet.lastWork<3600000){ await sendBotText(sock,replyChat,"⏳ You can work again in about 1 hour.",quoteOptions); continue; } wallet.lastWork=now; const earned=100+Math.floor(Math.random()*401); wallet.coins+=earned; addXp(senderJid,15); saveJsonFile(ECONOMY_FILE,economy); await sendBotText(sock,replyChat,`💼 You worked and earned *${earned} coins*!`,quoteOptions); }
          else if (cmd === "give") { const first=args.split(/\s+/)[0]||""; const target=(msg.message?.extendedTextMessage?.contextInfo?.mentionedJid||[])[0] || (first.replace(/\D/g,"").length>=8?`${first.replace(/\D/g,"")}@s.whatsapp.net`:""); const amount=Number(args.split(/\s+/).pop()); if(!target||!Number.isInteger(amount)||amount<1){ await sendBotText(sock,replyChat,`Use: ${settings.PREFIX}give @user 100`,quoteOptions); continue;} if(wallet.coins<amount){await sendBotText(sock,replyChat,"❌ Not enough coins.",quoteOptions);continue;} wallet.coins-=amount; getWallet(target).coins+=amount; saveJsonFile(ECONOMY_FILE,economy); await sendBotText(sock,replyChat,`💸 Sent *${amount} coins* to @${target.split("@")[0]}.`,{...quoteOptions,mentions:[target]}); }
          else if (cmd === "leaderboard") { const top=Object.entries(economy).sort((a,b)=>(b[1].coins||0)-(a[1].coins||0)).slice(0,10); await sendBotText(sock,replyChat,`🏆 *COIN LEADERBOARD*\n\n${top.map((x,i)=>`${i+1}. @${x[0].split("@")[0]} — 🪙 ${x[1].coins||0}`).join("\n")||"No players yet."}`,{...quoteOptions,mentions:top.map(x=>x[0])}); }
          else if (cmd === "shop") { await sendBotText(sock,replyChat,"🛒 *SACHi SHOP*\n\n💎 Premium 7 days — 5,000 coins\nUse: .buy premium7",quoteOptions); }
          else if (cmd === "buy") { if(args.toLowerCase()==="premium7" && wallet.coins>=5000){ wallet.coins-=5000; premiumUsers[senderJid]={expiresAt:Date.now()+7*86400000,source:"coins"}; saveJsonFile(ECONOMY_FILE,economy); saveJsonFile(PREMIUM_FILE,premiumUsers); await sendBotText(sock,replyChat,"💎 Premium activated for 7 days!",quoteOptions);} else await sendBotText(sock,replyChat,"❌ Use .buy premium7 with 5,000 coins.",quoteOptions); }
          else if (cmd === "premium") { const active=isPremium(senderJid); const exp=premiumUsers[senderJid]?.expiresAt; await sendBotText(sock,replyChat,`💎 *PREMIUM STATUS*\n\n${active?"✅ ACTIVE":"❌ INACTIVE"}${exp?`\n⏳ Expires: ${new Date(exp).toLocaleString("en-LK")}`:""}\n\n🛒 ${settings.PREFIX}shop`,quoteOptions); }
          else if (cmd === "ai") { if(!args){await sendBotText(sock,replyChat,`Use: ${settings.PREFIX}ai <question>`,quoteOptions);continue;} try { const answer=await askSachiAI(args); await sendBotText(sock,replyChat,`🤖 *AI*\n\n${answer}`,quoteOptions);} catch(e){await sendBotText(sock,replyChat,e?.message==="AI_NOT_CONFIGURED"?"🤖 AI is not configured yet. Add AI_API_URL and AI_API_KEY in settings.js.":"❌ AI service error. Check your AI API settings.",quoteOptions);} }
          else if (cmd === "stats") { if(!isOwner && !isPremium(senderJid)){await sendBotText(sock,replyChat,"❌ Owner/Premium only.",quoteOptions);continue;} await sendBotText(sock,replyChat,`📊 *SACHi-MD STATISTICS*\n\n💬 Messages: ${botStats.messages}\n⚡ Commands: ${botStats.commands}\n👤 Tracked users: ${Object.keys(botStats.users||{}).length}\n👥 Tracked groups: ${Object.keys(botStats.groups||{}).length}\n⏱️ Runtime: ${formatDuration(Date.now()-Number(botStats.startedAt||Date.now()))}`,quoteOptions); }
          else if (["addprem","delprem","premlist"].includes(cmd)) { if(!isOwner){await sendBotText(sock,replyChat,"❌ Owner only.",quoteOptions);continue;} const target=(msg.message?.extendedTextMessage?.contextInfo?.mentionedJid||[])[0] || `${(args.split(/\s+/)[0]||"").replace(/\D/g,"")}@s.whatsapp.net`; if(cmd==="premlist"){const list=Object.entries(premiumUsers).filter(([,v])=>v.expiresAt>Date.now()); await sendBotText(sock,replyChat,`💎 *PREMIUM USERS*\n\n${list.map(([j,v])=>`• @${j.split("@")[0]} — ${new Date(v.expiresAt).toLocaleString("en-LK")}`).join("\n")||"None"}`,{...quoteOptions,mentions:list.map(x=>x[0])});continue;} if(!target||target.startsWith("@s.whatsapp.net")){await sendBotText(sock,replyChat,`Use: ${settings.PREFIX}${cmd} @user`,quoteOptions);continue;} if(cmd==="addprem"){premiumUsers[target]={expiresAt:Date.now()+30*86400000,source:"owner"};await sendBotText(sock,replyChat,"💎 Premium added for 30 days.",{...quoteOptions,mentions:[target]});} else {delete premiumUsers[target];await sendBotText(sock,replyChat,"🗑️ Premium removed.",{...quoteOptions,mentions:[target]});} saveJsonFile(PREMIUM_FILE,premiumUsers); }
          else if (["antimention","anticaps","antiflood","raidmode","aimod","smartai"].includes(cmd)) { if(!replyChat.endsWith("@g.us")){await sendBotText(sock,replyChat,"❌ Group only.",quoteOptions);continue;} const metadata=await sock.groupMetadata(replyChat); const participant=String(msg.key.participant||""); const admins=(metadata.participants||[]).filter(p=>p.admin); const admin=admins.some(p=>String(p.id).split(":")[0]===participant.split(":")[0])||isOwner; if(!admin){await sendBotText(sock,replyChat,"❌ Group admins only.",quoteOptions);continue;} const mode=String(args).toLowerCase(); if(!["on","off"].includes(mode)){await sendBotText(sock,replyChat,`Use: ${settings.PREFIX}${cmd} on/off`,quoteOptions);continue;} const cfg=getGroupSettings(replyChat); cfg[cmd]=mode==="on"; saveGroupSettings(); await sendBotText(sock,replyChat,`🛡️ ${cmd} ${mode==="on"?"enabled ✅":"disabled ❌"}.`,quoteOptions); }
        } else if (["groupinfo","admins","tagall","hidetag","promote","demote","kick","add","link","revoke","setname","setdesc","welcome","goodbye","antilink","antispam","antibadword","warn","warnings","resetwarn","addbadword","delbadword","badwords","setrules","rules","warnlimit","mute","unmute","antimention","anticaps","antiflood","raidmode","aimod","smartai"].includes(cmd)) {
          if (!msg.key.remoteJid?.endsWith("@g.us")) {
            await sendBotText(sock, replyChat, "❌ This command works only inside a group.", quoteOptions);
            continue;
          }

          const groupJid = msg.key.remoteJid;
          const metadata = await sock.groupMetadata(groupJid);
          const participantJid = String(msg.key.participant || msg.key.remoteJid || "");
          const meJid = sock.user?.id || "";
          const normalizeJid = (jid) => String(jid || "").split(":")[0];
          const adminList = (metadata.participants || []).filter(p => p.admin === "admin" || p.admin === "superadmin");
          const isGroupAdmin = adminList.some(p => normalizeJid(p.id) === normalizeJid(participantJid)) || isOwner;
          const botIsAdmin = adminList.some(p => normalizeJid(p.id) === normalizeJid(meJid));

          const targetFromMessage = () => {
            const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
            if (mentioned.length) return mentioned[0];
            const quoted = msg.message?.extendedTextMessage?.contextInfo?.participant;
            if (quoted) return quoted;
            const first = args.split(/\s+/)[0] || "";
            const digits = first.replace(/\D/g, "");
            return digits.length >= 8 ? `${digits}@s.whatsapp.net` : "";
          };

          const requireAdmin = async () => {
            if (!isGroupAdmin) {
              await sendBotText(sock, replyChat, "❌ Group admins only.", quoteOptions);
              return false;
            }
            if (!botIsAdmin && ["promote","demote","kick","add","revoke","setname","setdesc","mute","unmute"].includes(cmd)) {
              await sendBotText(sock, replyChat, "❌ I need group admin permission for this command.", quoteOptions);
              return false;
            }
            return true;
          };

          if (cmd === "groupinfo") {
            const admins = adminList.map(p => `@${String(p.id).split("@")[0]}`).join(" ");
            await sock.sendMessage(replyChat, {
              text: `╭━━〔 👥 GROUP INFO 〕━━╮
│
│ 🏷️ Name : ${metadata.subject}
│ 👤 Members : ${metadata.participants?.length || 0}
│ 👑 Admins : ${adminList.length}
│
│ 🛡️ Admins:
│ ${admins || "None"}
│
╰━━━━━━━━━━━━━━━━━━━━╯
${settings.FOOTER}`,
              mentions: adminList.map(p => p.id)
            }, quoteOptions);
          } else if (cmd === "admins") {
            const mentions = adminList.map(p => p.id);
            await sock.sendMessage(replyChat, {
              text: `👑 *GROUP ADMINS*\n\n${mentions.map(j => `• @${j.split("@")[0]}`).join("\n") || "No admins found."}`,
              mentions
            }, quoteOptions);
          } else if (cmd === "tagall" || cmd === "hidetag") {
            if (!(await requireAdmin())) continue;
            const members = (metadata.participants || []).map(p => p.id);
            const text = args || (cmd === "tagall" ? "📢 Attention everyone!" : "📢 Group announcement");
            await sock.sendMessage(replyChat, { text, mentions: members }, quoteOptions);
          } else if (["promote","demote","kick"].includes(cmd)) {
            if (!(await requireAdmin())) continue;
            const target = targetFromMessage();
            if (!target) {
              await sendBotText(sock, replyChat, `Use: ${settings.PREFIX}${cmd} @user`, quoteOptions);
              continue;
            }
            const action = cmd === "promote" ? "promote" : cmd === "demote" ? "demote" : "remove";
            await sock.groupParticipantsUpdate(groupJid, [target], action);
            await sendBotText(sock, replyChat, `✅ ${cmd.toUpperCase()} completed.`, quoteOptions);
          } else if (cmd === "add") {
            if (!(await requireAdmin())) continue;
            const target = targetFromMessage();
            if (!target) {
              await sendBotText(sock, replyChat, `Use: ${settings.PREFIX}add 947xxxxxxxxx`, quoteOptions);
              continue;
            }
            await sock.groupParticipantsUpdate(groupJid, [target], "add");
            await sendBotText(sock, replyChat, "✅ Member add request sent.", quoteOptions);
          } else if (cmd === "link") {
            if (!(await requireAdmin())) continue;
            const code = await sock.groupInviteCode(groupJid);
            await sendBotText(sock, replyChat, `🔗 *GROUP INVITE LINK*\n\nhttps://chat.whatsapp.com/${code}`, quoteOptions);
          } else if (cmd === "revoke") {
            if (!(await requireAdmin())) continue;
            const code = await sock.groupRevokeInvite(groupJid);
            await sendBotText(sock, replyChat, `♻️ *NEW GROUP LINK*\n\nhttps://chat.whatsapp.com/${code}`, quoteOptions);
          } else if (cmd === "profilename") {
            if (!(await requireAdmin())) continue;
            if (!args) {
              await sendBotText(sock, replyChat, `Use: ${settings.PREFIX}setname New Group Name`, quoteOptions);
              continue;
            }
            await sock.groupUpdateSubject(groupJid, args);
            await sendBotText(sock, replyChat, "✅ Group name updated.", quoteOptions);
          } else if (cmd === "setdesc") {
            if (!(await requireAdmin())) continue;
            if (!args) {
              await sendBotText(sock, replyChat, `Use: ${settings.PREFIX}setdesc New description`, quoteOptions);
              continue;
            }
            await sock.groupUpdateDescription(groupJid, args);
            await sendBotText(sock, replyChat, "✅ Group description updated.", quoteOptions);
          } else if (cmd === "mute" || cmd === "unmute") {
            if (!(await requireAdmin())) continue;
            await sock.groupSettingUpdate(groupJid, cmd === "mute" ? "announcement" : "not_announcement");
            await sendBotText(sock, replyChat, cmd === "mute" ? "🔒 Group is now admin-only." : "🔓 Group is now open to members.", quoteOptions);
          } else if (["warn","warnings","resetwarn","addbadword","delbadword","badwords","setrules","rules","warnlimit"].includes(cmd)) {
            if (!(await requireAdmin())) continue;
            const target = targetFromMessage();
            if (cmd === "warn") {
              if (!target) { await sendBotText(sock, replyChat, `Use: ${settings.PREFIX}warn @user [reason]`, quoteOptions); continue; }
              if (adminList.some(p => String(p.id).split(":")[0] === target.split(":")[0])) { await sendBotText(sock, replyChat, "❌ Cannot warn a group admin.", quoteOptions); continue; }
              const count = getWarningCount(groupJid, target) + 1; const limit = Math.max(1, Number(getGroupSettings(groupJid).warnlimit) || 3);
              setWarningCount(groupJid, target, count >= limit ? 0 : count);
              if (count >= limit && botIsAdmin) { await sock.groupParticipantsUpdate(groupJid, [target], "remove"); await sendBotText(sock, replyChat, `🚨 @${target.split("@")[0]} reached ${limit}/${limit} warnings and was removed.`, { ...quoteOptions, mentions:[target] }); }
              else await sendBotText(sock, replyChat, `⚠️ @${target.split("@")[0]} warning ${count}/${limit}.`, { ...quoteOptions, mentions:[target] });
            } else if (cmd === "warnings") {
              if (!target) { await sendBotText(sock, replyChat, `Use: ${settings.PREFIX}warnings @user`, quoteOptions); continue; }
              await sendBotText(sock, replyChat, `⚠️ @${target.split("@")[0]} has ${getWarningCount(groupJid, target)}/${Math.max(1, Number(getGroupSettings(groupJid).warnlimit)||3)} warnings.`, { ...quoteOptions, mentions:[target] });
            } else if (cmd === "resetwarn") {
              if (!target) { await sendBotText(sock, replyChat, `Use: ${settings.PREFIX}resetwarn @user`, quoteOptions); continue; }
              setWarningCount(groupJid, target, 0); await sendBotText(sock, replyChat, `✅ Warnings reset for @${target.split("@")[0]}.`, { ...quoteOptions, mentions:[target] });
            } else if (cmd === "addbadword") {
              if (!args) { await sendBotText(sock, replyChat, `Use: ${settings.PREFIX}addbadword <word>`, quoteOptions); continue; }
              const cfg = getGroupSettings(groupJid); cfg.badwords = Array.isArray(cfg.badwords) ? cfg.badwords : []; if (!cfg.badwords.some(w => w.toLowerCase() === args.toLowerCase())) cfg.badwords.push(args.toLowerCase()); saveGroupSettings(); await sendBotText(sock, replyChat, `✅ Added blocked word: ${args}`, quoteOptions);
            } else if (cmd === "delbadword") {
              if (!args) { await sendBotText(sock, replyChat, `Use: ${settings.PREFIX}delbadword <word>`, quoteOptions); continue; }
              const cfg = getGroupSettings(groupJid); cfg.badwords = (cfg.badwords || []).filter(w => w.toLowerCase() !== args.toLowerCase()); saveGroupSettings(); await sendBotText(sock, replyChat, `✅ Removed blocked word: ${args}`, quoteOptions);
            } else if (cmd === "badwords") {
              const cfg = getGroupSettings(groupJid); await sendBotText(sock, replyChat, `🚫 *BLOCKED WORDS*\n\n${getBadWords(cfg).join("\n• ")}`, quoteOptions);
            } else if (cmd === "setrules") {
              if (!args) { await sendBotText(sock, replyChat, `Use: ${settings.PREFIX}setrules <rules text>`, quoteOptions); continue; }
              const cfg = getGroupSettings(groupJid); cfg.rules = args; saveGroupSettings(); await sendBotText(sock, replyChat, "✅ Group rules saved.", quoteOptions);
            } else if (cmd === "rules") {
              const rules = getGroupSettings(groupJid).rules; await sendBotText(sock, replyChat, `📜 *GROUP RULES*\n\n${rules || "No rules have been set yet."}`, quoteOptions);
            } else if (cmd === "warnlimit") {
              const n = Number(args); if (!Number.isInteger(n) || n < 1 || n > 10) { await sendBotText(sock, replyChat, `Use: ${settings.PREFIX}warnlimit 1-10`, quoteOptions); continue; }
              const cfg = getGroupSettings(groupJid); cfg.warnlimit = n; saveGroupSettings(); await sendBotText(sock, replyChat, `✅ Warning limit set to ${n}.`, quoteOptions);
            }
          } else if (["welcome","goodbye","antilink","antispam","antibadword"].includes(cmd)) {
            if (!(await requireAdmin())) continue;
            const mode = String(args || "").toLowerCase();
            if (!["on","off"].includes(mode)) {
              await sendBotText(sock, replyChat, `Use: ${settings.PREFIX}${cmd} on/off`, quoteOptions);
              continue;
            }
            const cfg = getGroupSettings(groupJid);
            cfg[cmd] = mode === "on";
            saveGroupSettings();
            await sendBotText(sock, replyChat, `╭━━〔 ⚙️ ${cmd.toUpperCase()} 〕━━╮\n│\n│ 📊 𝑺𝒕𝒂𝒕𝒖𝒔 : ${mode === "on" ? "𝑶𝑵 ✅" : "𝑶𝑭𝑭 ❌"}\n│ 💾 𝑺𝒂𝒗𝒆𝒅 : 𝑷𝑬𝑹𝑴𝑨𝑵𝑬𝑵𝑻\n│\n╰━━━━━━━━━━━━━━━━━━━━╯`, quoteOptions);
          }
        } else if (cmd === "sv") {
          if (!isOwner) {
            await sock.sendMessage(replyChat, { text: "❌ 𝑶𝒏𝒍𝒚 𝑶𝒘𝒏𝒆𝒓 𝒄𝒂𝒏 𝒖𝒔𝒆 .sv 👑" }, quoteOptions);
            continue;
          }
          const quoted = quotedOf(msg.message);
          const media = unwrap(quoted);
          const type = getContentType(media);

          if (type === "imageMessage") {
            const buffer = await toBuffer(
              await downloadContentFromMessage(media.imageMessage, "image"),
              10 * 1024 * 1024
            );
            await sock.sendMessage(replyChat, { image: buffer, caption: `💾 ${settings.BOT_NAME}\n${settings.FOOTER}` }, quoteOptions);
          } else if (type === "videoMessage") {
            const buffer = await toBuffer(
              await downloadContentFromMessage(media.videoMessage, "video"),
              15 * 1024 * 1024
            );
            await sock.sendMessage(replyChat, { video: buffer, caption: `💾 ${settings.BOT_NAME}\n${settings.FOOTER}` }, quoteOptions);
          } else {
            await sock.sendMessage(replyChat, { text: "❌ Reply to a view-once photo/video and use .sv" }, quoteOptions);
          }

        } else if (cmd === "setdp") {
          // In a self-chat WhatsApp marks the message as fromMe and may use
          // a LID JID instead of the owner's phone-number JID. Treat fromMe
          // as owner-authorized so .setdp also works in "Message yourself".
          if (!isOwner) {
            await sock.sendMessage(replyChat, { text: "❌ Owner only." }, quoteOptions);
            continue;
          }
          const quoted = quotedOf(msg.message);
          const media = unwrap(quoted);
          const type = getContentType(media);
          if (type !== "imageMessage") {
            await sock.sendMessage(replyChat, { text: `🖼️ Reply to an image and use ${settings.PREFIX}setdp` }, quoteOptions);
            continue;
          }
          const buffer = await toBuffer(
            await downloadContentFromMessage(media.imageMessage, "image"),
            8 * 1024 * 1024
          );
          await sock.updateProfilePicture(sock.user.id, buffer);
          await sock.sendMessage(replyChat, { text: "✅ SACHi-MD profile picture updated." }, quoteOptions);

        } else if (cmd === "fb") {
              if (!args) {
            await sock.sendMessage(replyChat, {
              text: `Use: ${settings.PREFIX}fb <public Facebook video/reel URL>`
            }, quoteOptions);
            continue;
          }

          await sock.sendMessage(replyChat, {
            text: "⏳ Getting Facebook video..."
          }, quoteOptions);

          let sentByApi = false;
          if (settings.MEDIA_API_URL) {
            try {
              const apiMedia = await cobaltDownload(args, "auto");
              if (apiMedia?.buffer?.length) {
                await sock.sendMessage(replyChat, {
                  video: apiMedia.buffer, mimetype: "video/mp4",
                  caption: `🎬 ${settings.BOT_NAME}\n${settings.FOOTER}`
                }, quoteOptions);
                console.log("[MEDIA API] .fb downloaded via configured API");
                sentByApi = true;
              }
            } catch (apiErr) {
              console.error("[MEDIA API .fb]", apiErr?.message || apiErr);
            }
          }

          if (!sentByApi) {
            const fb = new Facebook();
            const result = await fb.fbdl(args);
            const url = result?.results?.quality?.hd || result?.results?.quality?.sd;
            if (!url) throw new Error("FACEBOOK_DOWNLOAD_FAILED");
            const response = await axios.get(url, {
              responseType: "arraybuffer", timeout: 30000,
              maxContentLength: settings.MAX_MEDIA_MB * 1024 * 1024
            });
            await sock.sendMessage(replyChat, {
              video: Buffer.from(response.data), mimetype: "video/mp4",
              caption: `🎬 ${settings.BOT_NAME}\n${settings.FOOTER}`
            }, quoteOptions);
          }

        } else if (cmd === "photo") {
              if (!args) {
            await sock.sendMessage(replyChat, {
              text: `Use: ${settings.PREFIX}photo <search>`
            }, quoteOptions);
            continue;
          }

          await sock.sendMessage(replyChat, {
            text: "🔎 Searching photo..."
          }, quoteOptions);

          const result = await DDG.imageSearch(args, {
            safeSearch: DDG.SafeSearchType.MODERATE
          });

          const image = result?.results?.[0];
          if (!image?.image) throw new Error("PHOTO_NOT_FOUND");

          const response = await axios.get(image.image, {
            responseType: "arraybuffer",
            timeout: 20000,
            maxContentLength: 8 * 1024 * 1024
          });

          await sock.sendMessage(replyChat, {
            image: Buffer.from(response.data),
            caption: `🖼️ ${args}\n${settings.BOT_NAME}\n${settings.FOOTER}`
          }, quoteOptions);

        } else if (cmd === "vv") {
          if (!isOwner) {
            await sock.sendMessage(replyChat, { text: "❌ 𝑶𝒏𝒍𝒚 𝑶𝒘𝒏𝒆𝒓 𝒄𝒂𝒏 𝒖𝒔𝒆 .vv 👑" }, quoteOptions);
            continue;
          }
          const quoted = quotedOf(msg.message);
          const media = unwrap(quoted);
          const type = getContentType(media);

          if (type === "imageMessage") {
            const buffer = await toBuffer(
              await downloadContentFromMessage(media.imageMessage, "image"),
              10 * 1024 * 1024
            );

            await sock.sendMessage(replyChat, {
              image: buffer,
              caption: `👁️ ${settings.BOT_NAME}\n${settings.FOOTER}`,
              viewOnce: true
            }, quoteOptions);

          } else if (type === "videoMessage") {
            const buffer = await toBuffer(
              await downloadContentFromMessage(media.videoMessage, "video"),
              15 * 1024 * 1024
            );

            await sock.sendMessage(replyChat, {
              video: buffer,
              caption: `👁️ ${settings.BOT_NAME}\n${settings.FOOTER}`,
              viewOnce: true
            }, quoteOptions);

          } else {
            await sock.sendMessage(replyChat, {
              text: "❌ Reply to a photo/video and use .vv"
            }, quoteOptions);
          }
        }
      } catch (err) {
        console.error(`[COMMAND ERROR] ${cmd}:`, err?.message || err);
        try {
          await sock.sendMessage(replyChat, {
            text: `❌ ${cmd} failed: ${err?.message || "unknown error"}\nCheck the Katabump console for details.`
          }, quoteOptions);
        } catch {}
      }
    }
  });
}

process.on("uncaughtException", err => {
  console.error("[FATAL]", err);
});

process.on("unhandledRejection", err => {
  console.error("[REJECTION]", err);
});

connect().catch(err => {
  console.error("[START ERROR]", err);
  setTimeout(() => connect().catch(e => console.error("[RETRY ERROR]", e)), 5000);
});
