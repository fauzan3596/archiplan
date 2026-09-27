// Deploys the Puter worker and the static site in build/client.
//
// Replaces `puter worker deploy` / `puter site deploy` from @heyputer/cli
// 0.3.x, which (a) writes worker code to ~/Workers/<name>.js even when the
// existing worker runs from a different file, and (b) flattens nested
// folders on site upload, so assets/ ends up in the site root.
//
// Usage: node scripts/deploy.mjs [worker|site]   (default: both)
// Auth:  PUTER_AUTH_TOKEN, or the token saved by `npm run deploy:login`.
// Config (.env): VITE_PUTER_WORKER_URL, PUTER_SITE_SUBDOMAIN.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { loadEnv } from "vite";

const WORKER_FILE = "lib/puter.worker.js";
const SITE_DIR = "build/client";
const DEFAULT_SUBDOMAIN = "archiplan";

const require = createRequire(import.meta.url);
const env = loadEnv("production", process.cwd(), "");

const fail = (message) => {
  console.error(`\n✖ ${message}`);
  process.exit(1);
};

// Same location the Puter CLI (`conf`, projectName "puter-cli") saves to.
const cliConfigPath = () => {
  const home = os.homedir();
  const name = "puter-cli-nodejs";

  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(appData, name, "Config", "config.json");
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Preferences", name, "config.json");
  }
  const configHome = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(configHome, name, "config.json");
};

const getToken = () => {
  if (process.env.PUTER_AUTH_TOKEN) return process.env.PUTER_AUTH_TOKEN;

  try {
    const config = JSON.parse(fs.readFileSync(cliConfigPath(), "utf8"));
    return config.accounts?.[config.active || "default"]?.token ?? null;
  } catch {
    return null;
  }
};

// The SDK's Node XHR shim assumes every response has a Content-Type, which
// signed upload responses omit (same workaround as the Puter CLI).
const patchHeadersContentType = () => {
  const original = Headers.prototype.get;
  Headers.prototype.get = function (name) {
    const value = original.call(this, name);
    return value === null && String(name).toLowerCase() === "content-type"
      ? ""
      : value;
  };
};

const listFiles = (root, base = "") =>
  fs.readdirSync(path.join(root, base), { withFileTypes: true }).flatMap((entry) => {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return listFiles(root, rel);
    return entry.isFile() ? [rel] : [];
  });

const deployWorker = async (puter) => {
  const workerUrl = env.VITE_PUTER_WORKER_URL;
  if (!workerUrl) fail("VITE_PUTER_WORKER_URL is not set in .env");

  const name = new URL(workerUrl).hostname.split(".")[0];
  const code = fs.readFileSync(WORKER_FILE, "utf8");

  let existing = null;
  try {
    existing = await puter.workers.get(name);
  } catch {
    existing = null;
  }

  if (existing) {
    // Update the file the worker actually runs from, in place.
    const filePath = existing.file_path ?? existing.path;
    if (!filePath) fail(`Could not find the source file of worker '${name}'`);

    await puter.fs.write(filePath, code, { overwrite: true });
    console.log(`✔ Worker '${name}' updated (${filePath})`);
  } else {
    const filePath = `~/Workers/${name}.js`;
    await puter.fs.write(filePath, code, {
      overwrite: true,
      createMissingParents: true,
    });
    await puter.workers.create(name, filePath);
    console.log(`✔ Worker '${name}' created`);
  }

  console.log(`  ${workerUrl} (changes can take up to 30s to propagate)`);
};

const deploySite = async (puter) => {
  const subdomain = env.PUTER_SITE_SUBDOMAIN || DEFAULT_SUBDOMAIN;

  if (!fs.existsSync(path.join(SITE_DIR, "index.html"))) {
    fail(`${SITE_DIR}/index.html not found — run \`npm run build\` first`);
  }

  // Each deploy goes to a fresh folder so the live site is never half-updated.
  const folder = await puter.fs.mkdir(
    `~/Sites/${subdomain}/deployment-${Date.now()}`,
    { createMissingParents: true },
  );
  const root = folder.path;
  const files = listFiles(SITE_DIR);

  for (const rel of files) {
    const data = fs.readFileSync(path.join(SITE_DIR, rel));
    await puter.fs.write(`${root}/${rel}`, new File([data], path.basename(rel)), {
      overwrite: true,
      createMissingParents: true,
    });
  }
  console.log(`✔ Uploaded ${files.length} file(s) to ${root}`);

  let existing = null;
  try {
    existing = await puter.hosting.get(subdomain);
  } catch {
    existing = null;
  }

  if (existing) {
    await puter.hosting.update(subdomain, root);
  } else {
    try {
      await puter.hosting.create(subdomain, root);
    } catch (e) {
      fail(
        `Could not create subdomain '${subdomain}' (it may be taken): ${e.message}`,
      );
    }
  }

  console.log(`✔ Site live at https://${subdomain}.puter.site`);
};

const target = process.argv[2];
if (target && !["worker", "site"].includes(target)) {
  fail(`Unknown target '${target}'. Use 'worker', 'site', or nothing for both.`);
}

const token = getToken();
if (!token) fail("Not logged in to Puter. Run `npm run deploy:login` first.");

patchHeadersContentType();
const { init } = require("@heyputer/puter.js/src/init.cjs");
const puter = init(token);

try {
  if (target !== "site") await deployWorker(puter);
  if (target !== "worker") await deploySite(puter);
} catch (e) {
  fail(e?.message ?? JSON.stringify(e));
}
