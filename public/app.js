const $ = (id) => document.getElementById(id);
const fields = ["threshold", "pingEnabled", "pingThreshold", "pingPersona", "draftModel", "intellectualEnabled", "prior", "batchMinMinutes", "batchMaxMinutes", "continuous", "breakMinMinutes", "breakMaxMinutes", "activeStartHour", "activeEndHour", "maxProfilesPerBatch", "minDelayMs", "maxDelayMs", "humanize", "quickPassBelow", "maxScreens", "maxProfileScrolls", "advanceGesture", "model", "effort", "captureReasoning", "userGuidance", "avdName", "emulatorWindow", "stopEmulatorOnExit", "deviceSerial"];
const boolFields = new Set(["pingEnabled", "humanize", "continuous", "captureReasoning", "intellectualEnabled", "emulatorWindow", "stopEmulatorOnExit"]);
let settings = {};
let state = { status: "idle", current: null };
let setup = { step: "idle", busy: false, message: "", googleAccount: null, feeldInstalled: false };
const decisionsById = new Map();
const cardEls = new Map(); // Live tab "Recent"
const noteDrafts = new Map(); // unsaved note text by decision id, survives card rebuilds
const ownDrafts = new Map(); // unsent "write my own" ping text by decision id
const pingOpen = new Set(); // decision ids whose ping picker is open
const reviewCards = new Map(); // decision id -> { el, ref } in the History tab
const queueCards = new Map(); // decision id -> { el, ref } in the To review tab
const isEditing = (el) => el && el.contains(document.activeElement) && ["TEXTAREA", "INPUT"].includes(document.activeElement.tagName);

function fmtP(p) { return (p * 100).toFixed(0) + "%"; }
const fmtTime = (iso) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

// Keep whatever card is at the top of the viewport in place while the DOM above it changes.
function keepScroll(update) {
  const cards = document.querySelectorAll(".tabpane:not([hidden]) .card");
  let anchor = null, top = 0;
  for (const c of cards) {
    const r = c.getBoundingClientRect();
    if (r.bottom > 0) { anchor = c; top = r.top; break; }
  }
  update();
  if (anchor && anchor.isConnected && window.scrollY > 0) {
    const delta = anchor.getBoundingClientRect().top - top;
    if (Math.abs(delta) > 1) window.scrollBy(0, delta);
  }
}
const modelNames = { "claude-opus-5": "Claude Opus 5", "claude-sonnet-5": "Claude Sonnet 5", "claude-haiku-4-5": "Claude Haiku 4.5", "claude-opus-4-8": "Claude Opus 4.8", "claude-fable-5-1": "Claude Fable 5.1" };
const hasEffort = (model) => !/haiku/i.test(model || "");
function modelLabel(d) {
  if (!d.model) return "model not recorded";
  const effort = hasEffort(d.model) && d.effort ? ` (${d.effort} effort)` : "";
  return `${modelNames[d.model] ?? d.model}${effort}`;
}
// Likelihood ratio as a whole-number ratio: 12 -> "12:1", 1.5 -> "3:2", 0.7 -> "7:10", 1 -> "1:1".
function fmtRatio(lr) {
  if (!(lr > 0)) return "1:1";
  let best = [1, 1], bestErr = Infinity;
  for (let den = 1; den <= 20; den++) {
    const num = Math.max(1, Math.round(lr * den));
    if (num > 20 && den > 1) continue;
    const err = Math.abs(num / den - lr) / lr;
    if (err < bestErr - 1e-9) { bestErr = err; best = [num, den]; }
    if (err < 0.02) break;
  }
  return `${best[0]}:${best[1]}`;
}
const recommendationOf = (d) => (d.action === "recommend_ping" ? "ping" : d.action === "recommend_like" ? "like" : d.action === "recommend_pass" ? "pass" : null);
const isPending = (d) => !d.review && !d.applied;
const actionWord = { like: "Liked", ping: "Pinged", pass: "Passed" };

async function api(method, path, body) {
  const r = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
}

// ---------- settings ----------
function renderSettingsDerived() {
  $("thresholdVal").textContent = fmtP(parseFloat($("threshold").value));
  const prior = parseFloat($("prior").value);
  $("priorVal").textContent = fmtP(prior);
  $("lrNeeded").textContent = ((1 - prior) / prior).toFixed(1);
  const effortOk = hasEffort($("model").value);
  $("effort").disabled = !effortOk;
  $("effortHint").textContent = effortOk ? "" : "Haiku 4.5 has no effort control.";
  $("quickPassVal").textContent = fmtP(parseFloat($("quickPassBelow").value));
  $("pingVal").textContent = fmtP(parseFloat($("pingThreshold").value));
  $("pingOpts").hidden = $("pingEnabled").value !== "true";
  $("continuousOpts").hidden = $("continuous").value !== "true";
}
function fillSettings(s) {
  settings = s;
  for (const f of fields) $(f).value = String(s[f]);
  renderSettingsDerived();
}
async function saveSettings() {
  const patch = {};
  for (const f of fields) {
    const el = $(f);
    if (boolFields.has(f)) patch[f] = el.value === "true";
    else patch[f] = el.type === "number" || el.type === "range" ? parseFloat(el.value) : el.value;
  }
  const res = await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
  const body = await res.json();
  if (res.ok) { fillSettings(body); $("saveMsg").textContent = "Saved."; }
  else $("saveMsg").textContent = "Error: " + body.error;
  setTimeout(() => ($("saveMsg").textContent = ""), 2500);
}

