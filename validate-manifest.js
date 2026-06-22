#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

const manifest = fs.readFileSync("herdr-plugin.toml", "utf8");

function requireMatch(pattern, message) {
  if (!pattern.test(manifest)) {
    console.error(`manifest validation failed: ${message}`);
    process.exit(1);
  }
}

requireMatch(/^id\s*=\s*"tab-mover"\s*$/m, "missing plugin id");
requireMatch(/^name\s*=\s*"Tab Mover"\s*$/m, "missing name");
requireMatch(/^version\s*=\s*"\d+\.\d+\.\d+"\s*$/m, "missing semver version");
requireMatch(/^min_herdr_version\s*=\s*"0\.7\.0"\s*$/m, "missing minimum Herdr version");
requireMatch(/^platforms\s*=\s*\["linux",\s*"macos"\]\s*$/m, "missing supported platforms");
requireMatch(/^\[\[actions\]\]$/m, "missing action declaration");
requireMatch(/^id\s*=\s*"move-tab"\s*$/m, "missing move-tab action");
requireMatch(/^contexts\s*=\s*\["tab"\]\s*$/m, "move-tab action must be tab-scoped");
requireMatch(/^command\s*=\s*\["node",\s*"capture-and-open\.js"\]\s*$/m, "missing capture action command");
requireMatch(/^\[\[panes\]\]$/m, "missing pane declaration");
requireMatch(/^id\s*=\s*"picker"\s*$/m, "missing picker pane");
requireMatch(/^placement\s*=\s*"overlay"\s*$/m, "picker pane must be overlay");
requireMatch(/^command\s*=\s*\["node",\s*"pick-and-move\.js"\]\s*$/m, "missing picker command");
