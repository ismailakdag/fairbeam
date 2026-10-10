// Fast, dependency-free contract checks; these do not claim a native package or GUI pass.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const json = (path) => JSON.parse(read(path));
const base = json("src-tauri/tauri.conf.json");
const linux = json("src-tauri/tauri.linux.conf.json");
const pkg = json("package.json");
assert.deepEqual(linux.bundle.targets, ["deb"], "Linux overrides macOS package targets");
assert.equal(linux.bundle.createUpdaterArtifacts, false, "experimental packages need no signing key");
assert.equal(linux.bundle.category, "Education");
assert.deepEqual(linux.bundle.linux.deb.depends, ["libwebkit2gtk-4.1-0", "libgtk-3-0", "libxdo3"]);
for (const icon of linux.bundle.icon) {
  assert.ok(icon.endsWith(".png"));
  assert.ok(readFileSync(new URL(`../src-tauri/${icon}`, import.meta.url)).length > 0);
}
assert.equal(linux.identifier, undefined, "keep the existing workspace identity");
assert.equal(linux.version, undefined, "inherit the app version");
assert.equal(linux.bundle.resources, undefined, "inherit the complete app resource map");
assert.ok(base.bundle.resources["../runtime/pins.json"]);
assert.equal(pkg.scripts["desktop:build:linux"], "tauri build --config src-tauri/tauri.linux.conf.json");
const workflow = read(".github/workflows/linux-desktop.yml");
assert.match(workflow, /runs-on: ubuntu-24\.04/);
assert.match(workflow, /workflow_dispatch:/);
assert.doesNotMatch(workflow, /^\s+(push|pull_request|schedule):/m);
assert.match(workflow, /contents: read/);
assert.match(workflow, /npm run desktop:build:linux -- -- --locked/);
assert.doesNotMatch(workflow, /publish-release|TAURI_SIGNING|gh release|contents: write/);
console.log("check-linux-desktop: experimental Debian config and manual-only build contract pass (no native build)");
