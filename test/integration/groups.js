// How the integration suite is split when it runs in parallel (one VS Code + one project copy per group).
// Each name is a section of suite.js (`await section('…')`); a group's sections run in suite order.
// Every group but the first starts with its own setup (seed, build, docs generate) — see suite.js `setup()`.
// Rebalance by the per-step times in the PASS / FAIL lines. Measured (s, 2026-11-21): core 83 · v04 29 · v06 50 ·
// v05 24 · v07 27 · v08 82 · v10–v13 76 · setup ≈ 17 per group.
exports.GROUPS = [
  ['core'],
  ['language', 'v04', 'v06', 'v15'],
  ['v05', 'v08'],
  ['v07', 'v10', 'v11', 'review', 'v12', 'v13', 'v14']
];

/** The group ('1', '2', …) a section belongs to. */
exports.groupOf = name => {
  const i = exports.GROUPS.findIndex(g => g.includes(name));
  if (i < 0) {
    throw new Error(`section ${name} is in no group (test/integration/groups.js)`);
  }
  return String(i + 1);
};
