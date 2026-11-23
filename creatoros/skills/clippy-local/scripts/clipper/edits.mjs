// Clippy word-exact edits: the editor pass names where a clip starts and ends
// (and the stretches it cuts out) as spoken words; at render they're found in
// the clip's own word timings, so cuts land between words, not mid-sentence.
// Words are [text, start, end] in seconds.

export const toks = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/'/g, '').split(/\s+/).filter(Boolean);
/** Where `phrase` is said in `words` ([w, s, e]): { first, last } word indexes, the match nearest `near` s. */
export function findPhrase(words, phrase, near, within = 10) {
  const want = toks(phrase);
  if (want.length < 2) return null;
  const have = words.map((w) => toks(w[0]).join(''));
  let best = null;
  for (let i = 0; i < have.length; i++) {
    if (Math.abs(words[i][1] - near) > within) continue;
    if (have[i] !== want[0] && have[i] !== want[1]) continue;
    // Greedy in-order match inside a window a little longer than the phrase.
    let j = 0;
    let hit = 0;
    let last = i;
    for (let k = i; k < Math.min(have.length, i + want.length + 3) && j < want.length; k++) {
      const at = want.indexOf(have[k], j);
      if (at >= 0 && at - j <= 2) { hit += 1; j = at + 1; last = k; }
    }
    const ratio = hit / want.length;
    const dist = Math.abs(words[i][1] - near);
    // Matched from the phrase's 2nd word: the word just before (said without a pause) is its misheard 1st.
    const first = have[i] !== want[0] && i > 0 && words[i][1] - words[i - 1][2] < 0.3 ? i - 1 : i;
    if (ratio >= 0.6 && (!best || ratio > best.ratio + 0.05 || (Math.abs(ratio - best.ratio) <= 0.05 && dist < best.dist))) best = { first, last, ratio, dist };
  }
  return best;
}
export const subtract = (ranges, cuts) => cuts.reduce((acc, [x, y]) => acc.flatMap(([a, b]) => (y <= a || x >= b ? [[a, b]] : [[a, x], [y, b]].filter(([p, q]) => q - p > 0.05))), ranges);
export const intersect = (A, B) => A.flatMap(([a, b]) => B.map(([c, d]) => [Math.max(a, c), Math.min(b, d)]).filter(([p, q]) => q - p > 0.05));
/** Caption spelling fixes ("citaloa" -> "Sinaloa"), multi-word aware. */
export function applyFixes(words, fixes) {
  if (!fixes?.length) return words;
  const out = words.map((w) => [...w]);
  for (const f of fixes) {
    const heard = toks(f.heard);
    if (!heard.length) continue;
    for (let i = 0; i + heard.length <= out.length; i++) {
      if (!heard.every((h, k) => toks(out[i + k][0]).join('') === h)) continue;
      const tail = /[.,!?]+$/.exec(out[i + heard.length - 1][0])?.[0] ?? '';
      out[i] = [`${f.correct}${tail}`, out[i][1], out[i + heard.length - 1][2]];
      out.splice(i + 1, heard.length - 1);
    }
  }
  return out;
}
