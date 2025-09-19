/**
 * Belaynish Telegram Bot (Fly.io)
 * - /ai master command (chat, wiki, duck, translate, media, tts, replicate, help)
 * - Hugging Face Space/API, Replicate, Runway, Stability, Pixabay, ElevenLabs
 * - Redis (Upstash) memory fallback to in-memory
 * - All replies start with "Belaynish"
 * - Typing indicator shown while processing
 * - Replicate long-job polling included with user-facing progress updates
 * - Admin-only commands (post to channel, clear/export memory)
 */

import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import { Telegraf } from 'telegraf';
import Redis from 'ioredis';
import NodeCache from 'node-cache';
import translateLib from '@vitalets/google-translate-api';

const BOT_TOKEN = process.env.TELEGRAM_TOKEN;
if (!BOT_TOKEN) {
  console.error('Missing TELEGRAM_TOKEN in env.');
  process.exit(1);
}
const BASE_URL = process.env.BASE_URL || null;
const PORT = parseInt(process.env.PORT || '8080', 10);
const MEMORY_TTL = parseInt(process.env.MEMORY_TTL_SECONDS || '10800', 10); // seconds

const bot = new Telegraf(BOT_TOKEN);

/* ---------------------------
   Admin / Owner
   --------------------------- */
const OWNER_ID = process.env.OWNER_ID ? parseInt(process.env.OWNER_ID, 10) : null;
const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(s => parseInt(s, 10))
  .filter(Boolean);

/* ---------------------------
   Memory
   --------------------------- */
let redis = null;
let usingRedis = false;
if (process.env.REDIS_URL || process.env.UPSTASH_REDIS_REST_URL) {
  try {
    const url = process.env.REDIS_URL || process.env.UPSTASH_REDIS_REST_URL;
    redis = new Redis(url, {
      password: process.env.UPSTASH_REDIS_REST_TOKEN || undefined
    });
    usingRedis = true;
    console.log('Using Redis memory.');
  } catch (e) {
    console.warn('Redis init failed:', e.message);
    usingRedis = false;
  }
}
const memCache = new NodeCache({ stdTTL: MEMORY_TTL, checkperiod: 120 });

async function getMemory(chatId) {
  const key = `memory:${chatId}`;
  if (usingRedis && redis) {
    try {
      const v = await redis.get(key);
      return v ? JSON.parse(v) : [];
    } catch (e) {
      console.warn('Redis get failed:', e.message);
    }
  }
  return memCache.get(key) || [];
}
async function saveMemory(chatId, history) {
  const key = `memory:${chatId}`;
  if (usingRedis && redis) {
    try {
      await redis.set(key, JSON.stringify(history), 'EX', MEMORY_TTL);
      return;
    } catch (e) {
      console.warn('Redis set failed:', e.message);
    }
  }
  memCache.set(key, history);
}
async function clearMemory(chatId) {
  const key = `memory:${chatId}`;
  if (usingRedis && redis) {
    try {
      await redis.del(key);
      return;
    } catch (e) {
      console.warn('Redis del failed:', e.message);
    }
  }
  memCache.del(key);
}

/* ---------------------------
   Utilities
   --------------------------- */
const withPrefix = (txt) => `Belaynish\n\n${txt}`;
const safeFirst = (arr) => (Array.isArray(arr) && arr.length ? arr[0] : null);
function isAdmin(userId) {
  if (!userId) return false;
  if (OWNER_ID && userId === OWNER_ID) return true;
  return ADMIN_IDS.includes(userId);
}

/* ---------------------------
   Web helpers: Wikipedia, DuckDuckGo, Translate
   --------------------------- */
