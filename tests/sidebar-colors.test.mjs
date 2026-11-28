import assert from "node:assert/strict";
import test from "node:test";
import { withSidebarColors } from "../src/sidebar-colors.mjs";

const LOCAL = "10000000-0000-4000-8000-000000000000";
const CORAL = "20000000-0000-4000-8000-000000000000";
const CYAN = "30000000-0000-4000-8000-000000000000";
const NEW = "00000000-0000-4000-8000-000000000000";

test("colors exact device rows and leaves native state backgrounds available", () => {
  const original = ".sidebar { color: white; }\n";
  const css = withSidebarColors(original, LOCAL, [CYAN, CORAL, LOCAL, CORAL, 'bad"]{}']);
  assert.ok(css.startsWith(original));
  assert.match(css, new RegExp(`${LOCAL}:[^\\n]+${LOCAL}:`));
  assert.ok(css.indexOf(LOCAL) < css.indexOf(CORAL));
  assert.ok(css.indexOf(CORAL) < css.indexOf(CYAN));
  const tints = [...css.matchAll(/--t3-infobar-device-tint: ([^;]+);/g)].map(match => match[1]);
  assert.deepEqual(tints, [
    "light-dark(rgb(101 114 134 / 0.13), rgb(189 195 210 / 0.14))",
    "light-dark(rgb(252 106 92 / 0.36), rgb(255 143 124 / 0.35))",
    "light-dark(rgb(42 192 201 / 0.34), rgb(84 221 229 / 0.31))",
  ]);
  assert.match(css, /background-image: linear-gradient/);
  assert.doesNotMatch(css, /background-color|bad/);
  assert.equal(withSidebarColors(css, LOCAL, [CORAL, CYAN]), css);
});

test("retains assigned colors when new environments appear and old ones are hidden", () => {
  const first = withSidebarColors("", LOCAL, [CORAL, CYAN]);
  const previous = first.replace("rgb(252 106 92 / 0.36), rgb(255 143 124 / 0.35)",
    "rgb(65 117 207 / 0.13), rgb(103 154 245 / 0.16)");
  const extraCss = "\n.other { opacity: 1; }\n";
  const updated = withSidebarColors(previous + extraCss, LOCAL, [NEW]);
  assert.ok(updated.indexOf(CORAL) < updated.indexOf(CYAN));
  assert.ok(updated.indexOf(CYAN) < updated.indexOf(NEW));
  assert.equal(updated, withSidebarColors(first + extraCss, LOCAL, [NEW]));
  assert.ok(updated.endsWith(extraCss));
  assert.throws(() => withSidebarColors(first, 'bad"]{}', [NEW]), /无法识别/);
  assert.throws(() => withSidebarColors("/* t3-infobar-device-colors:start */", LOCAL, [NEW]), /不完整/);
});
