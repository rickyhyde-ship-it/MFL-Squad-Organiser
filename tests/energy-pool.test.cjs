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
      'energyProjectionCountKey', 'storedEnergyProjectionCount', 'energyPoolReadyCount', 'updatePitchEnergyWarnings'].map(functionSource).join('\n')}
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

test('planner warning counts are cached against each player training intensity', () => {
  const { context } = harness();
  context.document = { getElementById: () => ({ querySelectorAll: () => [], querySelector: () => null }) };
  context.cacheEnergyModel({ ...model([]), complete: true, missingSources: [] });
  context.updatePitchEnergyWarnings([{ index: 0, modelKey: profile.key, trainingIntensity: 'high' }], {
    rows: [{ matchStarts: [{ energies: [6000], resting: [false] }] }],
  });
  assert.equal(context.storedEnergyProjectionCount(profile.key, false, 'high'), 1);
  assert.equal(context.storedEnergyProjectionCount(profile.key, false, 'low'), null);
});

test('pool scan and starting-XI planner agree for all training intensities and both schedules', async () => {
  const observations = Array.from({ length: 86 }, (_, index) => observation(1500 + index * 100, 1000, 2));
  const { context } = harness(responses({ models: [model(observations)] }, { models: [model(observations)] }));
  const { models: [pooled] } = await context.fetchPooledEnergyModels([profile]);
  context.cacheEnergyModel(pooled);
  for (const limited of [false, true]) {
    for (const intensity of ['low', 'medium', 'high']) {
    const schedule = context.energyScheduleForMode(limited);
    const projection = context.calculateEnergyProjection([{ modelKey: profile.key, drain: 4 }], schedule, intensity);
    const count = projection.rows.reduce((sum, row) => sum + row.matchStarts.filter(match => match.energies[0] <= 6000).length, 0);
    assert.ok(count > 0);
    assert.equal(context.lowStartCountForEnergyModel(profile, pooled, schedule, intensity), count);
    }
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

test('rest restores 65% of missing raw energy instead of draining, including at full energy', () => {
  const { context } = harness();
  const schedule = [1, 2, 3].map(day => ({ day, training: false, league: true, cup: false }));
  const projection = context.calculateEnergyProjection([
    { drain: 4.11, manualDrain: true, restMatches: { '2:league': true } },
    { drain: 20, manualDrain: true, restMatches: { '1:league': true } },
  ], schedule);
  const rest = projection.rows[1].matchStarts[0];
  assert.equal(rest.energies[0], 9589);
  assert.equal(rest.uses[0].source, 'rest');
  assert.equal(rest.uses[0].drainRaw, 0);
  assert.equal(rest.uses[0].recoveryRaw, 267);
  assert.equal(rest.after[0], 9856);
  assert.equal(projection.rows[2].matchStarts[0].energies[0], 9856);
  assert.equal(projection.final[0], 9445);
  assert.equal(projection.rows[0].end[1], 10000);
});

test('D7 and D9 support play/play, rest/play, play/rest and rest/rest in sequence', () => {
  const { context } = harness();
  const combinations = [
    { league: false, cup: false, secondStart: 6400, end: 4400 },
    { league: true, cup: false, secondStart: 9440, end: 7440 },
    { league: false, cup: true, secondStart: 6400, end: 8740 },
    { league: true, cup: true, secondStart: 9440, end: 9804 },
  ];
  for (const day of [7, 9]) {
    for (const choice of combinations) {
      const schedule = [
        { day: 1, training: false, league: true, cup: false },
        context.energyScheduleForMode(false).find(row => row.day === day),
        { day: day + 1, training: true, league: true, cup: false },
      ];
      const rests = { [`${day}:league`]: choice.league, [`${day}:cup`]: choice.cup };
      const projection = context.calculateEnergyProjection([
        { drain: 20, manualDrain: true, restMatches: rests },
        { drain: 20, manualDrain: true },
      ], schedule);
      const row = projection.rows[1];
      assert.equal(row.afterTraining[0], 8400);
      assert.equal(row.matchStarts[0].type, 'league');
      assert.equal(row.matchStarts[1].type, 'cup');
      assert.equal(row.matchStarts[0].energies[0], 8400);
      assert.equal(row.matchStarts[1].energies[0], choice.secondStart);
      assert.equal(row.end[0], choice.end);
      assert.equal(row.end[1], 4400, 'resting one player does not change another player');
      assert.equal(projection.rows[2].matchStarts[0].energies[0], Math.round(choice.end + (10000 - choice.end) * 0.2));
    }
  }
});

test('resting at the energy floor recovers energy and removes that appearance from warnings', () => {
  const { context, read } = harness();
  const schedule = Array.from({ length: 6 }, (_, index) => ({ day: index + 1, training: false, league: true, cup: false }));
  const starters = Array.from({ length: 5 }, (_, index) => ({
    index, drain: 20, modelKey: profile.key, manualDrain: true,
    player: { name: `Player ${index}` }, restMatches: index === 0 ? { '6:league': true } : {},
  }));
  const projection = context.calculateEnergyProjection(starters, schedule);
  const match = projection.rows[5].matchStarts[0];
  assert.equal(match.energies[0], 1500);
  assert.equal(match.after[0], 7025);
  assert.equal(match.playingCount, 4);
  assert.equal(match.tiredCount, 4);
  assert.equal(match.blocked, false);
  const badges = new Map();
  context.document = {
    getElementById: () => ({ querySelectorAll: () => [], querySelector: selector => ({ appendChild: badge => badges.set(selector, badge.textContent) }) }),
    createElement: () => ({ setAttribute() {} }),
  };
  context.updatePitchEnergyWarnings(starters, projection);
  assert.equal(badges.get('.pitch-slot[data-idx="0"] .pitch-slot-ovr-alerts'), '3');
  assert.equal(badges.get('.pitch-slot[data-idx="1"] .pitch-slot-ovr-alerts'), '4');

  // A custom rest plan must never replace the pool's all-matches count.
  context.cacheEnergyModel({ ...model([]), complete: true, missingSources: [] });
  read(`energyProjectionCounts.full['${profile.key}']=77;`);
  starters[0].manualDrain = false;
  context.updatePitchEnergyWarnings(starters, projection);
  assert.equal(context.storedEnergyProjectionCount(profile.key, false), 77);
});

test('cup rests remain tied to the cup on cup-only days and across schedule modes', () => {
  const { context } = harness();
  const starter = { drain: 20, manualDrain: true, restMatches: { '6:cup': true, '7:cup': true, '16:cup': true } };
  for (const limited of [false, true]) {
    const projection = context.calculateEnergyProjection([starter], context.energyScheduleForMode(limited));
    const cupOnly = projection.rows.find(row => row.scheduleDay.day === 6).matchStarts[0];
    assert.equal(cupOnly.match, 1);
    assert.equal(cupOnly.type, 'cup');
    assert.equal(cupOnly.resting[0], true);
    const double = projection.rows.find(row => row.scheduleDay.day === 7).matchStarts;
    assert.equal(double[0].resting[0], false);
    assert.equal(double[1].resting[0], true);
  }
});

test('team rest updates every visible starter, allows individual overrides, and preserves other matches', () => {
  const { context, read } = harness();
  read(`
    let viewerMode=false,saveCount=0;
    const squad={starters:[{playerId:1},{playerId:2},null,{playerId:3}]};
    function activeSquad(){return squad;}
    function playerForSlot(slot){return slot?{name:'Player '+slot.playerId}:null;}
    function isSlotIgnoredNextSeason(){return false;}
    function energyProfileFor(){return null;}
    function defaultEnergyDrainFor(){return 4;}
    function autoSave(){saveCount++;localStorage.setItem('squad',JSON.stringify(squad));}
    const document={getElementById:()=>({focus(){}})};
    ${['slotPlayerKey','energyPlayerKey','energyTrainingIntensityFor','getEnergyStarters','setEnergyRestForPlayer','toggleEnergyRest','toggleEnergyTeamRest'].map(functionSource).join('\n')}
  `);
  context.toggleEnergyRest(0, 9, 'cup');
  context.toggleEnergyTeamRest(7, 'league');
  assert.equal(read('saveCount'), 2, 'team toggle saves the batch once');
  assert.equal(read(`getEnergyStarters(squad).every(entry=>entry.restMatches['7:league']===true)`), true);
  context.toggleEnergyRest(1, 7, 'league');
  assert.equal(read(`getEnergyStarters(squad).filter(entry=>entry.restMatches['7:league']).length`), 2);
  context.toggleEnergyTeamRest(7, 'cup');
  assert.equal(read(`getEnergyStarters(squad).filter(entry=>entry.restMatches['7:league']).length`), 2);
  assert.equal(read(`getEnergyStarters(squad).every(entry=>entry.restMatches['7:cup']===true)`), true);
  context.toggleEnergyTeamRest(7, 'league');
  assert.equal(read(`getEnergyStarters(squad).every(entry=>entry.restMatches['7:league']===true)`), true);
  context.toggleEnergyTeamRest(7, 'league');
  assert.equal(read(`getEnergyStarters(squad).some(entry=>entry.restMatches['7:league'])`), false);
  assert.equal(read(`getEnergyStarters(squad).every(entry=>entry.restMatches['7:cup']===true)`), true);
  assert.equal(read(`JSON.parse(localStorage.getItem('squad')).energyRests['player:1']['9:cup']`), true);
  const savedCount = read('saveCount');
  context.toggleEnergyTeamRest(1, 'cup'); // No cup is scheduled.
  read('viewerMode=true;');
  context.toggleEnergyTeamRest(7, 'cup');
  context.toggleEnergyRest(0, 7, 'cup');
  assert.equal(read('saveCount'), savedCount);
  assert.equal(read(`getEnergyStarters(squad).every(entry=>entry.restMatches['7:cup']===true)`), true);
});

test('training formulas use missing raw energy, round once, and respect the energy floor', () => {
  const { context } = harness();
  assert.equal(context.energyAfterTraining(8000, 'low'), 8400);
  assert.equal(context.energyAfterTraining(8000, 'medium'), 8000);
  assert.equal(context.energyAfterTraining(8000, 'high'), 7700);
  assert.equal(context.energyAfterTraining(10000, 'high'), 9900);
  assert.equal(context.energyAfterTraining(9589, 'low'), 9671);
  assert.equal(context.energyAfterTraining(9589, 'medium'), 9589);
  assert.equal(context.energyAfterTraining(9589, 'high'), 9448);
  assert.equal(context.energyAfterTraining(1500, 'low'), 3200);
  assert.equal(context.energyAfterTraining(1500, 'medium'), 1500);
  assert.equal(context.energyAfterTraining(1500, 'high'), 1500);
  assert.equal(context.energyAfterTraining(2000, 'high'), 1500);
});

test('each starter can use a different training intensity in the same projection', () => {
  const { context } = harness();
  const starters = ['low', 'medium', 'high'].map(trainingIntensity => ({
    drain: 20, manualDrain: true, trainingIntensity,
  }));
  const projection = context.calculateEnergyProjection(starters, [
    { day: 1, training: false, league: true, cup: false },
    { day: 2, training: true, league: false, cup: false },
  ]);
  assert.deepEqual(Array.from(projection.final), [8400, 8000, 7700]);
});

test('individual training overrides persist and a team change synchronizes every starter', () => {
  const { context, read, storage } = harness();
  read(`
    let viewerMode=false,saveCount=0;
    const squad={starters:[{playerId:1},{playerId:2}],energyTrainingIntensities:{}};
    function activeSquad(){return squad;}
    function autoSave(){saveCount++;}
    const document={getElementById:()=>null,querySelector:()=>({focus(){}})};
    ${['slotPlayerKey','energyPlayerKey','energyTrainingIntensityFor','setPlayerEnergyTrainingIntensity'].map(functionSource).join('\n')}
  `);
  context.setPlayerEnergyTrainingIntensity(0, 'medium');
  assert.equal(read(`squad.energyTrainingIntensities['player:1']`), 'medium');
  assert.equal(read(`energyTrainingIntensityFor(squad,squad.starters[0],0)`), 'medium');
  assert.equal(read(`energyTrainingIntensityFor(squad,squad.starters[1],1)`), 'low');
  context.setEnergyTrainingIntensity('high');
  assert.equal(storage.get('mfl_energy_training_intensity'), 'high');
  assert.equal(read('Object.keys(squad.energyTrainingIntensities).length'), 0);
  assert.equal(read(`energyTrainingIntensityFor(squad,squad.starters[0],0)`), 'high');
  assert.equal(read(`energyTrainingIntensityFor(squad,squad.starters[1],1)`), 'high');
  assert.equal(read('saveCount'), 2);
});

test('starter controls render OVR, age, retirement status and individual training buttons', () => {
  const context = vm.createContext({});
  vm.runInContext(`
    const ENERGY_TRAINING_MODES=['low','medium','high'];
    const ENERGY_TRAINING_DESCRIPTIONS={low:'Low',medium:'Medium',high:'High'};
    let energyTrainingIntensity='low',viewerMode=false,nextSeasonMode=false;
    function isNextSeasonMode(){return nextSeasonMode;}
    function projectedRetirementYears(value){if(value===null||value===undefined||value==='')return null;return Number(value);}
    function getOvrColor(){return '#fff';}
    function escAttr(value){return String(value);}
    ${functionSource('energyPlayerRetirementMeta')}
    ${functionSource('renderEnergyPlayerMeta')}
    ${functionSource('renderEnergyPlayerTrainingOptions')}
  `, context);
  const playerMeta = context.renderEnergyPlayerMeta({ ovr: 84, age: 31, retireIn: 2 });
  assert.match(playerMeta, /OVR <strong[^>]*>84<\/strong>/);
  assert.match(playerMeta, /Age <strong>31<\/strong>/);
  assert.match(playerMeta, /data-level="orange"[^>]*>Retires 2S/);
  assert.doesNotMatch(context.renderEnergyPlayerMeta({ ovr: 80, age: 24, retireIn: null }), /is-retirement/);
  const controls = context.renderEnergyPlayerTrainingOptions({ index: 3, trainingIntensity: 'medium', player: { name: 'Test Player' } });
  assert.equal((controls.match(/class="energy-player-training-option"/g) || []).length, 3);
  assert.match(controls, /data-intensity="medium" aria-pressed="true"/);
});

test('Starting XI controls do not expose legacy custom drain inputs', () => {
  assert.doesNotMatch(html, /class="energy-drain-input"/);
  assert.doesNotMatch(html, /function updateEnergyDrain\(/);
  assert.match(html, /return`<div class="energy-player-control\$\{fallback\?' is-fallback':''\}">\$\{renderEnergyPlayerIdentity\(entry,source\)\}\$\{renderEnergyPlayerTrainingOptions\(entry\)\}<\/div>`/);
});

test('each intensity trains once before double matches, supports rest, and skips non-training days', () => {
  const { context } = harness();
  const schedule = [
    { day: 1, training: false, league: true, cup: false },
    { day: 7, training: true, league: true, cup: true },
    { day: 30, training: false, league: false, cup: false },
    { day: 31, training: false, league: true, cup: false },
  ];
  const expected = {
    low: { before: 8400, recovered: 9440, end: 7440 },
    medium: { before: 8000, recovered: 9300, end: 7300 },
    high: { before: 7700, recovered: 9195, end: 7195 },
  };
  for (const [intensity, values] of Object.entries(expected)) {
    const projection = context.calculateEnergyProjection([{ drain: 20, manualDrain: true, restMatches: { '7:league': true } }], schedule, intensity);
    assert.equal(projection.rows[0].afterTraining[0], 10000);
    assert.equal(projection.rows[1].afterTraining[0], values.before);
    assert.equal(projection.rows[1].matchStarts[1].energies[0], values.recovered);
    assert.equal(projection.rows[1].end[0], values.end);
    assert.equal(projection.rows[2].end[0], values.end);
    assert.equal(projection.rows[3].matchStarts[0].energies[0], values.end);
    const trainingOnly = context.calculateEnergyProjection([{ drain: 20, manualDrain: true }], [schedule[0], { day: 15, training: true, league: false, cup: false }], intensity);
    assert.equal(trainingOnly.rows[1].end[0], values.before);
  }
});

test('training selection persists and invalid or missing values fall back to Low', () => {
  const { context, read, storage } = harness();
  context.document = { getElementById: () => null };
  assert.equal(read('energyTrainingIntensity'), 'low');
  assert.equal(context.normalizeEnergyTrainingIntensity(null), 'low');
  assert.equal(context.normalizeEnergyTrainingIntensity('invalid'), 'low');
  context.setEnergyTrainingIntensity('high');
  assert.equal(storage.get('mfl_energy_training_intensity'), 'high');
  assert.equal(read('energyTrainingIntensity'), 'high');
  assert.equal(context.energyAfterTraining(8000), 7700);
  context.setEnergyTrainingIntensity('medium');
  assert.equal(context.energyAfterTraining(8000), 8000);
  assert.equal(read('renderCount'), 2);
});

test('saved low counts remain compatible and all six training/schedule counts stay separate', () => {
  const { context, read, storage } = harness();
  context.document = { getElementById: () => ({ querySelectorAll: () => [], querySelector: () => null }) };
  context.cacheEnergyModel({ ...model([]), complete: true, missingSources: [] });
  storage.set('mfl_energy_projection_counts_v2_wallet', JSON.stringify({ full: { [profile.key]: 4 }, limited: { [profile.key]: 1 } }));
  context.loadEnergyProjectionCounts();
  assert.equal(context.storedEnergyProjectionCount(profile.key, false, 'low'), 4);
  assert.equal(context.storedEnergyProjectionCount(profile.key, false, 'medium'), null);
  assert.equal(context.energyPoolReadyCount([profile]), 0);
  for (const intensity of ['medium', 'high']) {
    for (const limited of [false, true]) {
      read(`energyTrainingIntensity='${intensity}';energyLimitedSchedule=${limited};`);
      const count = intensity === 'medium' ? (limited ? 7 : 10) : (limited ? 18 : 25);
      context.updatePitchEnergyWarnings([{ index: 0, modelKey: profile.key }], {
        rows: [{ matchStarts: Array.from({ length: count }, () => ({ energies: [6000], resting: [false] })) }],
      });
      assert.equal(context.storedEnergyProjectionCount(profile.key), count);
    }
  }
  context.loadEnergyProjectionCounts();
  assert.equal(context.energyPoolReadyCount([profile]), 1);
  assert.equal(context.storedEnergyProjectionCount(profile.key, false, 'low'), 4);
  assert.equal(context.storedEnergyProjectionCount(profile.key, true, 'low'), 1);
  assert.equal(context.storedEnergyProjectionCount(profile.key, false, 'medium'), 10);
  assert.equal(context.storedEnergyProjectionCount(profile.key, true, 'high'), 18);
});
