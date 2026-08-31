// Paste this into the DevTools console of a live ESPN draft room.
//
// It does not click anything. It samples the DOM's structural vocabulary so
// content/selectors.js can be written against reality instead of guesses, and
// re-run later to detect when ESPN's markup has drifted.
//
// Output is copied to the clipboard and printed. Paste it back to Claude.
(() => {
  const KEYWORD = /pick|draft|player|roster|clock|queue|board|team|round|onthe/i;
  const MAX_SAMPLES = 3;

  const className = (el) => {
    const c = el.className;
    if (typeof c === 'string') return c;
    if (c && typeof c.baseVal === 'string') return c.baseVal;
    return '';
  };

  const text = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();

  // 1. Class vocabulary: which draft-ish classes exist, how many, sample text.
  const classes = new Map();
  for (const el of document.querySelectorAll('*')) {
    for (const cls of className(el).split(/\s+/)) {
      if (!cls || !KEYWORD.test(cls)) continue;
      if (!classes.has(cls)) classes.set(cls, { count: 0, samples: [] });
      const rec = classes.get(cls);
      rec.count++;
      const t = text(el);
      if (t && t.length < 120 && rec.samples.length < MAX_SAMPLES) rec.samples.push(t);
    }
  }

  // 2. data-* attribute vocabulary — often more stable than class names.
  const dataAttrs = new Map();
  for (const el of document.querySelectorAll('*')) {
    for (const attr of el.attributes) {
      if (!attr.name.startsWith('data-')) continue;
      if (!dataAttrs.has(attr.name)) dataAttrs.set(attr.name, { count: 0, samples: [] });
      const rec = dataAttrs.get(attr.name);
      rec.count++;
      if (rec.samples.length < MAX_SAMPLES && attr.value) rec.samples.push(attr.value.slice(0, 60));
    }
  }

  // 3. Anything that reads like a pick coordinate, with its ancestor chain.
  const PICK_TEXT = /\bR(ound)?\s?\d+\b.*\bP(ick)?\s?\d+\b|\b\d+\.\d+\b/i;
  const pickish = [];
  for (const el of document.querySelectorAll('li, tr, div, span')) {
    if (el.children.length > 2) continue;
    const t = text(el);
    if (!t || t.length > 80 || !PICK_TEXT.test(t)) continue;
    const chain = [];
    let node = el;
    for (let i = 0; i < 5 && node && node !== document.body; i++) {
      chain.push(`${node.tagName.toLowerCase()}${className(node) ? '.' + className(node).split(/\s+/).join('.') : ''}`);
      node = node.parentElement;
    }
    pickish.push({ text: t, chain });
    if (pickish.length >= 8) break;
  }

  // 4. Where does the phrase "on the clock" live?
  const clock = [];
  for (const el of document.querySelectorAll('div, span, h1, h2, h3, p')) {
    if (el.children.length > 1) continue;
    const t = text(el);
    if (!/on the clock|you'?re up|your pick/i.test(t) || t.length > 100) continue;
    clock.push({
      text: t,
      selector: `${el.tagName.toLowerCase()}${className(el) ? '.' + className(el).split(/\s+/).join('.') : ''}`
    });
    if (clock.length >= 5) break;
  }

  // 5. Biggest repeated-structure containers — the pick feed is usually one.
  const repeats = [];
  for (const el of document.querySelectorAll('ul, ol, tbody, div')) {
    const kids = [...el.children];
    if (kids.length < 5) continue;
    const first = className(kids[0]);
    if (!first) continue;
    const uniform = kids.filter((k) => className(k) === first).length;
    if (uniform < kids.length * 0.8) continue;
    repeats.push({
      container: `${el.tagName.toLowerCase()}${className(el) ? '.' + className(el).split(/\s+/).join('.') : ''}`,
      childClass: first,
      childCount: kids.length,
      sample: text(kids[0]).slice(0, 100)
    });
  }
  repeats.sort((a, b) => b.childCount - a.childCount);

  const summarize = (map) =>
    [...map.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 60)
      .map(([k, v]) => ({ name: k, count: v.count, samples: v.samples }));

  const report = {
    url: location.href,
    capturedAt: new Date().toISOString(),
    classes: summarize(classes),
    dataAttrs: summarize(dataAttrs),
    pickish,
    clock,
    repeats: repeats.slice(0, 12)
  };

  const json = JSON.stringify(report, null, 1);
  try {
    copy(json);
    console.log('FDA probe: copied to clipboard,', json.length, 'chars');
  } catch {
    console.log('FDA probe: clipboard unavailable, copy the object below');
  }
  console.log(report);
  return report;
})();
