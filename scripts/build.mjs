import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const outputDirectory = join(root, "dist");
const output = join(outputDirectory, `institutional-pdf-bridge-${manifest.version}.xpi`);
const files = [
  "bootstrap.js",
  "icon.svg",
  "manifest.json",
  "preferences.css",
  "preferences.js",
  "preferences.xhtml",
  "prefs.js",
  "proxy-child.sys.mjs",
  "proxy-parent.sys.mjs",
  "LICENSE"
];

mkdirSync(outputDirectory, { recursive: true });
rmSync(output, { force: true });
execFileSync("zip", ["-X", "-9", output, ...files], { cwd: root, stdio: "inherit" });
console.log(output);
