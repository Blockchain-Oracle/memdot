/** Words too common to help a keyword search. Short on purpose: recall matters more than size. */
export const STOPWORDS = new Set(
  "a an and are as at be been but by do does did for from had has have he her his i if in into is it its me my no not of on or our she so that the their them they this to was we were what when where which who why will with you your".split(
    " ",
  ),
);

const WORD = /[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu;
const MAX_TERM_CHARS = 64;

/**
 * A light English stemmer, so "meetings" finds "meeting". Exactness doesn't matter, only that the
 * same word always lands on the same term, on the server and on the device.
 */
function stem(word: string): string {
  if (word.length <= 3 || !/^[a-z]+$/.test(word)) return word;
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.endsWith("sses")) return word.slice(0, -2);
  if (word.endsWith("s") && !/(ss|us|is)$/.test(word)) return stem(word.slice(0, -1));
  for (const suffix of ["ing", "ed"]) {
    if (!word.endsWith(suffix)) continue;
    const base = word.slice(0, -suffix.length);
    if (base.length < 3 || !/[aeiouy]/.test(base)) return word;
    return /([b-df-hj-np-tv-z])\1$/.test(base) && !/(ll|ss|zz)$/.test(base)
      ? base.slice(0, -1)
      : base;
  }
  return word;
}

/** The terms a text is indexed and searched under. */
export function tokenize(text: string): string[] {
  const words = text.normalize("NFKC").toLowerCase().match(WORD) ?? [];
  return words.flatMap((word) => {
    const cleaned = word.replace(/['_-]+$/, "").slice(0, MAX_TERM_CHARS);
    return cleaned && !STOPWORDS.has(cleaned) ? [stem(cleaned)] : [];
  });
}

/** Each distinct term with how many times it appears. */
export function termFrequencies(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const term of tokenize(text)) counts.set(term, (counts.get(term) ?? 0) + 1);
  return counts;
}
