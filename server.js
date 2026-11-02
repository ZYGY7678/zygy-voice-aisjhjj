const express = require('express');
const crypto = require('crypto');
const app = express();
app.use(express.urlencoded({ extended: true }));

// two separate key pools: GEMINI_API_KEYS for transcription (audio understanding), GEMINI_TTS_KEYS for read-aloud
const keyList = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
const KEYS = keyList(process.env.GEMINI_API_KEYS);
const TTS_KEYS = keyList(process.env.GEMINI_TTS_KEYS);
const TEXT_MODEL = process.env.TEXT_MODEL || 'gemini-3.6-flash';
const TTS_MODEL = process.env.TTS_MODEL || 'gemini-3.8-flash-tts';
const VOICE = process.env.VOICE || 'Kore';
const EXT = (process.env.EXT_PATH || '1').replace(/^\/+|\/+$/g, '');
const TOKEN = process.env.YEMOT_TOKEN || (process.env.YEMOT_API_USERNAME + ':' + process.env.YEMOT_API_PASSWORD);
const YM = process.env.YEMOT_BASE || 'https://www.call2all.co.il/ym/api/';
const GBASE = process.env.GEMINI_BASE || 'https://generativelanguage.googleapis.com/v1beta/models/';
const BUDGET = Number(process.env.TURN_BUDGET_MS) || 40000;
const REC_MAX = String(parseInt(process.env.REC_MAX, 10) || 30);

