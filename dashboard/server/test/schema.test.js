// Checks the dollar quoting in the SCHEMA that db.js runs on every start. PostgreSQL needs a DO
// block and a function body to open and close with $$; a single $ is a syntax error and the
// dashboard then loops on "database not ready".
const test = require("node:test");
const assert = require("node:assert/strict");
const { SCHEMA } = require("../db");

const lines = SCHEMA.split(/\r?\n/);

test("every DO block in SCHEMA opens with DO $$ and closes with $$;", () => {
  const starts = lines.map((line, i) => [line, i]).filter(([line]) => /^\s*DO\b/.test(line));
  assert.ok(starts.length > 0, "SCHEMA has no DO block, so this test checks nothing");
  for (const [line, i] of starts) {
    assert.match(line, /^\s*DO \$\$\s*$/, `line ${i + 1} opens a DO block without $$: ${line}`);
    // The matching end is the next line that starts with a dollar sign.
    const end = lines.findIndex((l, j) => j > i && /^\s*\$/.test(l));
    assert.ok(end > i, `the DO block on line ${i + 1} is never closed`);
    assert.match(lines[end], /^\s*\$\$;\s*$/, `line ${end + 1} closes the DO block on line ${i + 1} without $$;: ${lines[end]}`);
  }
});

test("every function body in SCHEMA is quoted with $$ at both ends", () => {
  const starts = lines.map((line, i) => [line, i]).filter(([line]) => /\bAS\s+\$/.test(line));
  for (const [line, i] of starts) {
    assert.match(line, /\bAS \$\$\s*$/, `line ${i + 1} opens a function body without $$: ${line}`);
    const end = lines.findIndex((l, j) => j > i && /^\s*\$/.test(l));
    assert.ok(end > i, `the function body on line ${i + 1} is never closed`);
    assert.match(lines[end], /^\s*\$\$ LANGUAGE \w+;\s*$/, `line ${end + 1} closes the function body without $$: ${lines[end]}`);
  }
});

test("SCHEMA has no single $ used as a delimiter", () => {
  // A dollar sign is allowed only in $$, in a $n parameter, or as a regex anchor before a quote.
  for (const [i, line] of lines.entries()) {
    const stray = line.replace(/\$\$/g, "").replace(/\$\d+/g, "").replace(/\$'/g, "");
    assert.ok(!stray.includes("$"), `line ${i + 1} has a single $: ${line}`);
  }
});
