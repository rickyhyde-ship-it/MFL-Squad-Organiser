const assert = require('node:assert/strict');
const { test } = require('node:test');

require('../energy-lab.js');

const { calculateProjection } = global.energyLabCore;

const hooks = {
  maxRaw: 10000,
  floorRaw: 1500,
  recoveryRate: 0.65,
  afterTraining(energy, intensity) {
    if (intensity === 'medium') return energy;
    if (intensity === 'high') return Math.max(1500, Math.round(energy - 100 - (10000 - energy) * 0.1));
    return Math.round(energy + (10000 - energy) * 0.2);
  },
  energyUse(starter) {
    return { source: 'test', drainRaw: starter.drainRaw, sampleSize: 10 };
  },
};

function player(overrides = {}) {
  return {
    startingEnergy: 100,
    trainingIntensity: 'medium',
    threshold: 89,
    starter: { drainRaw: 2500 },
    ...overrides,
  };
}

test('Energy Lab keeps every player in one projection while honoring individual settings', () => {
  const projection = calculateProjection(
    [player(), player({ startingEnergy: 80, trainingIntensity: 'low', threshold: 75, starter: { drainRaw: 1000 } })],
    [{ day: 1, training: true, league: true, cup: false }],
    hooks,
  );
  assert.deepEqual(projection.rows[0].afterTraining, [10000, 8400]);
  assert.deepEqual(projection.final, [7500, 7400]);
  assert.equal(projection.rows[0].matches[0].outcomes.length, 2);
  assert.equal(projection.gamesPlayed, 2);
  assert.deepEqual(projection.gamesPlayedByPlayer, [1, 1]);
});

test('threshold rests are inclusive: equal and lower rest, higher plays', () => {
  const projection = calculateProjection(
    [player({ startingEnergy: 60, threshold: 60 }), player({ startingEnergy: 59, threshold: 60 }), player({ startingEnergy: 61, threshold: 60 })],
    [{ day: 1, training: false, league: true, cup: false }],
    hooks,
  );
  const outcomes = projection.rows[0].matches[0].outcomes;
  assert.equal(outcomes[0].resting, true);
  assert.equal(outcomes[1].resting, true);
  assert.equal(outcomes[2].resting, false);
  assert.equal(projection.final[0], 8600);
  assert.equal(projection.final[1], 8565);
  assert.equal(projection.final[2], 3600);
  assert.equal(projection.autoRests, 2);
  assert.equal(projection.gamesPlayed, 1);
  assert.deepEqual(projection.gamesPlayedByPlayer, [0, 0, 1]);
});

test('auto-rest uses retirement-tier recovery rates', () => {
  const projection = calculateProjection(
    [
      player({ startingEnergy: 60, threshold: 60, starter: { drainRaw: 2500 } }),
      player({ startingEnergy: 60, threshold: 60, starter: { drainRaw: 2500, player: { retireIn: 3 } } }),
      player({ startingEnergy: 60, threshold: 60, starter: { drainRaw: 2500, player: { retireIn: 2 } } }),
      player({ startingEnergy: 60, threshold: 60, starter: { drainRaw: 2500, player: { retireIn: 1 } } }),
    ],
    [{ day: 1, training: false, league: true, cup: false }],
    hooks,
  );
  assert.deepEqual(projection.final, [8600, 8600, 8200, 7400]);
});

test('missing thresholds use the 89% default rest limit', () => {
  const projection = calculateProjection(
    [player({ startingEnergy: 89, threshold: undefined })],
    [{ day: 1, training: false, league: true, cup: false }],
    hooks,
  );
  assert.equal(projection.rows[0].matches[0].outcomes[0].resting, true);
  assert.equal(projection.gamesPlayed, 0);
});

test('double-match days re-check the threshold after the first game', () => {
  const projection = calculateProjection(
    [player({ startingEnergy: 80, threshold: 60 })],
    [{ day: 7, training: false, league: true, cup: true }],
    hooks,
  );
  assert.equal(projection.rows[0].matches[0].outcomes[0].resting, false);
  assert.equal(projection.rows[0].matches[1].before[0], 5500);
  assert.equal(projection.rows[0].matches[1].outcomes[0].resting, true);
  assert.equal(projection.final[0], 8425);
});
