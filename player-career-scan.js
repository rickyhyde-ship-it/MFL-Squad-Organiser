(function (global) {
  "use strict";

  const MAX_CALLS_PER_MINUTE = 79;
  const REQUEST_INTERVAL_MS = 775;
  const CACHE_VERSION = 1;
  const CACHE_PREFIX = "agentHubSeasonsInGame:v1:";

  function normalizeWallet(value) {
    const wallet = String(value || "").trim().toLowerCase();
    return /^0x[a-f0-9]{16}$/.test(wallet) ? wallet : "";
  }

  function emptyCache() {
    return { version: CACHE_VERSION, updatedAt: null, seasons: {} };
  }

  function load(wallet) {
    const normalized = normalizeWallet(wallet);
    if (!normalized) return emptyCache();
    try {
      const parsed = JSON.parse(localStorage.getItem(CACHE_PREFIX + normalized) || "null");
      if (!parsed || parsed.version !== CACHE_VERSION || !parsed.seasons || typeof parsed.seasons !== "object") return emptyCache();
      return {
        version: CACHE_VERSION,
        updatedAt: Number(parsed.updatedAt) || null,
        seasons: Object.fromEntries(Object.entries(parsed.seasons).flatMap(([id, value]) => {
          const number = Number(value);
          return Number.isFinite(number) && number >= 1 ? [[String(id), Math.round(number)]] : [];
        })),
      };
    } catch (error) {
      return emptyCache();
    }
  }

  function save(wallet, cache) {
    const normalized = normalizeWallet(wallet);
    if (!normalized) return;
    try {
      localStorage.setItem(CACHE_PREFIX + normalized, JSON.stringify({
        version: CACHE_VERSION,
        updatedAt: Date.now(),
        seasons: cache.seasons || {},
      }));
    } catch (error) {}
  }

  function historyEvents(payload) {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.history)) return payload.history;
    if (Array.isArray(payload?.experiences)) return payload.experiences;
    if (Array.isArray(payload?.value)) return payload.value;
    return [];
  }

  function calculate(player, payload) {
    const initial = historyEvents(payload).find((event) => String(event?.reasonType || "").toUpperCase() === "INITIAL");
    const currentAge = Number(player?.age ?? player?.metadata?.age);
    const initialAge = Number(initial?.values?.age);
    if (!Number.isFinite(currentAge) || !Number.isFinite(initialAge)) return null;
    return Math.max(1, Math.round(currentAge - initialAge + 1));
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function countCached(players, cache) {
    return players.reduce((count, player) => count + (Object.prototype.hasOwnProperty.call(cache.seasons, String(player.id)) ? 1 : 0), 0);
  }

  async function scan(options) {
    const wallet = normalizeWallet(options.wallet);
    if (!wallet) throw new Error("A valid wallet address is required for the season scan.");
    const apiBase = String(options.apiBase || "").replace(/\/$/, "");
    if (!apiBase) throw new Error("The player API address is unavailable.");

    const uniquePlayers = Array.from(new Map((options.players || []).filter((player) => player?.id).map((player) => [String(player.id), player])).values());
    const cache = load(wallet);
    const queue = options.force
      ? uniquePlayers
      : uniquePlayers.filter((player) => !Object.prototype.hasOwnProperty.call(cache.seasons, String(player.id)));
    const total = queue.length;
    const startedAt = Date.now();
    let completed = 0;
    let failures = 0;
    let lastStartedAt = 0;
    let rateLimited = false;
    let cancelled = false;

    const report = (extra = {}) => {
      const elapsed = Date.now() - startedAt;
      const cadence = completed ? Math.max(REQUEST_INTERVAL_MS, elapsed / completed) : REQUEST_INTERVAL_MS;
      options.onProgress?.({
        completed,
        total,
        failures,
        cached: countCached(uniquePlayers, cache),
        playerCount: uniquePlayers.length,
        etaMs: Math.ceil((total - completed) * cadence),
        rateLimited,
        cancelled,
        cache,
        ...extra,
      });
    };

    report();
    for (const player of queue) {
      if (options.shouldStop?.()) {
        cancelled = true;
        break;
      }
      const waitMs = Math.max(0, REQUEST_INTERVAL_MS - (Date.now() - lastStartedAt));
      if (waitMs) await delay(waitMs);
      if (options.shouldStop?.()) {
        cancelled = true;
        break;
      }

      lastStartedAt = Date.now();
      let seasons = null;
      try {
        const response = await fetch(`${apiBase}/players/${encodeURIComponent(player.id)}/experiences/history`, {
          headers: { Accept: "application/json" },
        });
        if (response.status === 429) {
          rateLimited = true;
          break;
        }
        if (!response.ok) throw new Error(`Player history API failed with ${response.status}.`);
        seasons = calculate(player, await response.json());
        if (seasons === null) throw new Error("Player history did not include a usable INITIAL age.");
        cache.seasons[String(player.id)] = seasons;
      } catch (error) {
        failures += 1;
      }
      completed += 1;
      if (completed % 5 === 0) save(wallet, cache);
      report({ playerId: String(player.id), seasons });
    }

    save(wallet, cache);
    report();
    return { cache, completed, total, failures, rateLimited, cancelled };
  }

  global.AgentHubCareerScan = Object.freeze({
    MAX_CALLS_PER_MINUTE,
    REQUEST_INTERVAL_MS,
    load,
    save,
    calculate,
    countCached,
    scan,
  });
})(window);
