// ===== The Button: sealed letter → task letter → the device =====
// Classic script (not a module) so the page also works opened straight from disk.
// Every action goes through a database function (supabase/schema.sql), which
// enforces the rules; this page just shows the result.

(function () {
  const CLICKS_PER_SCREW = 5;
  const DIAL_MIN = 1;
  const DIAL_MAX = 5; // the database allows up to 7; the page stops at 5

  const $ = (id) => document.getElementById(id);
  const statusEl = $("status");
  const sealedEl = $("sealed");
  const sealEl = $("seal");
  const letterEl = $("letter");
  const deviceEl = $("device");
  const rereadEl = $("reread");
  const countdownEl = $("countdown");
  const pressEl = $("press");
  const messageEl = $("message");
  const panelEl = $("panel");
  const dialEl = $("dial");
  const dialKnob = $("dial-knob");
  const dialValue = $("dial-value");
  const screwEls = Array.from(document.querySelectorAll("[data-screw]"));

  const key = new URLSearchParams(window.location.search).get("key");
  let db = null;
  let status = null;
  let clockOffsetMs = 0; // server clock minus this device's clock
  let timer = null;
  let dialDays = 2;      // what the knob shows; saved to the database after a pause
  let dialSaveTimer = null;
  const screwTurns = [0, 0, 0, 0]; // in-browser only; only removal is saved

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function showError(message) {
    statusEl.hidden = false;
    statusEl.textContent = message;
    statusEl.classList.add("task__status--error");
  }

  function formatRemaining(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
  }

  function days(n) {
    return n + (n === 1 ? " day" : " days");
  }

  async function call(fn, args) {
    const { data, error } = await db.rpc(fn, Object.assign({ p_key: key }, args));
    if (error) throw error;
    return data;
  }

  // ----- Views -----

  function showView(view) {
    sealedEl.hidden = view !== "sealed";
    letterEl.hidden = view !== "letter";
    deviceEl.hidden = view !== "device";
    rereadEl.hidden = view !== "device";
  }

  function showDial(n) {
    dialDays = n;
    dialKnob.style.setProperty("--turn", n - DIAL_MIN);
    dialValue.textContent = days(n);
  }

  function render(s) {
    status = s;
    clockOffsetMs = new Date(s.server_now).getTime() - Date.now();
    statusEl.hidden = true;

    if (s.state === "sealed") {
      $("sealed-name").textContent = s.name;
      showView("sealed");
      return;
    }

    // Screws and panel
    s.screws_out_at.forEach((outAt, i) => { screwEls[i].hidden = outAt !== null; });
    panelEl.hidden = s.panel_off;
    dialEl.inert = !s.panel_off;
    showDial(s.dial_hours / 24);

    clearInterval(timer);
    if (s.state === "out") {
      endGame();
    } else {
      deviceEl.classList.remove("device--dead");
      pressEl.disabled = false;
      tick();
      timer = setInterval(tick, 1000);
    }
  }

  // ----- Countdown -----

  function tick() {
    const remaining = new Date(status.expires_at).getTime() - (Date.now() + clockOffsetMs);
    if (remaining <= 0) {
      endGame();
      return;
    }
    countdownEl.textContent = formatRemaining(remaining);
  }

  function endGame() {
    clearInterval(timer);
    countdownEl.textContent = "00:00:00";
    deviceEl.classList.add("device--dead");
    pressEl.disabled = true;
    pressEl.textContent = "Dead";
    dialEl.inert = true;
    screwEls.forEach((el) => { el.disabled = true; });
    messageEl.textContent = "Time ran out. Your task is over.";
  }

  // ----- Actions -----

  async function breakSeal() {
    sealEl.disabled = true;
    sealEl.classList.add("seal--breaking");
    const [s] = await Promise.all([call("open_letter"), wait(700)]);
    render(s);
    showView("letter");
  }

  async function press() {
    pressEl.disabled = true;
    messageEl.textContent = "";
    try {
      render(await call("record_click"));
      messageEl.textContent = "Recorded. You've got " + days(status.dial_hours / 24) + " again.";
    } catch (err) {
      // The database refuses late clicks; trust it over the local countdown.
      if (/time is up/i.test(err.message)) {
        endGame();
      } else {
        messageEl.textContent = "That press didn't go through: " + err.message;
        pressEl.disabled = false;
      }
    }
  }

  async function turnScrew(el) {
    const i = Number(el.dataset.screw) - 1;
    screwTurns[i] += 1;
    el.style.setProperty("--turns", screwTurns[i]);
    if (screwTurns[i] < CLICKS_PER_SCREW) return;

    el.disabled = true;
    let s;
    try {
      s = await call("remove_screw", { p_screw: i + 1 });
    } catch (err) {
      el.disabled = false;
      screwTurns[i] = 0;
      el.style.setProperty("--turns", 0);
      return;
    }

    el.classList.add("screw--falling");
    await wait(600);
    el.classList.remove("screw--falling");

    if (s.panel_off && !panelEl.hidden) {
      panelEl.classList.add("device__panel--falling");
      await wait(900);
      panelEl.classList.remove("device__panel--falling");
    }
    render(s);
  }

  // Turning the dial shows the new value straight away and saves it once
  // the contestant stops turning.
  function turnDial(step) {
    const next = Math.min(DIAL_MAX, Math.max(DIAL_MIN, dialDays + step));
    if (next === dialDays) return;
    showDial(next);

    clearTimeout(dialSaveTimer);
    dialSaveTimer = setTimeout(async () => {
      try {
        render(await call("set_dial", { p_days: dialDays }));
      } catch (err) {
        showDial(status.dial_hours / 24);
      }
    }, 500);
  }

  // ----- Start -----

  async function load() {
    if (!key) {
      showError("No contestant key in this link. Use the link the Taskmaster sent you.");
      return;
    }

    const { url, publishableKey } = window.SUPABASE_CONFIG;
    db = window.supabase.createClient(url, publishableKey);

    let s;
    try {
      s = await call("get_status");
    } catch (err) {
      showError("Couldn't reach the Taskmaster's records: " + err.message);
      return;
    }
    if (!s) {
      showError("That key doesn't match any contestant. Check your link.");
      return;
    }

    render(s);
    if (s.state !== "sealed") showView("device");

    const report = (err) => { messageEl.textContent = "Something went wrong: " + err.message; };
    sealEl.addEventListener("click", () => breakSeal().catch((err) => {
      sealEl.disabled = false;
      sealEl.classList.remove("seal--breaking");
      showError("Couldn't open the letter: " + err.message);
    }));
    $("dismiss").addEventListener("click", () => showView("device"));
    rereadEl.addEventListener("click", () => showView("letter"));
    pressEl.addEventListener("click", () => press().catch(report));
    screwEls.forEach((el) => el.addEventListener("click", () => turnScrew(el).catch(report)));
    $("dial-down").addEventListener("click", () => turnDial(-1));
    $("dial-up").addEventListener("click", () => turnDial(1));
  }

  load().catch((err) => showError("Something went wrong: " + err.message));
})();