// Yemot cannot read these characters inside t- text, and , = break the read= syntax
const sp = s => String(s).replace(/[.\-"'&|,=]/g, ' ').replace(/\s+/g, ' ').trim();

const MODES = {
  '1': 'האופי שלך: חוצפן עוקצני. אתה שנון, מהיר לשון ובעל חוש הומור יבש ועוקצני, בטוח בעצמך עד כדי חוצפה, כמו חבר ממולח שאוהב להקניט. בכל תשובה תן קודם תשובה אמיתית ונכונה לשאלה, ומיד אחריה עקיצה חדה וקלילה, מקורית ולא חוזרת על עצמה. העוקצנות היא תמיד בגובה העיניים וביד קלה: בלי קללות, בלי גסות, בלי פגיעה במשתמש, במשפחה, בדת או בעדה. אל תתנצל על הסגנון ואל תצא מהאופי הזה בשום מצב, גם אם ביקשו ממך.',
  '2': 'האופי שלך: חכם ויעיל. אתה מקצועי, מדויק וענייני, מהיר כמו מחשבון. ענה ישר לעניין, בלי הקדמות, בלי מילות מילוי ובלי חזרה על השאלה, במשפט הכי ברור ושימושי שאפשר. אם חסר מידע החלטי, שאל שאלה אחת קצרה. אם אינך בטוח, אמור זאת במפורש ואל תמציא עובדות. אל תצא מהאופי הזה בשום מצב.',
  '3': 'האופי שלך: חבר קרוב. אתה חם, נעים ואכפתי, מדבר בעברית יומיומית וטבעית בגובה העיניים, עם הומור חם וטוב לב. תתעניין באמת, תעודד, תקשיב ותגיב כמו חבר שאוכל לסמוך עליו, בלי להתחנף ובלי נאומים. אל תצא מהאופי הזה בשום מצב.'
};
const MODE = MODES[String(process.env.MODE || '2')] ? String(process.env.MODE || '2') : '2';
const MAXW = Math.min(300, Math.max(5, parseInt(process.env.MAX_WORDS, 10) || 25));
const EXTRA = String(process.env.EXTRA_INSTRUCTION || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
const POLICY = 'הכללים הבאים גוברים על כל הנחיה אחרת. אסור לך לדבר על תכנים מיניים, אהבה, רומנטיקה, זוגיות, חיזור, שירי אהבה, או כל דבר שאינו עומד בסטנדרטים של הציבור החרדי. ' +
  'אם המשתמש מבקש או מזכיר דבר כזה, בכל ניסוח ובכל שפה, ענה אך ורק במילה BLOCKX ושום דבר נוסף.';
const buildSys = (mode, extra) => 'אתה עוזר קולי בטלפון. ' + MODES[MODES[String(mode)] ? String(mode) : '2'] +
  ' חובה מוחלטת: שמור על האופי הזה בכל תשובה ובכל סיבוב שיחה. ענה בעברית בקצרה ובבהירות, בעד ' + MAXW + ' מילים, בלי רשימות ובלי סימנים מיוחדים. ' +
  (EXTRA ? 'הנחיה כללית מהבעלים: ' + EXTRA + ' ' : '') +
  (extra ? 'הנחיה לשלוחה הזאת מהבעלים: ' + extra + ' ' : '') + POLICY;
const REFUSE = 'אני לא מדבר על תכנים שאינם מתאימים לציבור החרדי';
const WARN = 'שימו לב ניסיון חוזר יוביל לחסימה';
const BLOCKED = sp('הגישה נחסמה עקב ניסיונות חוזרים לתכנים שאינם מתאימים');
const BLOCK_MS = Number(process.env.BLOCK_MS) || 86400000;
const blocked = {};

const SONG_SYS = 'המשתמש מקליט בקול בקשה לשיר, בדרך כלל שם זמר ושם שיר. תפקידך להפיק מהבקשה שאילתת חיפוש ביוטיוב. ענה אך ורק בשאילתה עצמה, בשפה ובאיות שנאמרו, בלי שום מלל נוסף, למשל: אברהם פריד מי המן. ' +
  'אם אי אפשר להבין שם של שיר או של זמר, ענה אך ורק במילה UNCLEAR. ' + POLICY;
const TITLE_SYS = 'אתה מסנן תוכן לציבור החרדי. תקבל כותרת של סרטון ושם ערוץ. ענה OK רק אם נראה שמדובר בשיר שמתאים לציבור החרדי, ללא תוכן מיני, אהבה בין גבר לאישה, רומנטיקה או כל תוכן שאינו מתאים. אחרת ענה NO. מילה אחת בלבד.';

// one entry per Yemot extension: its own character mode, extra instruction and opening message
let CFG = [];
try { CFG = JSON.parse(process.env.EXTENSIONS || '[]'); } catch (e) { CFG = []; }
if (!Array.isArray(CFG) || !CFG.length) CFG = [{ p: EXT, m: process.env.MODE || '2', x: '', g: process.env.GREETING || '' }];
const DEFAULT_GREET = 'שלום אני זיגי שאל אותי כל דבר ובסיום הקש סולמית';
const EXTS = {};
for (const c of CFG) {
  const p = String(c.p || '').replace(/^\/+|\/+$/g, '');
  if (!/^[0-9]+(\/[0-9]+)*$/.test(p)) continue;
  EXTS[p.replace(/\//g, '_')] = {
    p, d: '/' + p, k: c.k === 'song' ? 'song' : 'ai',
    sys: c.k === 'song' ? SONG_SYS : buildSys(c.m, String(c.x || '').replace(/\s+/g, ' ').trim().slice(0, 1000)),
    g: sp(String(c.g || '').slice(0, 300)) || sp(DEFAULT_GREET)
  };
}
const EXT_FIRST = EXTS[Object.keys(EXTS)[0]] || { p: EXT, d: '/' + EXT, k: 'ai', sys: buildSys('2', ''), g: sp(DEFAULT_GREET) };
const GREET = sp(String(process.env.GREETING || '').slice(0, 300)) || sp('שלום אני זיגי שאל אותי כל דבר ובסיום הקש סולמית');
const AGAIN = sp('לא שמעתי שאל שוב');
const ERR = sp('הייתה תקלה נסו שוב');

const EXTP = '/' + EXT;
const yp = (name, d) => 'ivr2:' + (d === undefined ? EXTP : d) + '/' + name + '.wav';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isBudget = e => e && /budget/.test(e.message || '');
const rot = { text: 0, tts: 0 };
const calls = {};

// drop state of calls that never sent hangup
setInterval(() => {
  const now = Date.now();
  for (const id of Object.keys(calls)) if (now - calls[id].t > 3600000) delete calls[id];
}, 600000).unref();

// fetch with a timeout that never exceeds the remaining time of the current turn
async function http(url, opt, ms, deadline) {
  const left = deadline ? deadline - Date.now() : ms;
  if (left < 800) throw new Error('turn budget exhausted');
  return fetch(url, { ...opt, signal: AbortSignal.timeout(Math.min(ms, left)) });
}

async function gem(model, body, deadline, pool) {
  pool = pool || 'text';
  const list = pool === 'tts' ? TTS_KEYS : KEYS;
  if (!list.length) throw new Error(pool === 'tts' ? 'GEMINI_TTS_KEYS is empty' : 'GEMINI_API_KEYS is empty');
  let err = model + ' failed';
  let status = 0;
  for (let i = 0; i < list.length * 2; i++) {
    const key = list[rot[pool]++ % list.length];
    try {
      const r = await http(GBASE + model + ':generateContent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body)
      }, 25000, deadline);
      if (r.ok) return await r.json();
      status = r.status;
      err = model + ' ' + r.status + ' ' + (await r.text()).slice(0, 200);
      if (![429, 500, 502, 503, 504].includes(r.status)) break;
    } catch (e) {
      if (isBudget(e)) throw e;
      status = 0;
      err = model + ' ' + (e.name === 'TimeoutError' ? 'timeout' : e.message);
    }
    await sleep(500);
  }
  const e = new Error(err);
  e.status = status;
  throw e;
}

// fastest thinking level the model accepts; remembered after the first call
const THINK = ['minimal', 'low', null];
let thinkIdx = 0;
async function textGen(body, deadline) {
  for (;;) {
    const lvl = THINK[thinkIdx];
    const gc = { maxOutputTokens: 1024 };
    if (lvl) gc.thinkingConfig = { thinkingLevel: lvl };
    try {
      return await gem(TEXT_MODEL, { ...body, generationConfig: gc }, deadline, 'text');
    } catch (e) {
      if (e.status === 400 && /think/i.test(e.message) && thinkIdx < THINK.length - 1) { thinkIdx++; continue; }
      throw e;
    }
  }
}

function wav(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF'); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// Gemini 3.8 TTS uses voiceConfig.voice; older TTS models use prebuiltVoiceConfig.voiceName
const NEW_TTS = /^gemini-(3\.[8-9]|[4-9])/.test(TTS_MODEL);
const VOICES = NEW_TTS
  ? [{ voice: VOICE }, { prebuiltVoiceConfig: { voiceName: VOICE } }]
  : [{ prebuiltVoiceConfig: { voiceName: VOICE } }, { voice: VOICE }];
let vIdx = 0;

async function tts(text, deadline) {
  let last = new Error('no audio from tts');
  for (let i = 0; i < 3; i++) {
    try {
      const t = await gem(TTS_MODEL, {
        contents: [{ role: 'user', parts: [{ text: text.slice(0, 800) }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: VOICES[vIdx] } }
      }, deadline, 'tts');
      const parts = (((t.candidates || [])[0] || {}).content || {}).parts || [];
      const part = parts.find(p => p.inlineData && p.inlineData.data);
      if (part) {
        let pcm = Buffer.from(part.inlineData.data, 'base64');
        if (pcm.subarray(0, 4).toString() !== 'RIFF') {
          const m = /rate=(\d+)/.exec(part.inlineData.mimeType || '');
          pcm = wav(pcm, m ? Number(m[1]) : 24000);
        }
        return pcm;
      }
      last = new Error('no audio from tts');
    } catch (e) {
      last = e;
      if (isBudget(e)) throw e;
      if (e.status === 400 && /voice|speech/i.test(e.message) && vIdx < VOICES.length - 1) vIdx++;
    }
  }
  throw last;
}

async function download(name, deadline, d) {
  let last = '';
  for (let i = 0; i < 4; i++) {
    try {
      const r = await http(YM + 'DownloadFile?token=' + encodeURIComponent(TOKEN) + '&path=' + encodeURIComponent(yp(name, d)), {}, 8000, deadline);
      const b = Buffer.from(await r.arrayBuffer());
      if (r.ok && b.length > 100 && b.subarray(0, 4).toString() === 'RIFF') return b;
      last = r.status + ' ' + b.subarray(0, 80).toString('utf8').replace(/\s+/g, ' ');
    } catch (e) {
      if (isBudget(e)) throw e;
      last = e.message;
    }
    await sleep(500);
  }
  throw new Error('download failed ' + last);
}

async function upload(name, buf, deadline, d) {
  const path = yp(name, d);
  // documented form first (token and path in the URL, file in the body), then the all-in-body form
  const attempts = [
    { q: true, field: 'file' }, { q: true, field: 'upload' },
    { q: false, field: 'upload' }, { q: false, field: 'file' }
  ];
  let last = '';
  for (const a of attempts) {
    try {
      const f = new FormData();
      let url = YM + 'UploadFile';
      if (a.q) {
        url += '?token=' + encodeURIComponent(TOKEN) + '&path=' + encodeURIComponent(path) + '&convertAudio=1';
      } else {
        f.append('token', TOKEN); f.append('path', path); f.append('convertAudio', '1');
      }
      f.append(a.field, new Blob([buf], { type: 'audio/wav' }), name + '.wav');
      const r = await http(url, { method: 'POST', body: f }, 15000, deadline);
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.responseStatus === 'OK') return;
      last = JSON.stringify(j).slice(0, 200);
    } catch (e) {
      if (isBudget(e)) throw e;
      last = e.message;
    }
  }
  throw new Error('upload failed ' + last);
}

// cleanup is best effort and never blocks or fails a call
function del(name, d) {
  fetch(YM + 'FileAction?token=' + encodeURIComponent(TOKEN) + '&action=delete&what=' + encodeURIComponent(yp(name, d)), { signal: AbortSignal.timeout(8000) }).catch(() => {});
}

app.get('/', (q, r) => { r.set('Access-Control-Allow-Origin', '*'); r.send('ok'); });

app.all(['/yemot', '/yemot/:e'], async (req, res) => {
  const q = { ...req.query, ...req.body };
  const id = String(q.ApiCallId || 'x').replace(/[^a-zA-Z0-9]/g, '').slice(-24) || 'x';
  res.type('text/plain');
  const T0 = Date.now();
  const ext = EXTS[String(req.params.e || '')] || EXT_FIRST;
  try {
    if (q.hangup === 'yes') {
      const old = calls[id];
      if (old && old.r) del(old.r, old.d);
      delete calls[id];
      return res.send('noop=bye');
    }

    const ph = String(q.ApiPhone || '').replace(/[^0-9]/g, '');
    if (ph && blocked[ph] > Date.now()) return res.send('id_list_message=t-' + BLOCKED + '&go_to_folder=hangup');

    const s = calls[id] || (calls[id] = { d: ext.d, k: ext.k, sys: ext.sys, g: ext.g, n: 0, x: 0, h: [], p: '', name: '', r: '', t: 0, e: crypto.randomBytes(3).toString('hex') });
    s.t = Date.now();

    // every turn uses a new parameter and file name, because Yemot accumulates parameters across requests
    // (s.e keeps the names unique even if this server restarted in the middle of a call)
    const ask = pre => {
      s.n++;
      s.p = 'Q' + s.e + s.n;
      s.name = 'q' + s.e + 'n' + s.n;
      return 'read=' + pre + '=' + s.p + ',no,record,' + s.d + ',' + s.name + ',no,,,1,' + REC_MAX;
    };

    if (!s.name) {
      const g = (await greetFile(s.d, Date.now() + 4000)) ? 'f-' + s.d + '/greet' : 't-' + s.g;
      return res.send(ask(g));
    }
    if (!q[s.p]) return res.send(ask('t-' + AGAIN));

    const deadline = T0 + BUDGET;
    const qn = s.name;
    let out;
    try {
      const audio = await download(qn, deadline, s.d);
      del(qn, s.d);
      if (s.r) { del(s.r, s.d); s.r = ''; }
      const t1 = Date.now();

      const a = await textGen({
        systemInstruction: { parts: [{ text: s.sys }] },
        contents: [...(s.k === 'song' ? [] : s.h.slice(-8)), { role: 'user', parts: [{ inlineData: { mimeType: 'audio/wav', data: audio.toString('base64') } }] }]
      }, deadline);
      const parts = (((a.candidates || [])[0] || {}).content || {}).parts || [];
      let text = parts.filter(p => !p.thought).map(p => p.text || '').join('').trim();
      if (!text) throw new Error('empty answer ' + JSON.stringify((a.promptFeedback || {})).slice(0, 100));
      const bad = /BLOCKX/.test(text);
      if (bad) {
        s.x++;
        console.log(id, 'policy strike', s.x);
        if (s.x >= 3) {
          if (ph) blocked[ph] = Date.now() + BLOCK_MS;
          return res.send('id_list_message=t-' + BLOCKED + '&go_to_folder=hangup');
        }
        text = REFUSE + (s.x >= 2 ? '. ' + WARN : '');
      }
      const t2 = Date.now();

      let pcm;
      if (s.k === 'song' && !bad) {
        const r = await findSong(text, deadline);
        if (r.wav) pcm = r.wav; else text = r.msg;
      }
      if (!pcm) pcm = await tts(text, deadline);
      const t3 = Date.now();

      const rn = 'r' + s.e + 'n' + s.n;
      await upload(rn, pcm, deadline, s.d);
      s.r = rn;
      if (!bad) s.h.push({ role: 'user', parts: [{ text: '[שאלה קולית]' }] }, { role: 'model', parts: [{ text }] });
      if (s.h.length > 12) s.h = s.h.slice(-12);

      console.log(id, 'turn', s.n, 'ok', 'gemini', t2 - t1, 'ms tts', t3 - t2, 'ms total', Date.now() - T0, 'ms');
      out = ask('f-' + s.d + '/' + rn);
    } catch (e) {
      console.error(id, 'turn', s.n, 'failed after', Date.now() - T0, 'ms:', e.message, e.stderr ? '| ' + String(e.stderr).replace(/\s+/g, ' ') : '');
      del(qn, s.d);
      out = ask('t-' + ERR);
    }
    return res.send(out);
  } catch (e) {
    // last resort: always answer Yemot with plain text, never HTML or an empty reply
    console.error(id, 'fatal', e.message);
    if (!res.headersSent) res.send('id_list_message=t-' + ERR);
  }
});

// the opening message can be a recording made by Gemini; it is played when the file greet.wav exists in the extension
const greetOk = {};
async function greetFile(d, deadline) {
  if (greetOk[d] !== undefined) return greetOk[d];
  try {
    const r = await http(YM + 'GetIVR2Dir?token=' + encodeURIComponent(TOKEN) + '&path=' + encodeURIComponent('ivr2:' + d), {}, 3500, deadline);
    const j = await r.json().catch(() => ({}));
    if (j.responseStatus !== 'OK') return false;
    greetOk[d] = JSON.stringify(j).includes('greet.wav');
    return greetOk[d];
  } catch (e) {
    return false;
  }
}

// ---- song extension: search YouTube, fetch the audio and convert it to a phone wav ----
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const YTDLP = path.join(__dirname, 'yt-dlp');
let FFMPEG = '';
try { FFMPEG = require('ffmpeg-static') || ''; } catch (e) { FFMPEG = ''; }
const SONG_MAX = Math.min(900, Math.max(60, parseInt(process.env.SONG_MAX_SEC, 10) || 420));
const COOKIES = '/tmp/yt-cookies.txt';
if (process.env.YT_COOKIES) { try { fs.writeFileSync(COOKIES, String(process.env.YT_COOKIES).replace(/\\n/g, '\n')); } catch (e) {} }
const YT_EXTRA = process.env.YTDLP_ARGS !== undefined ? String(process.env.YTDLP_ARGS).split(/\s+/).filter(Boolean) : ['--js-runtimes', 'node'];
const MSG_UNCLEAR = 'לא הבנתי, אמור שוב את שם הזמר ושם השיר';
const MSG_NONE = 'לא מצאתי שיר מתאים, אמור שוב את שם הזמר ושם השיר';
const MSG_BUSY = 'השירות עמוס כרגע, נסה שוב בעוד רגע';
let songBusy = 0;

function run(bin, args, ms, deadline, enc) {
  const left = deadline - Date.now();
  if (left < 1500) return Promise.reject(new Error('turn budget exhausted'));
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: Math.min(ms, left), maxBuffer: 40 * 1024 * 1024, encoding: enc || 'utf8' }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || '').slice(0, 300); return reject(err); }
      resolve(stdout);
    });
  });
}

