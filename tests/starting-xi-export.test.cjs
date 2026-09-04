const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'starting-xi-export.js'), 'utf8');

function createContext(overrides = {}) {
  const starters = overrides.starters || [
    {
      slot: { slotPos: 'GK' },
      player: { id: 7, name: 'Test Keeper', ovr: 86, age: 29, retireIn: null },
      trainingIntensity: 'medium',
      drain: 4,
      manualDrain: false,
      modelKey: 'keeper-model'
    }
  ];
  const schedule = [{ day: 1, training: true, league: true, cup: false }];
  const projection = {
    rows: [{
      scheduleDay: schedule[0],
      afterTraining: [10000],
      end: [9550],
      matchStarts: [{ match: 1, playingCount: 1, tiredCount: 0, blocked: false, resting: [false], energies: [10000], after: [9550] }]
    }],
    final: [9550],
    lowest: 9550,
    warningStarts: 0,
    firstWarning: null
  };
  const context = vm.createContext({
    window: {},
    console,
    ENERGY_MAX_RAW: 10000,
    energyLimitedSchedule: false,
    energyTrainingIntensity: 'low',
    activeSquad: () => ({ name: 'Test XI', division: 3 }),
    getEnergyStarters: () => starters,
    energyModelsPending: () => Boolean(overrides.pending),
    activeEnergySchedule: () => schedule,
    calculateEnergyProjection: () => projection,
    modelPredictionFor: entry => entry.manualDrain ? null : { drainRaw: 450, sampleSize: 12, tier: 'standard' },
    projectedRetirementYears: () => null,
    document: {},
    requestAnimationFrame: callback => callback(),
    setTimeout,
    URL,
    Date,
    Number,
    Math
  });
  vm.runInContext(source, context);
  return context;
}

test('Starting XI PNG snapshot includes squad, player, model and projection data', () => {
  const context = createContext();
  const snapshot = context.window.buildStartingXiEnergyExportSnapshot();
  assert.equal(snapshot.squad.name, 'Test XI');
  assert.equal(snapshot.matches, 1);
  assert.equal(snapshot.starters[0].player.name, 'Test Keeper');
  assert.equal(snapshot.starters[0].model.drain, '4.5%');
  assert.match(snapshot.starters[0].model.source, /12 comparable matches/);
  assert.equal(snapshot.projection.rows[0].matchStarts[0].energies[0], 10000);
});

test('Starting XI PNG export waits for historic evidence', () => {
  const context = createContext({ pending: true });
  assert.throws(
    () => context.window.buildStartingXiEnergyExportSnapshot(),
    /historic energy evidence/
  );
});

test('Starting XI PNG export requires at least one starter', () => {
  const context = createContext({ starters: [] });
  assert.throws(
    () => context.window.buildStartingXiEnergyExportSnapshot(),
    /Add players to the Starting XI/
  );
});
