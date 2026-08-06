/**
 * Emits the README pipeline diagram in both colour schemes.
 *
 * The diagram exists twice — once per `prefers-color-scheme` — and hand-editing two SVGs
 * in lockstep is how they drift. Change the geometry or the copy here and re-run
 * `node scripts/gen-diagram.mjs`; the committed SVGs are the output.
 *
 * Labels are monospace on purpose. Card widths are sized against a fixed character
 * advance, so a viewer without the preferred font still lands inside its box.
 */
import { writeFileSync } from 'node:fs';

const MONO = 'ui-monospace,SFMono-Regular,SF Mono,Menlo,Consolas,monospace';

const THEMES = {
  dark: {
    id: 'pd',
    bg: '#0B0E14', card: '#131926', border: '#242D3E', rule: '#1C2434',
    text: '#DCE5F0', muted: '#8593A8', dim: '#5C6879',
    cyan: '#38BDF8', violet: '#A78BFA', pink: '#F472B6', gold: '#F2B33D',
    frame: 'none',
  },
  light: {
    id: 'pl',
    bg: '#FFFFFF', card: '#F6F8FA', border: '#D9E0E8', rule: '#E4E9EF',
    text: '#1F2933', muted: '#5B6673', dim: '#8A94A2',
    cyan: '#0284C7', violet: '#7C3AED', pink: '#DB2777', gold: '#B4780A',
    frame: '#D8DEE6',
  },
};

const W = 1240, H = 380;

// One row of the jury column: a coloured source node feeding a model card.
const JURY = [
  { y: 90,  color: 'cyan',   model: 'GPT-5.6 Terra', harness: 'codex' },
  { y: 190, color: 'violet', model: 'Grok 4.5',      harness: 'grok build' },
  { y: 290, color: 'pink',   model: 'Kimi K3',       harness: 'kimi code' },
];

const MERGE = [
  ['anchor',  'snap to a changed line', 'free'],
  ['block',   'file + line window',     'free'],
  ['jaccard', 'token similarity',       'free'],
  ['referee', 'only when ambiguous',    '0–2 calls'],
];

function card(t, x, y, w, h, r = 10) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${t.card}" stroke="${t.border}"/>`;
}

function arrow(t, x1, x2, y) {
  const midY = y;
  return `<path d="M${x1} ${midY}H${x2 - 7}" stroke="${t.dim}" stroke-width="1.5" fill="none"/>` +
    `<path d="M${x2 - 8} ${midY - 4.5}L${x2} ${midY}L${x2 - 8} ${midY + 4.5}Z" fill="${t.dim}"/>`;
}

function render(t) {
  const p = [];
  p.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Juror pipeline: the diff fans out to a jury of models, their findings are merged, and one comment is posted">`);
  p.push(`<title>How Juror works</title>`);
  p.push(`<defs><radialGradient id="${t.id}-glow" cx="0.5" cy="0.5" r="0.5">` +
    `<stop offset="0" stop-color="${t.gold}" stop-opacity="0.22"/>` +
    `<stop offset="1" stop-color="${t.gold}" stop-opacity="0"/></radialGradient></defs>`);
  p.push(`<rect width="${W}" height="${H}" rx="16" fill="${t.bg}"/>`);
  if (t.frame !== 'none') p.push(`<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="15.5" fill="none" stroke="${t.frame}"/>`);

  const label = (x, y, s, size, fill, anchor = 'start', extra = '') =>
    `<text x="${x}" y="${y}" font-family="${MONO}" font-size="${size}" fill="${fill}" text-anchor="${anchor}"${extra}>${s}</text>`;

  // ── column headings
  const heads = [[40, 'THE DIFF'], [280, 'THE JURY'], [650, 'MERGE'], [1000, 'VERDICT']];
  for (const [x, s] of heads) p.push(label(x, 44, s, 12, t.dim, 'start', ' letter-spacing="2.4"'));

  // ── col A: the diff
  p.push(card(t, 40, 158, 150, 64));
  p.push(label(115, 184, 'your diff', 15, t.text, 'middle'));
  p.push(label(115, 205, 'untrusted', 12, t.dim, 'middle'));

  // fan out
  for (const j of JURY) {
    const c = t[j.color];
    p.push(`<path d="M190 190C238 190 246 ${j.y} 296 ${j.y}" stroke="${c}" stroke-width="1.75" fill="none" opacity="0.85"/>`);
  }

  // ── col B: the jury
  for (const j of JURY) {
    const c = t[j.color];
    p.push(card(t, 296, j.y - 32, 264, 64));
    p.push(`<circle cx="322" cy="${j.y}" r="5" fill="${c}"/>`);
    p.push(label(342, j.y - 3, j.model, 14, t.text));
    p.push(label(342, j.y + 16, j.harness + ' · own sandbox', 11.5, t.dim));
    // converge
    p.push(`<path d="M560 ${j.y}C602 ${j.y} 608 190 644 190" stroke="${c}" stroke-width="1.75" fill="none" opacity="0.6"/>`);
  }
  p.push(label(296, 352, '+ any model on models.dev, via the opencode harness', 11.5, t.dim));

  // ── col C: merge
  p.push(card(t, 650, 75, 300, 230));
  p.push(label(674, 106, 'cheap methods first', 12, t.muted));
  p.push(`<path d="M674 120H926" stroke="${t.rule}" stroke-width="1"/>`);
  MERGE.forEach(([name, how, cost], i) => {
    const y = 152 + i * 42;
    const paid = cost !== 'free';
    p.push(label(674, y, name, 13.5, paid ? t.gold : t.text));
    p.push(label(674, y + 16, how, 11, t.dim));
    p.push(label(926, y, cost, 11.5, paid ? t.gold : t.muted, 'end'));
  });

  // ── col D: verdict
  p.push(arrow(t, 950, 998, 190));
  p.push(card(t, 1000, 105, 200, 170));
  p.push(`<circle cx="1100" cy="163" r="46" fill="url(#${t.id}-glow)"/>`);
  p.push(`<circle cx="1100" cy="163" r="21" fill="none" stroke="${t.gold}" stroke-width="6"/>`);
  p.push(label(1100, 216, 'one comment', 14, t.text, 'middle'));
  p.push(label(1100, 238, 'one notification', 11.5, t.dim, 'middle'));
  p.push(label(1100, 260, '$0.91 · 2m14s', 12, t.gold, 'middle'));

  p.push('</svg>\n');
  return p.join('\n');
}

for (const [name, t] of Object.entries(THEMES)) {
  writeFileSync(`assets/pipeline-${name}.svg`, render(t));
}
console.log('wrote assets/pipeline-{dark,light}.svg');
