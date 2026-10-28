/** Safe-text helpers: text from the API or SDK is capped, flattened and scrubbed before display. */

const MAX_DETAIL_LENGTH = 300;
const KEY_LIKE = /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{6,}/g;
const REDACTED = "[redacted]";

/** Removes terminal escape sequences and control characters; whitespace controls become spaces. */
function stripControls(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 0x1b) {
      const next = text.charAt(i + 1);
      if (next === "[") {
        // CSI: parameters and intermediates, then a final byte 0x40-0x7e.
        i += 2;
        while (i < text.length && !(text.charCodeAt(i) >= 0x40 && text.charCodeAt(i) <= 0x7e)) {
          i += 1;
        }
      } else if (next === "]") {
        // OSC: until BEL or ST (ESC \).
        i += 2;
        while (i < text.length && text.charCodeAt(i) !== 0x07 && !(text.charCodeAt(i) === 0x1b && text.charAt(i + 1) === "\\")) {
          i += 1;
        }
        if (text.charCodeAt(i) === 0x1b) {
          i += 1;
        }
      } else {
        i += 1; // two-byte escape
      }
    } else if (code === 0x09 || code === 0x0a || code === 0x0d) {
      out += " ";
    } else if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) {
      // dropped
    } else {
      out += text.charAt(i);
    }
  }
  return out;
}

function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret !== "") {
      out = out.split(secret).join(REDACTED);
    }
  }
  return out.replace(KEY_LIKE, REDACTED);
}

/**
 * One-line, length-capped, credential-free text. Control characters are
 * stripped first so they cannot split a key; then configured secrets are
 * redacted exactly and key-like strings by pattern.
 */
export function safeText(text: string, secrets: readonly string[] = []): string {
  const cleaned = redact(stripControls(text), secrets);
  const oneLine = cleaned.split(/\s+/).filter((word) => word !== "").join(" ");
  const chars = Array.from(oneLine);
  return chars.length > MAX_DETAIL_LENGTH ? `${chars.slice(0, MAX_DETAIL_LENGTH).join("")}…` : oneLine;
}
