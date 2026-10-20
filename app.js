(async () => {
  let D;
  try {
    const r = await fetch("twin_data.json");
    if (!r.ok) throw new Error(r.status);
    D = await r.json();
  } catch (e) {
    document.querySelector(".wrap").insertAdjacentHTML("afterbegin",
      '<p class="note">Could not load the data (twin_data.json). Serve this folder with a web server; opening index.html via file:// does not work.</p>');
    return;
  }
  const F = D.features, GR = D.groups;
  const fi = Object.fromEntries(F.map((f, i) => [f, i]));

  // ---------- models ----------
  const dec = (b64, T) => {
    const s = atob(b64), u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    return new T(u.buffer);
  };
  const load = p => ({
    base: p.base, roots: p.roots, feat: dec(p.feat, Int8Array), thr: dec(p.thr, Float64Array),
    left: dec(p.left, Int32Array), right: dec(p.right, Int32Array), val: dec(p.val, Float32Array),
    miss: dec(p.miss, Uint8Array), leaf: dec(p.leaf, Uint8Array)
  });
  const M = {};
  for (const dt of Object.keys(D.models)) M[dt] = { T: load(D.models[dt].temp), H: load(D.models[dt].hum) };
  function predict(m, x) {
    let s = m.base;
    const { roots, feat, thr, left, right, val, miss, leaf } = m;
    for (let r = 0; r < roots.length; r++) {
      let i = roots[r];
      while (!leaf[i]) {
        const v = x[feat[i]];
        i = Number.isNaN(v) ? (miss[i] ? left[i] : right[i]) : (v <= thr[i] ? left[i] : right[i]);
      }
      s += val[i];
    }
    return s;
  }
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  // One-step model rolled forward from the measured state one bin before the
  // block. During the 2-h treatment the chosen levels replace the logged ones.
  function rollout(block, key, scen) {
    const dt = +key, g = block.grid[key], m = M[key], n = g.T.length;
    let T = g.T[0], H = g.H[0];
    const out = [{ t: -dt, T, H }];
    const x = new Float64Array(F.length);
    for (let k = 0; k < n - 1; k++) {
      const tm = -dt + k * dt;
      for (const c of ["ext_temp", "ext_hum", "ext_par", "ext_wind", "hour_sin", "hour_cos"]) x[fi[c]] = g.exo[c][k];
      x[fi.temp_centro] = T; x[fi.hum_centro] = H; x[fi.dT_ext] = T - g.exo.ext_temp[k];
      for (const gr of GR) {
        const forced = scen && scen[gr] != null && tm >= 0 && tm < 120;
        x[fi[gr]] = forced ? scen[gr] : g.act[gr][k];
      }
      const dT = predict(m.T, x), dH = predict(m.H, x);
      T = clamp(T + dT, 10, 60); H = clamp(H + dH, 5, 100);
      out.push({ t: tm + dt, T, H });
    }
    return out;
  }
  const treatMean = (tr, dt, key = "T") => {
    const v = tr.filter(p => p.t >= dt && p.t <= 120).map(p => p[key]);
    return v.reduce((a, b) => a + b, 0) / v.length;
  };

  // ---------- actuators ----------
  const ACT = [
    { g: "VENT_ROOF", name: "Roof vents", unit: "%", levels: [0, 25, 50, 75, 100] },
    { g: "VENT_SIDE", name: "Side vents", unit: "%", levels: [0, 50, 100] },
    { g: "SHADE", name: "Shade screen", unit: "%", levels: [0, 50, 100] },
    { g: "FOG", name: "Fogging", unit: "s/min", levels: [0, 5, 10, 20] },
    { g: "LIGHTS", name: "LED lights", unit: "/10", levels: [0, 4, 8, 10] },
    { g: "RECIRC", name: "Centre recirculator", unit: "", levels: [0, 1], fmt: v => v ? "ON" : "off" },
    { g: "RECIRC2", name: "Fog recirculator", unit: "", levels: [0, 1], fmt: v => v ? "ON" : "off" },
  ];
  const fmtLevel = (a, v) => a.fmt ? a.fmt(v) : String(v);
  const nf1 = new Intl.NumberFormat("en-GB", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const nf2 = new Intl.NumberFormat("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const signed = (v, f = nf1) => (v > 0 ? "+" : v < 0 ? "−" : "±") + f.format(Math.abs(v));

  const PRESETS = [
    { id: "open", label: "Open all vents", s: { VENT_ROOF: 100, VENT_SIDE: 100 } },
    { id: "shut", label: "Close everything", s: { VENT_ROOF: 0, VENT_SIDE: 0, SHADE: 0, FOG: 0 } },
    { id: "fog", label: "Fogging at full", s: { FOG: 20 } },
    { id: "shade", label: "Screen deployed", s: { SHADE: 100 } },
    { id: "logged", label: "As logged", s: {} },
  ];

  // ---------- state ----------
  const blocks = D.blocks;
  const state = { i: 0, scen: { VENT_ROOF: 100, VENT_SIDE: 100 }, v: "T" };

  // Opening block: the midday block where the two twins disagree most about
  // opening every vent, so the first view already shows the point.
  (function pickStart() {
    let best = 0, gap = -1;
    blocks.forEach((b, i) => {
      if (!/ 1[2-5]:/.test(b.t0)) return;
      const d = dt => treatMean(rollout(b, dt, state.scen), +dt) - treatMean(rollout(b, dt, null), +dt);
      const x = d("60") - d("15");
      if (x > gap) { gap = x; best = i; }
    });
    state.i = best;
  })();

  // ---------- strip ----------
  const strip = document.getElementById("strip");
  // 31 campaign days, 3 Aug - 2 Sep, built in UTC so the local offset never shifts a date.
  const allDays = Array.from({ length: 31 }, (_, k) => new Date(Date.UTC(2026, 7, 3 + k)).toISOString().slice(0, 10));
  const tExt = blocks.map(b => b.ext.T), tMin = Math.min(...tExt), tMax = Math.max(...tExt);
  const cellBtns = [];
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  function mixColor(t) {
    const a = css("--cold"), b = css("--hot");
    const p = h => [1, 3, 5].map(k => parseInt(h.slice(k, k + 2), 16));
    const A = p(a), B = p(b);
    return `rgb(${A.map((v, k) => Math.round(v + (B[k] - v) * t)).join(",")})`;
  }
  allDays.slice(0, 31).forEach(day => {
    const col = document.createElement("div"); col.className = "day";
    ["09", "12", "15", "18"].forEach(h => {
      const btn = document.createElement("button"); btn.className = "cell"; btn.type = "button";
      const idx = blocks.findIndex(b => b.t0.startsWith(`${day} ${h}`));
      if (idx < 0) { btn.disabled = true; btn.setAttribute("aria-label", `${day} ${h}:00 no data`); }
      else {
        btn.dataset.i = idx; btn.dataset.t = (blocks[idx].ext.T - tMin) / (tMax - tMin);
        btn.setAttribute("aria-label", `${day} ${h}:00, outside ${blocks[idx].ext.T} °C`);
        btn.addEventListener("click", () => { state.i = idx; render(); });
        cellBtns.push(btn);
      }
      col.appendChild(btn);
    });
    strip.appendChild(col);
  });
  const paintStrip = () => cellBtns.forEach(b => { b.style.background = mixColor(+b.dataset.t); });

  // ---------- faders ----------
  const faders = document.getElementById("faders");
  const segs = {};
  ACT.forEach(a => {
    const box = document.createElement("div"); box.className = "fader";
    box.innerHTML = `<div class="fader-top"><span class="fader-name">${a.name}</span><span class="fader-logged" id="lg-${a.g}"></span></div>`;
    const seg = document.createElement("div"); seg.className = "seg"; seg.setAttribute("role", "group");
    seg.setAttribute("aria-label", a.name);
    const mk = (v, lbl, cls) => {
      const b = document.createElement("button"); b.type = "button"; b.textContent = lbl; if (cls) b.className = cls;
      b.addEventListener("click", () => { state.scen = { ...state.scen }; if (v == null) delete state.scen[a.g]; else state.scen[a.g] = v; render(); });
      b.dataset.v = v == null ? "" : v; seg.appendChild(b); return b;
    };
    mk(null, "Logged", "reg");
    a.levels.forEach(v => mk(v, fmtLevel(a, v)));
    segs[a.g] = seg; box.appendChild(seg); faders.appendChild(box);
  });
  const presets = document.getElementById("presets");
  PRESETS.forEach(p => {
    const b = document.createElement("button"); b.className = "preset"; b.type = "button"; b.textContent = p.label;
    b.addEventListener("click", () => { state.scen = { ...p.s }; render(); });
    presets.appendChild(b);
  });
  document.getElementById("prev").addEventListener("click", () => { state.i = (state.i - 1 + blocks.length) % blocks.length; render(); });
  document.getElementById("next").addEventListener("click", () => { state.i = (state.i + 1) % blocks.length; render(); });

  // ---------- charts ----------
  const NS = "http://www.w3.org/2000/svg";
  const el = (tag, attrs, parent) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e); return e;
  };
  function niceTicks(lo, hi, n = 5) {
    const span = hi - lo, step0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const step = [1, 2, 2.5, 5, 10].map(s => s * mag).find(s => span / s <= n) || mag * 10;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
    return out;
  }
  function drawSeries(svg, W, H, series, key, unit) {
    svg.replaceChildren();
    const L = 44, R = 12, T = 10, B = 26;
    const xs = t => L + (t + 60) / 240 * (W - L - R);
    const all = series.flatMap(s => s.pts.map(p => p[key])).filter(Number.isFinite);
    let lo = Math.min(...all), hi = Math.max(...all);
    const pad = Math.max((hi - lo) * 0.12, key === "T" ? 0.6 : 2); lo -= pad; hi += pad;
    const ys = v => T + (hi - v) / (hi - lo) * (H - T - B);
    el("rect", { x: xs(0), y: T, width: xs(120) - xs(0), height: H - T - B, fill: "var(--band)" }, svg);
    const ax = el("g", { class: "axis" }, svg);
    niceTicks(lo, hi, key === "T" ? 6 : 4).forEach(v => {
      el("line", { x1: L, x2: W - R, y1: ys(v), y2: ys(v), class: "gridline" }, ax);
      const t = el("text", { x: L - 6, y: ys(v) + 3.5, "text-anchor": "end" }, ax);
      t.textContent = (key === "T" ? nf1 : new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 })).format(v);
    });
    [-60, 0, 60, 120, 180].forEach(t => {
      const tx = el("text", { x: xs(t), y: H - 8, "text-anchor": "middle" }, ax);
      tx.textContent = t === 0 ? "0 min" : (t > 0 ? `+${t}` : `${t}`);
    });
    series.forEach(s => {
      const pts = s.pts.filter(p => Number.isFinite(p[key]));
      if (!pts.length) return;
      let d = "";
      pts.forEach((p, i) => { d += (i ? "L" : "M") + xs(p.t).toFixed(1) + "," + ys(p[key]).toFixed(1); });
      el("path", { d, class: "trace", fill: "none", stroke: s.color, "stroke-width": s.w || 2,
        "stroke-dasharray": s.dash || "none", "stroke-linejoin": "round", "stroke-linecap": "round",
        opacity: s.op || 1 }, svg);
      if (s.dots) pts.forEach(p => el("circle", { cx: xs(p.t), cy: ys(p[key]), r: s.dots, fill: s.color }, svg));
    });
  }

  function drawEffects() {
    const svg = document.getElementById("chart-E"); svg.replaceChildren();
    const v = state.v, W = 640;
    const rows = ACT.map(a => {
      const r15 = D.effects.find(e => e.dt_min === 15 && e.var === v && e.group === a.g);
      const r60 = D.effects.find(e => e.dt_min === 60 && e.var === v && e.group === a.g);
      return { a, meas: r15.measured, se: r15.se, s15: r15.simulated, s60: r60.simulated };
    });
    const vals = rows.flatMap(r => [r.meas - r.se, r.meas + r.se, r.s15, r.s60]);
    let lo = Math.min(0, ...vals), hi = Math.max(0, ...vals); const pad = (hi - lo) * 0.06; lo -= pad; hi += pad;
    const L = 150, R = 16, T = 22, rowH = 42, H = T + rows.length * rowH + 22;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const xs = x => L + (x - lo) / (hi - lo) * (W - L - R);
    const ax = el("g", { class: "axis" }, svg);
    niceTicks(lo, hi, 6).forEach(t => {
      el("line", { x1: xs(t), x2: xs(t), y1: T - 6, y2: H - 20, class: "gridline" }, ax);
      const tx = el("text", { x: xs(t), y: H - 6, "text-anchor": "middle" }, ax);
      tx.textContent = (t > 0 ? "+" : "") + new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 }).format(t);
    });
    el("line", { x1: xs(0), x2: xs(0), y1: T - 6, y2: H - 20, stroke: "var(--ink)", "stroke-width": 1.2 }, svg);
    const hd = el("text", { x: W - R, y: 12, "text-anchor": "end", class: "tick" }, svg);
    hd.textContent = v === "T" ? "effect on block-mean temperature (°C)" : "effect on block-mean humidity (RH points)";
    rows.forEach((r, k) => {
      const y0 = T + k * rowH;
      const nm = el("text", { x: 0, y: y0 + 21, "font-family": "var(--font-body)", "font-size": 13, fill: "var(--ink)" }, svg);
      nm.textContent = r.a.name;
      const bar = (val, dy, color) => {
        const x1 = xs(Math.min(0, val)), x2 = xs(Math.max(0, val));
        el("rect", { x: x1, y: y0 + dy, width: Math.max(x2 - x1, 1), height: 8, fill: color, rx: 1 }, svg);
      };
      // measured: dot + standard-error whisker
      el("line", { x1: xs(r.meas - r.se), x2: xs(r.meas + r.se), y1: y0 + 7, y2: y0 + 7, stroke: "var(--meas)", "stroke-width": 1.5 }, svg);
      el("circle", { cx: xs(r.meas), cy: y0 + 7, r: 4, fill: "var(--meas)" }, svg);
      bar(r.s15, 16, "var(--t15)");
      bar(r.s60, 27, "var(--t60)");
    });
  }
  function drawChoice() {
    const box = document.getElementById("choice");
    const names = { VENT_ROOF: "Roof vents", VENT_SIDE: "Side vents", SHADE: "Screen", FOG: "Fogging" };
    const colors = { VENT_ROOF: "var(--cold)", VENT_SIDE: "var(--t15)", SHADE: "var(--muted)", FOG: "var(--t60)" };
    const row = dt => D.choice.find(c => c.dt_min === dt);
    const c15 = row(15), c60 = row(60);
    const bar = c => Object.keys(names).map(g => `<i style="width:${(100 * c["twin_picks_" + g]).toFixed(1)}%;background:${colors[g]}" title="${names[g]} ${(100 * c["twin_picks_" + g]).toFixed(0)} %"></i>`).join("");
    const top = c => { const g = Object.keys(names).sort((a, b) => c["twin_picks_" + b] - c["twin_picks_" + a])[0]; return `${names[g]} (${Math.round(100 * c["twin_picks_" + g])} % of blocks)`; };
    box.innerHTML = `
      <span class="label">What cools most at midday?</span>
      <div class="choice-row"><span>Randomised blocks: <b>${names[c15.measured_best]}</b></span></div>
      <div class="choice-row"><span class="k15">15-min twin: ${top(c15)}</span><div class="choice-bar">${bar(c15)}</div></div>
      <div class="choice-row"><span class="k60">1-h twin: ${top(c60)}</span><div class="choice-bar">${bar(c60)}</div></div>
      <div class="legend">${Object.keys(names).map(g => `<span><i class="sw" style="border-color:${colors[g]}"></i>${names[g]}</span>`).join("")}</div>
      <div class="legend"><span><i class="sw meas"></i>Measured (± standard error)</span><span><i class="sw t15"></i>15-min twin</span><span><i class="sw t60"></i>1-h twin</span></div>`;
  }
  ["T", "H"].forEach(v => document.getElementById("v-" + v).addEventListener("click", () => {
    state.v = v;
    document.getElementById("v-T").setAttribute("aria-pressed", v === "T");
    document.getElementById("v-H").setAttribute("aria-pressed", v === "H");
    drawEffects();
  }));

  // ---------- render ----------
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function render() {
    const b = blocks[state.i];
    const [d, h] = b.t0.split(" ");
    const [, mo, da] = d.split("-");
    const hEnd = String(+h.slice(0, 2) + 2).padStart(2, "0") + h.slice(2);
    document.getElementById("block-name").textContent = `${+da} ${MONTHS[+mo - 1]} · ${h}–${hEnd}`;
    document.getElementById("block-phase").textContent = { B: "dose–response", C: "factorial", D: "space-filling" }[b.phase] || "";
    document.getElementById("block-wx").innerHTML =
      `<span>Outside <span class="num">${nf1.format(b.ext.T)} °C</span></span>` +
      `<span>RH <span class="num">${b.ext.H} %</span></span>` +
      `<span>PAR <span class="num">${b.ext.PAR}</span> W m⁻²</span>`;
    cellBtns.forEach(c => c.setAttribute("aria-pressed", +c.dataset.i === state.i));
    ACT.forEach(a => {
      const set = state.scen[a.g];
      segs[a.g].querySelectorAll("button").forEach(btn => {
        const v = btn.dataset.v === "" ? null : +btn.dataset.v;
        btn.setAttribute("aria-pressed", set == null ? v == null : v === set);
      });
      const lg = b.cmd[a.g];
      document.getElementById("lg-" + a.g).textContent = `programmed: ${fmtLevel(a, lg)}${a.unit && !a.fmt ? " " + a.unit : ""}`;
    });

    const r = {}, base = {};
    for (const dt of ["15", "60"]) { r[dt] = rollout(b, dt, state.scen); base[dt] = rollout(b, dt, null); }
    const dlt = dt => treatMean(r[dt], +dt) - treatMean(base[dt], +dt);
    const dlH = dt => treatMean(r[dt], +dt, "H") - treatMean(base[dt], +dt, "H");
    const changed = Object.keys(state.scen).length > 0;
    const measMean = (() => { const m = b.meas; const v = m.T.filter((_, i) => m.t[i] > 0 && m.t[i] <= 120 && Number.isFinite(m.T[i])); return v.reduce((a, c) => a + c, 0) / v.length; })();
    document.getElementById("readouts").innerHTML = `
      <div class="readout r15"><span class="label">15-min twin</span><span class="big">${signed(dlt("15"))} °C</span>
        <span class="sub">${signed(dlH("15"))} RH points vs. logged</span></div>
      <div class="readout r60"><span class="label">1-h twin</span><span class="big">${signed(dlt("60"))} °C</span>
        <span class="sub">${signed(dlH("60"))} RH points vs. logged</span></div>
      <div class="readout"><span class="label">Measured in the block</span><span class="big num">${nf1.format(measMean)} °C</span>
        <span class="sub">mean over the 2 treatment hours, logged settings</span></div>`;
    const a = dlt("15"), c = dlt("60");
    let txt;
    if (!changed) txt = "No change: both twins replay the block as logged. Pick another action on the left.";
    else if (Math.sign(a) !== Math.sign(c) && Math.abs(a) > 0.2 && Math.abs(c) > 0.2)
      txt = `The twins disagree: the 15-min twin says the temperature would ${a < 0 ? "fall" : "rise"} by ${nf1.format(Math.abs(a))} °C, the 1-h twin that it would ${c < 0 ? "fall" : "rise"} by ${nf1.format(Math.abs(c))} °C.`;
    else if (Math.abs(c) < 0.25 * Math.abs(a) && Math.abs(a) > 0.5)
      txt = `The 1-h twin sees almost no effect (${signed(c)} °C) where the 15-min twin sees ${signed(a)} °C.`;
    else txt = `Both twins agree on the direction: ${signed(a)} °C at 15 min and ${signed(c)} °C at 1 h.`;
    document.getElementById("verdict").textContent = txt;

    const meas = b.meas.t.map((t, i) => ({ t, T: b.meas.T[i], H: b.meas.H[i] })).filter(p => p.t >= -60 && p.t <= 180);
    const ser = [
      { pts: base["15"], color: "var(--muted)", dash: "4 4", w: 1.4, op: .8 },
      { pts: base["60"], color: "var(--muted)", dash: "2 5", w: 1.4, op: .8 },
      { pts: meas, color: "var(--meas)", w: 1.6 },
      { pts: r["15"], color: "var(--t15)", w: 2.6, dots: 2.6 },
      { pts: r["60"], color: "var(--t60)", w: 2.6, dots: 4.5 },
    ];
    drawSeries(document.getElementById("chart-T"), 760, 300, ser, "T");
    drawSeries(document.getElementById("chart-H"), 760, 190, ser, "H");
  }

  paintStrip(); render(); drawEffects(); drawChoice();
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const repaint = () => paintStrip();
  try { mq.addEventListener("change", repaint); } catch (e) {}
  new MutationObserver(repaint).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
})();
