const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const source = readFileSync(require('node:path').join(__dirname, '../matches.js'), 'utf8');
const context = vm.createContext({ document: { getElementById: () => null } });
// Expose the actual private functions only inside this test context.
vm.runInContext(source.replace(/\}\)\(\);\s*$/, 'globalThis.subject = { text, score, validData, parseKickoff, teamByMatchId }; })();'), context);
const { text, score, validData, parseKickoff, teamByMatchId } = context.subject;

test('external text accepts strings without interpreting markup', () => {
  assert.equal(text('<b>"quoted"</b>'), '<b>"quoted"</b>');
  for (const invalid of [null, undefined, {}, [], 5, true]) assert.equal(text(invalid, '?'), '?');
});

test('scores accept only nonnegative integers or digit strings', () => {
  for (const value of [0, 2, '0', '12']) assert.equal(score(value), String(value));
  for (const value of [-1, 1.5, Infinity, NaN, {}, [], null, '<img onerror=x>', '2 goals']) assert.equal(score(value), '?');
});

test('schedule collections must be arrays of records', () => {
  assert.ok(validData({ matches: [{}], teams: [], stadiums: [] }));
  for (const matches of [null, {}, [null], [[]], [1]]) assert.ok(!validData({ matches, teams: [], stadiums: [] }));
  assert.ok(!validData(null));
});

test('kickoff ignores invalid types and accepts the feed format', () => {
  for (const value of [null, {}, 5, '<script>']) assert.equal(parseKickoff(value), null);
  assert.equal(parseKickoff('06/11/2026 13:00').hh, '13');
});

test('team lookup only matches scalar IDs', () => {
  const team = { id: 1, name_en: 'USA' };
  assert.equal(teamByMatchId([team], '1'), team);
  assert.equal(teamByMatchId([{}], undefined), null);
  assert.equal(teamByMatchId([{ id: {} }], {}), null);
});
