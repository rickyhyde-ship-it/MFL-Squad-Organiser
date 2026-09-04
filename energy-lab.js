(function (global) {
  'use strict';

  const COLORS = ['#b976ff', '#48f59a', '#ffb347', '#55c8ff', '#f587c7'];
  const DASHES = ['', '8 5', '3 4'];
  const STORAGE_KEY = 'mfl_energy_lab_v1';
  const state = { players: [], projection: null, modelStatus: '', exportBusy: false };
  const readyModelKeys = new Set();
  let serial = 0;
  let toastTimer = null;

  function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
  }

  function calculateProjection(players, schedule, hooks) {
    const applyTraining = hooks?.afterTraining || global.energyAfterTraining;
    const getUse = hooks?.energyUse || global.energyUseFor;
    const maxRaw = Number(hooks?.maxRaw ?? global.ENERGY_MAX_RAW ?? 10000);
    const floorRaw = Number(hooks?.floorRaw ?? global.ENERGY_FLOOR_RAW ?? 1500);
    const recoveryRate = Number(hooks?.recoveryRate ?? global.ENERGY_REST_RECOVERY ?? .65);
    let energies = players.map(player => Math.round(clampNumber(player.startingEnergy, 15, 100, 100) * 100));
    let autoRests = 0;
    let lowest = energies.length ? Math.min(...energies) : maxRaw;
    const rows = [];

    schedule.forEach(scheduleDay => {
      const start = energies.slice();
      if (scheduleDay.training) {
        energies = energies.map((energy, index) => applyTraining(energy, players[index].trainingIntensity));
      }
      const afterTraining = energies.slice();
      const matchTypes = ['league', 'cup'].filter(type => scheduleDay[type]);
      const matches = [];

      matchTypes.forEach((type, matchIndex) => {
        const before = energies.slice();
        const outcomes = players.map((player, index) => {
          const thresholdRaw = Math.round(clampNumber(player.threshold, 15, 100, 60) * 100);
          const resting = before[index] < thresholdRaw;
          if (resting) {
            const recoveryRaw = Math.round((maxRaw - before[index]) * recoveryRate);
            autoRests += 1;
            return { resting: true, beforeRaw: before[index], drainRaw: 0, recoveryRaw, source: 'auto-rest', sampleSize: 0 };
          }
          const use = getUse(player.starter, before[index]);
          return { resting: false, beforeRaw: before[index], recoveryRaw: 0, ...use };
        });
        energies = energies.map((energy, index) => outcomes[index].resting
          ? Math.min(maxRaw, energy + outcomes[index].recoveryRaw)
          : Math.max(floorRaw, energy - outcomes[index].drainRaw));
        matches.push({ match: matchIndex + 1, type, before, outcomes, after: energies.slice() });
      });

      const end = energies.slice();
      if (end.length) lowest = Math.min(lowest, ...end);
      rows.push({ scheduleDay, start, afterTraining, matches, end });
    });

    return { rows, final: energies.slice(), autoRests, lowest };
  }

  global.energyLabCore = { calculateProjection, clampNumber };
  if (!global.document) return;

  function positions() {
    return typeof POSITION_ORDER !== 'undefined' && Array.isArray(POSITION_ORDER) && POSITION_ORDER.length
      ? POSITION_ORDER
      : ['GK','RB','RWB','CB','LB','LWB','CDM','RM','CM','LM','CAM','RW','CF','LW','ST'];
  }

  function schedule() {
    return typeof activeEnergySchedule === 'function' ? activeEnergySchedule() : (typeof ENERGY_SCHEDULE !== 'undefined' ? ENERGY_SCHEDULE : []);
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  function playerColor(index) { return COLORS[index % COLORS.length]; }
  function playerDash(index) { return DASHES[Math.floor(index / COLORS.length) % DASHES.length]; }
  function percent(raw) { return Math.ceil(Number(raw) / 100); }
  function initials(name) { return String(name || 'P').split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase(); }

  function saveState() {
    try {
      const compact = state.players.map(item => ({
        id: item.id,
        position: item.position,
        startingEnergy: item.startingEnergy,
        trainingIntensity: item.trainingIntensity,
        threshold: item.threshold,
      }));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(compact));
    } catch (_) {}
  }

  function readState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      return Array.isArray(saved) ? saved.slice(0, 15) : [];
    } catch (_) { return []; }
  }

  function showToast(message) {
    const toast = document.getElementById('energyLabToast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2600);
  }

  function setFormStatus(message, error) {
    const status = document.getElementById('energyLabFormStatus');
    if (!status) return;
    status.textContent = message;
    status.classList.toggle('is-error', Boolean(error));
  }

  function normalizePlayer(raw) {
    if (!raw) return null;
    return typeof mapApiPlayer === 'function' && raw.metadata ? mapApiPlayer(raw) : raw;
  }

  async function fetchPlayer(id) {
    const owned = typeof allPlayers !== 'undefined' && Array.isArray(allPlayers) ? allPlayers.find(player => String(player.id) === String(id)) : null;
    if (owned) return owned;
    const base = typeof API_BASE !== 'undefined' ? API_BASE : 'https://z519wdyajg.execute-api.us-east-1.amazonaws.com/prod';
    const response = await fetch(`${base}/players/${encodeURIComponent(id)}`);
    if (response.status === 404) throw new Error(`Player ${id} was not found.`);
    if (!response.ok) throw new Error(`Player ${id} lookup failed (${response.status}).`);
    const payload = await response.json();
    const raw = payload?.player || (Array.isArray(payload) ? payload[0] : payload?.data || payload);
    const player = normalizePlayer(raw);
    if (!player) throw new Error(`Player ${id} has no active profile.`);
    return player;
  }

  function playerAtPosition(player, position) {
    const overall = player?.metadata && typeof ovrAtPosition === 'function'
      ? ovrAtPosition(player.metadata, position)
      : Number(player?.ovr || 0);
    return { ...player, ovr: overall };
  }

  function makeStarter(item) {
    const modelPlayer = playerAtPosition(item.player, item.position);
    const entry = {
      slot: { slotPos: item.position },
      index: state.players.indexOf(item),
      player: modelPlayer,
      trainingIntensity: item.trainingIntensity,
      drain: typeof defaultEnergyDrainFor === 'function' ? defaultEnergyDrainFor(modelPlayer) : 4,
      manualDrain: false,
    };
    const profile = typeof energyProfileFor === 'function' ? energyProfileFor(entry) : null;
    return { ...entry, profile, modelKey: profile && typeof energyModelKey === 'function' ? energyModelKey(profile) : null };
  }

  async function ensureModels() {
    const profiles = new Map();
    state.players.forEach(item => {
      item.starter = makeStarter(item);
      if (item.starter.profile && item.starter.modelKey && !readyModelKeys.has(item.starter.modelKey)) {
        profiles.set(item.starter.modelKey, { key: item.starter.modelKey, ...item.starter.profile });
      }
    });
    if (!profiles.size) {
      state.modelStatus = state.players.length ? 'Historic model ready · auto-rest simulation active' : '';
      return;
    }
    state.modelStatus = `Checking historic evidence for ${profiles.size} profile${profiles.size === 1 ? '' : 's'}…`;
    renderStatus();
    try {
      const payload = await fetchPooledEnergyModels([...profiles.values()]);
      payload.models.forEach(model => { cacheEnergyModel(model); readyModelKeys.add(model.key); });
      const missing = [...new Set(payload.models.flatMap(model => model.missingSources || []))];
      state.modelStatus = missing.length
        ? `Partial historic model · ${missing.join(', ')} unavailable · fallback active where needed`
        : `Pooled historic model ready · ${payload.models.length} profile${payload.models.length === 1 ? '' : 's'} · two datasets`;
    } catch (error) {
      state.modelStatus = 'Historic evidence unavailable · retirement-based fallback drain active';
      console.warn('[Energy Lab]', error);
    }
  }

  async function addPlayers() {
    const input = document.getElementById('energyLabIds');
    const button = document.getElementById('energyLabAdd');
    const defaultPosition = document.getElementById('energyLabDefaultPosition')?.value || 'CM';
    const ids = [...new Set(String(input?.value || '').split(/[\s,;]+/).map(value => value.trim()).filter(Boolean))];
    const invalid = ids.filter(id => !/^\d+$/.test(id) || Number(id) <= 0);
    const existing = new Set(state.players.map(item => item.id));
    const pending = ids.filter(id => !invalid.includes(id) && !existing.has(id));
    if (!ids.length) { setFormStatus('Enter one or more numeric player IDs.', true); input?.focus(); return; }
    if (invalid.length) { setFormStatus(`Invalid ID${invalid.length === 1 ? '' : 's'}: ${invalid.join(', ')}`, true); return; }
    if (!pending.length) { setFormStatus('Those players are already in the comparison.', true); return; }
    button.disabled = true;
    button.textContent = 'Loading…';
    setFormStatus(`Loading ${pending.length} player${pending.length === 1 ? '' : 's'}…`);
    try {
      const results = await Promise.allSettled(pending.map(fetchPlayer));
      const failures = [];
      results.forEach((result, index) => {
        if (result.status === 'rejected') { failures.push(result.reason?.message || `Player ${pending[index]} failed.`); return; }
        const player = result.value;
        const registered = Array.isArray(player.metadata?.positions) ? player.metadata.positions : String(player.positions || '').split(',').map(value => value.trim()).filter(Boolean);
        state.players.push({
          uid: `energy-player-${++serial}`,
          id: String(player.id),
          player,
          position: positions().includes(defaultPosition) ? defaultPosition : (registered[0] || 'CM'),
          startingEnergy: 100,
          trainingIntensity: 'low',
          threshold: 60,
          starter: null,
        });
      });
      input.value = '';
      renderRoster();
      await recalculate();
      setFormStatus(failures.length ? failures.join(' ') : `${pending.length} player${pending.length === 1 ? '' : 's'} added to the same projection.`, failures.length > 0);
    } finally {
      button.disabled = false;
      button.textContent = 'Add to projection';
    }
  }

  async function restorePlayers() {
    const saved = readState();
    if (!saved.length) { renderAll(); return; }
    setFormStatus(`Restoring ${saved.length} saved player${saved.length === 1 ? '' : 's'}…`);
    const results = await Promise.allSettled(saved.map(item => fetchPlayer(item.id)));
    results.forEach((result, index) => {
      if (result.status !== 'fulfilled') return;
      const savedItem = saved[index];
      state.players.push({
        uid: `energy-player-${++serial}`,
        id: String(result.value.id),
        player: result.value,
        position: positions().includes(savedItem.position) ? savedItem.position : 'CM',
        startingEnergy: clampNumber(savedItem.startingEnergy, 15, 100, 100),
        trainingIntensity: ['low', 'medium', 'high'].includes(savedItem.trainingIntensity) ? savedItem.trainingIntensity : 'low',
        threshold: clampNumber(savedItem.threshold, 15, 100, 60),
        starter: null,
      });
    });
    renderRoster();
    await recalculate();
    setFormStatus(state.players.length ? `${state.players.length} saved player${state.players.length === 1 ? '' : 's'} restored.` : 'Saved players could not be restored.', !state.players.length);
  }

  async function recalculate() {
    saveState();
    if (!state.players.length) {
      state.projection = null;
      state.modelStatus = '';
      renderOutputs();
      return;
    }
    await ensureModels();
    state.players.forEach(item => { item.starter = makeStarter(item); });
    state.projection = calculateProjection(state.players, schedule(), {
      afterTraining: energyAfterTraining,
      energyUse: energyUseFor,
      maxRaw: typeof ENERGY_MAX_RAW !== 'undefined' ? ENERGY_MAX_RAW : 10000,
      floorRaw: typeof ENERGY_FLOOR_RAW !== 'undefined' ? ENERGY_FLOOR_RAW : 1500,
      recoveryRate: typeof ENERGY_REST_RECOVERY !== 'undefined' ? ENERGY_REST_RECOVERY : .65,
    });
    renderOutputs();
  }

  function renderRoster() {
    const root = document.getElementById('energyLabPlayers');
    if (!root) return;
    if (!state.players.length) {
      root.innerHTML = '<div class="energy-lab-empty-roster">Add player IDs to begin. Every player you add will share one season chart and one daily table.</div>';
      return;
    }
    const options = positions().map(position => `<option value="${position}">${position}</option>`).join('');
    root.innerHTML = state.players.map((item, index) => {
      const overall = playerAtPosition(item.player, item.position).ovr;
      const dash = playerDash(index) ? ' · dashed line' : '';
      return `<article class="energy-lab-player" style="--player-color:${playerColor(index)};animation-delay:${Math.min(index * 45, 270)}ms" data-uid="${item.uid}">
        <div class="energy-lab-player-swatch" aria-hidden="true">${escapeHtml(initials(item.player.name))}</div>
        <div><div class="energy-lab-player-name">${escapeHtml(item.player.name)}</div><div class="energy-lab-player-meta">ID ${escapeHtml(item.id)} · ${Math.round(overall)} OVR${dash}</div></div>
        <button class="energy-lab-player-remove" type="button" data-action="remove" aria-label="Remove ${escapeHtml(item.player.name)}" title="Remove player">×</button>
        <div class="energy-lab-player-controls">
          <label class="energy-lab-field"><span>Playing position</span><select data-field="position" aria-label="Position for ${escapeHtml(item.player.name)}">${options}</select></label>
          <label class="energy-lab-field"><span>Starting energy</span><input data-field="startingEnergy" type="number" min="15" max="100" step="1" value="${item.startingEnergy}" inputmode="decimal" aria-label="Starting energy percentage for ${escapeHtml(item.player.name)}"></label>
          <label class="energy-lab-field"><span>Rest below</span><input data-field="threshold" type="number" min="15" max="100" step="1" value="${item.threshold}" inputmode="decimal" aria-label="Minimum match start percentage for ${escapeHtml(item.player.name)}"></label>
          <label class="energy-lab-field" style="grid-column:1/-1"><span>Training intensity</span><select data-field="trainingIntensity" aria-label="Training intensity for ${escapeHtml(item.player.name)}"><option value="low">Low · recover 20% missing</option><option value="medium">Medium · no change</option><option value="high">High · energy cost</option></select></label>
        </div>
      </article>`;
    }).join('');
    root.querySelectorAll('.energy-lab-player').forEach((card, index) => {
      const item = state.players[index];
      card.querySelector('[data-field="position"]').value = item.position;
      card.querySelector('[data-field="trainingIntensity"]').value = item.trainingIntensity;
    });
  }

  function renderStatus() {
    const status = document.getElementById('energyLabModelStatus');
    if (status) status.textContent = state.modelStatus || 'Add players to load historic energy evidence.';
  }

  function renderSummary() {
    const matchCount = schedule().reduce((sum, day) => sum + Number(day.league) + Number(day.cup), 0);
    const lowest = state.projection ? `${percent(state.projection.lowest)}%` : '—';
    const rests = state.projection ? state.projection.autoRests : 0;
    const fields = [
      ['Players', state.players.length, 'one shared chart'],
      ['Matches', matchCount, matchCount === 28 ? '28-game schedule' : 'full schedule'],
      ['Auto-rests', rests, 'threshold decisions'],
      ['Lowest close', lowest, 'daily end energy'],
    ];
    const root = document.getElementById('energyLabHeroMeta');
    if (root) root.innerHTML = fields.map(([label, value, note]) => `<div class="energy-lab-hero-stat"><span>${label}</span><strong>${value}</strong><small>${note}</small></div>`).join('');
  }

  function chartGeometry(width, height) {
    const margin = { left: 54, right: 24, top: 24, bottom: 47 };
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;
    const maxDay = Math.max(1, ...schedule().map(day => day.day));
    const x = day => margin.left + (Number(day) / maxDay) * innerWidth;
    const y = raw => margin.top + ((100 - clampNumber(Number(raw) / 100, 15, 100, 100)) / 85) * innerHeight;
    return { margin, innerWidth, innerHeight, maxDay, x, y };
  }

  function renderChart() {
    const root = document.getElementById('energyLabChartWrap');
    const legend = document.getElementById('energyLabLegend');
    if (!root || !legend) return;
    if (!state.projection || !state.players.length) {
      root.innerHTML = '<div class="energy-lab-chart-empty">The season energy chart will appear here after you add a player.</div>';
      legend.innerHTML = '';
      return;
    }
    const width = 1000, height = 430, geo = chartGeometry(width, height);
    const yTicks = [20, 40, 60, 80, 100];
    const xTicks = [0, 5, 10, 15, 20, 25, 30, geo.maxDay].filter((value, index, values) => value <= geo.maxDay && values.indexOf(value) === index);
    const grid = yTicks.map(tick => `<line class="grid-line" x1="${geo.margin.left}" y1="${geo.y(tick * 100)}" x2="${width - geo.margin.right}" y2="${geo.y(tick * 100)}"></line><text class="axis-label" x="${geo.margin.left - 10}" y="${geo.y(tick * 100) + 3}" text-anchor="end">${tick}%</text>`).join('')
      + xTicks.map(tick => `<line class="grid-line" x1="${geo.x(tick)}" y1="${geo.margin.top}" x2="${geo.x(tick)}" y2="${height - geo.margin.bottom}" opacity=".55"></line><text class="axis-label" x="${geo.x(tick)}" y="${height - 18}" text-anchor="middle">D${tick}</text>`).join('');
    const thresholds = state.players.map((item, index) => `<line class="threshold-line" x1="${geo.margin.left}" y1="${geo.y(item.threshold * 100)}" x2="${width - geo.margin.right}" y2="${geo.y(item.threshold * 100)}" stroke="${playerColor(index)}"><title>${escapeHtml(item.player.name)} rests below ${item.threshold}%</title></line>`).join('');
    const series = state.players.map((item, index) => {
      const points = [{ day: 0, value: item.startingEnergy * 100 }, ...state.projection.rows.map(row => ({ day: row.scheduleDay.day, value: row.end[index] }))];
      const d = points.map((point, pointIndex) => `${pointIndex ? 'L' : 'M'} ${geo.x(point.day).toFixed(2)} ${geo.y(point.value).toFixed(2)}`).join(' ');
      const dash = playerDash(index);
      const dots = points.map(point => `<circle class="player-point" cx="${geo.x(point.day)}" cy="${geo.y(point.value)}" r="2.2" fill="#0e151e" stroke="${playerColor(index)}"><title>${escapeHtml(item.player.name)} · Day ${point.day} close · ${percent(point.value)}%</title></circle>`).join('');
      const rests = state.projection.rows.flatMap(row => row.matches.flatMap(match => match.outcomes[index].resting ? [{ day: row.scheduleDay.day, value: match.before[index], match: match.match, type: match.type }] : [])).map(rest => {
        const cx = geo.x(rest.day), cy = geo.y(rest.value), size = 5;
        return `<path class="rest-point" d="M ${cx} ${cy-size} L ${cx+size} ${cy} L ${cx} ${cy+size} L ${cx-size} ${cy} Z" stroke="${playerColor(index)}"><title>${escapeHtml(item.player.name)} · Auto-rested Day ${rest.day} G${rest.match} at ${percent(rest.value)}%</title></path>`;
      }).join('');
      return `<g><path class="player-line" d="${d}" stroke="${playerColor(index)}"${dash ? ` stroke-dasharray="${dash}"` : ''}></path>${dots}${rests}</g>`;
    }).join('');
    root.innerHTML = `<svg class="energy-lab-chart" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="energyLabChartTitle energyLabChartDesc"><title id="energyLabChartTitle">All-player daily energy through the season</title><desc id="energyLabChartDesc">Each line shows one player's end-of-day energy. Dashed horizontal lines show individual match-start thresholds. Diamond markers show automatic rests.</desc>${grid}${thresholds}${series}</svg>`;
    legend.innerHTML = state.players.map((item, index) => `<span class="energy-lab-legend-item" style="--player-color:${playerColor(index)}"><i class="energy-lab-legend-line${playerDash(index) ? ' is-dashed' : ''}"></i><span><strong>${escapeHtml(item.player.name)}</strong> · ${item.position} · rest &lt;${item.threshold}%</span></span>`).join('') + '<span class="energy-lab-legend-item"><span style="color:#d0a8ff;font-size:15px">◇</span><span>Auto-rest</span></span>';
  }

  function scheduleLabel(day) {
    const events = [];
    if (day.training) events.push('Training');
    if (day.league) events.push('League');
    if (day.cup) events.push('Cup');
    return events.length ? events.join(' · ') : 'Recovery day';
  }

  function renderTable() {
    const table = document.getElementById('energyLabTable');
    if (!table) return;
    if (!state.projection || !state.players.length) {
      table.innerHTML = '<tbody><tr><td class="energy-lab-table-empty">Daily energy values will appear after players are added.</td></tr></tbody>';
      return;
    }
    const headers = state.players.map((item, index) => `<th scope="col" style="--player-color:${playerColor(index)}">${escapeHtml(item.player.name)}<br><span style="color:${playerColor(index)}">${item.position} · ${item.trainingIntensity}</span></th>`).join('');
    const rows = state.projection.rows.map(row => {
      const cells = state.players.map((item, index) => {
        const matchEvents = row.matches.map(match => {
          const outcome = match.outcomes[index];
          const css = outcome.resting ? 'is-rest' : outcome.beforeRaw < item.threshold * 100 ? 'is-low' : '';
          const action = outcome.resting ? `REST → ${percent(match.after[index])}%` : `PLAY −${(outcome.drainRaw / 100).toFixed(1)}%`;
          return `<span class="${css}">G${match.match} ${match.type === 'league' ? 'LGE' : 'CUP'} · ${percent(outcome.beforeRaw)}% · ${action}</span>`;
        });
        if (!matchEvents.length) matchEvents.push(`<span>${row.scheduleDay.training ? `Training → ${percent(row.afterTraining[index])}%` : 'No energy change'}</span>`);
        return `<td style="--player-color:${playerColor(index)}"><div class="energy-lab-cell-value"><span>Close</span><strong>${percent(row.end[index])}%</strong></div><div class="energy-lab-cell-events">${matchEvents.join('')}</div></td>`;
      }).join('');
      return `<tr><th scope="row" class="energy-lab-day">D${row.scheduleDay.day}</th><td class="energy-lab-schedule">${escapeHtml(scheduleLabel(row.scheduleDay))}</td>${cells}</tr>`;
    }).join('');
    table.innerHTML = `<caption class="sr-only">Daily running energy for every player in the Energy Lab projection</caption><thead><tr><th scope="col">Day</th><th scope="col">Schedule</th>${headers}</tr></thead><tbody>${rows}</tbody>`;
  }

  function renderOutputs() {
    renderStatus();
    renderSummary();
    renderChart();
    renderTable();
    const exportButton = document.getElementById('energyLabExportButton');
    if (exportButton) exportButton.disabled = !state.projection || state.exportBusy;
  }

  function renderAll() { renderRoster(); renderOutputs(); }

  function setPage(page) {
    if (typeof viewerMode !== 'undefined' && viewerMode) return;
    const energy = page === 'energy';
    document.body.classList.toggle('energy-lab-active', energy);
    const lab = document.getElementById('energyLabPage');
    if (lab) lab.hidden = !energy;
    document.querySelectorAll('.app-page-tab').forEach(button => {
      const active = button.dataset.page === (energy ? 'energy' : 'squad');
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
    });
    try { history.replaceState(null, '', energy ? '#energy-lab' : location.pathname + location.search); } catch (_) {}
    if (energy) {
      renderAll();
      requestAnimationFrame(() => document.getElementById('energyLabIds')?.focus({ preventScroll: true }));
    } else if (typeof allPlayers !== 'undefined' && !allPlayers.length && typeof squads !== 'undefined' && !squads.length) {
      document.getElementById('appScreen').style.display='none';
      document.getElementById('uploadScreen').style.display='flex';
    }
  }

  function openEnergyLab() {
    document.getElementById('uploadScreen').style.display='none';
    document.getElementById('appScreen').style.display='block';
    setPage('energy');
  }

  function updateItem(uid, field, value) {
    const item = state.players.find(player => player.uid === uid);
    if (!item) return;
    if (field === 'position' && positions().includes(value)) item.position = value;
    if (field === 'trainingIntensity' && ['low', 'medium', 'high'].includes(value)) item.trainingIntensity = value;
    if (field === 'startingEnergy') item.startingEnergy = clampNumber(value, 15, 100, 100);
    if (field === 'threshold') item.threshold = clampNumber(value, 15, 100, 60);
    renderRoster();
    recalculate();
  }

  function removeItem(uid) {
    state.players = state.players.filter(player => player.uid !== uid);
    renderRoster();
    recalculate();
  }

  function drawRoundedRect(ctx, x, y, width, height, radius, fill, stroke) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, r);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.stroke(); }
  }

  function prepareCanvas(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#090e14'; ctx.fillRect(0, 0, width, height);
    return { canvas, ctx };
  }

  function drawExportHeader(ctx, width, title, subtitle) {
    ctx.fillStyle = '#b976ff'; ctx.font = '700 18px JetBrains Mono, monospace'; ctx.fillText('MFL // ENERGY LAB', 62, 56);
    ctx.fillStyle = '#f0f4f8'; ctx.font = '600 42px Space Grotesk, sans-serif'; ctx.fillText(title, 62, 106);
    ctx.fillStyle = '#8294a7'; ctx.font = '500 15px DM Sans, sans-serif'; ctx.fillText(subtitle, 62, 136);
    ctx.fillStyle = '#a855f7'; ctx.fillRect(width - 290, 48, 228, 5);
  }

  function graphCanvas() {
    const width = 1600, height = 900;
    const { canvas, ctx } = prepareCanvas(width, height);
    drawExportHeader(ctx, width, 'Season energy projection', `${state.players.length} player${state.players.length === 1 ? '' : 's'} · daily closing energy · diamonds mark auto-rests`);
    const plot = { left: 90, top: 190, right: 1535, bottom: 720 };
    const maxDay = Math.max(1, ...schedule().map(day => day.day));
    const x = day => plot.left + (day / maxDay) * (plot.right - plot.left);
    const y = raw => plot.top + ((100 - clampNumber(raw / 100, 15, 100, 100)) / 85) * (plot.bottom - plot.top);
    ctx.lineWidth = 1;
    ctx.font = '600 13px JetBrains Mono, monospace';
    [20,40,60,80,100].forEach(tick => { ctx.strokeStyle = '#263342'; ctx.beginPath(); ctx.moveTo(plot.left, y(tick*100)); ctx.lineTo(plot.right, y(tick*100)); ctx.stroke(); ctx.fillStyle='#718397'; ctx.textAlign='right'; ctx.fillText(`${tick}%`, plot.left-14, y(tick*100)+5); });
    [0,5,10,15,20,25,30,maxDay].filter((v,i,a)=>v<=maxDay&&a.indexOf(v)===i).forEach(tick => { ctx.strokeStyle='#1d2835'; ctx.beginPath(); ctx.moveTo(x(tick),plot.top); ctx.lineTo(x(tick),plot.bottom); ctx.stroke(); ctx.fillStyle='#718397'; ctx.textAlign='center'; ctx.fillText(`D${tick}`,x(tick),plot.bottom+29); });
    state.players.forEach((item,index)=>{
      const color=playerColor(index),dash=playerDash(index).split(' ').filter(Boolean).map(Number);
      ctx.save();ctx.strokeStyle=color;ctx.globalAlpha=.3;ctx.setLineDash([7,7]);ctx.beginPath();ctx.moveTo(plot.left,y(item.threshold*100));ctx.lineTo(plot.right,y(item.threshold*100));ctx.stroke();ctx.restore();
      const points=[{day:0,value:item.startingEnergy*100},...state.projection.rows.map(row=>({day:row.scheduleDay.day,value:row.end[index]}))];
      ctx.save();ctx.strokeStyle=color;ctx.lineWidth=3.5;ctx.lineJoin='round';ctx.lineCap='round';ctx.setLineDash(dash);ctx.beginPath();points.forEach((point,i)=>i?ctx.lineTo(x(point.day),y(point.value)):ctx.moveTo(x(point.day),y(point.value)));ctx.stroke();ctx.restore();
      state.projection.rows.forEach(row=>row.matches.forEach(match=>{if(!match.outcomes[index].resting)return;const cx=x(row.scheduleDay.day),cy=y(match.before[index]),s=7;ctx.fillStyle='#0e151e';ctx.strokeStyle=color;ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(cx,cy-s);ctx.lineTo(cx+s,cy);ctx.lineTo(cx,cy+s);ctx.lineTo(cx-s,cy);ctx.closePath();ctx.fill();ctx.stroke();}));
    });
    let lx=68,ly=790;
    state.players.forEach((item,index)=>{const label=`${item.player.name} · ${item.position} · rest <${item.threshold}%`;ctx.font='600 13px DM Sans, sans-serif';const needed=ctx.measureText(label).width+58;if(lx+needed>1530){lx=68;ly+=34;}ctx.strokeStyle=playerColor(index);ctx.lineWidth=3;ctx.setLineDash(playerDash(index).split(' ').filter(Boolean).map(Number));ctx.beginPath();ctx.moveTo(lx,ly-4);ctx.lineTo(lx+28,ly-4);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle='#c9d3de';ctx.textAlign='left';ctx.fillText(label,lx+38,ly);lx+=needed;});
    ctx.fillStyle='#5f7286';ctx.font='500 12px DM Sans, sans-serif';ctx.fillText(`Exported ${new Date().toLocaleString()} · Historic model with fallback where evidence is unavailable`,68,height-28);
    return canvas;
  }

  function truncate(ctx, text, width) {
    let value=String(text);if(ctx.measureText(value).width<=width)return value;
    while(value.length&&ctx.measureText(`${value}…`).width>width)value=value.slice(0,-1);
    return `${value}…`;
  }

  function tableCanvas() {
    const cellWidth=230,dayWidth=82,scheduleWidth=190,rowHeight=54,headerHeight=58;
    const width=Math.max(1400,70+dayWidth+scheduleWidth+state.players.length*cellWidth+70);
    const height=185+headerHeight+state.projection.rows.length*rowHeight+60;
    const {canvas,ctx}=prepareCanvas(width,height);
    drawExportHeader(ctx,width,'Daily running energy',`${state.players.length} player${state.players.length===1?'':'s'} · exact match-start decisions and daily closes`);
    const left=48,top=175;
    const columns=[{label:'DAY',width:dayWidth},{label:'SCHEDULE',width:scheduleWidth},...state.players.map((item,index)=>({label:`${item.player.name} · ${item.position}`,width:cellWidth,color:playerColor(index)}))];
    let x=left;ctx.font='700 12px JetBrains Mono, monospace';
    columns.forEach(col=>{ctx.fillStyle='#151d28';ctx.fillRect(x,top,col.width,headerHeight);ctx.strokeStyle='#334153';ctx.strokeRect(x,top,col.width,headerHeight);ctx.fillStyle=col.color||'#9eafc0';ctx.textAlign='left';ctx.fillText(truncate(ctx,col.label,col.width-20),x+10,top+34);x+=col.width;});
    state.projection.rows.forEach((row,rowIndex)=>{
      const y=top+headerHeight+rowIndex*rowHeight;x=left;
      const values=[`D${row.scheduleDay.day}`,scheduleLabel(row.scheduleDay),...state.players.map((item,index)=>{
        const decisions=row.matches.map(match=>`${match.outcomes[index].resting?'REST':'PLAY'} ${percent(match.before[index])}%`).join(' · ');
        return `${percent(row.end[index])}% close${decisions?` · ${decisions}`:''}`;
      })];
      columns.forEach((col,colIndex)=>{ctx.fillStyle=rowIndex%2?'#0e151e':'#111922';ctx.fillRect(x,y,col.width,rowHeight);ctx.strokeStyle='#293746';ctx.strokeRect(x,y,col.width,rowHeight);ctx.fillStyle=colIndex<2?'#98a8b8':columns[colIndex].color;ctx.font=colIndex===0?'700 13px JetBrains Mono, monospace':'600 12px DM Sans, sans-serif';ctx.textAlign='left';ctx.fillText(truncate(ctx,values[colIndex],col.width-20),x+10,y+32);x+=col.width;});
    });
    ctx.fillStyle='#5f7286';ctx.font='500 12px DM Sans, sans-serif';ctx.fillText(`Auto-rest rule: rest when projected match-start energy is strictly below each player's threshold. Exported ${new Date().toLocaleString()}.`,left,height-24);
    return canvas;
  }

  function combineCanvases(topCanvas,bottomCanvas) {
    const width=Math.max(topCanvas.width,bottomCanvas.width),gap=28;
    const {canvas,ctx}=prepareCanvas(width,topCanvas.height+bottomCanvas.height+gap);
    ctx.drawImage(topCanvas,0,0);ctx.drawImage(bottomCanvas,0,topCanvas.height+gap);
    return canvas;
  }

  function downloadCanvas(canvas, mode) {
    const link=document.createElement('a');
    link.download=`mfl-energy-${mode}-${new Date().toISOString().slice(0,10)}.png`;
    link.href=canvas.toDataURL('image/png');
    link.click();
  }

  async function exportPng() {
    if (!state.projection || state.exportBusy) return;
    const button=document.getElementById('energyLabExportButton');
    const mode=document.getElementById('energyLabExportMode')?.value||'both';
    state.exportBusy=true;if(button){button.disabled=true;button.textContent='Rendering…';}
    try {
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const canvas=mode==='graph'?graphCanvas():mode==='table'?tableCanvas():combineCanvases(graphCanvas(),tableCanvas());
      downloadCanvas(canvas,mode);
      showToast(`${mode==='both'?'Graph + table':mode[0].toUpperCase()+mode.slice(1)} PNG exported.`);
    } catch (error) {
      console.error('[Energy Lab export]',error);showToast('PNG export failed. Try a smaller player set.');
    } finally {state.exportBusy=false;if(button){button.disabled=false;button.textContent='Export PNG';}}
  }

  function initialize() {
    const defaultPosition=document.getElementById('energyLabDefaultPosition');
    if (defaultPosition) defaultPosition.innerHTML=positions().map(position=>`<option value="${position}">${position}</option>`).join('');
    if (defaultPosition) defaultPosition.value='CM';
    document.querySelector('.app-page-nav')?.addEventListener('click',event=>{const button=event.target.closest('.app-page-tab');if(button)setPage(button.dataset.page);});
    document.querySelector('.app-page-nav')?.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();const next=event.key==='ArrowRight'?'energy':'squad';setPage(next);document.querySelector(`.app-page-tab[data-page="${next}"]`)?.focus();});
    document.getElementById('energyLabAdd')?.addEventListener('click',addPlayers);
    document.getElementById('btnOpenEnergyLab')?.addEventListener('click',openEnergyLab);
    document.getElementById('energyLabIds')?.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key==='Enter')addPlayers();});
    document.getElementById('energyLabPlayers')?.addEventListener('click',event=>{const button=event.target.closest('[data-action="remove"]');const card=event.target.closest('.energy-lab-player');if(button&&card)removeItem(card.dataset.uid);});
    document.getElementById('energyLabPlayers')?.addEventListener('change',event=>{const field=event.target.closest('[data-field]');const card=event.target.closest('.energy-lab-player');if(field&&card)updateItem(card.dataset.uid,field.dataset.field,field.value);});
    document.getElementById('energyLabClear')?.addEventListener('click',()=>{state.players=[];state.projection=null;saveState();renderAll();setFormStatus('Projection cleared.');});
    document.getElementById('energyLabScheduleToggle')?.addEventListener('click',()=>{if(typeof toggleEnergyScheduleMode==='function')toggleEnergyScheduleMode();recalculate();});
    document.getElementById('energyLabExportButton')?.addEventListener('click',exportPng);
    renderAll();
    restorePlayers();
    if (location.hash==='#energy-lab') openEnergyLab();
  }

  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded',initialize,{once:true});
  else initialize();
})(typeof window !== 'undefined' ? window : globalThis);
