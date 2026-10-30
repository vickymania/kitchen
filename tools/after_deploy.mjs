// The steps after a successful live deploy (tools/deploy.mjs). Neither one can
// undo or fail the deploy: a failure prints a loud warning and that is all.
//
//   pushPrivate    `git push origin <branch>`: the private repo on GitHub is
//                  the backup, so it is pushed on every release. Skipped when
//                  there is no `origin` remote (a fresh clone, the public copy).
//   publishPublic  tools/publish_public.mjs --push: the scrubbed public copy,
//                  only when that tool and the clone of the public repo exist.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function git(root, args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return { ok: r.status === 0, out: String(r.stdout ?? "").trim(), err: String(r.stderr ?? "").trim() };
}

export function warn(title, detail = "") {
  const bar = "!".repeat(72);
  console.log(`\n${bar}\n!! WARNING: ${title}\n!! The deploy itself is live and stays live.${detail ? `\n${detail.split("\n").map((l) => `!! ${l}`).join("\n")}` : ""}\n${bar}\n`);
}

/** { done, skipped?, branch? }: push the current branch to origin, never throws. */
export function pushPrivate(root) {
  try {
    if (!git(root, ["remote"]).out.split(/\s+/).includes("origin")) {
      console.log("Private backup: no `origin` remote, push skipped.");
      return { done: false, skipped: "no origin remote" };
    }
    const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).out;
    if (!branch || branch === "HEAD") {
      warn("private backup not pushed: detached HEAD");
      return { done: false, skipped: "detached HEAD" };
    }
    console.log(`> git push origin ${branch}`);
    const r = git(root, ["push", "origin", branch]);
    if (!r.ok) {
      warn(`git push origin ${branch} failed`, r.err);
      return { done: false, branch };
    }
    console.log(`Private backup: ${branch} pushed to origin.`);
    return { done: true, branch };
  } catch (e) {
    warn("private backup push crashed", e.message);
    return { done: false };
  }
}

/** { done, skipped? }: run the public publish with --push when it can, never throws. */
export function publishPublic(root, { clone = null } = {}) {
  try {
    const tool = path.join(root, "tools", "publish_public.mjs");
    if (!fs.existsSync(tool)) return { done: false, skipped: "no publish tool" };
    const target = clone ?? process.env.KITCHEN_PUBLIC_CLONE ?? defaultClone(root);
    if (!target || !fs.existsSync(path.join(target, ".git"))) {
      console.log(`Public copy: no clone of the public repo at ${target}, publish skipped.`);
      return { done: false, skipped: "no public clone" };
    }
    console.log(`> node tools/publish_public.mjs --push --clone "${target}"`);
    const r = spawnSync(process.execPath, [tool, "--push", "--clone", target], { cwd: root, stdio: "inherit" });
    if (r.status !== 0) {
      warn("the public copy was NOT published (leak scan, export tests or push failed; see above)");
      return { done: false };
    }
    return { done: true };
  } catch (e) {
    warn("public publish crashed", e.message);
    return { done: false };
  }
}

/** ../kitchen-public next to the main checkout (a worktree resolves to its main checkout). */
function defaultClone(root) {
  const r = git(root, ["rev-parse", "--git-common-dir"]);
  if (!r.ok) return null;
  return path.join(path.dirname(path.dirname(path.resolve(root, r.out))), "kitchen-public");
}