async function wikiSummary(query) {
  try {
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`;
    const r = await axios.get(url, { timeout: 10000 });
    return r.data?.extract || 'No Wikipedia summary found.';
  } catch (e) {
    return 'Wikipedia lookup failed.';
  }
}

async function duckDuck(query) {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const r = await axios.get(url, { timeout: 8000 });
    if (r.data?.AbstractText) return r.data.AbstractText;
    const rt = safeFirst(r.data?.RelatedTopics);
    if (rt?.Text) return rt.Text;
    return 'No DuckDuckGo instant answer.';
  } catch (e) {
    return 'DuckDuckGo lookup failed.';
  }
}

async function translateUnofficial(text, to = 'en') {
  try {
    const r = await translateLib(text, { to });
    return r.text;
  } catch (e) {
    return text;
  }
}

/* ---------------------------
   Hugging Face Space / API
   --------------------------- */
async function callHfSpace(prompt, spaceUrl = process.env.HF_SPACE_URL) {
  if (!spaceUrl) throw new Error('HF_SPACE_URL not configured');
  const base = spaceUrl.replace(/\/$/, '');
  const candidates = [`${base}/run/predict`, `${base}/api/predict`, base];
  for (const url of candidates) {
    try {
      const resp = await axios.post(url, { data: [prompt] }, { timeout: 120000 });
      if (resp.data?.data && resp.data.data.length) return String(resp.data.data[0]);
      if (resp.data?.generated_text) return String(resp.data.generated_text);
      if (typeof resp.data === 'string' && resp.data.length) return resp.data;
    } catch (e) {
      // try next
    }
  }
  throw new Error('HF Space did not return output');
}

async function callHfApi(prompt, modelUrl = process.env.HF_URL) {
  if (!modelUrl || !process.env.HUGGINGFACE_API_KEY) throw new Error('HF API not configured');
  const resp = await axios.post(modelUrl, { inputs: prompt }, {
    headers: { Authorization: `Bearer ${process.env.HUGGINGFACE_API_KEY}` },
    timeout: 120000
  });
  if (Array.isArray(resp.data) && resp.data[0]?.generated_text) return resp.data[0].generated_text;
  if (resp.data?.generated_text) return resp.data.generated_text;
  if (resp.data?.data && resp.data.data[0]) return resp.data.data[0];
  return JSON.stringify(resp.data).slice(0, 4000);
}

/* ---------------------------
   Replicate calls + polling
   --------------------------- */
async function callReplicateCreate(versionOrModel, input) {
  if (!process.env.REPLICATE_API_KEY) throw new Error('REPLICATE_API_KEY missing');
  const url = 'https://api.replicate.com/v1/predictions';
  const resp = await axios.post(url, { version: versionOrModel, input }, {
    headers: { Authorization: `Token ${process.env.REPLICATE_API_KEY}`, 'Content-Type': 'application/json' },
    timeout: 600000
  });
  return resp.data; // may include id, status
}

async function replicateGet(predictionId) {
  const url = `https://api.replicate.com/v1/predictions/${predictionId}`;
  const resp = await axios.get(url, {
    headers: { Authorization: `Token ${process.env.REPLICATE_API_KEY}` },
    timeout: 600000
  });
  return resp.data;
}

const REPLICATE_POLL_INTERVAL_MS = parseInt(process.env.REPLICATE_POLL_INTERVAL_MS || '3000', 10);
const REPLICATE_POLL_TIMEOUT_SEC = parseInt(process.env.REPLICATE_POLL_TIMEOUT_SEC || '600', 10);

async function pollReplicatePrediction(predictionId, onProgress = null) {
  const start = Date.now();
  while (true) {
    const elapsed = (Date.now() - start) / 1000;
    if (elapsed > REPLICATE_POLL_TIMEOUT_SEC) throw new Error('Replicate polling timed out');
    const res = await replicateGet(predictionId);
    if (onProgress && typeof onProgress === 'function') {
      try { onProgress(res); } catch (e) { /* ignore progress errors */ }
    }
    if (res.status === 'succeeded') return res;
    if (res.status === 'failed') throw new Error('Replicate job failed: ' + JSON.stringify(res));
    await new Promise(r => setTimeout(r, REPLICATE_POLL_INTERVAL_MS));
  }
}

/* ---------------------------
   Replicate progress editor factory
   --------------------------- */
function createReplicateProgressEditorFactory(ctx) {
  // returns an onProgress(res) function bound to this ctx
  const chatId = ctx.chat?.id || ctx.from?.id;
  let lastPercent = -1;
  let lastSentTime = 0;
  let progressMsg = null;
  // throttle: send update if percent delta >= 5 or time since last >= 15000ms
  const MIN_DELTA = 5;
  const MIN_INTERVAL_MS = 15000;

  return async function onProgress(res) {
    try {
      // try to extract progress percent
      let percent = null;
      if (typeof res.progress === 'number') {
        percent = Math.round(res.progress * 100);
      } else if (res.metrics && typeof res.metrics.progress === 'number') {
        percent = Math.round(res.metrics.progress * 100);
      } else if (res.logs && Array.isArray(res.logs)) {
        const lastLog = res.logs[res.logs.length - 1] || '';
        if (typeof lastLog === 'string') {
          const m = lastLog.match(/(\d{1,3})\s?%/);
          if (m) percent = Math.min(100, Math.max(0, parseInt(m[1], 10)));
          else {
            const m2 = lastLog.match(/progress[:=]\s*([0-9.]+)/i);
            if (m2) {
              let p = parseFloat(m2[1]);
              if (p <= 1) p = Math.round(p * 100);
              percent = Math.min(100, Math.max(0, Math.round(p)));
            }
          }
        }
      }

      const now = Date.now();
      const shouldUpdate = (typeof percent === 'number' && (percent - lastPercent) >= MIN_DELTA) || (now - lastSentTime >= MIN_INTERVAL_MS);
      if (!shouldUpdate) return;

      lastSentTime = now;
      // Compose progress text
      const pctText = typeof percent === 'number' ? `${percent}%` : 'processing...';
      const text = withPrefix(`Processing: ${pctText}`);

      if (!progressMsg) {
        // send initial message
        const sent = await ctx.reply(text);
        progressMsg = sent;
      } else {
        // try to edit existing message
        try {
          await ctx.telegram.editMessageText(chatId, progressMsg.message_id, undefined, text);
        } catch (e) {
          // fallback: send a new short message if edit fails
          await ctx.reply(text);
        }
      }

      if (typeof percent === 'number') lastPercent = percent;
    } catch (e) {
      console.warn('onProgress error', e.message);
    }
  };
}

/* ---------------------------
   Runway generic
   --------------------------- */
async function callRunway(endpoint, model, input) {
  if (!process.env.RUNWAY_API_KEY) throw new Error('RUNWAY_API_KEY missing');
  const url = endpoint.replace(/\/$/, '');
  const r = await axios.post(url, { model, input }, {
    headers: { Authorization: `Bearer ${process.env.RUNWAY_API_KEY}`, 'Content-Type': 'application/json' },
    timeout: 600000
  });
  return r.data;
}

/* ---------------------------
   Stability image
   --------------------------- */
async function callStabilityImage(prompt, opts = {}) {
  if (!process.env.STABILITY_KEY) throw new Error('STABILITY_KEY missing');
  const url = 'https://api.stability.ai/v1/generation/stable-diffusion-v1-5/text-to-image';
  const payload = {
    text_prompts: [{ text: prompt }],
    cfg_scale: opts.cfg_scale || 7,
    height: opts.height || 512,
    width: opts.width || 512,
    samples: 1
  };
  const r = await axios.post(url, payload, {
    headers: { Authorization: `Bearer ${process.env.STABILITY_KEY}`, 'Content-Type': 'application/json' },
    responseType: 'arraybuffer',
    timeout: 180000
  });
  return r.data;
}

/* ---------------------------
   Pixabay search
   --------------------------- */
async function pixabaySearch(query) {
  if (!process.env.PIXABAY_KEY) throw new Error('PIXABAY_KEY missing');
  const url = `https://pixabay.com/api/?key=${process.env.PIXABAY_KEY}&q=${encodeURIComponent(query)}&image_type=photo&per_page=3`;
  const r = await axios.get(url, { timeout: 10000 });
  return r.data.hits || [];
}

/* ---------------------------
   ElevenLabs TTS
   --------------------------- */
async function elevenTTS(text) {
  if (!process.env.ELEVENLABS_API_KEY || !process.env.ELEVENLABS_VOICE_ID) throw new Error('ElevenLabs not configured');
  const url = `${(process.env.ELEVENLABS_API_URL || 'https://api.elevenlabs.io/v1').replace(/\/$/, '')}/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}`;
  const resp = await axios.post(url, { text }, {
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
    responseType: 'arraybuffer',
    timeout: 120000
  });
  return Buffer.from(resp.data);
}

/* ---------------------------
   HF model map (env-driven)
   --------------------------- */
const HF_MODEL_MAP = {
  llama2: process.env.MODEL_LLAMA2 || process.env.HF_URL,
  mistral: process.env.MODEL_MISTRAL || process.env.HF_URL,
  flan_t5: process.env.MODEL_FLAN_T5 || process.env.HF_URL,
  falcon: process.env.MODEL_FALCON || process.env.HF_URL,
  gpt2: process.env.MODEL_GPT2 || process.env.HF_URL,
  bloom: process.env.MODEL_BLOOM || process.env.HF_URL,
  default: process.env.MODEL || process.env.HF_URL || process.env.HF_MODEL
};

/* ---------------------------
   Show typing helper
   --------------------------- */
async function showTyping(ctx, ms = 1000) {
  try {
    await ctx.sendChatAction('typing');
  } catch (e) {}
}

/* ---------------------------
   /ai master command
   --------------------------- */
bot.command('ai', async (ctx) => {
  await showTyping(ctx);

  const raw = (ctx.message?.text || '').trim();
  const parts = raw.split(' ').slice(1);
  if (!parts.length) return ctx.reply(withPrefix('Usage: /ai <mode> <input>\nType /ai help for modes.'));

  const mode = parts[0].toLowerCase();
  const rest = parts.slice(1).join(' ').trim();

  // wrapper to keep typing on long tasks
  async function withTyping(fn) {
    const typingInterval = setInterval(() => { try { ctx.sendChatAction('typing'); } catch (e) {} }, 2500);
    try {
      return await fn();
    } finally {
      clearInterval(typingInterval);
    }
  }

  try {
    if (mode === 'help') {
      const help = `
/ai <mode> <input>

Chat:
  /ai chat [model] <prompt>     -> models: llama2, mistral, flan_t5, falcon (default llama2)

Search:
  /ai wiki <topic>
  /ai duck <query>

Translate:
  /ai translate [lang] <text>   -> default 'en' (use 'am' for Amharic)

Media:
  /ai media <mode> <input>
    modes: t2i t2v i2v v2v upscale act (Runway)
           flux fixface caption burncaption recon3d (Replicate)

TTS:
  /ai tts <text>

Replicate direct:
  /ai replicate <ENV_VAR_NAME> <prompt>

Admin:
  /ai post <@channel_or_channel_username> <message>     (admin only)
  /ai clear_memory <chatId>                              (admin only)
  /ai export_memory <chatId>                             (admin only)

Type /ai help for this message.
`;
      return ctx.reply(withPrefix(help));
    }

    // === CHAT ===
    if (mode === 'chat') {
      if (!rest) return ctx.reply(withPrefix('Provide prompt: /ai chat [model] <prompt>'));
      let modelKey = 'llama2';
      let prompt = rest;
      const tokens = rest.split(' ');
      if (tokens.length > 1 && HF_MODEL_MAP[tokens[0].toLowerCase()]) {
        modelKey = tokens[0].toLowerCase();
        prompt = tokens.slice(1).join(' ');
      }
      if (!prompt) return ctx.reply(withPrefix('Provide prompt after model name.'));

      // memory
      const mem = await getMemory(ctx.from.id);
      mem.push({ role: 'user', content: prompt });

      const context = mem.map(m => `${m.role}: ${m.content}`).join('\n');

      // Try HF Space -> HF API -> Replicate
      let answer = null;

      if (process.env.HF_SPACE_URL) {
        try {
          answer = await withTyping(() => callHfSpace(context, process.env.HF_SPACE_URL));
        } catch (e) { console.warn('HF Space error:', e.message); }
      }

      if (!answer && process.env.HUGGINGFACE_API_KEY) {
        const hfModelUrl = HF_MODEL_MAP[modelKey] || HF_MODEL_MAP.default;
        if (hfModelUrl) {
          try {
            answer = await withTyping(() => callHfApi(context, hfModelUrl));
          } catch (e) { console.warn('HF API error:', e.message); }
        }
      }

      if (!answer && process.env.REPLICATE_API_KEY) {
        try {
          const repKey = {
            llama2: 'REPLICATE_CHAT_MODEL_LLAMA2',
            mistral: 'REPLICATE_CHAT_MODEL_MISTRAL',
            gpt5: 'REPLICATE_CHAT_MODEL_GPT5',
            gpt4: 'REPLICATE_CHAT_MODEL_GPT4',
            gpt35: 'REPLICATE_CHAT_MODEL_GPT35'
          }[modelKey] || 'REPLICATE_CHAT_MODEL_GPT5';
          const repModel = process.env[repKey];
          if (repModel) {
            const created = await withTyping(() => callReplicateCreate(repModel, { prompt }));
            if (created?.id) {
              // send an initial message and poll with progress updates
              const progressEditor = createReplicateProgressEditorFactory(ctx);
              const polled = await pollReplicatePrediction(created.id, progressEditor);
              const out = safeFirst(polled.output) || JSON.stringify(polled);
              answer = String(out);
            } else if (created?.output && created.output.length) {
              answer = String(created.output[0]);
            } else {
              answer = 'Replicate job started (no immediate output).';
            }
          }
        } catch (e) { console.warn('Replicate chat error:', e.message); }
      }

      if (!answer) {
        const w = await wikiSummary(prompt);
        const d = await duckDuck(prompt);
        answer = `${w}\n\nDuck summary:\n${d}`;
      }

      mem.push({ role: 'assistant', content: answer });
      await saveMemory(ctx.from.id, mem);
      return ctx.reply(withPrefix(answer));
    }

    // === WIKI ===
    if (mode === 'wiki') {
      if (!rest) return ctx.reply(withPrefix('Usage: /ai wiki <topic>'));
      const out = await withTyping(() => wikiSummary(rest));
      return ctx.reply(withPrefix(out));
    }

    // === DUCK ===
    if (mode === 'duck') {
      if (!rest) return ctx.reply(withPrefix('Usage: /ai duck <query>'));
      const out = await withTyping(() => duckDuck(rest));
      return ctx.reply(withPrefix(out));
    }

    // === TRANSLATE ===
    if (mode === 'translate') {
      if (!rest) return ctx.reply(withPrefix('Usage: /ai translate [lang] <text>'));
      const toks = rest.split(' ');
      let to = 'en';
      let text = rest;
      if (toks.length > 1 && toks[0].length <= 3) {
        to = toks[0];
        text = toks.slice(1).join(' ');
      }
      const t = await withTyping(() => translateUnofficial(text, to));
      return ctx.reply(withPrefix(t));
    }

    // === TTS ===
    if (mode === 'tts') {
      if (!rest) return ctx.reply(withPrefix('Usage: /ai tts <text>'));
      if (process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID) {
        try {
          const audio = await withTyping(() => elevenTTS(rest));
          return ctx.replyWithVoice({ source: audio });
        } catch (e) { console.warn('ElevenLabs TTS failed:', e.message); }
      }
      if (process.env.REPLICATE_API_KEY && process.env.REPLICATE_TTS_MODEL) {
        try {
          const created = await withTyping(() => callReplicateCreate(process.env.REPLICATE_TTS_MODEL, { text: rest }));
          if (created?.id) {
            const progressEditor = createReplicateProgressEditorFactory(ctx);
            const polled = await pollReplicatePrediction(created.id, progressEditor);
            const out = safeFirst(polled.output) || null;
            if (out) return ctx.replyWithVoice(out);
          } else if (created?.output?.[0]) {
            return ctx.replyWithVoice(created.output[0]);
          }
        } catch (e) { console.warn('Replicate TTS error:', e.message); }
      }
      return ctx.reply(withPrefix('No TTS provider configured.'));
    }

    // === MEDIA unified ===
    if (mode === 'media') {
      const sub = parts[1] ? parts[1].toLowerCase() : null;
      const payload = parts.slice(2).join(' ');
      if (!sub || !payload) return ctx.reply(withPrefix('Usage: /ai media <mode> <input>. Type /ai help for modes.'));

      const runwayModes = ['t2i','t2v','i2v','v2v','upscale','act'];
      const repModes = ['flux','fixface','caption','burncaption','recon3d'];

      // Runway branch
      if (runwayModes.includes(sub) && process.env.RUNWAY_API_KEY) {
        try {
          let endpoint, model;
          switch (sub) {
            case 't2i': endpoint = process.env.RUNWAY_URL_TEXT_TO_IMAGE; model = process.env.RUNWAY_MODEL_TEXT_TO_IMAGE; break;
            case 't2v': endpoint = process.env.RUNWAY_URL_TEXT_TO_VIDEO; model = process.env.RUNWAY_MODEL_TEXT_TO_VIDEO; break;
            case 'i2v': endpoint = process.env.RUNWAY_URL_IMAGE_TO_VIDEO; model = process.env.RUNWAY_MODEL_IMAGE_TO_VIDEO; break;
            case 'v2v': endpoint = process.env.RUNWAY_URL_VIDEO_TO_VIDEO; model = process.env.RUNWAY_MODEL_VIDEO_TO_VIDEO; break;
            case 'upscale': endpoint = process.env.RUNWAY_URL_VIDEO_UPSCALE; model = process.env.RUNWAY_MODEL_VIDEO_UPSCALE; break;
            case 'act': endpoint = process.env.RUNWAY_URL_CHARACTER_PERFORMANCE; model = process.env.RUNWAY_MODEL_CHARACTER_PERFORMANCE; break;
          }
          const res = await withTyping(() => callRunway(endpoint, model, (sub==='t2i' || sub==='t2v') ? { prompt: payload } : (sub==='i2v' ? { image_url: payload } : { video_url: payload })));
          const out = safeFirst(res.output) || res.output;
          if (!out) return ctx.reply(withPrefix('Runway returned no output yet.'));
          if (sub === 't2i') return ctx.replyWithPhoto(out, { caption: withPrefix(payload) });
          return ctx.replyWithVideo(out, { caption: withPrefix(payload) });
        } catch (e) {
          return ctx.reply(withPrefix('Runway media error: ' + e.message));
        }
      }

      // Replicate branch
      if (repModes.includes(sub) && process.env.REPLICATE_API_KEY) {
        try {
          let repModel;
          switch (sub) {
            case 'flux': repModel = process.env.REPLICATE_IMAGE_MODEL; break;
            case 'fixface': repModel = process.env.REPLICATE_UPSCALE_MODEL; break;
            case 'caption': repModel = process.env.REPLICATE_VIDEO_CAPTION_MODEL; break;
            case 'burncaption': repModel = process.env.REPLICATE_VIDEO_CAPTIONED_MODEL; break;
            case 'recon3d': repModel = process.env.REPLICATE_3D_MODEL; break;
          }
          if (!repModel) return ctx.reply(withPrefix('Replicate model not set for this mode.'));
          const created = await withTyping(() => callReplicateCreate(repModel, (sub==='flux') ? { prompt: payload } : (sub==='fixface' ? { image: payload } : { video: payload })));
          if (created?.id) {
            await ctx.reply(withPrefix('Started job on Replicate, polling until done...'));
            const progressEditor = createReplicateProgressEditorFactory(ctx);
            const polled = await pollReplicatePrediction(created.id, progressEditor);
            const out = safeFirst(polled.output) || null;
            if (!out) return ctx.reply(withPrefix('Replicate finished but produced no output.'));
            if (sub === 'flux' || sub === 'fixface') return ctx.replyWithPhoto(out, { caption: withPrefix(payload) });
            if (sub === 'recon3d') return ctx.replyWithDocument(out);
            if (sub === 'caption') return ctx.reply(withPrefix(out));
            return ctx.replyWithVideo(out, { caption: withPrefix(payload) });
          } else if (created?.output?.[0]) {
            const out = created.output[0];
            if (sub === 'flux' || sub === 'fixface') return ctx.replyWithPhoto(out, { caption: withPrefix(payload) });
            if (sub === 'recon3d') return ctx.replyWithDocument(out);
            if (sub === 'caption') return ctx.reply(withPrefix(out));
            return ctx.replyWithVideo(out, { caption: withPrefix(payload) });
          } else {
            return ctx.reply(withPrefix('Replicate started job; check dashboard.'));
          }
        } catch (e) {
          return ctx.reply(withPrefix('Replicate media error: ' + e.message));
        }
      }

      // Stability / Pixabay fallback for t2i
      if (sub === 't2i') {
        if (process.env.STABILITY_KEY) {
          try {
            const buff = await withTyping(() => callStabilityImage(payload));
            return ctx.replyWithPhoto({ source: Buffer.from(buff) }, { caption: withPrefix(payload) });
          } catch (e) { console.warn('Stability error', e.message); }
        }
        if (process.env.PIXABAY_KEY) {
          try {
            const hits = await withTyping(() => pixabaySearch(payload));
            if (hits.length) return ctx.replyWithPhoto(hits[0].largeImageURL, { caption: withPrefix(payload) });
          } catch (e) { console.warn('Pixabay error', e.message); }
        }
      }

      return ctx.reply(withPrefix('No provider configured for that media mode or provider returned no output.'));
    }

    // === Replicate direct ===
    if (mode === 'replicate') {
      const repEnv = parts[1];
      const promptText = parts.slice(2).join(' ');
      if (!repEnv || !promptText) return ctx.reply(withPrefix('Usage: /ai replicate <ENV_VAR_NAME> <prompt>'));
      const repModel = process.env[repEnv];
      if (!repModel) return ctx.reply(withPrefix(`No replicate model found in env as ${repEnv}`));
      try {
        const created = await withTyping(() => callReplicateCreate(repModel, { prompt: promptText }));
        if (created?.id) {
          await ctx.reply(withPrefix('Replicate job started, polling until done...'));
          const progressEditor = createReplicateProgressEditorFactory(ctx);
          const polled = await pollReplicatePrediction(created.id, progressEditor);
          const out = safeFirst(polled.output) || JSON.stringify(polled);
          return ctx.reply(withPrefix(String(out)));
        } else if (created?.output?.[0]) {
          return ctx.reply(withPrefix(String(created.output[0])));
        } else {
          return ctx.reply(withPrefix('Replicate responded: ' + JSON.stringify(created).slice(0, 3000)));
        }
      } catch (e) {
        return ctx.reply(withPrefix('Replicate error: ' + e.message));
      }
    }

    // === ADMIN: post to channel, clear/export memory ===
    if (mode === 'post') {
      const userId = ctx.from.id;
      if (!isAdmin(userId)) return ctx.reply(withPrefix('Admin only command.'));
      const channel = parts[1];
      const message = parts.slice(2).join(' ');
      if (!channel || !message) return ctx.reply(withPrefix('Usage: /ai post <@channel_or_channelusername> <message>'));
      try {
        await bot.telegram.sendMessage(channel, withPrefix(message), { parse_mode: 'HTML' });
        return ctx.reply(withPrefix('Posted to ' + channel));
      } catch (e) {
        return ctx.reply(withPrefix('Failed to post: ' + e.message));
      }
    }

    if (mode === 'clear_memory') {
      const userId = ctx.from.id;
      if (!isAdmin(userId)) return ctx.reply(withPrefix('Admin only command.'));
      const target = parts[1] || String(ctx.from.id);
      await clearMemory(target);
      return ctx.reply(withPrefix(`Cleared memory for ${target}`));
    }

    if (mode === 'export_memory') {
      const userId = ctx.from.id;
      if (!isAdmin(userId)) return ctx.reply(withPrefix('Admin only command.'));
      const target = parts[1] || String(ctx.from.id);
      const mem = await getMemory(target);
      return ctx.reply(withPrefix(`Memory for ${target}:\n${JSON.stringify(mem).slice(0, 4000)}`));
    }

    // Unknown mode
    return ctx.reply(withPrefix('Unknown mode. Type /ai help for usage.'));
  } catch (err) {
    console.error('AI handler error', err);
    return ctx.reply(withPrefix('Error: ' + (err && err.message ? err.message : String(err))));
  }
});

/* ---------------------------
   Express server + webhook
   --------------------------- */
const app = express();
app.use(express.json());

app.get('/keepalive', (req, res) => res.send('Belaynish alive'));

app.post('/webhook', async (req, res) => {
  try {
    await bot.handleUpdate(req.body, res);
    res.sendStatus(200);
  } catch (e) {
    console.error('Webhook handling error', e);
    res.sendStatus(500);
  }
});

(async () => {
  app.listen(PORT, async () => {
    console.log(`Server listening on port ${PORT}`);
    if (BASE_URL) {
      try {
        const webhookUrl = `${BASE_URL.replace(/\/$/, '')}/webhook`;
        const resp = await axios.get(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${encodeURIComponent(webhookUrl)}`);
        console.log('setWebhook response:', resp.data);
      } catch (e) {
        console.warn('setWebhook failed:', e.message);
      }
    } else {
      console.log('BASE_URL not set; using webhook requires a reachable URL.');
    }
  });
})();