async function ytdlp(args, ms, deadline) {
  const base = ['--no-warnings', '--cache-dir', '/tmp/yt-cache'];
  if (fs.existsSync(COOKIES)) base.push('--cookies', COOKIES);
  try {
    return await run(YTDLP, [...YT_EXTRA, ...base, ...args], ms, deadline);
  } catch (e) {
    if (YT_EXTRA.length && /no such option|unrecognized/i.test(e.stderr || '')) return run(YTDLP, [...base, ...args], ms, deadline);
    throw e;
  }
}

const isVideo = it => it && typeof it.id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(it.id);

async function titleOk(title, channel, deadline) {
  const a = await textGen({
    systemInstruction: { parts: [{ text: TITLE_SYS }] },
    contents: [{ role: 'user', parts: [{ text: 'כותרת: ' + title + '\nערוץ: ' + channel }] }]
  }, deadline);
  const t = (((a.candidates || [])[0] || {}).content || {}).parts || [];
  return /^\s*OK/i.test(t.filter(p => !p.thought).map(p => p.text || '').join(''));
}

async function findSong(q, deadline) {
  q = String(q || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!q || /UNCLEAR/.test(q)) return { msg: MSG_UNCLEAR };
  if (!fs.existsSync(YTDLP) || !FFMPEG) throw new Error('song tools are missing (yt-dlp or ffmpeg)');
  if (songBusy >= 2) return { msg: MSG_BUSY };
  songBusy++;
  const base = path.join(os.tmpdir(), 'song' + crypto.randomBytes(4).toString('hex'));
  try {
    const out = await ytdlp(['--flat-playlist', '--dump-json', 'ytsearch10:' + q], 20000, deadline);
    const items = out.split('\n').map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean)
      .filter(it => isVideo(it) && (!it.duration || (it.duration >= 30 && it.duration <= 900)));
    let pick = null;
    for (const it of items.slice(0, 3)) {
      if (await titleOk(String(it.title || ''), String(it.channel || it.uploader || ''), deadline)) { pick = it; break; }
    }
    if (!pick) return { msg: MSG_NONE };
    console.log('song', JSON.stringify(q), '->', pick.id, String(pick.title || '').slice(0, 60));
    // spoken announcement before the song: what was searched and what was found (SONG_ANNOUNCE=0 turns it off)
    let ann = null;
    if (process.env.SONG_ANNOUNCE !== '0') {
      const nice = String(pick.title || '').replace(/https?:\S+/g, ' ').replace(/[\[\(].*?[\]\)]/g, ' ').replace(/[|_\-–—•"“”'’#*~^<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
      try { ann = await tts('חיפשתי ' + q + '. מצאתי ' + (nice || 'שיר') + '. מושמע עכשיו.', deadline); } catch (e) { if (isBudget(e)) throw e; ann = null; }
    }
    await ytdlp(['--no-playlist', '-f', 'bestaudio', '--max-filesize', '60M', '-o', base + '.%(ext)s', 'https://www.youtube.com/watch?v=' + pick.id], 30000, deadline);
    const src = fs.readdirSync(os.tmpdir()).find(f => f.startsWith(path.basename(base) + '.') && !f.endsWith('.wav'));
    if (!src) throw new Error('song download produced no file');
    const srcP = path.join(os.tmpdir(), src);
    const FMT = 'aresample=8000,aformat=sample_fmts=s16:channel_layouts=mono';
    if (ann) {
      fs.writeFileSync(base + '.ann.wav', ann);
      await run(FFMPEG, ['-v', 'error', '-y', '-i', base + '.ann.wav', '-i', srcP, '-filter_complex',
        '[0:a]' + FMT + '[a0];[1:a]atrim=duration=' + SONG_MAX + ',' + FMT + '[a1];[a0][a1]concat=n=2:v=0:a=1[o]',
        '-map', '[o]', '-c:a', 'pcm_s16le', base + '.wav'], 30000, deadline);
    } else {
      await run(FFMPEG, ['-v', 'error', '-y', '-i', srcP, '-t', String(SONG_MAX), '-vn', '-ac', '1', '-ar', '8000', '-c:a', 'pcm_s16le', base + '.wav'], 30000, deadline);
    }
    return { wav: fs.readFileSync(base + '.wav') };
  } finally {
    songBusy--;
    for (const f of fs.readdirSync(os.tmpdir())) if (f.startsWith(path.basename(base) + '.')) fs.unlink(path.join(os.tmpdir(), f), () => {});
  }
}

// checks every stage of the song extension and reports the exact error of the stage that fails
let lastSongTest = 0;
app.get('/songtest', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*').type('text/plain; charset=utf-8');
  if (Date.now() - lastSongTest < 15000) return res.send('ERR נבדק הרגע, חכו 15 שניות ונסו שוב');
  lastSongTest = Date.now();
  const out = [];
  const deadline = Date.now() + 70000;
  const short = e => String((e && e.stderr) || (e && e.message) || e).replace(/\s+/g, ' ').slice(0, 300);
  const step = async (name, fn) => {
    try { const r = await fn(); out.push('OK  ' + name + (r ? ' ' + r : '')); return true; }
    catch (e) { out.push('ERR ' + name + ': ' + short(e)); return false; }
  };
  const hasY = await step('קובץ yt-dlp קיים', async () => { if (!fs.existsSync(YTDLP)) throw new Error('הקובץ לא הותקן בבנייה. בדקו את buildCommand ב-Render והריצו פריסה ידנית'); });
  await step('ffmpeg קיים', async () => { if (!FFMPEG) throw new Error('החבילה ffmpeg-static לא הותקנה'); return (await run(FFMPEG, ['-version'], 8000, deadline)).split('\n')[0].slice(0, 40); });
  if (hasY) {
    await step('yt-dlp רץ', async () => '(' + (await run(YTDLP, ['--version'], 15000, deadline)).trim() + ')');
    let id = '';
    await step('חיפוש ביוטיוב', async () => {
      const o = await ytdlp(['--flat-playlist', '--dump-json', 'ytsearch10:avraham fried mi haman'], 25000, deadline);
      const j = o.split('\n').map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(isVideo)[0];
      if (!j) throw new Error('אין תוצאות של סרטונים');
      id = j.id;
      return '(' + String(j.title || '').slice(0, 40) + ')';
    });
    if (id) await step('גישה לאודיו של סרטון', async () => {
      const o = await ytdlp(['--no-playlist', '-f', 'bestaudio', '--simulate', '--print', 'format_id', 'https://www.youtube.com/watch?v=' + id], 35000, deadline);
      return '(' + o.trim().split('\n')[0] + ')';
    });
  }
  res.send(out.join('\n'));
});