// ---------- state / log / stats ----------
const statusLabel = { idle: "idle", booting: "starting the phone", setup_needed: "setup needed", awaiting_login: "waiting for Feeld login", running: "running", stopping: "stopping", stopped: "stopped", waiting: "waiting", error: "error" };
function setState(s) {
  state = s;
  $("statusText").textContent = (statusLabel[s.status] ?? s.status) + (s.current?.name ? ` · ${s.current.name}` : "");
  $("statusDot").className = "dot " + s.status;
  $("sSession").textContent = s.swipesThisSession;
  const busy = ["booting", "awaiting_login", "running", "stopping"].includes(s.status);
  $("startBtn").disabled = busy;
  $("stopBtn").disabled = !busy && s.status !== "waiting";
  $("startBtn").textContent = s.status === "waiting" ? "Start next batch now" : "Start batch";
  renderBatchText();
  if (s.status === "error" && s.lastError) appendLog({ at: new Date().toISOString(), message: "ERROR: " + s.lastError });
  renderCurrent();
  renderDevice();
}
function renderBatchText() {
  const s = state;
  const el = $("batchText");
  if (s.batch && ["running", "booting", "awaiting_login"].includes(s.status)) {
    const left = Math.max(0, Math.round((new Date(s.batch.endsAt) - Date.now()) / 60000));
    el.textContent = `· ${s.batch.plannedMinutes}-min batch, ${left} min left, ${s.batch.evaluated} judged, ${s.batch.applied} done`;
  } else if (s.status === "waiting" && s.nextBatchAt) {
    el.textContent = `· next batch ${new Date(s.nextBatchAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}`;
  } else if (s.lastBatchEnd) {
    el.textContent = `· last batch: ${s.lastBatchEnd}`;
  } else el.textContent = "";
  if (s.deck && ["running", "awaiting_login"].includes(s.status)) el.textContent += ` · phone: ${s.deck.replace(/-/g, " ")}`;
}
setInterval(renderBatchText, 30_000);

function appendLog(entry) {
  const el = $("log");
  el.textContent += `${entry.at.slice(11, 19)}  ${entry.message}\n`;
  el.scrollTop = el.scrollHeight;
}
function setStats(s) {
  $("sSeen").textContent = s.seen; $("sLiked").textContent = s.liked; $("sPinged").textContent = s.pinged ?? 0;
  $("sPending").textContent = s.pending ?? 0;
  $("sQueued").textContent = s.queued ? s.queued.like + s.queued.ping + s.queued.pass : 0;
}
async function refreshStats() { setStats((await (await fetch("/api/state")).json()).stats); }

