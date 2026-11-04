/**
 * Terminal key decoding (docs/tui-spec.md section 7). Pure and incremental:
 * bytes may arrive in any chunking, including inside a UTF-8 character or an
 * escape sequence. Unsupported sequences are consumed completely, so no raw
 * escape bytes ever reach the draft; the parser buffer is bounded.
 *
 * A lone ESC cannot be told from the start of a sequence; the caller asks
 * `pendingEscape` after each chunk and calls `dropEscape()` once the short
 * wait (about 25 ms) passed without more input.
 */

export type NamedKey =
  | "enter"
  | "backspace"
  | "delete"
  | "left"
  | "right"
  | "up"
  | "down"
  | "home"
  | "end"
  | "pageup"
  | "pagedown"
  | "f1"
  | "f2"
  | "f3"
  | "f4"
  | "f5"
  | "f6"
  | "ctrl-a"
  | "ctrl-c"
  | "ctrl-d"
  | "ctrl-e"
  | "ctrl-u";

export type Key =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "key"; readonly name: NamedKey }
  | { readonly kind: "ignored" };

/** Longest CSI sequence kept while waiting for its final byte. */
const MAX_SEQUENCE = 32;

const CTRL: Readonly<Record<number, NamedKey>> = {
  0x01: "ctrl-a",
  0x03: "ctrl-c",
  0x04: "ctrl-d",
  0x05: "ctrl-e",
  0x15: "ctrl-u",
  0x7f: "backspace",
  0x08: "backspace",
};

const LETTERS: Readonly<Record<string, NamedKey>> = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" };
const SS3_FUNCTION: Readonly<Record<string, NamedKey>> = { P: "f1", Q: "f2", R: "f3", S: "f4" };
const TILDE: Readonly<Record<string, NamedKey>> = {
  "1": "home",
  "7": "home",
  "4": "end",
  "8": "end",
  "3": "delete",
  "5": "pageup",
  "6": "pagedown",
  "11": "f1",
  "12": "f2",
  "13": "f3",
  "14": "f4",
  "15": "f5",
  "17": "f6",
};

type State = "ground" | "escape" | "csi" | "ss3";

const isPrintable = (code: number): boolean => code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f);

export class KeyDecoder {
  private readonly utf8 = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
  private state: State = "ground";
  private sequence = "";
  private overflowed = false;
  private afterCarriageReturn = false;

  /** True while the last input was a bare ESC that might still start a sequence. */
  get pendingEscape(): boolean {
    return this.state === "escape";
  }

  /** The wait for the rest of a sequence is over: a lone ESC is ignored. */
  dropEscape(): void {
    if (this.state === "escape") this.state = "ground";
  }

  /** Decodes the next chunk; consecutive printable characters form one `text` key. */
  feed(chunk: Uint8Array | string): Key[] {
    const text = typeof chunk === "string" ? chunk : this.utf8.decode(chunk, { stream: true });
    const keys: Key[] = [];
    let run = "";
    const flush = (): void => {
      if (run !== "") keys.push({ kind: "text", text: run });
      run = "";
    };
    for (const char of text) {
      const code = char.codePointAt(0) ?? 0;
      switch (this.state) {
        case "ground": {
          const wasCr = this.afterCarriageReturn;
          this.afterCarriageReturn = false;
          if (code === 0x1b) {
            flush();
            this.state = "escape";
          } else if (code === 0x0d || code === 0x0a) {
            if (code === 0x0a && wasCr) break; // the LF of a CRLF
            flush();
            this.afterCarriageReturn = code === 0x0d;
            keys.push({ kind: "key", name: "enter" });
          } else if (CTRL[code] !== undefined) {
            flush();
            keys.push({ kind: "key", name: CTRL[code] });
          } else if (isPrintable(code)) {
            run += char;
          }
          // Every other control (TAB, C1, NUL, ...) is dropped.
          break;
        }
        case "escape":
          flush();
          if (char === "[") {
            this.state = "csi";
            this.sequence = "";
            this.overflowed = false;
          } else if (char === "O") {
            this.state = "ss3";
          } else if (code === 0x1b) {
            // ESC ESC: the first is lone; the second may start a sequence.
          } else {
            this.state = "ground"; // Alt+key: ignored whole
          }
          break;
        case "ss3": {
          this.state = "ground";
          const name = LETTERS[char] ?? SS3_FUNCTION[char];
          keys.push(name === undefined ? { kind: "ignored" } : { kind: "key", name });
          break;
        }
        case "csi": {
          if (code >= 0x40 && code <= 0x7e) {
            this.state = "ground";
            keys.push(this.overflowed ? { kind: "ignored" } : this.finishCsi(char));
            this.sequence = "";
          } else if (code >= 0x20 && code <= 0x3f) {
            // An over-long sequence is swallowed up to its final byte, not leaked as text.
            if (this.sequence.length < MAX_SEQUENCE) this.sequence += char;
            else this.overflowed = true;
          } else {
            // A control byte inside the sequence, or an over-long one: drop it and what follows is new input.
            this.state = "ground";
            this.sequence = "";
            keys.push({ kind: "ignored" });
          }
          break;
        }
      }
    }
    flush();
    return keys;
  }

  private finishCsi(final: string): Key {
    const parameters = this.sequence.split(";");
    const first = parameters[0] ?? "";
    let name: NamedKey | undefined;
    if (final === "~") {
      name = TILDE[first];
    } else if (final === "P" || final === "Q" || final === "R" || final === "S") {
      name = first === "1" || first === "" ? SS3_FUNCTION[final] : undefined;
    } else {
      name = LETTERS[final];
    }
    return name === undefined ? { kind: "ignored" } : { kind: "key", name };
  }
}
