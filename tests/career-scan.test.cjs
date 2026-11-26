const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const scannerSource = fs.readFileSync(path.join(__dirname, '..', 'player-career-scan.js'), 'utf8');
const controlsSource = html.slice(html.indexOf('function applyCareerCache('), html.indexOf('// v2 replaces projections'));
const wallet = '0x0123456789abcdef';
const resume = 'careerScanButton';
const updateAll = 'careerScanUpdateAllButton';
const retry = 'careerScanRetryButton';
const pause = 'careerScanStopButton';

function harness(seasons, onRequest = () => 200) {
  const storage = new Map([['agentHubSeasonsInGame:v1:' + wallet, JSON.stringify({ version: 1, seasons })]]);
  const elements = new Map();
  const getElement = id => {
    if (!elements.has(id)) elements.set(id, { style: {}, classList: { contains: () => false }, setAttribute() {} });
    return elements.get(id);
  };
  const requests = [];
  let now = 100000;
  const context = vm.createContext({
    window: {},
    document: { getElementById: getElement },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    Date: { now: () => now },
    setTimeout(callback, ms) { now += ms; callback(); },
    async fetch(url) {
      const id = url.split('/').at(-3);
      requests.push(id);
      const status = onRequest(id, requests.length);
      return { status, ok: status === 200, json: async () => [{ reasonType: 'INITIAL', values: { age: 20 } }] };
    },
    allPlayers: [1, 2, 3].map(id => ({ id, age: 22 })),
    viewerMode: false,
    API_BASE: 'https://test.invalid',
    careerScanWallet: wallet,
    careerScanning: false,
    careerScanStop: false,
    activeSquadId: null,
    autoSave() {},
  });
  vm.runInContext(scannerSource, context);
  vm.runInContext(controlsSource, context);
  context.updateCareerScanPanel();
  return {
    requests,
    getElement,
    updatePanel: context.updateCareerScanPanel,
    cache: () => context.window.AgentHubCareerScan.load(wallet),
    click(id) {
      const button = html.match(new RegExp(`<button[^>]*id="${id}" onclick="([^"]+)"[^>]*>([^<]+)</button>`));
      assert.ok(button, `Missing ${id}`);
      if (id === updateAll) assert.equal(button[2], 'Update all players');
      return vm.runInContext(button[1], context);
    },
  };
}

test('Resume scan fills gaps in older caches without rescanning cached players', async () => {
  const app = harness({ 1: 1, 3: 2 });
  assert.equal(app.getElement(resume).textContent, 'Resume scan');
  await app.click(resume);
  assert.deepEqual(app.requests, ['2']);
  assert.equal(app.getElement(resume).disabled, true);
  assert.equal(app.getElement(updateAll).disabled, false);
});

test('Update all players scans cached players and Resume scan picks up a paused refresh', async () => {
  const app = harness({ 1: 1, 2: 1, 3: 1 }, (_id, request) => {
    if (request === 1) {
      assert.equal(app.getElement(resume).disabled, true);
      assert.equal(app.getElement(updateAll).disabled, true);
      assert.equal(app.getElement(pause).hidden, false);
      app.click(pause);
    }
    return 200;
  });
  assert.equal(app.getElement(resume).disabled, true);
  await app.click(updateAll);
  assert.deepEqual(app.requests, ['1']);
  assert.deepEqual(Array.from(app.cache().refreshPending), ['2', '3']);
  assert.equal(app.cache().seasons[1], 3);
  assert.equal(app.cache().seasons[2], 1);
  app.updatePanel();
  assert.equal(app.getElement(resume).disabled, false);
  await app.click(resume);
  assert.deepEqual(app.requests, ['1', '2', '3']);
  assert.equal(app.cache().seasons[3], 3);
  assert.equal(app.cache().refreshPending.length, 0);
  assert.equal(app.getElement(resume).disabled, true);
});

test('Retry failed can clear a rate-limited player from the pending refresh', async () => {
  const app = harness({ 1: 1, 2: 1, 3: 1 }, (_id, request) => request === 2 ? 429 : 200);
  await app.click(updateAll);
  assert.deepEqual(app.requests, ['1', '2']);
  assert.deepEqual(Array.from(app.cache().refreshPending), ['2', '3']);
  assert.equal(app.getElement(retry).hidden, false);
  await app.click(retry);
  assert.deepEqual(app.requests, ['1', '2', '2']);
  await app.click(resume);
  assert.deepEqual(app.requests, ['1', '2', '2', '3']);
  assert.equal(app.cache().refreshPending.length, 0);
  assert.equal(app.getElement(retry).hidden, true);
});
