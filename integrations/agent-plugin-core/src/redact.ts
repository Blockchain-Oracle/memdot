import { wordlist } from "@scure/bip39/wordlists/english.js";

const MARK = "[REDACTED]";
const SEED_WORDS = 12;
const BIP39 = new Set(wordlist);

/** What a setting holding a secret tends to be called. `pass` and `pwd` only as whole words of it. */
const SECRET_NAME = String.raw`[\w.-]*(?:api[_-]?key|auth[_-]?key|password|passwd|passphrase|secret|token|credential|mnemonic|seed[_-]?phrase|recovery[_-]?code|private[_-]?key)[\w.-]*|(?:[\w.-]*[_.-])?(?:pass|pwd)`;
const SECRET_FIELD = new RegExp(`^(?:${SECRET_NAME}|authorization|cookie)$`, "i");
/** A value, whole: to the closing quote when it has one, otherwise to the next space. */
const VALUE = String.raw`(?:"[^"\n]*"|'[^'\n]*'|\S+)`;

/** [pattern, whether group 1 is kept]. Checked in order, so a named secret goes before a shape. */
const PATTERNS: [RegExp, boolean][] = [
  // An end line can be cut off, so a block with none runs to the end of the text.
  [
    /-----BEGIN [^-]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
    false,
  ],
  [/(private[_-]?key["']?\s*:\s*[|>][-+]?[ \t]*\n)(?:[ \t]+[^\n]*(?:\n|$))+/gi, true],
  [/\bAGE-SECRET-KEY-1[0-9A-Z]{20,}\b/g, false],
  // Whole header values: a scheme can be anything.
  [/((?:proxy-)?authorization["']?\s*[:=]\s*["']?)[^\n"']+/gi, true],
  [/((?:set-)?cookie["']?\s*[:=]\s*["']?)[^\n"']+/gi, true],
  [/(\bbearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, true],
  // Anything named like a secret: as a JSON field, an assignment or a command-line flag.
  [new RegExp(`("(?:${SECRET_NAME})"\\s*:\\s*")(?:\\\\.|[^"\\\\])*`, "gi"), true],
  [
    new RegExp(`((?:^|[\\s;,&?{(:/])["']?(?:${SECRET_NAME})["']?\\s*[:=]\\s*)${VALUE}`, "gim"),
    true,
  ],
  [
    new RegExp(
      `((?:^|\\s)--?[\\w-]*(?:password|passwd|pass|secret|token|api-?key|auth)[\\w-]*[ =])(?!-)${VALUE}`,
      "gim",
    ),
    true,
  ],
  [/(\bmysql(?:dump|admin)?\b[^\n]*?\s-p)(?!\s)\S+/g, true],
  [/(\bcurl\b[^\n]*?\s(?:-u|--user)[ =]?[^\s:]*:)\S+/g, true],
  // Passwords and keys in addresses. The password can hold a slash or an @, so it runs to the last @.
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:)\S+(?=@[^\s@]+)/gi, true],
  [/(\bhttps?:\/\/)[^\s:/@]{16,}(?=@)/gi, true],
  [/\bhttps:\/\/hooks\.slack\.com\/services\/\S+/g, false],
  [/\bhttps:\/\/discord(?:app)?\.com\/api\/webhooks\/\S+/g, false],
  [/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, false],
  // Known key shapes.
  [/\bmd_[A-Za-z0-9_-]{16,}/g, false],
  [/\b(?:sk|rk|pk)[-_](?:live|test|proj|ant|or)?[-_]?[A-Za-z0-9_-]{16,}/g, false],
  [/\b(?:ASIA|AKIA)[A-Z0-9]{12,}\b/g, false],
  [/\bAIza[A-Za-z0-9_-]{30,}/g, false],
  [/\bya29\.[A-Za-z0-9_-]{20,}/g, false],
  [/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, false],
  [
    /\b(?:gh[pousr]_|github_pat_|glpat-|npm_|xox[baprs]-|gsk_|hf_|xai-|whsec_)[A-Za-z0-9_-]{16,}/g,
    false,
  ],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, false],
  // A 32-byte hex value is how a Substrate or EVM private key is written. Chain hashes look the
  // same, and losing one from a note costs far less than storing a key.
  [/\b(?:0x)?[0-9a-fA-F]{64}\b/g, false],
];

const WORD = /[a-zA-Z]{3,8}/g;

/** Twelve or more wallet words in a row, whatever is between them: a seed phrase or a recovery code. */
function redactSeedPhrases(text: string): string {
  return text.replace(/[a-zA-Z]{3,8}(?:[^a-zA-Z]{1,8}[a-zA-Z]{3,8}){11,}/g, (run) => {
    const words = [...run.matchAll(WORD)];
    let out = "";
    let copied = 0;
    let at = 0;
    while (at < words.length) {
      let end = at;
      while (end < words.length && BIP39.has((words[end] as RegExpExecArray)[0].toLowerCase())) {
        end += 1;
      }
      if (end - at >= SEED_WORDS) {
        const first = words[at] as RegExpExecArray;
        const last = words[end - 1] as RegExpExecArray;
        out += `${run.slice(copied, first.index)}${MARK}`;
        copied = last.index + last[0].length;
      }
      at = Math.max(end, at + 1);
    }
    return out + run.slice(copied);
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

/**
 * A value made safe piece by piece. Turning it into JSON first would escape the line breaks and
 * quotes the patterns rely on, so a secret inside an object would slip past them.
 */
export function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [
        key,
        SECRET_FIELD.test(key) && inner !== null && typeof inner !== "object"
          ? MARK
          : redactValue(inner),
      ]),
    );
  }
  return value;
}

/** Redacted, trimmed and cut to a size. The cut comes last, so it can't split a secret in two. */
export function bounded(value: unknown, max: number): string {
  const clean =
    typeof value === "string"
      ? redact(value).trim()
      : (JSON.stringify(redactValue(value)) ?? "").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max)}\n...[${clean.length - max} more characters]`;
}