// ---------- shared card rendering ----------
function distanceOf(d) {
  if (typeof d.distanceMiles === "number") return d.distanceMiles;
  const m = (d.profileText ?? "").match(/(\d+(?:\.\d+)?)\s*(miles?|mi|km|kilomet\w+)\s+away/i);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  return /k/i.test(m[2]) ? Math.round(n * 0.621371) : n;
}
function fillClassification(root, d) {
  const c = d.classification;
  const dist = distanceOf(d);
  root.querySelector(".name").textContent = `${d.name ?? "Unknown"}${d.age ? `, ${d.age}` : ""}`;
  if (dist !== undefined) { const sp = document.createElement("span"); sp.className = "dist"; sp.textContent = `${dist} mi`; root.querySelector(".name").appendChild(sp); }
  const badge = root.querySelector(".action");
  const actionLabel = { recommend_like: "Recommends like", recommend_ping: "Recommends ping", recommend_pass: "Recommends pass", skipped: "Not scored" };
  badge.textContent = actionLabel[d.action] ?? d.action.replace("_", " ");
  badge.className = "badge action " + d.action;
  if (c) {
    const bars = root.querySelectorAll(".prob");
    bars[0].querySelector(".fill").style.width = fmtP(c.probability);
    bars[0].querySelector(".thresh").style.left = fmtP(d.threshold);
    bars[0].querySelector(".pval").textContent = fmtP(c.probability);
    if (typeof d.pingThreshold === "number") { const t = bars[0].querySelector(".thresh.super"); t.style.left = fmtP(d.pingThreshold); t.hidden = false; }
    if (typeof c.arithmetic_probability === "number") {
      const a = document.createElement("span"); a.className = "arith"; a.title = "Arithmetic posterior: prior odds × the listed ratios";
      a.textContent = `arith ${fmtP(c.arithmetic_probability)}`;
      bars[0].appendChild(a);
    }
    if (c.intellectual_exception) {
      const lf = document.createElement("span"); lf.className = "badge likedfor"; lf.textContent = "🧠 intellectual exception";
      badge.after(lf);
    }
    if (typeof c.intellectual_probability === "number") {
      const ip = document.createElement("span"); ip.className = "intp"; ip.title = "Model's probability that you'd consider them eligible for the intellectual exception";
      ip.textContent = `🧠 ${fmtP(c.intellectual_probability)}`;
      root.querySelector(".model").appendChild(ip);
    }
    root.querySelector(".diet").textContent = c.dietary_badge ? `Dietary tag: ${c.dietary_badge}` : "No dietary tag shown";
    root.querySelector(".modelchip").textContent = modelLabel(d);
    const stage = root.querySelector(".stage");
    if (d.quickPass) stage.textContent = /pass$/.test(d.action) ? "text and first screen only · quick pass" : "text and first screen only";
    else if (typeof d.bioOnlyProbability === "number") stage.textContent = `first screen ${fmtP(d.bioOnlyProbability)} → all screens ${fmtP(c.probability)}`;
    else stage.textContent = "";
    const ul = root.querySelector(".evidence");
    ul.innerHTML = "";
    for (const e of c.evidence) {
      const li = document.createElement("li");
      li.className = e.direction;
      li.textContent = `${e.criterion === "intellectual" ? "🧠 " : ""}${e.observation}`;
      if (e.criterion !== "intellectual") {
        const lr = document.createElement("span"); lr.className = "lr"; lr.textContent = `LR ${fmtRatio(e.likelihood_ratio)}`; li.appendChild(lr);
      }
      ul.appendChild(li);
    }
    if (c.reasoning) root.querySelector(".reasoning").textContent = c.reasoning;
    else root.querySelector(".reasoning")?.closest("details")?.remove();
  } else {
    root.querySelector(".prob")?.remove();
    root.querySelector(".reasoning")?.closest("details")?.remove();
    root.querySelector(".diet").innerHTML = `<span class="error">${d.error ?? "Not classified"}</span>`;
    root.querySelector(".model")?.remove();
  }
  // Screens: the profile as it scrolled by. Loaded only when the section is opened.
  const box = root.querySelector(".screensBox");
  const screens = (d.screens ?? []).filter((u) => !(d.photos ?? []).includes(u));
  if (!screens.length) box?.remove();
  else {
    box.querySelector("summary").textContent = `Screens (${screens.length})`;
    box.addEventListener("toggle", () => {
      const wrap = box.querySelector(".screens");
      if (!box.open || wrap.children.length) return;
      for (const url of screens) {
        const img = document.createElement("img"); img.src = thumbUrl(url); img.loading = "lazy"; img.decoding = "async";
        img.onclick = () => { const z = img.classList.toggle("zoom"); img.src = z ? url : thumbUrl(url); };
        wrap.appendChild(img);
      }
    }, { once: true });
  }
}
const thumbUrl = (url) => url.replace(/^\/photos\//, "/thumbs/");
function fillPhotos(root, d, limit, full = false) {
  const photos = root.querySelector(".photos");
  photos.innerHTML = "";
  for (const url of d.photos.slice(0, limit)) {
    const img = document.createElement("img");
    img.src = full ? url : thumbUrl(url);
    img.loading = "lazy"; img.decoding = "async";
    img.onclick = () => {
      const zoomed = img.classList.toggle("zoom");
      img.src = zoomed || full ? url : thumbUrl(url);
    };
    photos.appendChild(img);
  }
}

// ---------- review: like / ping / pass / leave it ----------
async function sendReview(id, choice, message) {
  const res = await fetch(`/api/decisions/${id}/review`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ choice, message }) });
  const body = await res.json();
  if (!res.ok) { appendLog({ at: new Date().toISOString(), message: "Review rejected: " + body.error }); return null; }
  setStats(body.stats);
  pingOpen.delete(id);
  ownDrafts.delete(id);
  renderDecision(body.decision, false, true);
  return body.decision;
}
function fillReviewBar(root, d) {
  const bar = root.querySelector(".reviewbar");
  const box = root.querySelector(".pingbox");
  const label = bar.querySelector(".rlabel");
  const btns = bar.querySelectorAll(".rbtn");
  const rec = recommendationOf(d);
  const cur = () => decisionsById.get(d.id) ?? d;
  const paint = () => {
    const c = cur();
    btns.forEach((b) => {
      b.classList.toggle("on", c.review === b.dataset.c);
      b.classList.toggle("rec", !c.review && rec === b.dataset.c);
      b.disabled = !!c.applied;
    });
    if (c.applied) {
      label.innerHTML = `<b class="${c.applied}">${actionWord[c.applied]}</b> on Feeld · ${fmtTime(c.appliedAt)}${c.applyNote ? ` · ${c.applyNote}` : ""}${c.applied === "ping" && c.pingMessage ? `<span class="msg">“${c.pingMessage}”</span>` : ""}`;
    } else if (c.review === "skip") {
      label.textContent = "Left alone: no like, no pass.";
    } else if (c.review) {
      label.innerHTML = `Queued for the next batch: <b class="${c.review}">${c.review}</b>${c.review === "ping" && c.pingMessage ? `<span class="msg">“${c.pingMessage}”</span>` : ""}`;
    } else {
      label.textContent = rec ? `Model recommends ${rec}. Your call:` : "Not scored. Your call:";
    }
  };
  paint();
  btns.forEach((b) => {
    b.onclick = () => {
      const c = cur();
      if (b.dataset.c === "ping") { openPingBox(); return; }
      sendReview(d.id, c.review === b.dataset.c ? null : b.dataset.c);
    };
  });

  // The ping picker: three drafts, or your own words.
  const drafts = box.querySelector(".drafts");
  const own = box.querySelector(".draft.own input");
  const ownText = box.querySelector(".ownmsg");
  const hint = box.querySelector(".pinghint");
  const radioName = `ping-${d.id}`;
  own.name = radioName;
  ownText.value = ownDrafts.get(d.id) ?? "";
  ownText.oninput = () => { ownDrafts.set(d.id, ownText.value); own.checked = true; };
  ownText.onfocus = () => { own.checked = true; };
  const renderDrafts = () => {
    const c = cur();
    drafts.innerHTML = "";
    const list = c.pingDrafts ?? [];
    list.forEach((dr, i) => {
      const lab = document.createElement("label"); lab.className = "draft";
      const r = document.createElement("input"); r.type = "radio"; r.name = radioName; r.value = String(i);
      const t = document.createElement("span"); t.className = "dtext";
      const ang = document.createElement("b"); ang.textContent = dr.angle; t.appendChild(ang);
      t.appendChild(document.createTextNode(" " + dr.text));
      lab.append(r, t);
      drafts.appendChild(lab);
    });
    // Preselect: the message already chosen, else the first draft, else your own.
    const chosen = c.pingMessage ? list.findIndex((x) => x.text === c.pingMessage) : -1;
    const radios = box.querySelectorAll(`input[name="${radioName}"]`);
    if (chosen >= 0) radios[chosen].checked = true;
    else if (c.pingMessage) { own.checked = true; if (!ownText.value) ownText.value = c.pingMessage; }
    else if (list.length) radios[0].checked = true;
    else own.checked = true;
    hint.textContent = list.length ? `Drafted by ${modelNames[c.draftsModel] ?? c.draftsModel ?? "the drafting model"}.` : "No drafts yet.";
  };
  let draftingNow = false;
  const fetchDrafts = async () => {
    if (draftingNow) return;
    draftingNow = true;
    hint.textContent = `Drafting three openers with ${modelNames[settings.draftModel] ?? settings.draftModel}… (10–40 s)`;
    box.querySelector(".redraft").disabled = true;
    try {
      const r = await api("POST", `/api/decisions/${d.id}/drafts`);
      if (r.error) { hint.textContent = "Drafting failed: " + r.error; return; }
      decisionsById.set(d.id, r.decision);
      renderDrafts();
    } finally {
      draftingNow = false;
      box.querySelector(".redraft").disabled = false;
    }
  };
  function openPingBox() {
    const c = cur();
    if (c.applied) return;
    pingOpen.add(d.id);
    box.hidden = false;
    renderDrafts();
    if (!(c.pingDrafts ?? []).length) fetchDrafts();
  }
  box.querySelector(".redraft").onclick = fetchDrafts;
  box.querySelector(".cancelping").onclick = () => { pingOpen.delete(d.id); box.hidden = true; };
  box.querySelector(".queueping").onclick = async () => {
    const c = cur();
    const sel = box.querySelector(`input[name="${radioName}"]:checked`);
    const message = !sel || sel.value === "own" ? ownText.value.trim() : (c.pingDrafts ?? [])[+sel.value]?.text ?? "";
    if (!message) { hint.textContent = "Pick a draft or write a message first."; ownText.focus(); return; }
    box.querySelector(".queueping").disabled = true;
    const ok = await sendReview(d.id, "ping", message);
    if (!ok) box.querySelector(".queueping").disabled = false;
  };
  if (pingOpen.has(d.id)) openPingBox();
}

