// Agent Daily — app logic.
// Read top to bottom: helpers → goals → on-device storage → actions → UI → the agent loop.
(() => {
  // ---------- helpers ----------
  const $ = s => document.querySelector(s);
  const pad = n => String(n).padStart(2, "0");
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const todayStr = () => ymd(new Date());
  const nowHM = () => { const d = new Date(); return pad(d.getHours()) + ":" + pad(d.getMinutes()); };
  const rid = () => Math.random().toString(36).slice(2, 8);
  const clone = o => JSON.parse(JSON.stringify(o));
  const sumBy = (arr, k) => arr.reduce((a, e) => a + (Number(e[k]) || 0), 0);
  const inr = n => "₹" + Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });
  const litres = ml => (ml / 1000).toFixed(2);
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") n.className = v; else if (k.startsWith("on")) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v === true ? "" : v);
    }
    for (const c of kids.flat()) if (c != null && c !== "") n.append(c instanceof Node ? c : String(c));
    return n;
  }
  function validDate(s) {
    s = String(s || "").trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + "T00:00")) ? s : todayStr();
  }
  function normTime(s) {
    const m = String(s || "").trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m || +m[1] > 23 || +m[2] > 59) return null;
    return pad(+m[1]) + ":" + m[2];
  }
  const NUM_WORDS = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty", "twenty-one", "twenty-two", "twenty-three", "twenty-four", "twenty-five", "twenty-six", "twenty-seven", "twenty-eight", "twenty-nine", "thirty", "thirty-one"];
  const defaultTime = date => date === todayStr() ? nowHM() : "";

  // ---------- goals (from Arjun's Step 1) ----------
  const GOALS = { waterMl: 3000, glassMl: 250, breakfastBy: "08:00", lunchBy: "14:00" };
  const MEALS = [
    ["breakfast", "Breakfast", "by 8:00"],
    ["lunch", "Lunch", "1:30–2:00"],
    ["snack", "Snack", ""],
    ["dinner", "Dinner", ""],
  ];

  // ---------- on-device storage ----------
  // Everything lives in this browser's localStorage on the iPad: one key per day, one for tasks, one for the API key.
  const store = {
    get(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
    set(k, v) {
      try { localStorage.setItem(k, JSON.stringify(v)); }
      catch (e) { throw new Error("Couldn't save on this device. Storage may be full or blocked."); }
    },
  };
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}

  let viewDate = todayStr(), followToday = true;
  let day, tasks;

  function emptyDay(date) { return { date, water: [], meals: {}, wake: null, singing: [], guitar: [], expenses: [] }; }
  function normDay(date, data) {
    const d = emptyDay(date);
    if (data) {
      const c = clone(data);
      for (const k of ["water", "singing", "guitar", "expenses"]) d[k] = Array.isArray(c[k]) ? c[k] : [];
      d.meals = c.meals && typeof c.meals === "object" ? c.meals : {};
      d.wake = c.wake || null;
    }
    return d;
  }
  const readDay = date => normDay(date, store.get("ad:day:" + date));
  const readTasks = () => { const t = store.get("ad:tasks"); return Array.isArray(t) ? t : []; };

  function mutateDay(date, fn) {
    try {
      const d = readDay(date);
      const result = fn(d);
      store.set("ad:day:" + date, d);
      if (date === viewDate) day = d;
      render();
      return Promise.resolve(result);
    } catch (e) { return Promise.reject(e); }
  }
  function mutateTasks(fn) {
    try {
      const items = readTasks();
      const result = fn(items);
      store.set("ad:tasks", items);
      tasks = items;
      render();
      return Promise.resolve(result);
    } catch (e) { return Promise.reject(e); }
  }
  function removeFromDay(d, section, id) {
    if (section === "meals") { if (!d.meals[id]) throw new Error("No such meal logged"); delete d.meals[id]; return; }
    if (section === "wake") { if (!d.wake) throw new Error("No wake-up logged"); d.wake = null; return; }
    const arr = d[section];
    if (!Array.isArray(arr)) throw new Error("Unknown section " + section);
    const i = arr.findIndex(e => e.id === id);
    if (i < 0) throw new Error("No entry with id " + id);
    arr.splice(i, 1);
  }

  // ---------- shared write actions (used by the + sheets and by the agent's tools) ----------
  const act = {
    water: (date, ml, time) => mutateDay(date, d => { d.water.push({ id: rid(), time, ml }); return sumBy(d.water, "ml"); }),
    meal: (date, meal, status, time, note) => mutateDay(date, d => { d.meals[meal] = { status, time: status === "skipped" ? "" : time, note: note || "" }; }),
    wake: (date, time) => mutateDay(date, d => { d.wake = { time }; }),
    practice: (date, kind, minutes, what, time) => mutateDay(date, d => { d[kind].push({ id: rid(), time, minutes, what: what || "" }); return sumBy(d[kind], "minutes"); }),
    expense: (date, amount, where, category, note, time) => mutateDay(date, d => { d.expenses.push({ id: rid(), time, amount, where: where || "", category: (category || "").toLowerCase(), note: note || "" }); return sumBy(d.expenses, "amount"); }),
    addTask: (task, status, minutes, note) => { const id = rid(); const stamp = todayStr() + "T" + nowHM(); return mutateTasks(items => { items.push({ id, task, status, minutes: minutes || 0, note: note || "", created_at: stamp, done_at: status === "done" ? stamp : null }); return id; }); },
  };

  // ---------- bottom sheet ----------
  let sheetSave = null, sheetClear = null;
  function openSheet(title, fields, onSave, onClear) {
    $("#sheet-title").textContent = title;
    $("#sheet-err").textContent = "";
    const box = $("#sheet-fields"); box.replaceChildren();
    for (const f of fields) {
      const id = "f-" + f.name;
      if (f.type === "note") { box.append(el("p", { class: "sheet-note" }, f.label)); continue; }
      if (f.type === "choice") {
        const seg = el("div", { class: "seg", role: "group", "aria-label": f.label, "data-name": f.name, "data-value": f.value ?? "" });
        for (const [val, text] of f.options) {
          const b = el("button", { type: "button", "aria-pressed": String(String(f.value) === String(val)) }, text);
          b.onclick = () => { seg.dataset.value = val; seg.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x === b))); if (f.onPick) f.onPick(val); };
          seg.append(b);
        }
        box.append(el("div", { class: "field" }, el("span", { class: "flabel" }, f.label), seg));
      } else {
        const input = el("input", { id, name: f.name, type: f.type || "text", placeholder: f.placeholder || "", inputmode: f.type === "number" ? "decimal" : null, step: f.type === "number" ? "any" : null, autocomplete: "off", autocapitalize: f.type === "password" ? "off" : null, spellcheck: f.type === "password" ? "false" : null });
        if (f.value != null) input.value = f.value;
        box.append(el("div", { class: "field" }, el("label", { for: id }, f.label), input));
      }
    }
    sheetSave = onSave; sheetClear = onClear || null;
    $("#sheet-clear").hidden = !sheetClear;
    $("#sheet-bg").hidden = false; $("#sheet").hidden = false;
    const first = box.querySelector("input:not([type=time])") || box.querySelector("input,button");
    if (first) setTimeout(() => first.focus(), 30);
  }
  function closeSheet() { $("#sheet").hidden = true; $("#sheet-bg").hidden = true; sheetSave = null; sheetClear = null; }
  function sheetValues() {
    const v = {};
    $("#sheet-fields").querySelectorAll("input").forEach(i => { v[i.name] = i.value.trim(); });
    $("#sheet-fields").querySelectorAll(".seg").forEach(s => { v[s.dataset.name] = s.dataset.value; });
    return v;
  }
  async function runSheet(fn) {
    if (!fn) return;
    $("#sheet-save").disabled = true;
    try { await fn(sheetValues()); closeSheet(); }
    catch (err) { $("#sheet-err").textContent = err && err.message ? err.message : "Couldn't save. Try again."; }
    finally { $("#sheet-save").disabled = false; }
  }
  $("#sheet-form").addEventListener("submit", e => { e.preventDefault(); runSheet(sheetSave); });
  $("#sheet-clear").onclick = () => runSheet(sheetClear);
  $("#sheet-cancel").onclick = closeSheet;
  $("#sheet-bg").onclick = closeSheet;
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("#sheet").hidden) closeSheet(); });

  const need = (cond, msg) => { if (!cond) throw new Error(msg); };
  const SHEETS = {
    water: () => openSheet("Add water", [
      { name: "ml", label: "Amount (ml)", type: "number", value: 250 },
      { name: "preset", label: "Quick pick", type: "choice", value: "250", options: [["250", "250 ml"], ["500", "500 ml"], ["750", "750 ml"], ["1000", "1 L"]], onPick: v => { $("#f-ml").value = v; } },
      { name: "time", label: "Time", type: "time", value: defaultTime(viewDate) },
    ], v => { const ml = Math.round(+v.ml); need(ml > 0 && ml <= 5000, "Enter an amount between 1 and 5000 ml."); return act.water(viewDate, ml, normTime(v.time) || ""); }),
    wake: () => openSheet("Wake-up time", [
      { name: "time", label: "Woke up at", type: "time", value: day.wake ? day.wake.time : defaultTime(viewDate) },
    ], v => { const t = normTime(v.time); need(t, "Pick a time."); return act.wake(viewDate, t); },
       day.wake ? () => mutateDay(viewDate, d => removeFromDay(d, "wake", "wake")) : null),
    meal: key => {
      const [, label] = MEALS.find(m => m[0] === key); const m = day.meals[key];
      openSheet(label, [
        { name: "status", label: "Status", type: "choice", value: (m && m.status) || "eaten", options: [["eaten", "Eaten"], ["skipped", "Skipped"]] },
        { name: "time", label: "Time", type: "time", value: (m && m.time) || defaultTime(viewDate) },
        { name: "note", label: "What you ate", type: "text", value: (m && m.note) || "" },
      ], v => act.meal(viewDate, key, v.status === "skipped" ? "skipped" : "eaten", normTime(v.time) || "", v.note),
         m ? () => mutateDay(viewDate, d => removeFromDay(d, "meals", key)) : null);
    },
    practice: kind => openSheet(kind === "singing" ? "Singing practice" : "Guitar practice", [
      { name: "minutes", label: "Minutes", type: "number", value: "" },
      { name: "what", label: "What you practiced", type: "text", value: "" },
      { name: "time", label: "Time", type: "time", value: defaultTime(viewDate) },
    ], v => { const min = Math.round(+v.minutes); need(min > 0 && min <= 600, "Enter minutes between 1 and 600."); return act.practice(viewDate, kind, min, v.what, normTime(v.time) || ""); }),
    task: () => openSheet("New job task", [
      { name: "task", label: "Task", type: "text", value: "" },
      { name: "note", label: "Note", type: "text", value: "" },
    ], v => { need(v.task, "Write the task first."); return act.addTask(v.task, "pending", 0, v.note); }),
    expense: () => openSheet("Add expense", [
      { name: "amount", label: "Amount (₹)", type: "number", value: "" },
      { name: "where", label: "Where / on what", type: "text", value: "" },
      { name: "category", label: "Category", type: "text", value: "" },
      { name: "time", label: "Time", type: "time", value: defaultTime(viewDate) },
    ], v => { const amt = +v.amount; need(amt > 0, "Enter an amount."); need(v.where, "Say where you spent it."); return act.expense(viewDate, amt, v.where, v.category, "", normTime(v.time) || ""); }),
    settings: () => openSheet("Settings", [
      { name: "note1", type: "note", label: "The chat agent uses your own Claude API key. Create one at console.anthropic.com → API keys. It is saved only on this device and sent only to api.anthropic.com." },
      { name: "key", label: "Claude API key", type: "password", value: getKey(), placeholder: "sk-ant-…" },
    ], v => { setKey(v.key); refreshComposer(); },
       getKey() ? () => { setKey(""); refreshComposer(); } : null),
  };

  // ---------- building blocks ----------
  const lamp = state => el("span", { class: "lamp" + (state ? " " + state : ""), "aria-hidden": "true" });
  function head(label, lampState, sub, onAdd, addLabel) {
    return el("div", { class: "mod-h" }, lamp(lampState), el("span", { class: "lbl" }, label),
      sub ? el("span", { class: "sub" }, sub) : el("span", { class: "sp" }),
      onAdd ? el("button", { class: "key", type: "button", "aria-label": addLabel, onclick: onAdd }, "+") : null);
  }
  const screen = (value, unit, dim) => el("div", { class: "screen" }, el("span", { class: "v" + (dim ? " dim" : "") }, value), unit ? el("span", { class: "u" }, unit) : null);
  const rmBtn = (section, id) => el("button", { class: "rm", type: "button", "data-rm": section, "data-id": id, "aria-label": "Remove entry" }, "×");
  const row = (time, main, sub, section, id) => el("li", {}, el("span", { class: "e-time" }, time || ""), el("span", { class: "e-main" }, main, sub ? el("span", { class: "e-sub" }, " · " + sub) : null), section ? rmBtn(section, id) : null);
  const byTime = arr => [...arr].sort((a, b) => String(a.time || "").localeCompare(String(b.time || "")));
  const list = items => el("ul", { class: "entries" }, items);

  function renderStrip() {
    const strip = $("#strip"), today = new Date(); today.setHours(0, 0, 0, 0);
    const btns = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(today); d.setDate(today.getDate() - i);
      const key = ymd(d);
      btns.push(el("button", { type: "button", "aria-pressed": String(key === viewDate), "aria-label": d.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" }), onclick: () => { viewDate = key; followToday = key === todayStr(); loadDay(); } },
        el("span", { class: "wd" }, d.toLocaleDateString("en-IN", { weekday: "short" })),
        el("span", { class: "dn" }, pad(d.getDate()))));
    }
    strip.replaceChildren(...btns);
    const sel = strip.querySelector('[aria-pressed="true"]');
    if (sel) sel.scrollIntoView({ block: "nearest", inline: "center" });
  }

  function render() {
    const d = day;
    const vd = new Date(viewDate + "T00:00"), isToday = viewDate === todayStr();
    $("#d-num").textContent = pad(vd.getDate());
    $("#d-word").textContent = NUM_WORDS[vd.getDate()];
    $("#d-chip").textContent = isToday ? "TODAY " + nowHM() : vd.toLocaleDateString("en-IN", { weekday: "short" }).toUpperCase();
    $("#date-label").textContent = vd.toLocaleDateString("en-IN", { weekday: "long" }) + ", " + vd.toLocaleDateString("en-IN", { month: "long", year: "numeric" });
    renderStrip();

    // water: 12 dots, one per 250 ml glass
    const ml = sumBy(d.water, "ml"), glasses = GOALS.waterMl / GOALS.glassMl, filled = Math.min(glasses, Math.floor(ml / GOALS.glassMl));
    const dots = el("div", { class: "dots" + (ml >= GOALS.waterMl ? " full" : ""), role: "img", "aria-label": `${filled} of ${glasses} glasses` },
      Array.from({ length: glasses }, (_, i) => el("i", { class: i < filled ? "f" : "" })));
    $("#t-water").replaceChildren(
      head("Water", ml >= GOALS.waterMl ? "on" : ml > 0 ? "hot" : "", "", SHEETS.water, "Add water"),
      screen(litres(ml), "/ 3.00 L", ml === 0),
      el("div", {}, dots, el("div", { class: "scale" }, el("span", {}, "0"), el("span", {}, "1.5"), el("span", {}, "3 L"))),
      list(byTime(d.water).map(e => row(e.time, e.ml + " ml", "", "water", e.id))));

    // wake
    $("#t-wake").replaceChildren(
      head("Wake-up", d.wake ? "on" : "", "", SHEETS.wake, "Log wake-up time"),
      screen(d.wake ? d.wake.time : "--:--", "", !d.wake));

    // meals: four round keys
    let eaten = 0;
    const keys = MEALS.map(([key, label, goal]) => {
      const m = d.meals[key];
      let state = "", face = "—", gl = goal, late = false;
      if (m && m.status === "skipped") { state = "skipped"; face = "skip"; gl = "skipped"; }
      else if (m) {
        eaten++; state = "eaten"; face = m.time || "done";
        late = (key === "breakfast" && m.time && m.time > GOALS.breakfastBy) || (key === "lunch" && m.time && m.time > GOALS.lunchBy);
        if (late) gl = "late";
      }
      return el("button", { type: "button", class: "mkey " + state, "aria-label": `${label}: ${m ? (m.status === "skipped" ? "skipped" : "eaten" + (m.time ? " at " + m.time : "")) : "not logged"}. Log ${label}`, onclick: () => SHEETS.meal(key) },
        el("span", { class: "face" }, face),
        el("span", { class: "top" }, lamp(state === "eaten" ? (late ? "hot" : "on") : state === "skipped" ? "hot" : ""), el("span", { class: "nm" }, label)),
        el("span", { class: "gl" + (late || state === "skipped" ? " late" : "") }, gl));
    });
    const notes = MEALS.filter(([k]) => d.meals[k] && d.meals[k].note).map(([k, label]) => el("span", {}, label + ": " + d.meals[k].note));
    $("#t-meals").replaceChildren(
      head("Meals", eaten === 4 ? "on" : eaten ? "hot" : "", eaten + " of 4"),
      el("div", { class: "mkeys" }, keys),
      el("div", { class: "mnotes" }, notes));

    // practice
    for (const k of ["singing", "guitar"]) {
      const min = sumBy(d[k], "minutes");
      $("#t-" + k).replaceChildren(
        head(k === "singing" ? "Singing" : "Guitar", min > 0 ? "on" : "", "", () => SHEETS.practice(k), "Log " + k),
        screen(String(min), "min", min === 0),
        list(byTime(d[k]).map(e => row(e.time, e.minutes + " min", e.what, k, e.id))));
    }

    // tasks: all open + those finished on the viewed day
    const open = tasks.filter(t => t.status !== "done");
    const done = tasks.filter(t => t.status === "done" && String(t.done_at || "").slice(0, 10) === viewDate);
    $("#t-tasks").replaceChildren(
      head("Job tasks", open.length === 0 && done.length ? "on" : open.length ? "hot" : "", `${done.length} done · ${open.length} open`, SHEETS.task, "Add task"),
      list([...open, ...done].map(t => {
        const cb = el("input", { type: "checkbox", class: "tick", id: "task-" + t.id, "aria-label": "Done: " + t.task });
        cb.checked = t.status === "done";
        cb.addEventListener("change", () => setTaskStatus(t.id, cb.checked ? "done" : "pending"));
        const sub = [t.minutes ? t.minutes + " min" : "", t.note || ""].filter(Boolean).join(" · ");
        return el("li", { class: "task" + (t.status === "done" ? " done" : "") }, cb,
          el("label", { class: "e-main", for: "task-" + t.id }, t.task, sub ? el("span", { class: "e-sub" }, " · " + sub) : null),
          el("button", { class: "rm", type: "button", "data-rmtask": t.id, "aria-label": "Remove task" }, "×"));
      })));

    // expenses
    const spent = sumBy(d.expenses, "amount");
    $("#t-expenses").replaceChildren(
      head("Expenses", spent ? "hot" : "", "", SHEETS.expense, "Add expense"),
      screen(inr(spent), "", spent === 0),
      list(byTime(d.expenses).map(e => row(e.time, inr(e.amount) + " " + (e.where || ""), [e.category, e.note].filter(Boolean).join(" · "), "expenses", e.id))));

    const loggedCount = [d.water.length, d.wake ? 1 : 0, Object.keys(d.meals).length, d.singing.length, d.guitar.length, d.expenses.length].filter(Boolean).length;
    $("#logged-cap").textContent = loggedCount ? `${loggedCount} of 6 logged` : "Nothing logged";
  }

  // ---------- manual actions ----------
  function setTaskStatus(id, status) {
    mutateTasks(items => {
      const t = items.find(x => x.id === id); if (!t) return;
      t.status = status; t.done_at = status === "done" ? viewDate + "T" + (viewDate === todayStr() ? nowHM() : "23:59") : null;
    }).catch(showError);
  }
  document.addEventListener("click", e => {
    const b = e.target.closest("[data-rm],[data-rmtask]");
    if (!b) return;
    e.stopPropagation();
    if (!b.classList.contains("armed")) {
      b.classList.add("armed"); b.textContent = "Remove";
      setTimeout(() => { b.classList.remove("armed"); b.textContent = "×"; }, 3000);
      return;
    }
    if (b.dataset.rmtask) mutateTasks(items => { const i = items.findIndex(t => t.id === b.dataset.rmtask); if (i >= 0) items.splice(i, 1); }).catch(showError);
    else mutateDay(viewDate, d => removeFromDay(d, b.dataset.rm, b.dataset.id)).catch(showError);
  }, true);

  function notice(text) { const n = $("#notice"); n.textContent = text; n.hidden = !text; }
  function showError(e) { notice(e && e.message ? e.message : "Couldn't save that change."); }

  // ---------- navigation ----------
  function loadDay() { day = readDay(viewDate); tasks = readTasks(); render(); }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    if (followToday && viewDate !== todayStr()) viewDate = todayStr();
    loadDay();
  });
  setInterval(() => { if (!document.hidden && viewDate === todayStr()) $("#d-chip").textContent = "TODAY " + nowHM(); }, 30000);
  function selectTab(name) {
    $("#tab-today").setAttribute("aria-selected", name === "today");
    $("#tab-chat").setAttribute("aria-selected", name === "chat");
    $("#today-view").hidden = name !== "today";
    $("#chat-view").hidden = name !== "chat";
    $("#last-reply").hidden = name !== "today" || !$("#last-reply").textContent;
  }
  $("#tab-today").onclick = () => selectTab("today");
  $("#tab-chat").onclick = () => selectTab("chat");
  $("#settings-btn").onclick = SHEETS.settings;

  // =====================================================================
  // THE AGENT
  // An agent = a model + tools + a loop.
  //   1. Send Claude your message, the rules, today's log and the tool list.
  //   2. If Claude answers with tool calls, run them here and send back the results.
  //   3. Repeat until Claude answers with plain text. That text is the reply.
  // =====================================================================
  const MODEL = "claude-haiku-5-5";           // fast and cheap; swap for "claude-sonnet-5-5" for smarter parsing
  const API_URL = "https://api.anthropic.com/v1/messages";
  const getKey = () => { try { return localStorage.getItem("ad:apikey") || ""; } catch (e) { return ""; } };
  const setKey = k => { try { k ? localStorage.setItem("ad:apikey", k) : localStorage.removeItem("ad:apikey"); } catch (e) { throw new Error("Couldn't save the key on this device."); } };

  const RULES = `You are the logging agent inside Arjun's personal daily tracker. He tells you what he did in casual words (English or Hinglish) and you record it with the tools.
- Call a tool for every distinct thing he reports: water, meals, wake-up time, singing or guitar practice, job tasks, expenses. Several items in one message means several tool calls.
- Water is recorded in millilitres (1 L = 1000 ml). If he says glasses without a size, use 250 ml per glass.
- Times are 24-hour HH:MM local time. Leave time out when he doesn't give one; it defaults to now.
- Pass date (YYYY-MM-DD) only when he is logging for another day, such as yesterday.
- Expenses are in rupees. Pick a short lowercase category yourself (food, travel, shopping, bills and so on).
- Job tasks: new work goes to add_task. Finishing or spending time on an existing task goes to update_task with its id from the open tasks list.
- For "undo" or a correction, use remove_entry with the entry id from the log, then log the right value.
- Never invent entries. If something is unclear (an amount is missing, say), log what is clear and ask one short question.
- For questions about his day, answer from the log below; use get_day for other dates.
- After logging, reply in one or two short lines: what you recorded and, where it helps, where he stands against today's goals. Plain text, no markdown, no emoji.`;

  function contextBlock() {
    const date = todayStr(), d = readDay(date);
    const openTasks = readTasks().filter(t => t.status !== "done").map(t => ({ id: t.id, task: t.task, minutes: t.minutes || 0, note: t.note || "" }));
    const weekday = new Date().toLocaleDateString("en-IN", { weekday: "long" });
    return `Today: ${weekday}, ${date}. Time now: ${nowHM()} (24h, local).
Goals: water ${GOALS.waterMl} ml a day; breakfast before 08:00; lunch 13:30 to 14:00; evening snack and dinner have no set time; singing and guitar log minutes and what was practiced.
Today's log so far: ${JSON.stringify(d)}
Open job tasks: ${JSON.stringify(openTasks)}`;
  }

  // Tools: each has a name, a description and an input schema Claude reads, plus execute() that runs here.
  const S = (props, required) => ({ type: "object", properties: props, required: required || [] });
  const dateP = { type: "string", description: "YYYY-MM-DD, only when not today" };
  const timeP = { type: "string", description: "HH:MM 24h local; omit for now" };
  function makeTools(note) {
    const when = i => { const date = validDate(i.date); return { date, time: normTime(i.time) || defaultTime(date) }; };
    return [
      { name: "log_water", description: "Record water he drank. Returns the day's water total in ml.",
        input_schema: S({ ml: { type: "number", description: "Millilitres" }, time: timeP, date: dateP }, ["ml"]),
        execute: async i => {
          const ml = Math.round(Number(i.ml)); if (!(ml > 0 && ml <= 5000)) throw new Error("ml must be between 1 and 5000");
          const w = when(i); const total = await act.water(w.date, ml, w.time);
          note(`water +${ml} ml`); return { date: w.date, total_ml: total, goal_ml: GOALS.waterMl };
        } },
      { name: "log_meal", description: "Record a meal as eaten or skipped. Replaces any earlier entry for the same meal that day.",
        input_schema: S({ meal: { type: "string", enum: ["breakfast", "lunch", "snack", "dinner"] }, status: { type: "string", enum: ["eaten", "skipped"] }, note: { type: "string", description: "What he ate, optional" }, time: timeP, date: dateP }, ["meal"]),
        execute: async i => {
          const meal = String(i.meal); if (!MEALS.some(m => m[0] === meal)) throw new Error("meal must be breakfast, lunch, snack or dinner");
          const status = i.status === "skipped" ? "skipped" : "eaten", w = when(i);
          await act.meal(w.date, meal, status, w.time, String(i.note || ""));
          note(`${meal} ${status}`); return { ok: true, date: w.date, meal, status, time: w.time };
        } },
      { name: "log_wake", description: "Record what time he woke up.",
        input_schema: S({ time: timeP, date: dateP }, []),
        execute: async i => { const w = when(i); await act.wake(w.date, w.time); note(`woke ${w.time}`); return { ok: true, date: w.date, time: w.time }; } },
      { name: "log_practice", description: "Record singing or guitar practice: minutes and what he worked on.",
        input_schema: S({ kind: { type: "string", enum: ["singing", "guitar"] }, minutes: { type: "number" }, what: { type: "string", description: "What he practiced, optional" }, time: timeP, date: dateP }, ["kind", "minutes"]),
        execute: async i => {
          const kind = i.kind === "guitar" ? "guitar" : i.kind === "singing" ? "singing" : null; if (!kind) throw new Error("kind must be singing or guitar");
          const minutes = Math.round(Number(i.minutes)); if (!(minutes > 0 && minutes <= 600)) throw new Error("minutes must be between 1 and 600");
          const w = when(i); const total = await act.practice(w.date, kind, minutes, String(i.what || ""), w.time);
          note(`${kind} +${minutes} min`); return { date: w.date, kind, total_minutes: total };
        } },
      { name: "log_expense", description: "Record money he spent, in rupees.",
        input_schema: S({ amount: { type: "number" }, where: { type: "string", description: "Where or on what" }, category: { type: "string" }, note: { type: "string" }, time: timeP, date: dateP }, ["amount", "where"]),
        execute: async i => {
          const amount = Number(i.amount); if (!(amount > 0)) throw new Error("amount must be a positive number");
          const w = when(i); const total = await act.expense(w.date, amount, String(i.where || ""), String(i.category || ""), String(i.note || ""), w.time);
          note(`spent ${inr(amount)}`); return { date: w.date, day_total_rupees: total };
        } },
      { name: "add_task", description: "Add a job task. Use status done if he says it is already finished.",
        input_schema: S({ task: { type: "string" }, status: { type: "string", enum: ["pending", "done"] }, minutes: { type: "number" }, note: { type: "string" } }, ["task"]),
        execute: async i => {
          const task = String(i.task || "").trim(); if (!task) throw new Error("task is empty");
          const status = i.status === "done" ? "done" : "pending";
          const id = await act.addTask(task, status, Math.max(0, Math.round(Number(i.minutes) || 0)), String(i.note || ""));
          note(`task added${status === "done" ? " (done)" : ""}`); return { id, task, status };
        } },
      { name: "update_task", description: "Update an existing job task by id: mark done or pending, add minutes worked, or add a note.",
        input_schema: S({ id: { type: "string" }, status: { type: "string", enum: ["pending", "done"] }, add_minutes: { type: "number" }, note: { type: "string" } }, ["id"]),
        execute: async i => {
          const id = String(i.id);
          const t = await mutateTasks(items => {
            const t = items.find(x => x.id === id); if (!t) throw new Error("No task with id " + id);
            if (i.status === "done" || i.status === "pending") { t.status = i.status; t.done_at = i.status === "done" ? todayStr() + "T" + nowHM() : null; }
            const add = Math.round(Number(i.add_minutes) || 0); if (add > 0) t.minutes = (Number(t.minutes) || 0) + add;
            if (i.note) t.note = String(i.note);
            return clone(t);
          });
          note("task updated"); return t;
        } },
      { name: "remove_entry", description: "Delete one logged entry. section is water, singing, guitar or expenses with the entry id; meals with the meal name as id; wake with id wake.",
        input_schema: S({ section: { type: "string", enum: ["water", "meals", "wake", "singing", "guitar", "expenses"] }, id: { type: "string" }, date: dateP }, ["section", "id"]),
        execute: async i => {
          const date = validDate(i.date);
          await mutateDay(date, d => removeFromDay(d, String(i.section), String(i.id)));
          note(`removed ${i.section} entry`); return { ok: true };
        } },
      { name: "get_day", description: "Read the full log for a date (YYYY-MM-DD).",
        input_schema: S({ date: { type: "string" } }, ["date"]),
        execute: async i => readDay(validDate(i.date)) },
    ];
  }

  async function callClaude(body, signal) {
    let res;
    try {
      res = await fetch(API_URL, {
        method: "POST", signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": getKey(),
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",   // allows calling the API straight from a browser
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      throw new Error("No connection. Check your internet and send again.");
    }
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = json && json.error && json.error.message ? json.error.message : "HTTP " + res.status;
      if (res.status === 401) throw new Error("Your API key wasn't accepted. Check it in Settings.");
      if (res.status === 429) throw new Error("Too many requests right now. Wait a minute and send again.");
      throw new Error("Claude API error: " + msg);
    }
    return json;
  }

  const history = [];   // plain text turns, kept only while the app is open
  async function runAgent(userText, note, onText, signal) {
    history.push({ role: "user", content: userText });
    const recent = history.slice(-12);
    while (recent.length && recent[0].role !== "user") recent.shift();
    const messages = recent.map(m => ({ role: m.role, content: m.content }));
    const tools = makeTools(note);
    const toolDefs = tools.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
    const system = RULES + "\n\n" + contextBlock();
    let reply = "";

    for (let round = 0; round < 8; round++) {
      const res = await callClaude({ model: MODEL, max_tokens: 1024, system, tools: toolDefs, messages }, signal);
      messages.push({ role: "assistant", content: res.content });
      const text = res.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
      if (text) { reply = text; onText(text); }
      if (res.stop_reason !== "tool_use") break;

      const results = [];
      for (const block of res.content) {
        if (block.type !== "tool_use") continue;
        const tool = tools.find(t => t.name === block.name);
        let out, isError = false;
        try { out = tool ? await tool.execute(block.input || {}) : "Unknown tool " + block.name; if (!tool) isError = true; }
        catch (e) { out = "Error: " + (e && e.message ? e.message : e); isError = true; }
        results.push({ type: "tool_result", tool_use_id: block.id, content: typeof out === "string" ? out : JSON.stringify(out), ...(isError ? { is_error: true } : {}) });
      }
      messages.push({ role: "user", content: results });
    }
    reply = reply || "Done.";
    history.push({ role: "assistant", content: reply });
    return reply;
  }

  // ---------- chat UI ----------
  let ctl = null;
  function bubble(role, text) {
    $("#chat-empty").hidden = true;
    const t = el("div", {}, text), acts = el("ul", { class: "acts" });
    const b = el("div", { class: "bubble " + role }, t, role === "assistant" ? acts : null);
    $("#chat-view").append(b);
    return { t, acts, b };
  }
  function refreshComposer() {
    $("#msg").placeholder = getKey() ? "Tell it what you did…" : "Add your API key in Settings to chat";
  }
  function busy(on) { $("#send").hidden = on; $("#stop").hidden = !on; $("#msg").disabled = on; }
  function setLast(text) { const l = $("#last-reply"); l.textContent = text; l.hidden = !text || $("#today-view").hidden; }

  async function send(text) {
    if (!getKey()) { SHEETS.settings(); return; }
    bubble("user", text);
    const out = bubble("assistant", "Thinking…");
    const note = s => { out.acts.append(el("li", {}, lamp("on"), s)); };
    ctl = new AbortController(); busy(true); setLast("Thinking…");
    try {
      const reply = await runAgent(text, note, t => { out.t.textContent = t; setLast(t); }, ctl.signal);
      out.t.textContent = reply; setLast(reply);
    } catch (e) {
      const msg = e && e.name === "AbortError" ? "Stopped." : (e && e.message) || "Something went wrong. Send it again.";
      out.t.textContent = msg; setLast(msg);
      if (history.length && history[history.length - 1].role === "user") history.pop();
    } finally {
      busy(false); ctl = null; $("#msg").focus();
    }
  }

  $("#composer").addEventListener("submit", e => {
    e.preventDefault();
    const text = $("#msg").value.trim(); if (!text || ctl) return;
    $("#msg").value = ""; autosize();
    send(text);
  });
  $("#stop").onclick = () => ctl && ctl.abort();
  $("#msg").addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#composer").requestSubmit(); } });
  function autosize() { const t = $("#msg"); t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 120) + "px"; }
  $("#msg").addEventListener("input", autosize);

  // ---------- start ----------
  loadDay();
  refreshComposer();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
})();