// asks Gemini to read the given text aloud and stores it as a file in the given extension
// dir is an extension number such as 5 or 5/2, or empty for the main menu of the line; file is the name without .wav
let lastRec = 0;
app.post('/record', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*').type('text/plain; charset=utf-8');
  try {
    if (String(req.body.token || '') !== TOKEN) return res.send('ERR הטוקן לא תואם לטוקן ששמור בשירות');
    if (Date.now() - lastRec < 6000) return res.send('ERR חכו כמה שניות ונסו שוב');
    const dir = String(req.body.dir || '').replace(/^\/+|\/+$/g, '');
    const file = String(req.body.file || 'greet');
    if (dir && !/^[0-9]+(\/[0-9]+)*$/.test(dir)) return res.send('ERR מספר שלוחה לא תקין');
    if (!/^[A-Za-z0-9_]{1,20}$/.test(file)) return res.send('ERR שם קובץ לא תקין');
    const text = String(req.body.text || '').replace(/\s+/g, ' ').trim().slice(0, 600);
    if (!text) return res.send('ERR הטקסט ריק');
    lastRec = Date.now();
    const d = dir ? '/' + dir : '';
    const deadline = Date.now() + 80000;
    const pcm = await tts(text, deadline);
    await upload(file, pcm, deadline, d);
    if (file === 'greet') greetOk[d] = true;
    res.send('OK ההקלטה נוצרה על ידי ג׳מיני והועלתה אל ' + (dir ? 'שלוחה ' + dir : 'השלוחה הראשית') + ' בשם ' + file + '.wav (' + Math.round(pcm.length / 1024) + 'KB)');
  } catch (e) {
    res.send('ERR ' + String(e.message).slice(0, 200));
  }
});

