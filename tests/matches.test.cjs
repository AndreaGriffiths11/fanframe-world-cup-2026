// Run with node --test tests/matches.test.cjs using an installed playwright-core.
// PLAYWRIGHT_MODULE and CHROME_PATH may point to existing local installations.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createServer } = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const source = readFileSync(process.env.MATCHES_JS || require('node:path').join(__dirname, '../matches.js'), 'utf8');
let browser, server, origin;
const markup = '<img src="/missing" onerror="window.injected=true">';
const quoted = '\"><img src="/missing" onerror="window.injected=true"><span title="';
const fixture = () => ({
  matches: [{ local_date: '06/11/2026 13:00', home_team_id: 1, away_team_id: 2,
    stadium_id: 1, finished: 'FALSE', time_elapsed: 'notstarted', type: 'group', group: 'A', home_score: 2, away_score: 1 }],
  teams: [{ id: 1, fifa_code: 'USA', name_en: 'United States' }, { id: 2, fifa_code: 'CAN', name_en: 'Canada' }],
  stadiums: [{ id: 1, name_en: 'Test Stadium', city_en: 'Test City' }],
});

before(async () => {
  server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><select id="team"><option>USA</option><option>CAN</option></select><input id="username"><div id="matches-widget"></div>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
});
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });

async function render(data, options = {}) {
  const page = await browser.newPage();
  await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  await page.goto(origin);
  await page.evaluate(({ data, options }) => {
    const RealDate = Date;
    window.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : ['2026-06-11T12:00:00Z'])); }
      static now() { return new RealDate('2026-06-11T12:00:00Z').getTime(); }
    };
    window.TEAMS = [{ code: 'USA', flag: '🇺🇸' }, { code: 'CAN', flag: '🇨🇦' }];
    window.injected = false;
    window.fetchCount = 0;
    if (options.cache) localStorage.setItem('fanframe-matches-cache-v1', JSON.stringify({ savedAt: Date.now() - (options.stale ? 7 * 3600000 : 0), ...data }));
    window.fetch = async url => {
      window.fetchCount++;
      if (options.offline) throw new Error('fixture offline');
      const kind = /football\.(matches|teams|stadiums)\.json$/.exec(url)?.[1];
      if (!kind) throw new Error('Unexpected fixture URL');
      return { ok: true, json: async () => data[kind] };
    };
  }, { data, options });
  await page.addScriptTag({ content: source });
  await page.waitForFunction(() => document.querySelector('#matches-widget').textContent.trim());
  // Image errors have completed when load fires, including any injected fixture images.
  await page.waitForLoadState('load');
  return page;
}

test('normal kickoff, venue, flags and click-to-prefill', async () => {
  const page = await render(fixture());
  try {
    assert.equal(await page.locator('.match-row').count(), 1);
    assert.equal(await page.locator('.match-time').textContent(), '13:00 local');
    assert.match(await page.locator('.match-sub').textContent(), /Group A.*Test Stadium, Test City/);
    assert.equal(await page.locator('.match-flag').first().textContent(), '🇺🇸');
    await page.locator('[data-team-code="CAN"]').click();
    assert.equal(await page.locator('#team').inputValue(), 'CAN');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'username');
  } finally { await page.close(); }
});

for (const field of ['name_en', 'fifa_code', 'home_score', 'away_score', 'group', 'type', 'stadiumName', 'stadiumCity']) {
  test(`untrusted ${field} cannot create markup or handlers`, async () => {
    const data = fixture();
    data.matches[0].finished = 'TRUE';
    if (field === 'name_en' || field === 'fifa_code') data.teams[0][field] = quoted;
    else if (field === 'stadiumName') data.stadiums[0].name_en = markup;
    else if (field === 'stadiumCity') data.stadiums[0].city_en = markup;
    else data.matches[0][field] = markup;
    const page = await render(data);
    try {
      assert.equal(await page.evaluate(() => window.injected), false);
      assert.equal(await page.locator('#matches-widget img, #matches-widget script, #matches-widget [onerror]').count(), 0);
      assert.equal(await page.locator('.match-row').count(), 1);
      if (field === 'name_en') assert.equal(await page.locator('.match-team').first().getAttribute('title'), `Generate ${quoted} avatar`);
      if (field === 'fifa_code') assert.equal(await page.locator('.match-code').first().textContent(), quoted);
    } finally { await page.close(); }
  });
}

test('finished and live scores preserve normal display', async () => {
  for (const finished of ['TRUE', 'FALSE']) {
    const data = fixture(); data.matches[0].finished = finished; data.matches[0].time_elapsed = '45';
    const page = await render(data);
    try {
      assert.equal(await page.locator('.match-score').textContent(), '2 – 1');
      assert.equal(await page.locator('.match-status').textContent(), finished === 'TRUE' ? 'FT' : 'LIVE');
    } finally { await page.close(); }
  }
});

test('fresh and stale offline cache remain safe and usable', async () => {
  for (const stale of [false, true]) {
    const data = fixture(); data.stadiums[0].name_en = markup;
    const page = await render(data, { cache: true, stale, offline: true });
    try {
      assert.equal(await page.locator('.match-row').count(), 1);
      assert.equal(await page.locator('#matches-widget img').count(), 0);
      assert.equal(await page.evaluate(() => window.injected), false);
      assert.equal(await page.evaluate(() => window.fetchCount), stale ? 3 : 0);
    } finally { await page.close(); }
  }
});

test('invalid field types do not prevent rendering a valid schedule', async () => {
  const data = fixture(); data.teams[0].name_en = {}; data.teams[0].fifa_code = [];
  data.matches[0].type = {}; data.matches[0].group = {}; data.matches[0].home_score = {};
  data.matches.push({ local_date: 42 });
  const page = await render(data);
  try { assert.equal(await page.locator('.match-row').count(), 1); }
  finally { await page.close(); }
});

test('invalid top-level data displays unavailable', async () => {
  const page = await render({ matches: {}, teams: [], stadiums: [] });
  try { assert.match(await page.locator('#matches-widget').textContent(), /Schedule unavailable/); }
  finally { await page.close(); }
});

test('upcoming and empty schedules retain their states', async () => {
  for (const hasMatch of [true, false]) {
    const data = fixture(); if (hasMatch) data.matches[0].local_date = '06/12/2026 13:00'; else data.matches = [];
    const page = await render(data);
    try { assert.match(await page.locator('#matches-widget').textContent(), hasMatch ? /Up next/ : /No upcoming matches/); }
    finally { await page.close(); }
  }
});