// ---------- current profile (live) ----------
function renderCurrent() {
  const box = $("current");
  box.className = "current empty";
  if (state.status === "running") {
    const c = state.current;
    const doing = { reading: "reading the profile…", judging: "asking the model…", drafting: "drafting ping openers…", applying: "doing your review on Feeld…", "moving on": "moving on without voting…" };
    box.textContent = c ? `${c.name ?? "Someone"}: ${doing[c.doing] ?? c.doing}` : "Looking at the phone…";
    box.className = "current waiting";
    return;
  }
  box.textContent = state.status === "awaiting_login" ? "Log into Feeld on the phone panel on the right…"
    : state.status === "booting" ? "Starting the phone and opening Feeld…"
    : state.status === "setup_needed" ? "Feeld isn't installed on the phone yet. Use the Setup panel on the right."
    : state.status === "waiting" ? "Between batches. The next one starts on its own, or press Start to begin now."
    : "Press Start batch. New profiles are judged and left for you in the To review tab; your reviewed likes, pings and passes are done when those profiles come round again.";
}

// ---------- cards ----------
function buildCard(d) {
  const tpl = $("cardTpl").content.cloneNode(true);
  fillClassification(tpl, d);
  fillPhotos(tpl, d, 3);
  fillReviewBar(tpl, d);
  const vlabel = tpl.querySelector(".vlabel");
  vlabel.textContent = "Grade the model:";
  const vbtns = tpl.querySelectorAll(".vbtn:not(.exemplar)");
  const range = tpl.querySelector(".userpRange");
  const paint = (v, up) => {
    vbtns.forEach((b) => b.classList.toggle("on", b.dataset.v === v));
    range.value = typeof up === "number" ? Math.round(up * 100) : "";
  };
  paint(d.verdict ?? null, d.userProbability);
  const send = async (verdict, userProbability) => {
    const res = await fetch(`/api/decisions/${d.id}/verdict`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ verdict, userProbability }) });
    if (res.ok) {
      const body = await res.json();
      const cur = decisionsById.get(d.id) ?? d;
      cur.verdict = body.decision.verdict; cur.userProbability = body.decision.userProbability;
      paint(cur.verdict ?? null, cur.userProbability); setStats(body.stats);
    }
  };
  vbtns.forEach((b) => {
    b.onclick = () => send(b.classList.contains("on") ? null : b.dataset.v, b.classList.contains("on") ? null : undefined);
  });
  const exBtn = tpl.querySelector(".vbtn.exemplar");
  exBtn.classList.toggle("on", d.exemplar === "intellectual");
  exBtn.onclick = async () => {
    const next = exBtn.classList.contains("on") ? null : "intellectual";
    const res = await fetch(`/api/decisions/${d.id}/exemplar`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ exemplar: next }) });
    if (res.ok) { const body = await res.json(); const cur = decisionsById.get(d.id) ?? d; cur.exemplar = body.decision.exemplar; exBtn.classList.toggle("on", cur.exemplar === "intellectual"); }
  };
  range.onchange = () => {
    if (range.value === "") { send(null, null); return; }
    const up = Math.min(100, Math.max(0, parseFloat(range.value))) / 100;
    const p = d.classification?.probability;
    const verdict = p === undefined ? null : up > p + 0.1 ? "higher" : up < p - 0.1 ? "lower" : "about_right";
    send(verdict, up);
  };
  range.onkeydown = (e) => { if (e.key === "Enter") range.blur(); };
  const note = tpl.querySelector(".note");
  note.value = noteDrafts.get(d.id) ?? d.note ?? "";
  let noteTimer = null;
  const saveNote = async () => {
    const text = note.value;
    noteDrafts.set(d.id, text);
    if ((decisionsById.get(d.id)?.note ?? "") === text) return;
    const res = await fetch(`/api/decisions/${d.id}/note`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note: text }) });
    if (res.ok) {
      const body = await res.json();
      const cur = decisionsById.get(d.id) ?? d;
      cur.note = body.decision.note;
      if (noteDrafts.get(d.id) === cur.note) noteDrafts.delete(d.id);
      note.classList.add("saved"); setTimeout(() => note.classList.remove("saved"), 1200);
    }
  };
  note.oninput = () => { noteDrafts.set(d.id, note.value); clearTimeout(noteTimer); noteTimer = setTimeout(saveNote, 800); };
  note.onblur = () => { clearTimeout(noteTimer); saveNote(); };
  if (!d.classification) { tpl.querySelector(".verdict").remove(); note.remove(); }
  tpl.querySelector(".ptext").textContent = d.profileText || "(no profile text captured)";
  const u = d.usage ? ` · ${d.usage.input + d.usage.cacheRead} in / ${d.usage.output} out tokens` : "";
  tpl.querySelector(".meta").textContent = `${new Date(d.at).toLocaleString()} · threshold ${fmtP(d.threshold)}${u}`;
  return tpl.querySelector("article");
}

