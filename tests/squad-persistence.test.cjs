const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
function source(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0);
  let depth = 0;
  for (let i = html.indexOf('{', start); i < html.length; i++) {
    if (html[i] === '{') depth++;
    if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
  }
}
function harness(storage = new Map(), reject = () => false) {
  const elements = new Map();
  const context = vm.createContext({
    console: { warn() {} },
    document: { getElementById(id) {
      if (!elements.has(id)) elements.set(id, { value: '', style: {}, textContent: '', classList: { add() {} } });
      return elements.get(id);
    } },
    localStorage: {
      get length() { return storage.size; },
      key(index) { return [...storage.keys()][index] ?? null; },
      getItem(key) { return storage.get(key) ?? null; },
      setItem(key, value) { if (reject(key, value)) throw new Error('QuotaExceededError'); storage.set(key, value); },
    },
  });
  vm.runInContext(`
    let squadStorageKey=null, squads=[], allPlayers=[], activeSquadId=null;
    let collapsedDivisions=new Set(), clubsInitialized=false, viewerMode=false, careerScanWallet='';
    function buildSquadPlayerCache(){return [{id:'1',name:'Player One'}];}
    async function fetchOwnedClubs(){return [];}
    async function fetchPlayerProgressions(){return {};}
    async function fetchAllOwnedPlayers(){return [{id:'1',ovr:80}];}
    function mapApiPlayer(player){return player;}
    function applyCareerCache(){}
    function loadEnergyProjectionCounts(){}
    function normalizeCollapsedDivisions(value){return new Set(value||[]);}
    function mergeOwnedClubs(){}
    function launchApp(){autoSave();}
    function setClubSyncStatus(){}
    ${['resolveSquadStorageKey','setSquadSaveStatus','autoSave'].map(source).join('\n')}
    async ${source('loadPlayers')}
  `, context);
  return { context, storage, elements, run: code => vm.runInContext(code, context) };
}

test('squad edits survive reload even when optional player cache exceeds storage quota', async () => {
  const storage = new Map([['mfl_last_wallet','0xabc']]);
  const reject = (key, value) => key.startsWith('mfl_squads') && value.includes('playerCache');
  const first = harness(storage, reject);
  first.run(`squads=[{id:'club',starters:[{playerId:'1'}],energyLowTrainingDays:{15:true}}];activeSquadId='club';clubsInitialized=true;`);
  assert.equal(first.context.autoSave(), true);
  const refreshed = harness(storage, reject);
  refreshed.context.document.getElementById('walletInput').value = '0xabc';
  await refreshed.context.loadPlayers();
  assert.equal(refreshed.run('squads[0].starters[0].playerId'), '1');
  assert.equal(refreshed.run('squads[0].energyLowTrainingDays[15]'), true);
  assert.equal(refreshed.run('activeSquadId'), 'club');
});

test('opening another wallet in a second tab cannot redirect edits', async () => {
  const h = harness();
  h.context.document.getElementById('walletInput').value = '0xabc';
  await h.context.loadPlayers();
  h.storage.set('mfl_last_wallet', '0xdef');
  h.run(`squads=[{id:'club',name:'Edited'}];`);
  assert.equal(h.context.autoSave(), true);
  assert.equal(JSON.parse(h.storage.get('mfl_squads_0xabc')).squads[0].name, 'Edited');
  assert.equal(h.storage.has('mfl_squads_0xdef'), false);
});

test('loading a differently capitalised wallet restores its legacy save', async () => {
  const h = harness(new Map([['mfl_squads_0xAbC', JSON.stringify({squads:[{id:'legacy'}],clubsInitialized:true})]]));
  h.context.document.getElementById('walletInput').value = '0xabc';
  await h.context.loadPlayers();
  assert.equal(h.run('squads[0].id'), 'legacy');
  assert.equal(h.run('squadStorageKey'), 'mfl_squads_0xAbC');
});

test('a failed save preserves the previous data and visibly warns before refresh', () => {
  const previous = JSON.stringify({squads:[{id:'old'}]});
  let blocked = true;
  const h = harness(new Map([['mfl_last_wallet','0xabc'],['mfl_squads_0xabc',previous]]), () => blocked);
  h.run(`squads=[{id:'new'}];`);
  assert.equal(h.context.autoSave(), false);
  assert.equal(h.storage.get('mfl_squads_0xabc'), previous);
  assert.match(h.elements.get('squadSaveStatus').textContent, /Export your session before refreshing/);
  blocked = false;
  assert.equal(h.context.autoSave(), true);
  assert.match(h.elements.get('squadSaveStatus').textContent, /changes saved/);
});

test('read-only viewer never saves', () => {
  const h = harness();
  h.run('viewerMode=true');
  h.context.autoSave();
  assert.equal(h.storage.size, 0);
});

test('both published HTML entry points contain the same persistence fix', () => {
  assert.equal(html, fs.readFileSync(path.join(__dirname, '../mfl-squad-organiser.html'), 'utf8'));
});
