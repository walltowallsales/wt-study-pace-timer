const express = require('express');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
app.use(express.json({ limit: '128kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const clean = (s = '') => s.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
const looksLikeQuestion = t => /\?/.test(t) || /^\(?[abc]\)?[.)]?\s+/i.test(t);
const isReviewHeading = t => /how would you answer|review questions?/i.test(t);
const isParagraphLabel = t => /^(?:\d{1,2})(?:\s*[-–]\s*\d{1,2})?$/.test(t);

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

    // Question blocks are commonly marked by class names containing qu/question.
    if ((/\bqu\b|question/.test(cls) || looksLikeQuestion(text)) && current) {
      if (!/^\d+\.?\s/.test(text)) current.q += (current.q ? ' ' : '') + text;
      continue;
    }

    // Detect a paragraph number either in a dedicated child/span or at the start.
    let label = '';
    let labelFromLeadingText = false;
    const numberCandidate = clean($el.find('.parNum, .pNum, .num, span').first().text());
    if (isParagraphLabel(numberCandidate)) label = numberCandidate.replace(/\s+/g,'');
    if (!label) {
      const m = text.match(/^\s*(\d{1,2}(?:\s*[-–]\s*\d{1,2})?)\s*[.]?\s+(.*)$/s);
      if (m) {
        label = m[1].replace(/\s+/g,'');
        text = clean(m[2]);
        labelFromLeadingText = true;
      }
    }

    if (label) {
      flush(); reviewMode = false;
      // On WOL the discussion question is commonly on the same line as the
      // paragraph number (for example: "3. How does Jehovah speak to us?").
      // Preserve that remainder as the question instead of throwing it away.
      const questionOnNumberLine = labelFromLeadingText && /\?/.test(text) ? text : '';
      current = {
        label,
        section: currentSection,
        q: questionOnNumberLine,
        weight: 'normal',
        read: /\bread\b/i.test(text) && /(?:psalm|proverbs|matthew|mark|luke|john|acts|romans|corinthians|galatians|ephesians|philippians|colossians|thessalonians|timothy|titus|philemon|hebrews|james|peter|jude|revelation|genesis|exodus|leviticus|numbers|deuteronomy|joshua|judges|ruth|samuel|kings|chronicles|ezra|nehemiah|esther|job|ecclesiastes|song|isaiah|jeremiah|lamentations|ezekiel|daniel|hosea|joel|amos|obadiah|jonah|micah|nahum|habakkuk|zephaniah|haggai|zechariah|malachi)/i.test(text),
        picture: false,
        box: false,
        locked: false
      };
      continue;
    }

    if (current) {
      if (/illustration|picture|image|caption|figcaption/.test(cls) || $el.find('img,figure').length) current.picture = true;
      if (/box|sidebar|boxText/i.test(cls)) current.box = true;
      if (/\bread\b/i.test(text) && /\d+:\d+/.test(text)) current.read = true;
      if (looksLikeQuestion(text) && text.length < 700) current.q += (current.q ? ' ' : '') + text;
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