/** A decision arrived or changed: keep the maps and every list in step. `own` = caused by this dashboard. */
function renderDecision(d, prepend, own = false) {
  const prev = decisionsById.get(d.id);
  if (prev) {
    if (noteDrafts.has(d.id)) d.note = prev.note ?? d.note;
    if (prev.verdict !== undefined && d.verdict == null) d.verdict = prev.verdict;
    if (prev.userProbability != null && d.userProbability == null) d.userProbability = prev.userProbability;
  }
  decisionsById.set(d.id, d);
  const existing = cardEls.get(d.id);
  if (existing && isEditing(existing)) { scheduleListRenders(own); return; }
  if (existing || prepend) {
    const article = buildCard(d);
    keepScroll(() => {
      const feed = $("decisions");
      feed.querySelector(".empty")?.remove();
      if (existing) existing.replaceWith(article);
      else feed.prepend(article);
      cardEls.set(d.id, article);
      while (feed.children.length > 8) { const last = feed.lastElementChild; for (const [id, el] of cardEls) if (el === last) cardEls.delete(id); last.remove(); }
    });
  }
  scheduleListRenders(own);
}

// ---------- the two lists: To review and History ----------
let listTimer = null;
function scheduleListRenders(own = false) {
  clearTimeout(listTimer);
  listTimer = setTimeout(() => { renderQueue(own); renderReview(own); }, 150);
}
function assignBatches(all) {
  const sorted = [...all].sort((a, b) => (a.at < b.at ? -1 : 1));
  let pseudo = null, lastT = 0;
  for (const d of sorted) {
    const t = new Date(d.at).getTime();
    if (d.batchId) { d._batch = d.batchId; pseudo = null; }
    else {
      if (!pseudo || t - lastT > 15 * 60_000) pseudo = "~" + d.at;
      d._batch = pseudo;
    }
    lastT = t;
  }
  const groups = new Map();
  for (const d of sorted) { const g = groups.get(d._batch) ?? { id: d._batch, start: d.at, n: 0 }; g.n++; groups.set(d._batch, g); }
  return [...groups.values()].sort((a, b) => (a.start < b.start ? 1 : -1));
}
function refreshBatchOptions(groups) {
  const sel = $("fBatch"); const cur = sel.value;
  const label = (g) => `${fmtTime(g.start)} · ${g.n} profiles${g.id.startsWith("~") ? " (grouped by time)" : ""}`;
  const wanted = ["all", ...groups.map((g) => g.id)];
  if ([...sel.options].map((o) => o.value).join("|") !== wanted.join("|")) {
    sel.innerHTML = '<option value="all">All batches</option>' + groups.map((g) => `<option value="${g.id}">${label(g)}</option>`).join("");
    sel.value = wanted.includes(cur) ? cur : "all";
  }
}
function sortRows(rows, how) {
  const intOf = (d) => d.classification?.intellectual_probability ?? -1;
  rows.sort((a, b) => {
    if (how === "prob") return (b.classification?.probability ?? -1) - (a.classification?.probability ?? -1) || (b.at > a.at ? 1 : -1);
    if (how === "int") {
      const rank = (d) => (d.exemplar === "intellectual" ? 2 : d.classification?.intellectual_exception ? 1 : 0);
      return rank(b) - rank(a) || intOf(b) - intOf(a) || (b.at > a.at ? 1 : -1);
    }
    if (how === "oldest") return a.at < b.at ? -1 : 1;
    if (how === "near") return (distanceOf(a) ?? 9999) - (distanceOf(b) ?? 9999) || (b.at > a.at ? 1 : -1);
    return a.at < b.at ? 1 : -1;
  });
}
const PAGE = 40;
/** Render `rows` into `list`, reusing cards whose decision object hasn't changed. */
function paintList(list, cards, rows, limitRef, onMore) {
  const shown = rows.slice(0, limitRef.n);
  keepScroll(() => {
    const keep = new Set(shown.map((d) => d.id));
    for (const [id, entry] of cards) if (!keep.has(id)) { entry.el.remove(); cards.delete(id); }
    for (const d of shown) {
      let entry = cards.get(d.id);
      if (!entry || entry.ref !== d) {
        if (entry) entry.el.remove();
        entry = { el: buildCard(d), ref: d };
        cards.set(d.id, entry);
      }
      list.appendChild(entry.el);
    }
    list.querySelector(".empty")?.remove();
    if (rows.length > limitRef.n) {
      const more = document.createElement("button"); more.className = "empty more"; more.textContent = `Show more (${shown.length} of ${rows.length})`;
      more.onclick = () => { limitRef.n += PAGE; onMore(); };
      list.appendChild(more);
    } else if (!rows.length) {
      const e = document.createElement("div"); e.className = "empty"; e.textContent = list === $("queueList") ? "Nothing waiting for your review." : "Nothing here.";
      list.appendChild(e);
    }
  });
}
/** Don't yank a list around under the reader: when they've scrolled down, offer a pill instead. */
function deferIfScrolled(pane, list, pill, counter, userInitiated) {
  if (pane.hidden) return true;
  if (isEditing(list)) return true;
  if (!userInitiated && window.scrollY > 150 && list.children.length) {
    counter.n++;
    pill.hidden = false;
    pill.textContent = `${counter.n} ${counter.n === 1 ? "change" : "changes"} · click to update the list`;
    return true;
  }
  counter.n = 0; pill.hidden = true;
  return false;
}

