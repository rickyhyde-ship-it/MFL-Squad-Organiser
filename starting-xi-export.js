(function () {
  'use strict';

  let exportBusy = false;

  const COLORS = {
    background: '#070b10',
    panel: '#101821',
    panelAlt: '#0d141c',
    border: '#2d3a49',
    borderStrong: '#46586c',
    text: '#eef3f8',
    secondary: '#9eafc0',
    muted: '#718397',
    accent: '#b976ff',
    green: '#48f59a',
    warning: '#ffbf69',
    danger: '#ff718c'
  };

  function percent(raw) {
    return `${Math.ceil(Number(raw || 0) / 100)}%`;
  }

  function safeName(value) {
    return String(value || 'starting-xi')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'starting-xi';
  }

  function scheduleLabel(day) {
    const events = [];
    if (day.training) events.push('Training');
    if (day.league) events.push('League');
    if (day.cup) events.push('Cup');
    return events.join(' + ') || 'No events';
  }

  function retirementLabel(player) {
    const years = typeof projectedRetirementYears === 'function' ? projectedRetirementYears(player?.retireIn) : null;
    if (!Number.isInteger(years) || years < 0) return '—';
    if (years === 0) return 'This season';
    return `${years} season${years === 1 ? '' : 's'}`;
  }

  function modelDetails(entry) {
    const prediction = typeof modelPredictionFor === 'function' ? modelPredictionFor(entry, ENERGY_MAX_RAW) : null;
    if (entry.manualDrain) {
      return { drain: `${Number(entry.drain).toFixed(1)}%`, source: 'Manual fixed drain' };
    }
    if (prediction) {
      const tier = prediction.tier === 'widened' ? 'Widened historic model −10/+5' : 'Historic model −5/+5';
      return {
        drain: `${(prediction.drainRaw / 100).toFixed(1)}%`,
        source: `${tier} · ${Number(prediction.sampleSize || 0).toLocaleString()} comparable matches`
      };
    }
    return {
      drain: `${Number(entry.drain).toFixed(1)}%`,
      source: entry.modelKey ? 'Fallback · no comparable historic match' : 'Fallback · player profile unavailable'
    };
  }

  function buildSnapshot() {
    const squad = typeof activeSquad === 'function' ? activeSquad() : null;
    const starters = typeof getEnergyStarters === 'function' ? getEnergyStarters(squad) : [];
    if (!squad || !starters.length) throw new Error('Add players to the Starting XI before exporting.');
    if (typeof energyModelsPending === 'function' && energyModelsPending(starters)) {
      throw new Error('Wait for the historic energy evidence to finish loading.');
    }

    const schedule = activeEnergySchedule();
    const projection = calculateEnergyProjection(starters, schedule);
    const matches = schedule.reduce((total, day) => total + Number(day.league) + Number(day.cup), 0);
    const finalMin = projection.final.length ? Math.min(...projection.final) : ENERGY_MAX_RAW;
    const finalMax = projection.final.length ? Math.max(...projection.final) : ENERGY_MAX_RAW;
    const modelledCount = starters.filter(entry => Boolean(modelPredictionFor(entry, ENERGY_MAX_RAW))).length;

    return {
      squad,
      starters: starters.map((entry, index) => ({
        ...entry,
        exportIndex: index,
        model: modelDetails(entry)
      })),
      schedule,
      projection,
      matches,
      modelledCount,
      finalMin,
      finalMax,
      exportedAt: new Date()
    };
  }

  function roundedRect(ctx, x, y, width, height, radius, fill, stroke) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, r);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
  }

  function truncate(ctx, value, maxWidth) {
    let text = String(value ?? '');
    if (ctx.measureText(text).width <= maxWidth) return text;
    while (text.length && ctx.measureText(`${text}…`).width > maxWidth) text = text.slice(0, -1);
    return `${text}…`;
  }

  function drawText(ctx, text, x, y, options = {}) {
    ctx.fillStyle = options.color || COLORS.text;
    ctx.font = options.font || '500 16px "DM Sans", sans-serif';
    ctx.textAlign = options.align || 'left';
    ctx.textBaseline = options.baseline || 'alphabetic';
    ctx.fillText(truncate(ctx, text, options.maxWidth || Number.MAX_SAFE_INTEGER), x, y);
  }

  function playerCellLines(snapshot, row, playerIndex) {
    const lines = [];
    if (row.scheduleDay.training) lines.push(`TRAIN → ${percent(row.afterTraining[playerIndex])}`);
    row.matchStarts.forEach(match => {
      const resting = match.resting[playerIndex];
      lines.push(`G${match.match} ${resting ? 'REST' : 'PLAY'} ${percent(match.energies[playerIndex])} → ${percent(match.after[playerIndex])}`);
    });
    lines.push(`CLOSE ${percent(row.end[playerIndex])}`);
    return lines;
  }

  function dayStatus(snapshot, row) {
    if (!row.matchStarts.length) return ['No match'];
    return row.matchStarts.map(match => {
      const rests = snapshot.starters.length - match.playingCount;
      if (!match.playingCount) return `G${match.match}: all resting`;
      return `G${match.match}: ${match.tiredCount}/${match.playingCount} ≤60%${match.blocked ? ' · WARNING' : ''}${rests ? ` · ${rests} rest` : ''}`;
    });
  }

  function createCanvas(snapshot) {
    const margin = 64;
    const fixedWidths = { day: 72, schedule: 220, status: 270 };
    const playerWidth = 190;
    const tableWidth = fixedWidths.day + fixedWidths.schedule + snapshot.starters.length * playerWidth + fixedWidths.status;
    const width = Math.max(1800, tableWidth + margin * 2);
    const headerHeight = 166;
    const summaryHeight = 128;
    const rosterHeaderHeight = 48;
    const rosterRowHeight = 54;
    const rosterHeight = rosterHeaderHeight + snapshot.starters.length * rosterRowHeight;
    const tableHeaderHeight = 58;
    const rowHeight = 86;
    const titleGaps = 122;
    const footerHeight = 70;
    const height = headerHeight + summaryHeight + rosterHeight + tableHeaderHeight + snapshot.projection.rows.length * rowHeight + titleGaps + footerHeight;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, width, height);
    return { canvas, ctx, width, height, margin, fixedWidths, playerWidth, headerHeight, summaryHeight, rosterHeaderHeight, rosterRowHeight, tableHeaderHeight, rowHeight };
  }

  function drawHeader(ctx, snapshot, layout) {
    const { width, margin } = layout;
    ctx.fillStyle = COLORS.accent;
    ctx.fillRect(0, 0, 8, layout.headerHeight);
    drawText(ctx, 'MFL // STARTING XI ENERGY PLANNER', margin, 50, { color: COLORS.accent, font: '700 17px "JetBrains Mono", monospace' });
    drawText(ctx, snapshot.squad.name || 'Starting XI', margin, 102, { font: '700 44px "Space Grotesk", sans-serif', maxWidth: width - 720 });
    drawText(ctx, `Season 17 workload · Division ${snapshot.squad.division ?? '—'} · ${snapshot.matches}-match schedule`, margin, 136, { color: COLORS.secondary, font: '500 17px "DM Sans", sans-serif' });

    const badgeWidth = 470;
    roundedRect(ctx, width - margin - badgeWidth, 34, badgeWidth, 108, 12, COLORS.panel, COLORS.borderStrong);
    ctx.fillStyle = COLORS.green;
    ctx.fillRect(width - margin - badgeWidth, 34, 7, 108);
    drawText(ctx, 'EXPORT INCLUDES', width - margin - badgeWidth + 28, 68, { color: COLORS.green, font: '700 12px "JetBrains Mono", monospace' });
    drawText(ctx, `${snapshot.starters.length} starters · ${snapshot.projection.rows.length} days · ${snapshot.matches} matches`, width - margin - badgeWidth + 28, 100, { font: '700 20px "Space Grotesk", sans-serif', maxWidth: badgeWidth - 50 });
    drawText(ctx, energyLimitedSchedule ? 'Limited schedule' : 'Full schedule', width - margin - badgeWidth + 28, 126, { color: COLORS.secondary, font: '600 13px "DM Sans", sans-serif' });
  }

  function drawSummary(ctx, snapshot, layout, startY) {
    const gap = 14;
    const cardWidth = (layout.width - layout.margin * 2 - gap * 3) / 4;
    const values = [
      ['STARTING XI', `${snapshot.starters.length} / 11`, `${snapshot.modelledCount} using historic curves`],
      ['LOWEST ENERGY', percent(snapshot.projection.lowest), 'End-of-day minimum'],
      ['FINAL XI RANGE', snapshot.finalMin === snapshot.finalMax ? percent(snapshot.finalMin) : `${percent(snapshot.finalMin)}–${percent(snapshot.finalMax)}`, `After Day ${snapshot.schedule.at(-1)?.day || 0}`],
      ['BLOCKED STARTS', String(snapshot.projection.warningStarts), snapshot.projection.firstWarning ? `First: D${snapshot.projection.firstWarning.day}, G${snapshot.projection.firstWarning.match}` : 'Every match starts clear']
    ];
    values.forEach(([label, value, detail], index) => {
      const x = layout.margin + index * (cardWidth + gap);
      roundedRect(ctx, x, startY, cardWidth, 96, 9, COLORS.panel, index === 3 && snapshot.projection.warningStarts ? COLORS.warning : COLORS.border);
      drawText(ctx, label, x + 18, startY + 28, { color: COLORS.secondary, font: '700 11px "JetBrains Mono", monospace' });
      drawText(ctx, value, x + 18, startY + 61, { color: index === 3 && snapshot.projection.warningStarts ? COLORS.warning : COLORS.text, font: '700 25px "Space Grotesk", sans-serif' });
      drawText(ctx, detail, x + 18, startY + 82, { color: COLORS.muted, font: '500 12px "DM Sans", sans-serif', maxWidth: cardWidth - 36 });
    });
  }

  function drawTableCell(ctx, x, y, width, height, fill, stroke = COLORS.border) {
    ctx.fillStyle = fill;
    ctx.fillRect(x, y, width, height);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, width, height);
  }

  function drawRoster(ctx, snapshot, layout, startY) {
    drawText(ctx, 'STARTER SETTINGS & MODEL EVIDENCE', layout.margin, startY - 18, { color: COLORS.accent, font: '700 13px "JetBrains Mono", monospace' });
    const columns = [
      { label: 'POS', width: 84 },
      { label: 'PLAYER', width: 310 },
      { label: 'OVR', width: 78 },
      { label: 'AGE', width: 72 },
      { label: 'RETIREMENT', width: 126 },
      { label: 'TRAINING', width: 126 },
      { label: 'DRAIN', width: 100 }
    ];
    const used = columns.reduce((sum, column) => sum + column.width, 0);
    columns.push({ label: 'MODEL SOURCE', width: layout.width - layout.margin * 2 - used });
    let x = layout.margin;
    columns.forEach(column => {
      drawTableCell(ctx, x, startY, column.width, layout.rosterHeaderHeight, '#171f2a', COLORS.borderStrong);
      drawText(ctx, column.label, x + 12, startY + 30, { color: COLORS.secondary, font: '700 11px "JetBrains Mono", monospace', maxWidth: column.width - 24 });
      x += column.width;
    });
    snapshot.starters.forEach((entry, rowIndex) => {
      const y = startY + layout.rosterHeaderHeight + rowIndex * layout.rosterRowHeight;
      const player = entry.player || {};
      const overall = player.ovr === null || player.ovr === undefined || player.ovr === '' ? '—' : Math.round(Number(player.ovr));
      const age = player.age === null || player.age === undefined || player.age === '' ? '—' : Math.round(Number(player.age));
      const values = [entry.slot?.slotPos || 'XI', player.name || 'Unknown player', overall, age, retirementLabel(player), entry.trainingIntensity || energyTrainingIntensity, entry.model.drain, entry.model.source];
      x = layout.margin;
      columns.forEach((column, columnIndex) => {
        drawTableCell(ctx, x, y, column.width, layout.rosterRowHeight, rowIndex % 2 ? COLORS.panelAlt : COLORS.panel);
        drawText(ctx, values[columnIndex], x + 12, y + 33, {
          color: columnIndex === 0 ? COLORS.accent : columnIndex === 6 ? COLORS.green : COLORS.text,
          font: columnIndex === 1 ? '700 14px "DM Sans", sans-serif' : '600 12px "JetBrains Mono", monospace',
          maxWidth: column.width - 24
        });
        x += column.width;
      });
    });
    return startY + layout.rosterHeaderHeight + snapshot.starters.length * layout.rosterRowHeight;
  }

  function drawDailyTable(ctx, snapshot, layout, startY) {
    drawText(ctx, 'DAILY RUNNING ENERGY', layout.margin, startY - 18, { color: COLORS.accent, font: '700 13px "JetBrains Mono", monospace' });
    const columns = [
      { label: 'DAY', width: layout.fixedWidths.day },
      { label: 'SCHEDULE', width: layout.fixedWidths.schedule },
      ...snapshot.starters.map(entry => ({ label: `${entry.slot?.slotPos || 'XI'} · ${entry.player?.name || 'Player'}`, width: layout.playerWidth, player: true })),
      { label: 'MATCH STARTS', width: layout.fixedWidths.status }
    ];
    let x = layout.margin;
    columns.forEach(column => {
      drawTableCell(ctx, x, startY, column.width, layout.tableHeaderHeight, '#171f2a', COLORS.borderStrong);
      drawText(ctx, column.label, x + 10, startY + 34, { color: column.player ? COLORS.accent : COLORS.secondary, font: '700 11px "JetBrains Mono", monospace', maxWidth: column.width - 20 });
      x += column.width;
    });

    snapshot.projection.rows.forEach((row, rowIndex) => {
      const y = startY + layout.tableHeaderHeight + rowIndex * layout.rowHeight;
      const baseFill = rowIndex % 2 ? '#0b1219' : '#0e161f';
      const values = [
        [`D${row.scheduleDay.day}`],
        [scheduleLabel(row.scheduleDay)],
        ...snapshot.starters.map((entry, playerIndex) => playerCellLines(snapshot, row, playerIndex)),
        dayStatus(snapshot, row)
      ];
      x = layout.margin;
      columns.forEach((column, columnIndex) => {
        drawTableCell(ctx, x, y, column.width, layout.rowHeight, baseFill);
        values[columnIndex].forEach((line, lineIndex) => {
          const warning = String(line).includes('WARNING') || String(line).includes('PLAY 60%') || String(line).match(/PLAY [1-5][0-9]%/);
          const resting = String(line).includes('REST');
          drawText(ctx, line, x + 10, y + 21 + lineIndex * 17, {
            color: warning ? COLORS.danger : resting ? COLORS.green : columnIndex === 0 ? COLORS.accent : lineIndex === values[columnIndex].length - 1 && column.player ? COLORS.secondary : COLORS.text,
            font: lineIndex === 0 || columnIndex < 2 ? '700 11px "JetBrains Mono", monospace' : '600 11px "DM Sans", sans-serif',
            maxWidth: column.width - 20
          });
        });
        x += column.width;
      });
    });
  }

  function renderSnapshot(snapshot) {
    const layout = createCanvas(snapshot);
    const { ctx } = layout;
    drawHeader(ctx, snapshot, layout);
    drawSummary(ctx, snapshot, layout, layout.headerHeight + 4);
    const rosterY = layout.headerHeight + layout.summaryHeight + 44;
    const rosterBottom = drawRoster(ctx, snapshot, layout, rosterY);
    const dailyY = rosterBottom + 64;
    drawDailyTable(ctx, snapshot, layout, dailyY);
    drawText(ctx, `Generated ${snapshot.exportedAt.toLocaleString()} · Percentages are rounded up to match the planner display.`, layout.margin, layout.height - 30, { color: COLORS.muted, font: '500 13px "DM Sans", sans-serif', maxWidth: layout.width - layout.margin * 2 });
    return layout.canvas;
  }

  function setStatus(message) {
    const status = document.getElementById('startingXiEnergyExportStatus');
    if (status) status.textContent = message;
  }

  function setButtonState(busy, label) {
    const button = document.getElementById('startingXiEnergyExportButton');
    if (!button) return;
    button.dataset.busy = String(busy);
    button.disabled = busy;
    button.textContent = label;
  }

  async function exportStartingXiEnergyPng() {
    if (exportBusy) return;
    exportBusy = true;
    setButtonState(true, 'Rendering PNG…');
    setStatus('Rendering the complete Starting XI energy planner PNG.');
    try {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const snapshot = buildSnapshot();
      const canvas = renderSnapshot(snapshot);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('The browser could not create the PNG.');
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `mfl-${safeName(snapshot.squad.name)}-starting-xi-energy-${new Date().toISOString().slice(0, 10)}.png`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus('Starting XI energy planner PNG exported.');
      setButtonState(false, 'PNG exported');
      setTimeout(() => {
        if (!exportBusy) setButtonState(false, 'Export all as PNG');
      }, 1800);
    } catch (error) {
      console.error('[Starting XI energy export]', error);
      setStatus(error.message || 'PNG export failed.');
      setButtonState(false, 'Export failed · Retry');
    } finally {
      exportBusy = false;
    }
  }

  window.exportStartingXiEnergyPng = exportStartingXiEnergyPng;
  window.buildStartingXiEnergyExportSnapshot = buildSnapshot;
})();
