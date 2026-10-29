const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const labContext = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'energy-lab.js'), 'utf8'), labContext);
const core = labContext.energyLabCore;
const start = html.indexOf('const ENERGY_SCHEDULE=');
const end = html.indexOf('\nfunction toggleEnergyScheduleMode()', start);
const context = vm.createContext({ localStorage: {setItem(){}}, renderEnergyPlanner(){}, energyLimitedSchedule:false, energyExcludeCups:false });
vm.runInContext(html.slice(start, end), context);
test('Season 18 calendar and cup modes match the published dates', () => {
  const full = context.energyScheduleForMode(false);
  assert.equal(full.length, 29);
  assert.deepEqual(Array.from(full.filter(d => d.league), d => d.day), [1,2,3,4,5,7,8,9,10,11,13,17,18,20,21,22,23,24,25,26,27,29]);
  assert.deepEqual(Array.from(full.filter(d => d.cup), d => d.day), [6,7,9,10,12,14,19,21,23,28]);
  assert.equal(full.filter(d => d.training).length, 29);
  assert.equal(context.energyScheduleForMode(true).filter(d => d.cup).length, 6);
  assert.equal(context.energyScheduleForMode(true,true).filter(d => d.cup).length, 0);
  assert.equal(context.energyScheduleForMode(true,true).filter(d => d.league).length, 22);
});
test('training precedes cup and league in both projections', () => {
  const player = {startingEnergy:80,trainingIntensity:'low',threshold:15,starter:{}};
  const result = core.calculateProjection([player], [{day:7,training:true,cup:true,league:true}], {afterTraining:e=>e+400,energyUse:()=>({drainRaw:1000}),maxRaw:10000,floorRaw:1500});
  assert.equal(result.rows[0].afterTraining[0],8400);
  assert.deepEqual(Array.from(result.rows[0].matches, m=>[m.type,m.before[0]]), [['cup',8400],['league',7400]]);
  const fnStart = html.indexOf('function calculateEnergyProjection(');
  const fnEnd = html.indexOf('\n}', fnStart) + 2;
  const planner = vm.createContext({ENERGY_MAX_RAW:10000,ENERGY_FLOOR_RAW:1500,ENERGY_LOW_RAW:6000,energyAfterTraining:e=>e+400,energyUseFor:()=>({drainRaw:1000})});
  vm.runInContext(html.slice(fnStart, fnEnd), planner);
  const projected = planner.calculateEnergyProjection([{trainingIntensity:'low'}], [{day:7,training:true,cup:true,league:true}], 'low');
  assert.deepEqual(Array.from(projected.rows[0].matchStarts, m=>[m.type,m.energies[0]]), [['cup',10000+400],['league',9400]]);
});

test('cup switch updates the active schedule and saves its choice', () => {
  let saved;
  context.localStorage.setItem = (key, value) => { saved = [key, value]; };
  context.toggleEnergyCups();
  assert.deepEqual(saved, ['mfl_energy_exclude_cups', '1']);
  assert.equal(context.activeEnergySchedule().filter(day => day.cup).length, 0);
  context.toggleEnergyCups();
  assert.deepEqual(saved, ['mfl_energy_exclude_cups', '0']);
  assert.equal(context.activeEnergySchedule().filter(day => day.cup).length, 10);
});
