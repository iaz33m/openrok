import { chmodSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, "../dist/index.js");

if (existsSync(bin)) {
  chmodSync(bin, 0o755);
}