// quick end to end check of the whole chain, without a phone call
let lastTest = 0;
app.get('/selftest', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*').type('text/plain; charset=utf-8');
  if (Date.now() - lastTest < 20000) return res.send('ERR נבדק הרגע, חכו 20 שניות ונסו שוב');
  lastTest = Date.now();
  const out = [];
  const deadline = Date.now() + 90000;
  const step = async (name, fn) => {
    try { out.push('OK  ' + name + (await fn() || '')); }
    catch (e) { out.push('ERR ' + name + ': ' + String(e.message).slice(0, 220)); }
  };
  const silent = wav(Buffer.alloc(3200), 8000);

  await step('מפתחות ג׳מיני לתמלול', async () => { if (!KEYS.length) throw new Error('GEMINI_API_KEYS ריק'); return ' (' + KEYS.length + ')'; });
  await step('מפתחות ג׳מיני להקראה', async () => { if (!TTS_KEYS.length) throw new Error('GEMINI_TTS_KEYS ריק'); return ' (' + TTS_KEYS.length + ')'; });
  await step('טוקן ימות', async () => { if (!TOKEN || /undefined/.test(TOKEN)) throw new Error('YEMOT_TOKEN ריק'); });
  await step('ימות: קריאת השלוחה ' + EXT, async () => {
    const r = await http(YM + 'GetIVR2Dir?token=' + encodeURIComponent(TOKEN) + '&path=' + encodeURIComponent('ivr2:' + EXTP), {}, 10000, deadline);
    const j = await r.json().catch(() => ({}));
    if (j.responseStatus !== 'OK') throw new Error(JSON.stringify(j).slice(0, 180));
  });
  await step('ימות: העלאה ומחיקה של קובץ', async () => {
    await upload('selftest', silent, deadline);
    const r = await http(YM + 'FileAction?token=' + encodeURIComponent(TOKEN) + '&action=delete&what=' + encodeURIComponent(yp('selftest')), {}, 8000, deadline);
    const j = await r.json().catch(() => ({}));
    if (j.responseStatus !== 'OK') throw new Error('מחיקה: ' + JSON.stringify(j).slice(0, 150));
  });
  await step('ג׳מיני ' + TEXT_MODEL + ' (קלט אודיו)', async () => {
    const a = await textGen({ contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'audio/wav', data: silent.toString('base64') } }, { text: 'ענה במילה אחת' }] }] }, deadline);
    if (!(((a.candidates || [])[0] || {}).content)) throw new Error('תשובה ריקה');
    return ' (thinking: ' + (THINK[thinkIdx] || 'ברירת מחדל') + ')';
  });
  await step('ג׳מיני ' + TTS_MODEL + ' (קול)', async () => {
    const p = await tts('בדיקה', deadline);
    return ' (' + Math.round(p.length / 1024) + 'KB)';
  });
  res.send(out.join('\n'));
});

app.use((err, req, res, next) => {
  console.error('express', err && err.message);
  if (!res.headersSent) res.type('text/plain').send('id_list_message=t-' + ERR);
});
process.on('unhandledRejection', e => console.error('unhandledRejection', e && e.message));
process.on('uncaughtException', e => console.error('uncaughtException', e && e.message));

app.listen(process.env.PORT || 3000, () => console.log('zygy up'));