// To review
const queueLimit = { n: PAGE };
const queuePendingN = { n: 0 };
let queueVisible = [];
function renderQueue(userInitiated = true) {
  const list = $("queueList");
  const all = Array.from(decisionsById.values());
  const pending = all.filter(isPending);
  $("queueCount").textContent = pending.length ? `(${pending.length})` : "";
  if (deferIfScrolled($("tab-queue"), list, $("queuePending"), queuePendingN, userInitiated)) return;
  const show = $("qShow").value;
  const rows = pending.filter((d) => {
    if (show === "like") return d.action === "recommend_like" || d.action === "recommend_ping";
    if (show === "ping") return d.action === "recommend_ping";
    if (show === "pass") return d.action === "recommend_pass";
    if (show === "exception") return !!d.classification?.intellectual_exception;
    if (show === "skipped") return d.action === "skipped";
    return true;
  });
  sortRows(rows, $("qSort").value);
  queueVisible = rows;
  const nPass = rows.filter((d) => d.action === "recommend_pass").length;
  const nLike = rows.filter((d) => d.action === "recommend_like" || d.action === "recommend_ping").length;
  $("bulkPass").disabled = !nPass;
  $("bulkPass").textContent = `Pass on all recommended passes shown (${nPass})`;
  $("bulkSkip").disabled = !rows.length;
  $("bulkSkip").textContent = `Leave all shown alone (${rows.length})`;
  $("queueSummary").textContent = pending.length
    ? `${rows.length} of ${pending.length} waiting shown · ${nLike} recommended like or ping, ${nPass} recommended pass`
    : "Nothing waiting for your review.";
  paintList(list, queueCards, rows, queueLimit, () => renderQueue());
}
async function bulkReview(choice, ids) {
  if (!ids.length) return;
  const r = await api("POST", "/api/review/bulk", { choice, ids });
  if (r.error) { appendLog({ at: new Date().toISOString(), message: "Bulk review failed: " + r.error }); return; }
  if (r.stats) setStats(r.stats);
  // The server broadcasts each updated decision; re-render once they land.
  setTimeout(() => renderQueue(true), 300);
}
$("bulkPass").onclick = () => bulkReview("pass", queueVisible.filter((d) => d.action === "recommend_pass").map((d) => d.id));
$("bulkSkip").onclick = () => bulkReview("skip", queueVisible.map((d) => d.id));
$("queuePending").onclick = () => { window.scrollTo({ top: 0 }); renderQueue(true); };
for (const id of ["qShow", "qSort"]) $(id).addEventListener("input", () => { queueLimit.n = PAGE; renderQueue(); });
document.addEventListener("keydown", (e) => {
  if (["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
  if (document.activeElement === $("phone")) return; // keys go to the phone
  if ($("tab-queue").hidden) return;
  const top = queueVisible.find((d) => queueCards.has(d.id));
  if (!top) return;
  if (e.key === "ArrowLeft") { e.preventDefault(); sendReview(top.id, "pass"); }
  if (e.key === "ArrowRight") { e.preventDefault(); sendReview(top.id, "like"); }
});

// History
const reviewLimit = { n: PAGE };
const reviewPendingN = { n: 0 };
function renderReview(userInitiated = true) {
  const list = $("reviewList");
  const all = Array.from(decisionsById.values());
  $("reviewCount").textContent = all.length ? `(${all.length})` : "";
  if (deferIfScrolled($("tab-review"), list, $("reviewPending"), reviewPendingN, userInitiated)) return;
  refreshBatchOptions(assignBatches(all));
  const fBatch = $("fBatch").value;
  const minP = parseFloat($("minP").value);
  $("minPVal").textContent = fmtP(minP);
  const fAction = $("fAction").value, fSwipe = $("fSwipe").value, fSort = $("fSort").value, fVerdict = $("fVerdict").value;
  const which = $("minPWhich").value;
  document.body.classList.toggle("show-intp", which === "int" || fSort === "int");
  document.body.classList.toggle("show-arith", $("fProb").value === "both");
  const scoreOf = (d) => (which === "int" ? d.classification?.intellectual_probability : d.classification?.probability);
  const rows = all.filter((d) => {
    if (fBatch !== "all" && d._batch !== fBatch) return false;
    const p = scoreOf(d);
    if (minP > 0 && (p === undefined || p < minP)) return false;
    if (fVerdict === "ungraded" && d.verdict) return false;
    if (["higher", "lower", "about_right"].includes(fVerdict) && d.verdict !== fVerdict) return false;
    if (fAction === "like" && d.action !== "recommend_like" && d.action !== "recommend_ping") return false;
    if (fAction === "ping" && d.action !== "recommend_ping") return false;
    if (fAction === "pass" && d.action !== "recommend_pass") return false;
    if (fAction === "skipped" && d.action !== "skipped") return false;
    if (fAction === "exception" && !d.classification?.intellectual_exception) return false;
    if (fSwipe === "none" && !isPending(d)) return false;
    if (["like", "ping", "pass", "skip"].includes(fSwipe) && d.review !== fSwipe && d.applied !== fSwipe) return false;
    if (fSwipe === "queued" && !(d.review && d.review !== "skip" && !d.applied)) return false;
    if (fSwipe === "applied" && !d.applied) return false;
    return true;
  });
  sortRows(rows, fSort);
  const above = all.filter((d) => (scoreOf(d) ?? -1) >= minP).length;
  const done = rows.filter((d) => d.applied);
  const likedRows = done.filter((d) => d.applied !== "pass").length;
  const likeRate = done.length ? ` · like rate ${Math.round((100 * likedRows) / done.length)}% (${likedRows} of ${done.length} done on Feeld)` : "";
  $("filterSummary").textContent = all.length
    ? `${rows.length} of ${all.length} profiles shown · ${above} scored at or above ${fmtP(minP)}${likeRate}`
    : "Nothing evaluated yet.";
  paintList(list, reviewCards, rows, reviewLimit, () => renderReview());
}
document.addEventListener("focusout", () => setTimeout(() => { if (!isEditing($("reviewList")) && !isEditing($("queueList"))) scheduleListRenders(false); }, 50));
$("reviewPending").onclick = () => { window.scrollTo({ top: 0 }); renderReview(true); };
window.addEventListener("scroll", () => {
  if (window.scrollY > 150) return;
  if (reviewPendingN.n && !$("tab-review").hidden) renderReview(true);
  if (queuePendingN.n && !$("tab-queue").hidden) renderQueue(true);
}, { passive: true });
for (const id of ["minP", "minPWhich", "fAction", "fSwipe", "fSort", "fVerdict", "fProb", "fBatch"]) $(id).addEventListener("input", () => { reviewLimit.n = PAGE; renderReview(); });

// ---------- tabs ----------
function showTab(name) {
  document.querySelectorAll(".tabs .tab").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  $("tab-swipe").hidden = name !== "swipe";
  $("tab-queue").hidden = name !== "queue";
  $("tab-review").hidden = name !== "review";
  try { localStorage.setItem("tab", name); } catch {}
  if (name === "review") renderReview(true);
  if (name === "queue") renderQueue(true);
  wsSend({ type: "screen", on: name === "swipe" });
}
document.querySelectorAll(".tabs .tab").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));

