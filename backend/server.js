const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const STARTED_AT = Date.now();

const ALLOWED_ORIGINS = [
  'https://teaha1208-creator.github.io'
];
const LOCAL_ORIGIN_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

app.use(cors({
  origin: function (origin, cb) {
    if (!origin || ALLOWED_ORIGINS.indexOf(origin) !== -1 || LOCAL_ORIGIN_RE.test(origin)) {
      return cb(null, true);
    }
    cb(new Error('Not allowed by CORS'));
  }
}));
app.use(express.json({ limit: '64kb' }));

const stats = { translations: 0, chars: 0, errors: 0 };

const LANGS = new Set(['ko', 'ja', 'zh-CN', 'zh-TW', 'en']);
const MAX_TEXT_LEN = 5000;
const CHUNK_LEN = 450;
const UPSTREAM_TIMEOUT_MS = 15000;

function splitIntoChunks(text, max) {
  max = max || CHUNK_LEN;
  const chunks = [];
  let buf = '';
  let sentence = '';
  const pushSentence = () => {
    if (!sentence) return;
    if (buf.length + sentence.length > max && buf) {
      chunks.push(buf);
      buf = '';
    }
    if (sentence.length > max) {
      if (buf) {
        chunks.push(buf);
        buf = '';
      }
      for (let i = 0; i < sentence.length; i += max) {
        chunks.push(sentence.slice(i, i + max));
      }
      sentence = '';
      return;
    }
    buf += sentence;
    sentence = '';
  };
  for (const ch of text) {
    sentence += ch;
    if ('\u3002\uFF01\uFF1F!?\n'.indexOf(ch) !== -1) pushSentence();
  }
  pushSentence();
  if (buf) chunks.push(buf);
  return chunks;
}

const ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' '
};

function decodeEntities(s) {
  return String(s).replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (c) => ENTITIES[c] || c);
}

async function fetchWithTimeout(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function googleTranslate(chunk, source, target) {
  const url =
    'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t' +
    '&sl=' + encodeURIComponent(source) + '&tl=' + encodeURIComponent(target) +
    '&q=' + encodeURIComponent(chunk);
  const res = await fetchWithTimeout(url, UPSTREAM_TIMEOUT_MS);
  if (!res.ok) throw new Error('번역 서버 오류 (HTTP ' + res.status + ')');
  const data = await res.json();
  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    throw new Error('번역 서버 응답 형식이 올바르지 않습니다.');
  }
  const text = data[0].map((seg) => (seg && seg[0]) || '').join('');
  if (!text) throw new Error('번역 결과가 비어 있습니다.');
  return text;
}

async function myMemoryTranslate(chunk, source, target) {
  const url =
    'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(chunk) +
    '&langpair=' + encodeURIComponent(source) + '%7C' + encodeURIComponent(target) +
    '&de=teaha1208@example.com';
  const res = await fetchWithTimeout(url, UPSTREAM_TIMEOUT_MS);
  if (!res.ok) throw new Error('번역 서버 오류 (HTTP ' + res.status + ')');
  const data = await res.json();
  const status = Number(data.responseStatus);
  const translated = data.responseData && data.responseData.translatedText;
  if (status !== 200 || typeof translated !== 'string' || !translated) {
    throw new Error(data.responseDetails || '번역 서버에서 오류가 발생했습니다.');
  }
  if (/MYMEMORY WARNING/i.test(translated)) {
    throw new Error('오늘의 무료 번역 한도가 초과되었습니다.');
  }
  return decodeEntities(translated);
}

async function translateChunk(chunk, source, target) {
  try {
    return await googleTranslate(chunk, source, target);
  } catch (googleErr) {
    try {
      return await myMemoryTranslate(chunk, source, target);
    } catch (myMemoryErr) {
      if (googleErr && googleErr.name === 'AbortError' && myMemoryErr && myMemoryErr.name === 'AbortError') {
        throw new Error('번역 서버 응답 시간이 초과되었습니다.');
      }
      throw myMemoryErr;
    }
  }
}

app.get('/', (req, res) => {
  res.json({ name: 'mini-block-world API', status: 'ok' });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptimeSec: Math.floor((Date.now() - STARTED_AT) / 1000) });
});

app.get('/api/stats', (req, res) => {
  res.json({
    ...stats,
    uptimeSec: Math.floor((Date.now() - STARTED_AT) / 1000)
  });
});

app.post('/api/translate', async (req, res) => {
  const t0 = Date.now();
  const body = req.body || {};
  const text = typeof body.text === 'string' ? body.text : '';
  const source = body.source;
  const target = body.target;

  if (!text.trim()) {
    return res.status(400).json({ ok: false, error: 'text 필드가 필요합니다.' });
  }
  if (!LANGS.has(source) || !LANGS.has(target)) {
    return res.status(400).json({ ok: false, error: '지원 언어: ko, ja, zh-CN, zh-TW, en' });
  }
  if (source === target) {
    return res.status(400).json({ ok: false, error: '출발 언어와 도착 언어가 달라야 합니다.' });
  }
  if (text.length > MAX_TEXT_LEN) {
    return res.status(413).json({ ok: false, error: '텍스트는 ' + MAX_TEXT_LEN + '자 이하로 보내주세요.' });
  }

  const chunks = splitIntoChunks(text);
  try {
    const out = [];
    for (const chunk of chunks) {
      out.push(await translateChunk(chunk, source, target));
    }
    stats.translations += 1;
    stats.chars += text.length;
    res.json({
      ok: true,
      translatedText: out.join(''),
      chunks: chunks.length,
      elapsedMs: Date.now() - t0
    });
  } catch (e) {
    stats.errors += 1;
    res.status(502).json({ ok: false, error: e.message || '번역에 실패했습니다.' });
  }
});

app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'Not Found' });
});

app.listen(PORT, () => {
  console.log('mini-block-world API listening on port ' + PORT);
});
