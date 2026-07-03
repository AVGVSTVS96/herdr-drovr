#!/usr/bin/env node
// Structural sanity check for herdr-plugin.toml, dependency-free. Verifies the
// header keys exist, each action/pane section is complete, and every declared
// command entrypoint is a real file — without pinning exact values that would
// break on a legitimate version bump.

"use strict";
const fs = require("node:fs");

let failed = false;
function check(ok, message) {
  if (!ok) {
    console.error(`manifest validation failed: ${message}`);
    failed = true;
  }
}

const src = fs.readFileSync("herdr-plugin.toml", "utf8");
const sections = src.split(/^(?=\[\[)/m);
const head = sections.shift();

check(/^id\s*=\s*"[^"]+"/m.test(head), "header needs a plugin id");
check(/^name\s*=\s*"[^"]+"/m.test(head), "header needs a name");
check(/^version\s*=\s*"\d+\.\d+\.\d+"/m.test(head), "header needs a semver version");
check(/^min_herdr_version\s*=\s*"\d+\.\d+\.\d+"/m.test(head), "header needs a semver min_herdr_version");
check(/^platforms\s*=\s*\[/m.test(head), "header needs a platforms list");

function checkSection(kind, body, extra) {
  check(/^id\s*=\s*"[^"]+"/m.test(body), `${kind} section needs an id`);
  const cmd = body.match(/^command\s*=\s*\["node",\s*"([^"]+)"\]/m);
  check(cmd, `${kind} section needs a command = ["node", "<script>"]`);
  if (cmd) check(fs.existsSync(cmd[1]), `${kind} command references missing file: ${cmd[1]}`);
  if (extra) extra(body);
}

const actions = sections.filter((s) => s.startsWith("[[actions]]"));
const panes = sections.filter((s) => s.startsWith("[[panes]]"));
check(actions.length >= 1, "needs at least one [[actions]] section");
check(panes.length >= 1, "needs at least one [[panes]] section");
actions.forEach((s) => checkSection("action", s));
panes.forEach((s) =>
  checkSection("pane", s, (body) => {
    check(/^placement\s*=\s*"[^"]+"/m.test(body), "pane section needs a placement");
  })
);

process.exit(failed ? 1 : 0);
