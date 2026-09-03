const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const directory = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(directory, 'index.html'), 'utf8');

function functionSource(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists in the builder`);
  const bodyStart = html.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < html.length; index++) {
    if (html[index] === '{') depth++;
    if (html[index] === '}' && --depth === 0) return html.slice(start, index + 1);
  }
  throw new Error(`${name} has a complete function body`);
}

function harness() {
  const context = vm.createContext({});
  vm.runInContext([
    functionSource('normalizeDivision'),
    functionSource('squadCompletionStage'),
    functionSource('advanceSquadCompletionStage'),
    functionSource('divisionClubCounts'),
    functionSource('divisionCountEntries'),
    functionSource('normalizeCollapsedDivisions'),
    functionSource('toggleDivisionGroup'),
  ].join('\n'), context);
  return context;
}

test('club tick cycles unmarked to orange to green and back to unmarked', () => {
  const context = harness();
  const squad = {};
  assert.equal(context.squadCompletionStage(squad), 0);
  assert.equal(context.advanceSquadCompletionStage(squad), 1);
  assert.equal(squad.completed, false);
  assert.equal(context.advanceSquadCompletionStage(squad), 2);
  assert.equal(squad.completed, true);
  assert.equal(context.advanceSquadCompletionStage(squad), 0);
  assert.equal(squad.completed, false);
});

test('legacy completed clubs remain green after the three-state upgrade', () => {
  const context = harness();
  assert.equal(context.squadCompletionStage({ completed: true }), 2);
  assert.equal(context.squadCompletionStage({ completed: false }), 0);
  assert.equal(context.squadCompletionStage({ completionStage: 1, completed: true }), 1);
});

test('division club counters include every division and normalize invalid values', () => {
  const context = harness();
  const counts = context.divisionClubCounts([
    { division: 1 }, { division: '1' }, { division: 4 }, { division: 10 }, { division: 99 },
  ]);
  assert.equal(counts[1], 2);
  assert.equal(counts[4], 1);
  assert.equal(counts[10], 2);
  assert.equal(Object.keys(counts).length, 10);
});

test('header counter entries omit divisions with no clubs', () => {
  const context = harness();
  const entries = context.divisionCountEntries([
    { division: 1 }, { division: 1 }, { division: 4 }, { division: 10 },
  ]);
  assert.equal(entries.length, 3);
  assert.deepEqual(Array.from(entries, entry => entry.division), [1, 4, 10]);
  assert.deepEqual(Array.from(entries, entry => entry.count), [2, 1, 1]);
});

test('collapsed division state accepts only valid division values', () => {
  const context = harness();
  const collapsed = context.normalizeCollapsedDivisions([1, '4', 10, 0, 11, 'bad', 4]);
  assert.deepEqual([...collapsed], [1, 4, 10]);
  assert.equal(context.normalizeCollapsedDivisions(null).size, 0);
});

test('division toggles collapse, expand, rerender and persist once per click', () => {
  const context = harness();
  vm.runInContext(`
    let collapsedDivisions=new Set(),renders=0,saves=0;
    function renderSquadList(){renders++;}
    function autoSave(){saves++;}
  `, context);
  context.toggleDivisionGroup(4);
  assert.deepEqual(Array.from(vm.runInContext('collapsedDivisions', context)), [4]);
  context.toggleDivisionGroup(4);
  assert.deepEqual(Array.from(vm.runInContext('collapsedDivisions', context)), []);
  assert.equal(vm.runInContext('renders', context), 2);
  assert.equal(vm.runInContext('saves', context), 2);
});

test('club list includes grouped counter and both visual status treatments', () => {
  assert.match(html, /id="headerDivisionCounts"/);
  assert.match(html, /class="header-division-count"/);
  assert.match(html, /class="division-list-count"/);
  assert.match(html, /class="division-list-toggle" aria-expanded=/);
  assert.match(html, /className='division-list-group'/);
  assert.match(html, /\.squad-list-item\.in-progress/);
  assert.match(html, /data-stage="\$\{stageName\}"/);
  assert.match(html, /aria-pressed="\$\{pressed\}"/);
});
