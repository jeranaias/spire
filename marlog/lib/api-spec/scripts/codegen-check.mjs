#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiSpecDir = path.resolve(__dirname, "..");
const root = path.resolve(apiSpecDir, "..", "..");

const targets = [
  path.resolve(root, "lib", "api-client-react", "src", "generated"),
  path.resolve(root, "lib", "api-zod", "src", "generated"),
];

function listFilesRecursive(dir) {
  const out = new Map();
  if (!existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current)) {
      const full = path.join(current, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        stack.push(full);
      } else {
        const rel = path.relative(dir, full);
        out.set(rel, readFileSync(full));
      }
    }
  }
  return out;
}

function diffDirs(label, before, after) {
  const beforeFiles = listFilesRecursive(before);
  const afterFiles = listFilesRecursive(after);
  const changed = [];
  const added = [];
  const removed = [];
  for (const [rel, beforeBuf] of beforeFiles) {
    const afterBuf = afterFiles.get(rel);
    if (afterBuf === undefined) {
      removed.push(rel);
    } else if (!beforeBuf.equals(afterBuf)) {
      changed.push(rel);
    }
  }
  for (const rel of afterFiles.keys()) {
    if (!beforeFiles.has(rel)) added.push(rel);
  }
  if (changed.length === 0 && added.length === 0 && removed.length === 0) {
    return null;
  }
  return { label, changed, added, removed };
}

const snapshotRoot = mkdtempSync(path.join(tmpdir(), "api-codegen-check-"));
const snapshots = targets.map((target, index) => {
  const snap = path.join(snapshotRoot, String(index));
  if (existsSync(target)) {
    cpSync(target, snap, { recursive: true });
  }
  return { target, snap };
});

let exitCode = 0;
const restoreErrors = [];

let orvalFailed = false;
try {
  try {
    execFileSync(
      "pnpm",
      ["exec", "orval", "--config", "./orval.config.ts"],
      { cwd: apiSpecDir, stdio: "inherit" },
    );
  } catch (err) {
    console.error("\n[codegen:check] orval failed to run.");
    orvalFailed = true;
    exitCode = 1;
  }

  const diffs = [];
  if (!orvalFailed) {
    for (const { target, snap } of snapshots) {
      const label = path.relative(root, target);
      const result = diffDirs(label, snap, target);
      if (result) diffs.push(result);
    }
  }

  if (!orvalFailed && diffs.length > 0) {
    exitCode = 1;
    console.error("");
    console.error(
      "[codegen:check] Generated API client files are out of sync with lib/api-spec/openapi.yaml.",
    );
    for (const d of diffs) {
      console.error(`  - ${d.label}`);
      for (const f of d.changed) console.error(`      changed: ${f}`);
      for (const f of d.added) console.error(`      added:   ${f}`);
      for (const f of d.removed) console.error(`      removed: ${f}`);
    }
    console.error("");
    console.error(
      "[codegen:check] Run 'pnpm --filter @workspace/api-spec run codegen' and commit the updated files.",
    );
  } else if (!orvalFailed) {
    console.log(
      "[codegen:check] Generated API client files are up to date with openapi.yaml.",
    );
  }
} finally {
  for (const { target, snap } of snapshots) {
    try {
      rmSync(target, { recursive: true, force: true });
      if (existsSync(snap)) {
        cpSync(snap, target, { recursive: true });
      }
    } catch (err) {
      restoreErrors.push({ target, err });
    }
  }
  rmSync(snapshotRoot, { recursive: true, force: true });
}

if (restoreErrors.length > 0) {
  console.error("[codegen:check] Failed to restore snapshot for some files:");
  for (const { target, err } of restoreErrors) {
    console.error(`  - ${target}: ${err.message}`);
  }
  process.exit(1);
}

process.exit(exitCode);
