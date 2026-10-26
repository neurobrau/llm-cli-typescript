import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_FILE = "package.json";
const MAX_PARENT_LOOKUPS = 8;

/**
 * Reads the version from the nearest package.json above this module.
 *
 * The lookup is relative to the module location, never process.cwd(). It works
 * for dist/ and for the separately compiled test tree.
 */
export function readPackageVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < MAX_PARENT_LOOKUPS; i += 1) {
    let text: string | undefined;
    try {
      text = readFileSync(join(dir, PACKAGE_FILE), "utf8");
    } catch (error: unknown) {
      if (!isNotFound(error)) {
        throw error;
      }
    }
    if (text !== undefined) {
      return versionFromJson(text);
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error("package.json not found");
}

function versionFromJson(text: string): string {
  const data: unknown = JSON.parse(text);
  if (typeof data === "object" && data !== null && "version" in data) {
    const { version } = data;
    if (typeof version === "string" && version !== "") {
      return version;
    }
  }
  throw new Error("package.json has no version string");
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
