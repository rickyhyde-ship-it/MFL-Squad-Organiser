const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function source(name) {
  const start = html.indexOf(`function ${name}(`);
  const end = html.indexOf('\nfunction ', start + 1);
  assert.ok(start >= 0 && end > start);
  return html.slice(start, end);
}
function harness(nextSeason = false) {
  const context = vm.createContext({ isNextSeasonMode: () => nextSeason });
  vm.runInContext(['projectedPlayerSeasons', 'playerProgression', 'matchesCareerFilters'].map(source).join('\n'), context);
  return context.matchesCareerFilters;
}
const player = (seasons, progression = 0) => ({ seasonsInGame: seasons, careerProgression: { overall: progression } });
test('checkboxes alone select first season, second season, or both', () => {
  const match = harness();
  for (const [first, second, expected] of [[false,false,[1,2,3]], [true,false,[1]], [false,true,[2]], [true,true,[1,2]]]) {
    assert.deepEqual([1,2,3].filter(season => match(player(season),null,null,null,null,first,second)), expected);
  }
});
test('selected seasons are added to season and progression range matches', () => {
  const match = harness();
  const cases = [[3,5,null,null], [null,null,4,8], [3,5,4,8]];
  for (const ranges of cases) {
    assert.equal(match(player(1,0),...ranges,true,false), true);
    assert.equal(match(player(2,0),...ranges,false,true), true);
    assert.equal(match(player(4,6),...ranges,true,true), true);
    assert.equal(match(player(6,9),...ranges,true,true), false);
  }
  assert.equal(match(player(4,0),3,5,4,8,true,true), false);
  assert.equal(match(player(6,6),3,5,4,8,true,true), false);
});
test('unchecked options preserve range filtering and unknown seasons do not match a checkbox', () => {
  const match = harness();
  assert.equal(match(player(1),3,null,null,null,false,false), false);
  assert.equal(match(player(null),null,null,null,null,true,true), false);
  assert.equal(match(player(null,5),null,null,4,null,true,true), true);
  assert.equal(match(player(null,5),1,null,4,null,true,true), false);
  assert.equal(match({seasonsInGame:1},3,null,4,null,true,false), true);
});
test('checkboxes use displayed next-season projection', () => {
  const match = harness(true);
  assert.equal(match(player(1),null,null,null,null,true,false), false);
  assert.equal(match(player(1),null,null,null,null,false,true), true);
  assert.equal(match(player(2),null,null,null,null,false,true), false);
});
test('clear all filters resets both season checkboxes', () => {
  const elements = {};
  let applied = false;
  const context = vm.createContext({ document: {getElementById: id => elements[id] ||= {checked:true,value:'5'}}, ALT_UPGRADE_DEFAULT_THRESHOLD:95, updateUpgradeFilterButton(){}, applyFilters(){applied=true;} });
  vm.runInContext(source('clearPlayerFilters'),context);
  context.clearPlayerFilters();
  assert.equal(elements.filterFirstSeason.checked,false);
  assert.equal(elements.filterSecondSeason.checked,false);
  assert.equal(applied,true);
});
test('both published HTML entry points stay identical', () => {
  assert.equal(html,fs.readFileSync(path.join(__dirname,'..','mfl-squad-organiser.html'),'utf8'));
});
