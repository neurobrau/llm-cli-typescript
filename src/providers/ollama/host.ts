/**
 * Pure OLLAMA_HOST normalization. Accepts `host`, `host:port`, `[v6]`,
 * `[v6]:port` or an http(s) URL with an optional path prefix. Errors never
 * echo the raw value: it may contain credentials.
 */
import { isIPv6 } from "node:net";

import { SettingsError } from "../../domain/errors.js";

export const HOST_ENV_VAR = "OLLAMA_HOST";
export const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_PORT = "11434";
const LOCAL_HOST = "127.0.0.1";

const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//;
const HOSTNAME = /^[A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?$/;
const PATH_CHARS = /^[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/;

function invalid(reason: string): SettingsError {
  return new SettingsError(`Invalid ${HOST_ENV_VAR}: ${reason}.`);
}

/** Base URL (no trailing slash) for an OLLAMA_HOST value; absent or blank gives the local default. */
export function resolveBaseUrl(raw: string | undefined): string {
  const value = raw?.trim() ?? "";
  if (value === "") {
    return DEFAULT_BASE_URL;
  }
  const schemeMatch = SCHEME.exec(value);
  const scheme = (schemeMatch?.[1] ?? "http").toLowerCase();
  if (scheme !== "http" && scheme !== "https") {
    throw invalid("only http and https are supported");
  }
  const rest = schemeMatch === null ? value : value.slice(schemeMatch[0].length);
  if (rest.includes("?") || rest.includes("#")) {
    throw invalid("a query or fragment is not allowed");
  }
  const slash = rest.indexOf("/");
  const authority = slash < 0 ? rest : rest.slice(0, slash);
  const path = slash < 0 ? "" : rest.slice(slash).replace(/\/+$/, "");
  if (authority.includes("@")) {
    throw invalid("credentials in the address are not supported");
  }
  if (!PATH_CHARS.test(path)) {
    throw invalid("the path contains unsupported characters");
  }
  const { host, port } = splitAuthority(authority);
  const connectHost = host === "0.0.0.0" || host === "::" ? LOCAL_HOST : host;
  const shown = connectHost.includes(":") ? `[${connectHost}]` : connectHost;
  return `${scheme}://${shown}:${port}${path}`;
}

function splitAuthority(authority: string): { readonly host: string; readonly port: string } {
  let host: string;
  let portText: string | undefined;
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close < 0) {
      throw invalid("malformed IPv6 address");
    }
    host = authority.slice(1, close);
    const after = authority.slice(close + 1);
    if (after !== "" && !after.startsWith(":")) {
      throw invalid("malformed address");
    }
    portText = after === "" ? undefined : after.slice(1);
    if (!isIPv6(host)) {
      throw invalid("malformed IPv6 address");
    }
  } else {
    const parts = authority.split(":");
    if (parts.length > 2) {
      throw invalid("an IPv6 address must be written in brackets");
    }
    host = parts[0] ?? "";
    portText = parts[1];
    if (!HOSTNAME.test(host)) {
      throw invalid("malformed host name");
    }
  }
  return { host, port: portText === undefined ? DEFAULT_PORT : validPort(portText) };
}

function validPort(text: string): string {
  const port = /^[0-9]{1,5}$/.test(text) ? Number(text) : 0;
  if (port < 1 || port > 65_535) {
    throw invalid("the port must be a number from 1 to 65535");
  }
  return String(port);
}
