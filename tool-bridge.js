(function () {
  const API_BASE = "https://z519wdyajg.execute-api.us-east-1.amazonaws.com/prod";
  const CLUBS_QUERY = "withLeagueRank=true&withNextMatch=true&withPlayersCount=true&withLastMatches=true";
  const params = new URLSearchParams(window.location.search);
  const wallet = normalizeWallet(params.get("wallet") || localStorage.getItem("agentHubWallet") || "");
  const toolType = getToolType();
  const stateKey = `agentHubToolState:${toolType || "tool"}:${wallet || "anonymous"}`;
  const clubNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

  assignStateKeys();
  restoreCachedState();
  installStateCache();

  if (!wallet) return;

  const walletFields = [
    "#wallet-input",
    "#walletInput",
    ".wallet-input",
    'input[placeholder*="0x"]',
    'input[placeholder*="wallet" i]',
  ];

  for (const selector of walletFields) {
    document.querySelectorAll(selector).forEach((field) => {
      if (!field.value) field.value = wallet;
      field.setAttribute("value", wallet);
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  if (toolType === "friendly" || toolType === "league" || toolType === "schedule") {
    installClubPicker(toolType).catch((error) => {
      console.error("[Agent Hub] Failed to load wallet clubs", error);
      renderClubPickerError(toolType, error);
    });
  }

  function getToolType() {
    const path = window.location.pathname.toLowerCase();
    if (path.includes("/friendly/")) return "friendly";
    if (path.includes("/league/")) return "league";
    if (path.includes("/schedule/")) return "schedule";
    return "";
  }

  async function fetchWalletClubs() {
    const url = `${API_BASE}/clubs?walletAddress=${encodeURIComponent(wallet)}&${CLUBS_QUERY}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Club list failed: ${response.status}`);
    const payload = await response.json();
    const entries = Array.isArray(payload) ? payload : payload.value || [];

    return entries
      .map((entry) => {
        const club = entry.club || entry;
        if (!club || !club.id) return null;
        const competitions = entry.competitions || club.competitions || [];
        const league = competitions.find((competition) => competition.type === "LEAGUE") || competitions[0] || null;
        return {
          id: String(club.id),
          name: club.name || `Club ${club.id}`,
          city: club.city || "",
          division: club.division || "",
          leagueRank: entry.leagueRank || "",
          playersCount: entry.playersCount || "",
          nextMatch: entry.nextMatch || null,
          league,
        };
      })
      .filter(Boolean)
      .sort(sortClubOptions);
  }

  async function installClubPicker(type) {
    const clubs = await fetchWalletClubs();
    const target = findPickerTarget(type);
    if (!target) return;

    const field = document.createElement("div");
    field.className = "agent-club-field";
    const loadButton = type === "schedule" ? "" : `<button type="button" class="agent-club-load">${type === "league" ? "Load League" : "Target"}</button>`;
    field.innerHTML = `
      <label for="agent-club-select">Target Club</label>
      <div class="agent-club-control">
        <select id="agent-club-select" class="agent-club-select">
          ${clubs.map((club) => `<option value="${escapeHtml(club.id)}">${escapeHtml(formatClubLabel(club, type))}</option>`).join("")}
        </select>
        ${loadButton}
      </div>
      <div class="agent-club-meta" id="agent-club-meta"></div>
    `;

    target.parent.insertBefore(field, target.before);

    const select = field.querySelector("#agent-club-select");
    const button = field.querySelector(".agent-club-load");
    const selectedClub = () => clubs.find((item) => item.id === select.value);
    const prime = () => {
      const club = selectedClub();
      if (!club) return;
      updateMeta(field, club, type);
      primeClub(type, club);
    };
    const apply = () => {
      const club = clubs.find((item) => item.id === select.value);
      if (!club) return;
      updateMeta(field, club, type);
      applyClub(type, club);
    };

    select.addEventListener("change", prime);
    button?.addEventListener("click", apply);
    if (type === "league") {
      document.getElementById("search-input")?.addEventListener("input", () => {
        document.getElementById("load-btn")?.removeAttribute("data-agent-competition-id");
      });
      document.getElementById("load-btn")?.addEventListener("click", (event) => {
        const competitionId = event.currentTarget.dataset.agentCompetitionId;
        if (competitionId && typeof window.loadCompetitionById === "function") {
          event.preventDefault();
          event.stopImmediatePropagation();
          window.loadCompetitionById(competitionId);
        }
      }, true);
    }

    if (clubs.length) {
      restoreCachedState(field);
      if (!selectedClub()) select.value = clubs[0].id;
      const club = selectedClub() || clubs[0];
      updateMeta(field, club, type);
      primeClub(type, club);
    } else {
      field.querySelector(".agent-club-meta").textContent = "No clubs found for this wallet.";
      if (button) button.disabled = true;
      select.disabled = true;
    }
  }

  function findPickerTarget(type) {
    if (type === "friendly") {
      const clubInput = document.getElementById("club-id");
      const field = clubInput ? clubInput.closest(".field") : null;
      return field ? { parent: field.parentElement, before: field } : null;
    }

    if (type === "schedule") {
      const clubInput = document.getElementById("club-id");
      const field = clubInput ? clubInput.closest(".field") : null;
      return field ? { parent: field.parentElement, before: field } : null;
    }

    const searchContainer = document.querySelector(".search-container");
    return searchContainer ? { parent: searchContainer, before: searchContainer.firstElementChild } : null;
  }

  function applyClub(type, club) {
    primeClub(type, club);

    if (type === "league") {
      const competition = club.league;
      if (competition && typeof window.loadCompetitionById === "function") {
        window.loadCompetitionById(competition.id);
      }
    }

    if (type === "schedule" && typeof window.loadScheduleForClub === "function") {
      window.loadScheduleForClub(club.id);
    }
  }

  function primeClub(type, club) {
    if (type === "friendly" || type === "schedule") {
      const clubInput = document.getElementById("club-id");
      if (!clubInput) return;
      clubInput.value = club.id;
      clubInput.setAttribute("value", club.id);
      clubInput.dispatchEvent(new Event("input", { bubbles: true }));
      clubInput.dispatchEvent(new Event("change", { bubbles: true }));
      if (typeof window.setStatus === "function") {
        window.setStatus(type === "schedule" ? `Planning for ${club.name}. Load planner to scout upcoming opponents.` : `Targeting ${club.name}. Load matches to begin.`, "success");
      }
      saveCachedState();
      return;
    }

    if (type === "league") {
      const searchInput = document.getElementById("search-input");
      const loadButton = document.getElementById("load-btn");
      const competition = club.league;
      if (!competition) {
        if (typeof window.setStatus === "function") window.setStatus(`${club.name} has no league competition in the club feed.`, "error");
        return;
      }

      if (searchInput) {
        searchInput.value = String(competition.id);
        searchInput.setAttribute("value", String(competition.id));
        searchInput.dispatchEvent(new Event("change", { bubbles: true }));
      }
      document.getElementById("suggestions")?.classList.remove("active");
      if (loadButton) {
        loadButton.disabled = false;
        loadButton.dataset.agentCompetitionId = competition.id;
      }
      saveCachedState();
    }
  }

  function installStateCache() {
    const scheduleSave = debounce(saveCachedState, 250);
    document.addEventListener("input", scheduleSave, true);
    document.addEventListener("change", scheduleSave, true);
    window.addEventListener("beforeunload", saveCachedState);
  }

  function restoreCachedState(root = document) {
    let cached;
    try {
      cached = JSON.parse(localStorage.getItem(stateKey) || "null");
    } catch (error) {
      cached = null;
    }

    if (!cached || !cached.fields) return;

    Object.entries(cached.fields).forEach(([selector, state]) => {
      const field = root.querySelector(selector) || document.querySelector(selector);
      if (!field) return;
      if (field.type === "checkbox" || field.type === "radio") {
        field.checked = Boolean(state.checked);
      } else if ("value" in field) {
        field.value = state.value ?? "";
        field.setAttribute("value", state.value ?? "");
      }
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
    });

    if (cached.scroll) {
      setTimeout(() => {
        window.scrollTo(cached.scroll.x || 0, cached.scroll.y || 0);
      }, 0);
    }
  }

  function saveCachedState() {
    const fields = {};
    document.querySelectorAll("input, select, textarea").forEach((field) => {
      if (shouldSkipField(field)) return;
      const selector = fieldSelector(field);
      if (!selector) return;
      fields[selector] = field.type === "checkbox" || field.type === "radio"
        ? { checked: field.checked }
        : { value: field.value };
    });

    try {
      localStorage.setItem(
        stateKey,
        JSON.stringify({
          fields,
          scroll: { x: window.scrollX, y: window.scrollY },
          savedAt: Date.now(),
        }),
      );
    } catch (error) {
      console.warn("[Agent Hub] Could not cache tool state", error);
    }
  }

  function shouldSkipField(field) {
    return ["button", "file", "image", "password", "reset", "submit"].includes((field.type || "").toLowerCase());
  }

  function fieldSelector(field) {
    const tag = field.tagName.toLowerCase();
    if (field.id) return `#${escapeCss(field.id)}`;
    if (field.name) return `${tag}[name="${escapeAttribute(field.name)}"]`;
    return field.dataset.agentHubStateKey
      ? `[data-agent-hub-state-key="${escapeAttribute(field.dataset.agentHubStateKey)}"]`
      : "";
  }

  function assignStateKeys() {
    document.querySelectorAll("input, select, textarea").forEach((field, index) => {
      if (!field.id && !field.name) field.dataset.agentHubStateKey = `${field.tagName.toLowerCase()}-${index}`;
    });
  }

  function normalizeWallet(value) {
    const address = String(value || "").trim().toLowerCase();
    return /^0x[a-f0-9]{16}$/.test(address) ? address : "";
  }

  function escapeCss(value) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function escapeAttribute(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function debounce(callback, delay) {
    let timeout;
    return () => {
      window.clearTimeout(timeout);
      timeout = window.setTimeout(callback, delay);
    };
  }

  function sortClubOptions(a, b) {
    const nameOrder = clubNameCollator.compare(a.name || "", b.name || "");
    if (nameOrder) return nameOrder;
    return clubNameCollator.compare(a.id || "", b.id || "");
  }

  function updateMeta(field, club, type) {
    const meta = field.querySelector(".agent-club-meta");
    const parts = [];
    if (club.leagueRank) parts.push(`Rank ${club.leagueRank}`);
    if (club.playersCount) parts.push(`${club.playersCount} players`);
    if (club.nextMatch?.id) parts.push(`Next match ${club.nextMatch.id}`);
    meta.textContent = parts.join(" | ") || `Club ID ${club.id}`;
  }

  function formatClubLabel(club, type) {
    return club.name;
  }

  function renderClubPickerError(type, error) {
    const target = findPickerTarget(type);
    if (!target) return;
    const field = document.createElement("div");
    field.className = "agent-club-field error";
    field.innerHTML = `<label>Target Club</label><div class="agent-club-meta">Could not load wallet clubs: ${escapeHtml(error.message)}</div>`;
    target.parent.insertBefore(field, target.before);
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
})();
