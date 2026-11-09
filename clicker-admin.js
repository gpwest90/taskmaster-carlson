// ===== The Button: admin board — all contestants, click log, reset =====
// Classic script (not a module) so the page also works opened straight from disk.

(function () {
  const statusEl = document.getElementById("status");
  const boardEl = document.getElementById("board");
  const rowsEl = document.getElementById("rows");
  const logEl = document.getElementById("log");
  const logEmptyEl = document.getElementById("log-empty");
  const resetEl = document.getElementById("reset");
  const messageEl = document.getElementById("message");

  const adminKey = new URLSearchParams(window.location.search).get("key");
  let db = null;
  let contestants = [];
  let clockOffsetMs = 0; // server clock minus this device's clock
  let timer = null;

  function showError(message) {
    statusEl.textContent = message;
    statusEl.classList.add("task__status--error");
    boardEl.hidden = true;
  }

  function formatTime(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleString(undefined, {
      weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit",
    });
  }

  function formatDuration(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
  }

  function days(hours) {
    const n = hours / 24;
    return n + (n === 1 ? " day" : " days");
  }

  function serverNow() {
    return Date.now() + clockOffsetMs;
  }

  function contestantLink(key) {
    const url = new URL("clicker.html", window.location.href);
    url.search = "?key=" + encodeURIComponent(key);
    return url.href;
  }

  function cell(text, className) {
    const td = document.createElement("td");
    td.textContent = text;
    if (className) td.className = className;
    return td;
  }

  function buildRows() {
    rowsEl.replaceChildren();
    for (const c of contestants) {
      const screwsOut = c.screws_out_at.filter(Boolean).length;
      const tr = document.createElement("tr");
      tr.append(
        cell(c.name, "admin__name"),
        cell("", "admin__state"),
        cell("", "admin__left"),
        cell("", "admin__survived"),
        cell(formatTime(c.opened_at)),
        cell(String(c.click_count)),
        cell(c.panel_off ? "4/4 · panel off" : screwsOut + "/4"),
        cell(days(c.dial_hours)),
      );

      const linkTd = document.createElement("td");
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "admin__copy";
      copy.textContent = "Copy link";
      copy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(contestantLink(c.access_key));
          copy.textContent = "Copied";
        } catch {
          window.prompt("Copy this link:", contestantLink(c.access_key));
        }
        setTimeout(() => { copy.textContent = "Copy link"; }, 1500);
      });
      linkTd.append(copy);
      tr.append(linkTd);

      c.row = tr;
      rowsEl.append(tr);
    }
  }

  function buildLog(clicks) {
    logEl.replaceChildren();
    // Newest first.
    for (const k of clicks.slice().reverse()) {
      const tr = document.createElement("tr");
      tr.append(
        cell(formatTime(k.clicked_at)),
        cell(k.name, "admin__name"),
        cell(days(k.hours_granted)),
        cell(formatTime(k.expires_at)),
      );
      logEl.append(tr);
    }
    logEmptyEl.hidden = clicks.length > 0;
  }

  // Updates the time-based cells each second. "Out" is decided by the clock
  // here, matching the rule the database enforces on record_click.
  function tick() {
    const now = serverNow();
    for (const c of contestants) {
      const state = c.row.querySelector(".admin__state");
      const left = c.row.querySelector(".admin__left");
      const survived = c.row.querySelector(".admin__survived");

      if (!c.opened_at) {
        state.textContent = "Sealed";
        left.textContent = "—";
        survived.textContent = "—";
        continue;
      }

      const expires = new Date(c.expires_at).getTime();
      const opened = new Date(c.opened_at).getTime();
      const alive = now < expires;
      state.textContent = alive ? "Alive" : "Out";
      state.classList.toggle("admin__state--out", !alive);
      left.textContent = alive ? formatDuration(expires - now) : "—";
      survived.textContent = formatDuration((alive ? now : expires) - opened);
    }
  }

  async function load() {
    const { data, error } = await db.rpc("admin_overview", { p_admin_key: adminKey });
    if (error) {
      showError(/not authorised/i.test(error.message)
        ? "That admin key isn't right."
        : "Couldn't reach the Taskmaster's records: " + error.message);
      return;
    }

    contestants = data.contestants;
    clockOffsetMs = new Date(data.server_now).getTime() - Date.now();
    statusEl.textContent = "Updated " + new Date().toLocaleTimeString();
    buildRows();
    buildLog(data.clicks);
    boardEl.hidden = false;

    clearInterval(timer);
    tick();
    timer = setInterval(tick, 1000);
  }

  async function reset() {
    const answer = window.prompt(
      "This re-seals every letter, puts the screws back, sets the dial to 2 days " +
      "and deletes every click.\n\nType RESET to confirm."
    );
    if (answer !== "RESET") {
      messageEl.textContent = "Reset cancelled.";
      return;
    }

    resetEl.disabled = true;
    messageEl.textContent = "Resetting…";
    const { error } = await db.rpc("admin_reset", { p_admin_key: adminKey });
    resetEl.disabled = false;
    if (error) {
      messageEl.textContent = "Reset failed: " + error.message;
      return;
    }
    messageEl.textContent = "Reset done. Every letter is sealed again.";
    await load();
  }

  if (!adminKey) {
    showError("No admin key in this link.");
    return;
  }

  const { url, publishableKey } = window.SUPABASE_CONFIG;
  db = window.supabase.createClient(url, publishableKey);
  resetEl.addEventListener("click", () => {
    reset().catch((err) => {
      messageEl.textContent = "Something went wrong: " + err.message;
      resetEl.disabled = false;
    });
  });
  load().catch((err) => showError("Something went wrong: " + err.message));
  // Pick up contestants' clicks without a manual refresh.
  setInterval(() => load().catch(() => {}), 30000);
})();