// ---------- phone: live screen + input over WebSocket ----------
let ws = null;
const phone = $("phone"), shot = $("shot");
let prevUrl = null, frames = 0, fpsT0 = Date.now();
function wsSend(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function showFrame(blob) {
  const url = URL.createObjectURL(blob);
  shot.onload = () => { if (prevUrl) URL.revokeObjectURL(prevUrl); prevUrl = url; };
  shot.src = url;
  $("phoneMsg").style.display = "none";
  frames++;
  if (Date.now() - fpsT0 > 2000) { $("fps").textContent = (frames / ((Date.now() - fpsT0) / 1000)).toFixed(1) + " fps"; frames = 0; fpsT0 = Date.now(); }
}
function norm(ev) {
  const r = shot.getBoundingClientRect();
  return { x: (ev.clientX - r.left) / r.width, y: (ev.clientY - r.top) / r.height };
}
let down = null;
phone.addEventListener("pointerdown", (ev) => { phone.focus(); down = { ...norm(ev), t: Date.now(), cx: ev.clientX, cy: ev.clientY }; phone.setPointerCapture(ev.pointerId); ev.preventDefault(); });
phone.addEventListener("pointerup", (ev) => {
  if (!down) return;
  const up = norm(ev), dt = Date.now() - down.t;
  const dist = Math.hypot(ev.clientX - down.cx, ev.clientY - down.cy);
  if (dist < 8 && dt < 500) wsSend({ type: "tap", x: up.x, y: up.y });
  else wsSend({ type: "swipe", x1: down.x, y1: down.y, x2: up.x, y2: up.y, ms: Math.max(80, Math.min(1500, dt)) });
  down = null;
});
let textBuf = "", textTimer = null;
function flushText() { if (textBuf) { wsSend({ type: "text", text: textBuf }); textBuf = ""; } textTimer = null; }
const SPECIAL = new Set(["Enter", "Backspace", "Delete", "Tab", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]);
phone.addEventListener("keydown", (ev) => {
  if (ev.metaKey || ev.ctrlKey) return; // let copy/paste through
  if (SPECIAL.has(ev.key)) { flushText(); wsSend({ type: "key", key: ev.key }); ev.preventDefault(); return; }
  if (ev.key.length === 1) { textBuf += ev.key; clearTimeout(textTimer); textTimer = setTimeout(flushText, 150); ev.preventDefault(); }
});
phone.addEventListener("paste", (ev) => { const t = ev.clipboardData.getData("text"); if (t) wsSend({ type: "text", text: t }); ev.preventDefault(); });
for (const b of document.querySelectorAll("[data-key]")) b.onclick = () => wsSend({ type: "key", key: b.dataset.key });
$("sendText").addEventListener("keydown", (ev) => { if (ev.key === "Enter") { wsSend({ type: "text", text: $("sendText").value }); $("sendText").value = ""; } });
function connectWs() {
  ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws");
  ws.binaryType = "blob";
  ws.onopen = () => wsSend({ type: "screen", on: !$("tab-swipe").hidden });
  ws.onmessage = (ev) => { if (ev.data instanceof Blob) showFrame(ev.data); };
  ws.onclose = () => { $("phoneMsg").style.display = ""; $("phoneMsg").textContent = "Disconnected; reconnecting…"; setTimeout(connectWs, 2000); };
}

function renderDevice() {
  const d = state.device;
  $("stDevice").textContent = d ? "✅" : state.status === "booting" ? "⏳" : "○";
  $("deviceLabel").textContent = d ? `(${d.avd ? d.avd + " · " : ""}${d.serial})` : "";
  if (!d) { $("phoneMsg").style.display = ""; $("phoneMsg").textContent = state.status === "booting" ? "Starting the emulator… (first boot takes a minute or two)" : "No phone connected. It boots on its own when you press Start, or press Connect below."; }
}
function renderSetup(st) {
  setup = st;
  $("stGoogle").textContent = st.googleAccount ? "✅" : st.step === "google" && st.busy ? "⏳" : "○";
  $("googleAcct").textContent = st.googleAccount ? `(${st.googleAccount})` : "";
  $("stFeeld").textContent = st.feeldInstalled ? "✅" : st.step === "install" && st.busy ? "⏳" : "○";
  $("stLogin").textContent = st.feeldInstalled ? (state.deck === "discover" ? "✅" : "👉") : "○";
  const msg = $("setupMsg");
  msg.hidden = !st.message;
  msg.textContent = st.message || "";
  msg.className = "note" + (st.step === "error" ? " err" : "") + (st.needsAttention ? " warn" : "");
  $("googleForm").hidden = !!st.googleAccount || !state.device;
  $("installOnly").hidden = !(st.googleAccount && !st.feeldInstalled);
  $("setupRun").disabled = st.busy;
  $("setupInstall").disabled = st.busy;
}
$("setupRun").onclick = async () => {
  const email = $("gEmail").value.trim(), password = $("gPass").value;
  if (!email || !password) { $("setupMsg").hidden = false; $("setupMsg").className = "note err"; $("setupMsg").textContent = "Enter your Google email and password first."; return; }
  const r = await api("POST", "/api/setup/run", { email, password });
  if (r.error) appendLog({ at: new Date().toISOString(), message: "Setup: " + r.error });
  $("gPass").value = "";
};
$("setupInstall").onclick = () => api("POST", "/api/setup/install");
$("apkInstall").onclick = async () => {
  const files = $("apkPaths").value.split("\n").map((s) => s.trim()).filter(Boolean);
  const r = await api("POST", "/api/setup/apk", { files });
  appendLog({ at: new Date().toISOString(), message: r.error ? "APK install failed: " + r.error : "APK installed." });
};
for (const b of document.querySelectorAll("[data-action]")) b.onclick = async () => {
  b.disabled = true;
  try { const r = await api("POST", "/api/phone/action", { action: b.dataset.action }); if (r.error) appendLog({ at: new Date().toISOString(), message: "Action failed: " + r.error }); }
  finally { b.disabled = false; }
};
$("inspectBtn").onclick = async () => {
  $("inspect").hidden = false;
  $("inspect").textContent = "Inspecting…";
  $("inspect").textContent = JSON.stringify(await api("GET", "/api/debug/inspect"), null, 2);
};

// ---------- init ----------
async function init() {
  const st = await (await fetch("/api/state")).json();
  fillSettings(st.settings); setStats(st.stats);
  for (const e of st.log) appendLog(e);
  const decisions = await (await fetch("/api/decisions?limit=100000")).json();
  if (!decisions.length) $("decisions").innerHTML = '<div class="empty">No decisions yet.</div>';
  for (const d of decisions) decisionsById.set(d.id, d);
  for (const d of decisions.slice(0, 8).reverse()) renderDecision(d, true);
  setState(st.state);
  renderSetup(st.setup);
  let tab = "swipe";
  try { tab = localStorage.getItem("tab") || "swipe"; } catch {}
  showTab(tab);
  connectWs();

  const es = new EventSource("/api/events");
  es.addEventListener("log", (e) => appendLog(JSON.parse(e.data)));
  es.addEventListener("state", async (e) => { const st = JSON.parse(e.data); if (st.status === "booting") { settings = (await (await fetch("/api/state")).json()).settings; } setState(st); renderSetup(setup); });
  es.addEventListener("setup", (e) => renderSetup(JSON.parse(e.data)));
  es.addEventListener("decision", (e) => { const d = JSON.parse(e.data); renderDecision(d, !decisionsById.has(d.id)); refreshStats(); });
  // Setup status straight from the phone once it's up.
  fetch("/api/setup").then((r) => r.json()).then(renderSetup).catch(() => {});
}

$("startBtn").onclick = () => fetch("/api/start", { method: "POST" });
$("stopBtn").onclick = () => fetch("/api/stop", { method: "POST" });
$("saveBtn").onclick = saveSettings;
for (const f of ["threshold", "prior", "continuous", "quickPassBelow", "model", "pingEnabled", "pingThreshold"]) $(f).addEventListener("input", renderSettingsDerived);
init();
