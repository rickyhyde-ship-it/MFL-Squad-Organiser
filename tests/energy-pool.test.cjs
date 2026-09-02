const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const directory = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(directory, 'index.html'), 'utf8');
const profile = { key: 'CM|80|80|none', position: 'CM', overall: 80, physical: 80, retirement: 'none' };
const observation = (energyRaw, averageDrainRaw, sampleSize) => ({ energyRaw, averageDrainRaw, sampleSize });
const model = (observations, widenedObservations = observations) => ({
  ...profile, observations, widenedObservations,
  profileSamples: observations.reduce((sum, row) => sum + row.sampleSize, 0),
  usableProfileSamples: observations.reduce((sum, row) => sum + row.sampleSize, 0),
});

function functionSource(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists in the builder`);
  return html.slice(html.slice(start - 6, start) === 'async ' ? start - 6 : start, html.indexOf('\n}', start) + 2);
}

function harness(fetch = async () => { throw new Error('Unexpected request'); }) {
  const storage = new Map();
  const context = vm.createContext({
    fetch, AbortController, setTimeout, clearTimeout, console,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
  });
  vm.runInContext(`
    let careerScanWallet='wallet',energyProjectionCounts={full:{},limited:{}};
    let renderCount=0;
    function renderEnergyPlanner(){renderCount++;}
    ${html.slice(html.indexOf('const ENERGY_DEFAULT_DRAIN='), html.indexOf('const DIVISION_MIN_OVR='))}
    ${['mergeEnergyObservations', 'fetchPooledEnergyModels', 'cacheEnergyModel', 'energyModelsReadyMessage',
      'loadEnergyModels', 'energyModelsPending', 'predictionFromEnergyObservations', 'modelPredictionFromEnergyModel',
      'lowStartCountForEnergyModel', 'calculateEnergyProjection', 'energyUseFor', 'modelPredictionFor',
      'energyProjectionStorageKey', 'loadEnergyProjectionCounts', 'saveEnergyProjectionCounts',
      'storedEnergyProjectionCount', 'updatePitchEnergyWarnings'].map(functionSource).join('\n')}
  `, context);
  return { context, storage, read: code => vm.runInContext(code, context) };
}

function responses(first, second, calls = []) {
  return async (url, options) => {
    calls.push({ url, profiles: JSON.parse(options.body).profiles, signal: options.signal });
    const value = url.includes('jul-aug-2026') ? second : first;
    if (value instanceof Error) throw value;
    return { ok: true, json: async () => value };
  };
}

test('both entry points stay identical and all inline JavaScript parses', () => {
  assert.equal(fs.readFileSync(path.join(directory, 'mfl-squad-organiser.html'), 'utf8'), html);
  for (const [, script] of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(script);
});

test('both datasets receive the same profile batch and pooling weights every sample', async () => {
  const calls = [];
  const old = model([observation(10000, 400, 2), observation(9800, 300, 1)]);
  const added = model([observation(10000, 800, 6), observation(9800, 500, 3)]);
  const { context } = harness(responses({ models: [old] }, { models: [added] }, calls));
  const { models: [pooled] } = await context.fetchPooledEnergyModels([profile]);
  assert.equal(calls.length, 2);
  calls.forEach(call => assert.deepEqual(call.profiles, [profile]));
  assert.equal(pooled.complete, true);
  assert.equal(pooled.sourceCount, 2);
  assert.equal(pooled.profileSamples, 12);
  assert.equal(pooled.observations.length, 2);
  assert.equal(pooled.observations[1].averageDrainRaw, 700);
  assert.equal(pooled.observations[1].sampleSize, 8);
  const prediction = context.predictionFromEnergyObservations(pooled.observations, 10000);
  assert.equal(prediction.drainRaw, 617); // (400*2 + 300 + 800*6 + 500*3) / 12, rounded once.
  assert.equal(prediction.sampleSize, 12);
});

test('standard evidence in either dataset takes precedence over all widened evidence', async () => {
  const old = model([], [observation(10000, 1500, 100)]);
  const added = model([observation(10000, 500, 2)], [observation(10000, 900, 10)]);
  const { context } = harness(responses({ models: [old] }, { models: [added] }));
  const { models: [pooled] } = await context.fetchPooledEnergyModels([profile]);
  const prediction = context.modelPredictionFromEnergyModel({}, pooled, 10000);
  assert.equal(prediction.tier, 'standard');
  assert.equal(prediction.drainRaw, 500);
  assert.equal(prediction.sampleSize, 2);
  assert.equal(pooled.widenedObservations[0].sampleSize, 110);
});

test('widened estimates also use sample weights and the existing energy tolerance', async () => {
  const old = model([observation(10000, 400, 2)], [observation(7000, 600, 1)]);
  const added = model([], [observation(7000, 1000, 3)]);
  const { context } = harness(responses({ models: [old] }, { models: [added] }));
  const { models: [pooled] } = await context.fetchPooledEnergyModels([profile]);
  const prediction = context.modelPredictionFromEnergyModel({}, pooled, 7300);
  assert.equal(prediction.tier, 'widened');
  assert.equal(prediction.drainRaw, 900);
  assert.equal(prediction.sampleSize, 4);
  assert.equal(context.modelPredictionFromEnergyModel({}, pooled, 7301), null);
  assert.equal(context.modelPredictionFromEnergyModel({ manualDrain: true }, pooled, 7000), null);
});

test('either dataset can remain usable during an outage and partial models remain retryable', async () => {
  for (const unavailable of [0, 1]) {
    const payload = { models: [model([observation(10000, 400, 2)])] };
    const inputs = [payload, payload];
    inputs[unavailable] = new Error('Offline');
    const { context, read } = harness(responses(...inputs));
    const { models: [pooled] } = await context.fetchPooledEnergyModels([profile]);
    assert.equal(pooled.complete, false);
    assert.equal(pooled.sourceCount, 1);
    assert.equal(pooled.observations[0].sampleSize, 2);
    context.cacheEnergyModel(pooled);
    assert.equal(read(`energyModelFailures.has('${profile.key}')`), true);
    assert.match(context.energyModelsReadyMessage([{ modelKey: profile.key }]), /Partial real-match model/);
    context.cacheEnergyModel({ ...pooled, complete: true, missingSources: [], sourceCount: 2 });
    assert.equal(read(`energyModelFailures.has('${profile.key}')`), false);
  }
});

test('missing profile data is treated as an unavailable source; two failures reject', async () => {
  const { context } = harness(responses({ models: [] }, { models: [model([])] }));
  const { models: [pooled] } = await context.fetchPooledEnergyModels([profile]);
  assert.equal(pooled.complete, false);
  assert.equal(pooled.observations.length, 0);
  const failed = harness(responses({ models: [] }, new Error('Offline')));
  await assert.rejects(failed.context.fetchPooledEnergyModels([profile]), /All energy datasets are unavailable/);
});

test('a partial refresh cannot replace an already complete cached model', () => {
  const { context, read } = harness();
  context.cacheEnergyModel({ ...model([observation(10000, 700, 8)]), complete: true, sourceCount: 2, missingSources: [] });
  context.cacheEnergyModel({ ...model([observation(10000, 400, 2)]), complete: false, sourceCount: 1, missingSources: ['July'] });
  assert.equal(read(`energyModelCache.get('${profile.key}').complete`), true);
  assert.equal(read(`energyModelCache.get('${profile.key}').observations[0].sampleSize`), 8);
  assert.equal(read(`energyModelFailures.has('${profile.key}')`), false);
});

test('old single-source projections are ignored while pooled counts persist', () => {
  const { context, storage, read } = harness();
  storage.set('mfl_energy_projection_counts_v1_wallet', JSON.stringify({ full: { [profile.key]: 8 }, limited: { [profile.key]: 2 } }));
  context.loadEnergyProjectionCounts();
  assert.equal(context.storedEnergyProjectionCount(profile.key), null);
  read(`energyProjectionCounts.full['${profile.key}']=4;energyProjectionCounts.limited['${profile.key}']=1;`);
  context.saveEnergyProjectionCounts();
  context.loadEnergyProjectionCounts();
  assert.equal(context.storedEnergyProjectionCount(profile.key, false), 4);
  assert.equal(context.storedEnergyProjectionCount(profile.key, true), 1);
});

test('planner warnings do not save partial evidence as a finished pool scan', () => {
  const { context, read, storage } = harness();
  context.document = { getElementById: () => ({ querySelectorAll: () => [] }) };
  const starter = { index: 0, modelKey: profile.key };
  const projection = { rows: [] };
  context.cacheEnergyModel({ ...model([]), complete: false, missingSources: ['one source'] });
  context.updatePitchEnergyWarnings([starter], projection);
  assert.equal(context.storedEnergyProjectionCount(profile.key), null);
  assert.equal(storage.size, 0);
  read(`energyModelCache.get('${profile.key}').complete=true;`);
  context.updatePitchEnergyWarnings([starter], projection);
  assert.equal(context.storedEnergyProjectionCount(profile.key), 0);
  assert.equal(storage.size, 1);
});

test('pool scan and starting-XI planner agree for both schedules', async () => {
  const observations = Array.from({ length: 86 }, (_, index) => observation(1500 + index * 100, 1000, 2));
  const { context } = harness(responses({ models: [model(observations)] }, { models: [model(observations)] }));
  const { models: [pooled] } = await context.fetchPooledEnergyModels([profile]);
  context.cacheEnergyModel(pooled);
  for (const limited of [false, true]) {
    const schedule = context.energyScheduleForMode(limited);
    const projection = context.calculateEnergyProjection([{ modelKey: profile.key, drain: 4 }], schedule);
    const count = projection.rows.reduce((sum, row) => sum + row.matchStarts.filter(match => match.energies[0] <= 6000).length, 0);
    assert.ok(count > 0);
    assert.equal(context.lowStartCountForEnergyModel(profile, pooled, schedule), count);
  }
});

test('planner retries a partial model after the cooldown and replaces it with pooled evidence', async () => {
  const payload = { models: [model([observation(10000, 400, 2)])] };
  const calls = [];
  const { context, read } = harness(responses(payload, payload, calls));
  context.cacheEnergyModel({ ...payload.models[0], complete: false, sourceCount: 1, missingSources: ['July'] });
  const starters = [{ profile, modelKey: profile.key }];
  context.loadEnergyModels(starters);
  assert.equal(calls.length, 0);
  read(`energyModelFailures.set('${profile.key}',Date.now()-ENERGY_MODEL_RETRY_MS-1);`);
  context.loadEnergyModels(starters);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2);
  assert.equal(read(`energyModelCache.get('${profile.key}').complete`), true);
  assert.equal(read('renderCount'), 1);
});
