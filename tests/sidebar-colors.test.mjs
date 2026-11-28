import assert from "node:assert/strict";
import test from "node:test";
import { withSidebarColors } from "../src/sidebar-colors.mjs";

const LOCAL = "10000000-0000-4000-8000-000000000000";
const BLUE = "20000000-0000-4000-8000-000000000000";
const PURPLE = "30000000-0000-4000-8000-000000000000";
const NEW = "00000000-0000-4000-8000-000000000000";

test("colors exact device rows and leaves native state backgrounds available", () => {
  const original = ".sidebar { color: white; }\n";
  const css = withSidebarColors(original, LOCAL, [PURPLE, BLUE, LOCAL, BLUE, 'bad"]{}']);
  assert.ok(css.startsWith(original));
  assert.match(css, new RegExp(`${LOCAL}:[^\\n]+${LOCAL}:`));
  assert.ok(css.indexOf(BLUE) < css.indexOf(PURPLE));
  assert.match(css, /light-dark\(rgb\(65 117 207 \/ 0\.13\), rgb\(103 154 245 \/ 0\.16\)\)/);
  assert.match(css, /background-image: linear-gradient/);
  assert.doesNotMatch(css, /background-color|bad/);
  assert.equal(withSidebarColors(css, LOCAL, [BLUE, PURPLE]), css);
});

test("retains assigned colors when new environments appear and old ones are hidden", () => {
  const first = withSidebarColors("", LOCAL, [BLUE, PURPLE]);
  const extraCss = "\n.other { opacity: 1; }\n";
  const updated = withSidebarColors(first + extraCss, LOCAL, [NEW]);
  assert.ok(updated.indexOf(BLUE) < updated.indexOf(PURPLE));
  assert.ok(updated.indexOf(PURPLE) < updated.indexOf(NEW));
  assert.ok(updated.endsWith(extraCss));
  assert.throws(() => withSidebarColors(first, 'bad"]{}', [NEW]), /无法识别/);
  assert.throws(() => withSidebarColors("/* t3-infobar-device-colors:start */", LOCAL, [NEW]), /不完整/);
});
