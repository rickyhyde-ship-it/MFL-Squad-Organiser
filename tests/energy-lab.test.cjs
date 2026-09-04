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
    threshold: 60,
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
});

test('threshold rests are strict: equal plays, lower rests and recovers 65% of missing energy', () => {
  const projection = calculateProjection(
    [player({ startingEnergy: 60, threshold: 60 }), player({ startingEnergy: 59, threshold: 60 })],
    [{ day: 1, training: false, league: true, cup: false }],
    hooks,
  );
  const outcomes = projection.rows[0].matches[0].outcomes;
  assert.equal(outcomes[0].resting, false);
  assert.equal(outcomes[1].resting, true);
  assert.equal(projection.final[0], 3500);
  assert.equal(projection.final[1], 8565);
  assert.equal(projection.autoRests, 1);
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
