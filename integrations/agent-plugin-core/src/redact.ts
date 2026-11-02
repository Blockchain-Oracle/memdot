import { wordlist } from "@scure/bip39/wordlists/english.js";

const MARK = "[REDACTED]";
const SEED_WORDS = 12;
const BIP39 = new Set(wordlist);

/** [pattern, whether group 1 is kept]. Checked in order, so a named secret goes before a shape. */
const PATTERNS: [RegExp, boolean][] = [
  [/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, false],
  [/\bAGE-SECRET-KEY-1[0-9A-Z]{20,}\b/g, false],
  // Authorization headers, then anything named like a secret, with or without quotes.
  [
    /((?:authorization|proxy-authorization)["']?\s*[:=]\s*["']?(?:bearer|token|basic)\s+)[^\s"']+/gi,
    true,
  ],
  [/(\bbearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, true],
  [
    /("(?:[\w-]*(?:api[_-]?key|password|passwd|secret|token|credential|mnemonic|seed[_-]?phrase|recovery[_-]?code|private[_-]?key)[\w-]*|authorization)"\s*:\s*")(?:\\.|[^"\\])*/gi,
    true,
  ],
  [
    /((?:^|[\s;,&?{(])["']?[\w.-]*(?:api[_-]?key|password|passwd|secret|token|credential|mnemonic|seed[_-]?phrase|recovery[_-]?code|private[_-]?key)[\w.-]*["']?\s*[:=]\s*["']?)[^\s"'&;,)}]+/gim,
    true,
  ],
  // Passwords inside connection strings.
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s:/@]+(?=@)/gi, true],
  // Known key shapes.
  [/\bmd_[A-Za-z0-9_-]{16,}/g, false],
  [/\b(?:sk|rk|pk)[-_](?:live|test|proj|ant|or)?[-_]?[A-Za-z0-9_-]{16,}/g, false],
  [/\b(?:ASIA|AKIA)[A-Z0-9]{12,}\b/g, false],
  [/\bAIza[A-Za-z0-9_-]{30,}/g, false],
  [/\b(?:gh[pousr]_|github_pat_|glpat-|npm_|xox[baprs]-)[A-Za-z0-9_-]{16,}/g, false],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, false],
  // A 32-byte hex value is how a Substrate or EVM private key is written. Chain hashes look the
  // same, and losing one from a note costs far less than storing a key.
  [/\b0x[0-9a-fA-F]{64}\b/g, false],
];

/** Twelve or more wallet words in a row: a seed phrase or a MemDot recovery code. */
function redactSeedPhrases(text: string): string {
  return text.replace(/\b[a-zA-Z]{3,8}(?:[\s,-]+[a-zA-Z]{3,8}){11,}\b/g, (run) => {
    const parts = run.split(/([\s,-]+)/);
    const words = parts.filter((_, i) => i % 2 === 0);
    let out = "";
    let at = 0;
    while (at < words.length) {
      let end = at;
      while (end < words.length && BIP39.has((words[end] as string).toLowerCase())) end += 1;
      if (end - at >= SEED_WORDS) {
        out += `${out ? " " : ""}${MARK}`;
        at = end;
      } else {
        const stop = Math.max(end, at + 1);
        for (let i = at; i < stop; i += 1) {
          out += `${i > 0 ? (parts[i * 2 - 1] as string) : ""}${words[i] as string}`;
        }
        at = stop;
      }
    }
    return out;
  });
}

/** Removes anything that looks like a secret. Everything saved or sent passes through here. */
export function redact(text: string): string {
  let out = text;
  for (const [pattern, keepsPrefix] of PATTERNS) {
    out = out.replace(pattern, keepsPrefix ? `$1${MARK}` : MARK);
  }
  return redactSeedPhrases(out);
}

/** Redacted, trimmed and cut to a size. The cut comes last, so it can't split a secret in two. */
export function bounded(value: unknown, max: number): string {
  const raw = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  const clean = redact(raw).trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max)}\n...[${clean.length - max} more characters]`;
}
