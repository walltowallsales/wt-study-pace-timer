const express = require('express');
const cheerio = require('cheerio');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '128kb' }));
app.use(express.urlencoded({ extended: false }));


// ---------------- PIN protection ----------------
// Set these in Render > Environment:
//   APP_PIN = your PIN
//   PIN_REMEMBER_DAYS = number of days to remember a successful browser (default 90)
//
// If APP_PIN is blank/not set, PIN protection is disabled.
const APP_PIN = String(process.env.APP_PIN || '');
const parsedRememberDays = Number.parseFloat(process.env.PIN_REMEMBER_DAYS || '90');
const PIN_REMEMBER_DAYS = Number.isFinite(parsedRememberDays) && parsedRememberDays > 0
  ? Math.min(parsedRememberDays, 3650)
  : 90;
const AUTH_COOKIE = 'study_pace_auth';
const AUTH_SECRET = String(process.env.AUTH_SECRET || `study-pace:${APP_PIN}:v1`);

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  raw.split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function signAuth(expMs) {
  const payload = String(expMs);
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function authCookieValid(req) {
  if (!APP_PIN) return true;
  const token = parseCookies(req)[AUTH_COOKIE];
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot < 1) return false;
  const expText = token.slice(0, dot);
  const suppliedSig = token.slice(dot + 1);
  const exp = Number(expText);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  const expectedSig = crypto.createHmac('sha256', AUTH_SECRET).update(expText).digest('hex');
  try {
    const a = Buffer.from(suppliedSig, 'hex');
    const b = Buffer.from(expectedSig, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function safeNext(value) {
  const v = String(value || '/');
  return v.startsWith('/') && !v.startsWith('//') ? v : '/';
}

function loginPage(message = '', next = '/') {
  const escapedMessage = String(message).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const escapedNext = String(next).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  return `<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Study Pace Timer</title>
<style>
body{margin:0;background:#f5f7fb;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#182235}
.wrap{min-height:100vh;display:grid;place-items:center;padding:20px}
.card{width:min(420px,100%);background:#fff;border:1px solid #dfe5ee;border-radius:18px;padding:26px;box-shadow:0 12px 34px rgba(15,23,42,.08)}
h1{font-size:24px;margin:0 0 6px}.sub{color:#64748b;margin:0 0 20px}
input{box-sizing:border-box;width:100%;font-size:22px;letter-spacing:.12em;padding:13px 14px;border:1px solid #cbd5e1;border-radius:12px;text-align:center}
button{width:100%;margin-top:12px;padding:13px;border:0;border-radius:12px;background:#2563eb;color:#fff;font-size:17px;font-weight:800}
.err{background:#fee2e2;color:#991b1b;padding:10px 12px;border-radius:10px;margin-bottom:14px}
.note{font-size:12px;color:#64748b;margin-top:14px;text-align:center}
</style></head>
<body><div class="wrap"><form class="card" method="post" action="/login">
<h1>Study Pace Timer</h1><p class="sub">Enter the PIN to continue.</p>
${escapedMessage ? `<div class="err">${escapedMessage}</div>` : ''}
<input type="password" inputmode="numeric" autocomplete="one-time-code" name="pin" placeholder="PIN" autofocus required>
<input type="hidden" name="next" value="${escapedNext}">
<button type="submit">Unlock</button>
<div class="note">This browser will stay signed in for ${PIN_REMEMBER_DAYS} day${PIN_REMEMBER_DAYS === 1 ? '' : 's'}.</div>
</form></div></body></html>`;
}

app.get('/login', (req, res) => {
  if (!APP_PIN || authCookieValid(req)) return res.redirect(safeNext(req.query.next));
  res.type('html').send(loginPage('', safeNext(req.query.next)));
});

app.post('/login', (req, res) => {
  if (!APP_PIN) return res.redirect('/');
  const supplied = String(req.body.pin || '');
  const a = Buffer.from(supplied);
  const b = Buffer.from(APP_PIN);
  const correct = a.length === b.length && crypto.timingSafeEqual(a, b);
  const next = safeNext(req.body.next);
  if (!correct) return res.status(401).type('html').send(loginPage('Incorrect PIN. Try again.', next));

  const maxAgeMs = Math.round(PIN_REMEMBER_DAYS * 24 * 60 * 60 * 1000);
  const exp = Date.now() + maxAgeMs;
  res.cookie(AUTH_COOKIE, signAuth(exp), {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: maxAgeMs,
    path: '/'
  });
  res.redirect(next);
});

app.get('/logout', (_req, res) => {
  res.clearCookie(AUTH_COOKIE, { path: '/' });
  res.redirect('/login');
});

function requirePin(req, res, next) {
  if (!APP_PIN || authCookieValid(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'PIN required' });
  const nextUrl = encodeURIComponent(req.originalUrl || '/');
  res.redirect(`/login?next=${nextUrl}`);
}

// Everything below this point, including the importer and static app files,
// is protected by the PIN when APP_PIN is set.
app.use(requirePin);
app.use(express.static(path.join(__dirname, 'public')));

const clean = (s = '') => s.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
const looksLikeQuestion = t => /\?/.test(t) || /^\(?[abc]\)?[.)]?\s+/i.test(t);
const isReviewHeading = t => /how would you answer|review questions?/i.test(t);
const isParagraphLabel = t => /^(?:\d{1,2})(?:\s*[-–]\s*\d{1,2})?$/.test(t);

// WOL sometimes exposes the question, the 'Your answer' prompt, and the
// paragraph body as one combined DOM block. Keep only the question-side text.
const questionOnly = (s = '') => clean(String(s).split(/\byour answers?\b/i)[0]);

function parseWol(html) {
  const $ = cheerio.load(html);
  $('script,style,noscript,header,footer,nav').remove();

  const title = clean($('h1').first().text()) || clean($('title').text()).replace(/\s*[—|-].*$/, '');
  let currentSection = '';
  let reviewMode = false;
  const units = [];
  const reviewQuestions = [];
  let current = null;

  // WOL article content has changed class names over time, so intentionally use
  // broad semantic/block selectors and classify each block by its text/content.
  const roots = $('.bodyTxt, article, main, #content, .article').toArray();
  const root = roots.length ? $(roots[0]) : $('body');
  const blocks = root.find('h2,h3,h4,p,div').filter((_, el) => {
    const $el=$(el);
    if ($el.children('h2,h3,h4,p,div').length > 3) return false;
    const t=clean($el.clone().children('sup').remove().end().text());
    return t && t.length < 1600;
  }).toArray();

  const flush = () => {
    if (!current) return;
    current.q = clean(current.q);
    if (!current.q) current.q = `Discuss paragraph ${current.label}.`;
    units.push(current);
    current = null;
  };

  for (const el of blocks) {
    const $el = $(el);
    let text = clean($el.text());
    if (!text) continue;
    const tag = (el.tagName || '').toLowerCase();
    const cls = ($el.attr('class') || '').toLowerCase();

    if (/^h[2-4]$/.test(tag)) {
      if (isReviewHeading(text)) { flush(); reviewMode = true; currentSection = ''; continue; }
      if (text.length <= 180 && !/^study article/i.test(text)) { flush(); currentSection = text; reviewMode = false; }
      continue;
    }

    if (isReviewHeading(text)) { flush(); reviewMode = true; currentSection = ''; continue; }

    if (reviewMode && looksLikeQuestion(text) && reviewQuestions.length < 3) {
      reviewQuestions.push(text.replace(/^\s*[•·]\s*/, ''));
      continue;
    }

    // IMPORTANT: recognize a new numbered question BEFORE treating a block as
    // a generic question belonging to the current paragraph. WOL commonly
    // renders lines such as "4. What idea ...?" as ordinary paragraph blocks.
    // If generic-question detection runs first, paragraph 4 can be swallowed
    // by paragraph 3 and later fall back to "Discuss paragraph 4."
    let label = '';
    let questionOnNumberLine = '';

    // First prefer the complete visible text. This works whether the paragraph
    // number is plain text or wrapped in a span.
    const leading = text.match(/^\s*(\d{1,2}(?:\s*[-–]\s*\d{1,2})?)\s*[.]?\s+(.*)$/s);
    if (leading && isParagraphLabel(leading[1])) {
      label = leading[1].replace(/\s+/g, '');
      const remainder = questionOnly(leading[2]);
      if (/\?/.test(remainder)) questionOnNumberLine = remainder;
    }

    // Fallback for layouts where the number is isolated in its own element and
    // the leading-text regex does not see it as part of the visible text.
    if (!label) {
      const numberCandidate = clean($el.find('.parNum, .pNum, .num, span').first().text());
      if (isParagraphLabel(numberCandidate)) {
        label = numberCandidate.replace(/\s+/g, '');
        let remainder = text;
        const escaped = numberCandidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        remainder = questionOnly(remainder.replace(new RegExp(`^\\s*${escaped}\\s*[.]?\\s*`), ''));
        if (/\?/.test(remainder)) questionOnNumberLine = remainder;
      }
    }

    if (label) {
      flush(); reviewMode = false;
      current = {
        label,
        section: currentSection,
        q: questionOnNumberLine,
        weight: 'normal',
        read: /\bread\b/i.test(text) && /(?:psalm|proverbs|matthew|mark|luke|john|acts|romans|corinthians|galatians|ephesians|philippians|colossians|thessalonians|timothy|titus|philemon|hebrews|james|peter|jude|revelation|genesis|exodus|leviticus|numbers|deuteronomy|joshua|judges|ruth|samuel|kings|chronicles|ezra|nehemiah|esther|job|ecclesiastes|song|isaiah|jeremiah|lamentations|ezekiel|daniel|hosea|joel|amos|obadiah|jonah|micah|nahum|habakkuk|zephaniah|haggai|zechariah|malachi)/i.test(text),
        picture: /see also picture/i.test(text),
        box: /see also (?:the )?box/i.test(text),
        locked: false
      };
      continue;
    }

    // Only after ruling out a new numbered paragraph do we attach a question
    // block to the currently open unit.
    if ((/\bqu\b|question/.test(cls) || looksLikeQuestion(text)) && current) {
      if (!/^your answers?$/i.test(text) && text.length < 700) {
        current.q += (current.q ? ' ' : '') + text;
      }
      continue;
    }

    if (current) {
      if (/illustration|picture|image|caption|figcaption/.test(cls) || $el.find('img,figure').length) current.picture = true;
      if (/box|sidebar|boxText/i.test(cls)) current.box = true;
      if (/\bread\b/i.test(text) && /\d+:\d+/.test(text)) current.read = true;
    }
  }
  flush();

  // Remove obvious duplicates introduced by nested DOM blocks.
  const seen = new Set();
  const deduped = units.filter(u => {
    const k = `${u.label}|${u.section}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });

  return { title, units: deduped, reviewQuestions };
}

app.post('/api/import', async (req, res) => {
  try {
    const raw = String(req.body?.url || '').trim();
    let url;
    try { url = new URL(raw); } catch { return res.status(400).json({error:'That is not a valid URL.'}); }
    if (url.protocol !== 'https:' || url.hostname !== 'wol.jw.org') {
      return res.status(400).json({error:'For safety, this importer only accepts https://wol.jw.org article URLs.'});
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; StudyPaceTimer/1.0)',
        'accept': 'text/html,application/xhtml+xml'
      }
    });
    clearTimeout(timer);
    if (!response.ok) return res.status(502).json({error:`WOL returned HTTP ${response.status}.`});
    const html = await response.text();
    const parsed = parseWol(html);
    if (!parsed.units.length) {
      return res.status(422).json({error:'The page loaded, but the importer could not recognize the discussion paragraphs. Use the paste-outline option for this article.'});
    }
    res.json(parsed);
  } catch (err) {
    console.error(err);
    const msg = err?.name === 'AbortError' ? 'WOL took too long to respond.' : 'The server could not import that article.';
    res.status(500).json({error:msg});
  }
});

app.get('/api/health', (_req, res) => res.json({ok:true}));
app.get(/.*/, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`Study Pace Timer running on port ${PORT}`));
