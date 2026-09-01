(() => {
  "use strict";

  console.info("GNPy research extension v4 loaded");
  let latestResearch = null;

  const COLORS = {
    cyan: "#20c9c3", blue: "#5b8ff9", orange: "#ff9d4d",
    purple: "#bd78e8", white: "#111827", grid: "#d5dce5",
    text: "#243142", muted: "#65758b"
  };

  const escapeHtml = value => String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  const finite = value => {
    if(value === null || value === undefined) return null;
    if(typeof value === "string" && value.trim() === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const fmt = (value, digits = 3) => finite(value) === null ? "—" : Number(value).toFixed(digits);

  function getConsoleElement() {
    try { if (typeof consoleTargetEl === "function") return consoleTargetEl(); }
    catch (error) { console.warn(error); }
    return document.getElementById("console");
  }

  function consoleDocument(element = null) {
    return (element || getConsoleElement())?.ownerDocument || document;
  }

  function addOption(doc, select, text, value) {
    const option = doc.createElement("option");
    option.textContent = text;
    option.value = String(value);
    select.appendChild(option);
  }

  function showError(message, target = null) {
    const consoleElement = target || getConsoleElement();
    if (!consoleElement) return console.error(message);
    consoleElement.querySelector(".research-error-notice")?.remove();
    const notice = consoleDocument(consoleElement).createElement("div");
    notice.className = "research-error-notice";
    notice.innerHTML = `<strong>Research analysis unavailable</strong><div>${escapeHtml(message)}</div>`;
    consoleElement.prepend(notice);
  }

  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = name; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function csv(research) {
    const rows = [["element","type","channel","label","frequency_thz","signal_in_dbm","signal_out_dbm","ase_out_dbm","nli_out_dbm","osnr_db","gsnr_db"]];
    research.elements.forEach(element => (element.output.frequency_hz || []).forEach((frequency, index) => rows.push([
      element.uid, element.type, index, element.output.label?.[index] || "", frequency / 1e12,
      element.input.signal_dbm?.[index], element.output.signal_dbm?.[index],
      element.output.ase_dbm?.[index], element.output.nli_dbm?.[index],
      element.output.osnr_signal_bw_db?.[index], element.output.gsnr_calculated_db?.[index]
    ])));
    return rows.map(row => row.map(value => `"${String(value ?? "").replaceAll('"', '""')}"`).join(",")).join("\n");
  }

  function detailHtml(element) {
    const summary = element.summary || {};
    const derived = element.derived || {};
    const parameters = derived.element_parameters || {};
    const fields = [
      ["Channels", summary.channels], ["Mean signal output", summary.mean_signal_out_dbm, "dBm"],
      ["Mean ASE output", summary.mean_ase_out_dbm, "dBm"], ["Total ASE input", summary.total_ase_in_w, "W"],
      ["Total ASE output", summary.total_ase_out_w, "W"], ["Generated ASE residual", summary.total_ase_generated_residual_w, "W"],
      ["Mean NLI output", summary.mean_nli_out_dbm, "dBm"], ["Total NLI input", summary.total_nli_in_w, "W"],
      ["Total NLI output", summary.total_nli_out_w, "W"], ["Generated NLI residual", summary.total_nli_generated_residual_w, "W"],
      ["Mean OSNR", summary.mean_osnr_out_db, "dB"], ["Worst OSNR", summary.worst_osnr_out_db, "dB"],
      ["Mean GSNR", summary.mean_gsnr_out_db, "dB"], ["Worst GSNR", summary.worst_gsnr_out_db, "dB"],
      ["Spectral-transfer proxy p-p", summary.spectral_transfer_proxy_peak_to_peak_db, "dB"]
    ];
    return `<div class="details-grid"><section><h3>Summary</h3><dl>${fields.map(([name, value, unit]) => `<dt>${escapeHtml(name)}</dt><dd>${unit === "W" && finite(value) !== null ? Number(value).toExponential(5) : fmt(value)} ${unit || ""}</dd>`).join("")}</dl></section><section><h3>Element parameters</h3><pre>${escapeHtml(JSON.stringify(parameters, null, 2))}</pre></section><section class="wide"><h3>Provenance</h3><pre>${escapeHtml(JSON.stringify(derived.provenance || {}, null, 2))}</pre></section></div>`;
  }

  function raisedCosine(offset, baud, rollOff) {
    const absolute = Math.abs(offset);
    const flat = baud * (1 - rollOff) / 2;
    const edge = baud * (1 + rollOff) / 2;
    if (absolute <= flat) return 1;
    if (absolute >= edge || rollOff <= 0) return 0;
    return 0.5 * (1 + Math.cos(Math.PI * (absolute - flat) / (edge - flat)));
  }

  function reconstruct(element, channelIndex, settings) {
    const center = finite(element.output.frequency_hz?.[channelIndex]);
    const baud = finite(element.output.baud_rate_hz?.[channelIndex]);
    const signal = finite(element.output.signal_w?.[channelIndex]);
    const rollOff = finite(element.output.roll_off?.[channelIndex]) ?? 0.15;
    if (center === null || baud === null || signal === null) return null;
    const bandwidth = settings.bandwidth * 1e9;
    const offset = settings.offset * 1e9;
    const span = Math.max(baud * (1 + rollOff) * 1.8, bandwidth * 1.5);
    const count = 801;
    const xOffset = Array.from({ length: count }, (_, i) => -span / 2 + span * i / (count - 1));
    const shape = xOffset.map(value => raisedCosine(value, baud, rollOff));
    const df = span / (count - 1);
    const norm = shape.reduce((sum, value) => sum + value * df, 0) || 1;
    const input = shape.map(value => value * signal / norm);
    const filter = xOffset.map(value => Math.exp(-Math.LN2 * Math.pow(Math.abs(2 * (value - offset) / bandwidth), 2 * settings.order)));
    const cascade = filter.map(value => Math.pow(value, settings.roadms));
    const output = input.map((value, i) => value * cascade[i]);
    const inputPower = input.reduce((sum, value) => sum + value * df, 0);
    const outputPower = output.reduce((sum, value) => sum + value * df, 0);
    const toPsd = values => values.map(value => value > 0 ? 10 * Math.log10(value * 1e9 / 1e-3) : null);
    return {
      x: xOffset.map(value => (center + value) / 1e12),
      series: [
        { name: "Cascaded WSS response", values: cascade.map(value => value > 0 ? 10 * Math.log10(value) : null), color: COLORS.orange, width: 1.8 },
        { name: "Output PSD", values: toPsd(output), color: COLORS.cyan, width: 3.2 },
        { name: "Input signal PSD", values: toPsd(input), color: COLORS.blue, dash: true, markers: true, width: 2.4 }
      ],
      occupied: baud * (1 + rollOff) / 1e9,
      clipped: inputPower > 0 ? 100 * Math.max(0, 1 - outputPower / inputPower) : 0,
      penalty: outputPower > 0 ? 10 * Math.log10(inputPower / outputPower) : null
    };
  }

  function svgChart(container, x, series, axes, labels) {
    const cleanX = x.map(finite);
    const allY = series.flatMap(item => item.values.map(finite).filter(value => value !== null));
    const validX = cleanX.filter(value => value !== null);
    if (!validX.length || !allY.length) {
      container.innerHTML = `<div class="plot-message">No finite data is available for this element and quantity.</div>`;
      return;
    }
    let xMin = finite(axes.xMin) ?? Math.min(...validX);
    let xMax = finite(axes.xMax) ?? Math.max(...validX);
    let yMin = finite(axes.yMin) ?? Math.min(...allY);
    let yMax = finite(axes.yMax) ?? Math.max(...allY);
    if (xMin === xMax) { xMin -= 0.01; xMax += 0.01; }
    if (yMin === yMax) { yMin -= 1; yMax += 1; }
    const yPad = (yMax - yMin) * 0.06;
    if (finite(axes.yMin) === null) yMin -= yPad;
    if (finite(axes.yMax) === null) yMax += yPad;

    const width = 1400, height = Math.max(360, Number(axes.height) || 620);
    const margin = { left: 82, right: 26, top: 54, bottom: 62 };
    const plotW = width - margin.left - margin.right;
    const plotH = height - margin.top - margin.bottom;
    const px = value => margin.left + (value - xMin) / (xMax - xMin) * plotW;
    const py = value => margin.top + (yMax - value) / (yMax - yMin) * plotH;
    const ticks = 8;
    let svg = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(labels.title)}"><rect width="100%" height="100%" fill="#ffffff"/><text x="${margin.left}" y="25" fill="#172333" font-size="18" font-weight="600">${escapeHtml(labels.title)}</text>`;
    for (let i = 0; i <= ticks; i++) {
      const xv = xMin + (xMax - xMin) * i / ticks;
      const yv = yMin + (yMax - yMin) * i / ticks;
      const xPos = px(xv), yPos = py(yv);
      svg += `<line x1="${xPos}" y1="${margin.top}" x2="${xPos}" y2="${margin.top + plotH}" stroke="${COLORS.grid}"/><text x="${xPos}" y="${height - 32}" text-anchor="middle" fill="${COLORS.text}" font-size="12">${xv.toFixed(4)}</text>`;
      svg += `<line x1="${margin.left}" y1="${yPos}" x2="${margin.left + plotW}" y2="${yPos}" stroke="${COLORS.grid}"/><text x="${margin.left - 10}" y="${yPos + 4}" text-anchor="end" fill="${COLORS.text}" font-size="12">${yv.toFixed(2)}</text>`;
    }
    svg += `<line x1="${margin.left}" y1="${margin.top + plotH}" x2="${margin.left + plotW}" y2="${margin.top + plotH}" stroke="#172333"/><line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotH}" stroke="#172333"/>`;
    series.forEach((item, seriesIndex) => {
      let path = "", penDown = false;
      item.values.forEach((raw, index) => {
        const xv = cleanX[index], yv = finite(raw);
        if (xv === null || yv === null || xv < xMin || xv > xMax) { penDown = false; return; }
        path += `${penDown ? "L" : "M"}${px(xv).toFixed(2)},${py(yv).toFixed(2)} `;
        penDown = true;
      });
      const strokeWidth = item.width || (item.dash ? 2.8 : 2.2);
      svg += `<path d="${path}" fill="none" stroke="${item.color}" stroke-width="${strokeWidth}" ${item.dash ? 'stroke-dasharray="9 6"' : ""}/>`;
      if(item.markers){
        const stride = Math.max(1, Math.ceil(item.values.length / 28));
        item.values.forEach((raw, index) => {
          if(index % stride) return;
          const xv = cleanX[index], yv = finite(raw);
          if(xv === null || yv === null || xv < xMin || xv > xMax) return;
          svg += `<circle cx="${px(xv).toFixed(2)}" cy="${py(yv).toFixed(2)}" r="2.6" fill="${item.color}" stroke="#ffffff" stroke-width="0.8"/>`;
        });
      }
      svg += `<line x1="${margin.left + seriesIndex * 230}" y1="42" x2="${margin.left + 28 + seriesIndex * 230}" y2="42" stroke="${item.color}" stroke-width="3" ${item.dash ? 'stroke-dasharray="9 6"' : ""}/><text x="${margin.left + 35 + seriesIndex * 230}" y="46" fill="${COLORS.text}" font-size="12">${escapeHtml(item.name)}</text>`;
    });
    svg += `<text x="${margin.left + plotW / 2}" y="${height - 5}" text-anchor="middle" fill="${COLORS.text}" font-size="13">${escapeHtml(labels.x)}</text><text transform="translate(18 ${margin.top + plotH / 2}) rotate(-90)" text-anchor="middle" fill="${COLORS.text}" font-size="13">${escapeHtml(labels.y)}</text></svg>`;
    container.innerHTML = svg;
    container.dataset.axisRange = `x=${xMin}..${xMax}; y=${yMin}..${yMax}`;
  }

  function windowShell(title, body) {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${escapeHtml(title)}</title><style>
      :root{--bg:#071017;--panel:#0b1119;--line:#23303f;--ink:#dbe4ee;--dim:#7c8ba1;--accent:#4fd1c5}
      *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:"IBM Plex Mono",Consolas,monospace}header{position:sticky;top:0;z-index:10;padding:13px 20px;border-bottom:1px solid var(--line);background:#071017f2}h1{font-size:18px;color:var(--accent);margin:0 0 10px}.toolbar{display:grid;grid-template-columns:minmax(300px,2fr) repeat(5,minmax(115px,1fr)) auto;gap:9px;align-items:end}label{display:flex;flex-direction:column;gap:4px;color:var(--dim);font-size:10px}select,input,button{background:var(--panel);border:1px solid var(--line);border-radius:5px;color:var(--ink);padding:8px;font:11px inherit}button{color:var(--accent);border-color:var(--accent);cursor:pointer}button:hover,.tabs button.active{background:var(--accent);color:#071017}.tabs{display:flex;gap:8px;margin-top:10px}.view{display:none}.view.active{display:block}main{padding:16px 20px}.card{border:1px solid var(--line);background:var(--panel);border-radius:8px;padding:14px}.plot{width:100%;overflow:auto;background:#fff;border-radius:7px;margin-top:10px}.plot svg{display:block;width:100%;min-width:900px}.metrics{display:flex;gap:18px;flex-wrap:wrap;color:var(--dim);font-size:11px;margin:10px 0}.simple-trace-box{display:flex;gap:12px;flex-wrap:wrap;margin:10px 0;padding:9px;border:1px solid var(--line);border-radius:6px}.simple-trace-toggle{display:inline-flex;flex-direction:row;align-items:center;gap:7px;color:var(--ink);font-size:10px;cursor:pointer}.simple-trace-toggle input{width:auto;margin:0}.simple-trace-swatch{display:inline-block;width:22px;border-top-width:3px}.metrics b{color:var(--ink)}.controls{display:grid;grid-template-columns:2fr repeat(4,1fr);gap:9px}.details-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.details-grid section{border:1px solid var(--line);border-radius:7px;padding:13px;background:var(--panel)}.details-grid .wide{grid-column:1/-1}.details-grid h3{color:var(--accent);font-size:13px;margin:0 0 10px}.details-grid dl{display:grid;grid-template-columns:1fr auto;gap:7px 16px;margin:0;font-size:11px}.details-grid dt{color:var(--dim)}.details-grid dd{margin:0}.details-grid pre{white-space:pre-wrap;max-height:540px;overflow:auto;font-size:10px}.plot-message{padding:40px;color:#7a5200;background:#fff8e6}.plot-note{margin:8px 2px 0;color:var(--dim);font-size:10px}@media(max-width:1000px){.toolbar,.controls{grid-template-columns:1fr 1fr}.details-grid{grid-template-columns:1fr}.details-grid .wide{grid-column:auto}}
    </style></head><body>${body}</body></html>`;
  }


  function simpleTraceToggles(doc, host, series, onChange) {
    host.innerHTML = "";
    const state = {};

    series.forEach((item, index) => {
      const key = item.name || `Trace ${index + 1}`;
      state[key] = item.hidden !== true;

      const label = doc.createElement("label");
      label.className = "simple-trace-toggle";

      const checkbox = doc.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = state[key];

      const swatch = doc.createElement("span");
      swatch.className = "simple-trace-swatch";
      swatch.style.borderTopColor = item.color || "#4fd1c5";
      swatch.style.borderTopStyle = item.dash ? "dashed" : "solid";

      const caption = doc.createElement("span");
      caption.textContent = key;

      checkbox.onchange = () => {
        state[key] = checkbox.checked;
        onChange(series.filter(trace => state[trace.name || ""] !== false));
      };

      label.append(checkbox, swatch, caption);
      host.appendChild(label);
    });

    return state;
  }

  function openSpectrumWindow(research, preferredUid = null) {
    const win = window.open("", "gnpySpectrumAnalysis", "width=1500,height=900,resizable=yes,scrollbars=yes");
    if (!win) return alert("Pop-up blocked. Allow pop-ups for the spectrum analysis window.");
    const body = `<header><h1>GNPy Spectrum Analysis</h1><div class="toolbar"><label>Element<select id="element"></select></label><label>X minimum (THz)<input id="xMin" type="number" step="0.001" placeholder="Auto"></label><label>X maximum (THz)<input id="xMax" type="number" step="0.001" placeholder="Auto"></label><label>Y minimum<input id="yMin" type="number" step="0.1" placeholder="Auto"></label><label>Y maximum<input id="yMax" type="number" step="0.1" placeholder="Auto"></label><label>Chart height<input id="height" type="number" min="360" max="1400" step="50" value="620"></label><button id="reset">Reset axes</button></div><div class="tabs"><button data-tab="native" class="active">Native GNPy spectrum</button><button data-tab="model">Reconstructed PSD and ROADM clipping</button></div></header><main><section id="nativeView" class="view active"><div class="card"><label style="max-width:460px">Quantity<select id="quantity"><option value="power">Signal, ASE, NLI and total power</option><option value="qot">OSNR, NLI SNR and GSNR</option><option value="transfer">Signal transfer and spectral-transfer proxy</option></select></label><div id="nativeTraceToggles" class="simple-trace-box"></div><div id="nativePlot" class="plot"></div><p class="plot-note">Dashed lines with markers are drawn last so coincident traces remain visible. Exact overlap is physically meaningful, for example total ≈ signal when noise is very small.</p></div></section><section id="modelView" class="view"><div class="card"><div class="controls"><label>Channel<select id="channel"></select></label><label>WSS 3 dB bandwidth (GHz)<input id="bandwidth" type="number" value="75" step="0.1"></label><label>Filter order<input id="order" type="number" value="4" min="1"></label><label>Cascaded ROADMs<input id="roadms" type="number" value="2" min="0"></label><label>Filter offset (GHz)<input id="offset" type="number" value="0" step="0.1"></label></div><div id="metrics" class="metrics"></div><div id="modelTraceToggles" class="simple-trace-box"></div><div id="modelPlot" class="plot"></div><p class="plot-note">Input PSD is the dashed blue trace with markers. When clipping is negligible, input and output PSD overlap almost exactly.</p></div></section></main>`;
    win.document.open(); win.document.write(windowShell("GNPy Spectrum Analysis", body)); win.document.close();
    const doc = win.document;
    const elementSelect = doc.getElementById("element");
    research.elements.forEach((element, index) => addOption(doc, elementSelect, `${index + 1}. ${element.type} · ${element.uid}`, index));
    const preferred = research.elements.findIndex(element => element.uid === preferredUid);
    elementSelect.value = String(preferred >= 0 ? preferred : 0);
    const element = () => research.elements[Number(elementSelect.value) || 0];
    const axes = () => ({ xMin: doc.getElementById("xMin").value, xMax: doc.getElementById("xMax").value, yMin: doc.getElementById("yMin").value, yMax: doc.getElementById("yMax").value, height: doc.getElementById("height").value });

    function populateChannels() {
      const select = doc.getElementById("channel"); select.innerHTML = "";
      (element().output.frequency_hz || []).forEach((frequency, index) => addOption(doc, select, `${element().output.label?.[index] || `CH-${index + 1}`} · ${fmt(frequency / 1e12, 5)} THz`, index));
    }
    function drawNative() {
      const current = element(), quantity = doc.getElementById("quantity").value;
      const x = (current.output.frequency_hz || []).map(value => value / 1e12);
      let series, y;
      if (quantity === "qot") { y = "Ratio (dB)"; series = [{ name: "NLI SNR", values: current.output.snr_nli_db || [], color: COLORS.purple }, { name: "GSNR calculated", values: current.output.gsnr_calculated_db || [], color: COLORS.orange, width: 3.2 }, { name: "GSNR native", values: current.output.gsnr_gnpy_db || [], color: COLORS.blue, dash: true, markers: true }, { name: "OSNR output", values: current.output.osnr_signal_bw_db || [], color: COLORS.cyan, dash: true, markers: true, width: 2.6 }]; }
      else if (quantity === "transfer") { y = "Transfer (dB)"; series = [{ name: "Spectral-transfer proxy", values: current.derived.spectral_transfer_proxy_db || [], color: COLORS.orange, width: 3.2 }, { name: "Signal transfer", values: current.derived.signal_transfer_db || [], color: COLORS.cyan, dash: true, markers: true, width: 2.6 }]; }
      else { y = "Power (dBm/channel)"; series = [{ name: "ASE output", values: current.output.ase_dbm || [], color: COLORS.orange }, { name: "NLI output", values: current.output.nli_dbm || [], color: COLORS.purple }, { name: "Signal output", values: current.output.signal_dbm || [], color: COLORS.cyan, width: 3.2 }, { name: "Total output", values: current.output.total_dbm || [], color: COLORS.white, dash: true, markers: true, width: 2.6 }, { name: "Signal input", values: current.input.signal_dbm || [], color: COLORS.blue, dash: true, markers: true, width: 2.4 }]; }
      const nativePlot = doc.getElementById("nativePlot");
      const nativeLabels = { title: `${current.type} · ${current.uid}`, x: "Frequency (THz)", y };
      const redrawNativeVisible = visibleSeries => svgChart(nativePlot, x, visibleSeries, axes(), nativeLabels);
      simpleTraceToggles(doc, doc.getElementById("nativeTraceToggles"), series, redrawNativeVisible);
      redrawNativeVisible(series);
    }
    function drawModel() {
      const result = reconstruct(element(), Number(doc.getElementById("channel").value) || 0, { bandwidth: Number(doc.getElementById("bandwidth").value), order: Number(doc.getElementById("order").value), roadms: Number(doc.getElementById("roadms").value), offset: Number(doc.getElementById("offset").value) });
      if (!result) return;
      doc.getElementById("metrics").innerHTML = `<span>Occupied bandwidth <b>${fmt(result.occupied)} GHz</b></span><span>Clipped power <b>${fmt(result.clipped)}%</b></span><span>Equivalent filter loss <b>${fmt(result.penalty)} dB</b></span>`;
      const modelPlot = doc.getElementById("modelPlot");
      const modelLabels = { title: `${element().type} · ${element().uid}`, x: "Frequency (THz)", y: "PSD (dBm/GHz) / response (dB)" };
      const redrawModelVisible = visibleSeries => svgChart(modelPlot, result.x, visibleSeries, axes(), modelLabels);
      simpleTraceToggles(doc, doc.getElementById("modelTraceToggles"), result.series, redrawModelVisible);
      redrawModelVisible(result.series);
    }
    const drawAll = () => { populateChannels(); drawNative(); drawModel(); };
    elementSelect.onchange = drawAll; doc.getElementById("quantity").onchange = drawNative;
    ["xMin","xMax","yMin","yMax","height"].forEach(id => doc.getElementById(id).onchange = () => { drawNative(); drawModel(); });
    ["channel","bandwidth","order","roadms","offset"].forEach(id => doc.getElementById(id).oninput = drawModel);
    doc.getElementById("reset").onclick = () => { ["xMin","xMax","yMin","yMax"].forEach(id => doc.getElementById(id).value = ""); drawNative(); drawModel(); };
    doc.querySelectorAll("[data-tab]").forEach(button => button.onclick = () => { doc.querySelectorAll("[data-tab]").forEach(item => item.classList.toggle("active", item === button)); doc.querySelectorAll(".view").forEach(view => view.classList.remove("active")); doc.getElementById(`${button.dataset.tab}View`).classList.add("active"); });
    drawAll();
  }

  function openDetailsWindow(research, preferredUid = null) {
    const win = window.open("", "gnpyDetailedResults", "width=1250,height=850,resizable=yes,scrollbars=yes");
    if (!win) return alert("Pop-up blocked. Allow pop-ups for the detailed results window.");
    const body = `<header><h1>GNPy Detailed Research Results</h1><div class="toolbar" style="grid-template-columns:minmax(400px,1fr) auto"><label>Element<select id="element"></select></label><button id="export">Export selected element JSON</button></div></header><main><div id="content"></div></main>`;
    win.document.open(); win.document.write(windowShell("GNPy Detailed Results", body)); win.document.close();
    const doc = win.document, select = doc.getElementById("element");
    research.elements.forEach((element, index) => addOption(doc, select, `${index + 1}. ${element.type} · ${element.uid}`, index));
    const preferred = research.elements.findIndex(element => element.uid === preferredUid);
    select.value = String(preferred >= 0 ? preferred : 0);
    const render = () => { doc.getElementById("content").innerHTML = detailHtml(research.elements[Number(select.value) || 0]); };
    select.onchange = render;
    doc.getElementById("export").onclick = () => { const element = research.elements[Number(select.value) || 0]; download(`${element.uid}-research.json`, JSON.stringify(element, null, 2), "application/json"); };
    render();
  }

  function addCardControls(card, element, research, targetConsole) {
    if (card.querySelector(".research-toggle")) return;
    const doc = consoleDocument(targetConsole);
    const button = doc.createElement("button"); button.type = "button"; button.className = "research-toggle"; button.textContent = "Show summary";
    const panel = doc.createElement("div"); panel.className = "research-panel"; panel.hidden = true; panel.innerHTML = detailHtml(element);
    const detailsButton = doc.createElement("button"); detailsButton.className = "research-open-analysis"; detailsButton.textContent = "Open detailed results window"; detailsButton.onclick = () => openDetailsWindow(research, element.uid); panel.appendChild(detailsButton);
    const plotsButton = doc.createElement("button"); plotsButton.className = "research-open-analysis"; plotsButton.textContent = "Open Spectrum Analysis"; plotsButton.onclick = () => openSpectrumWindow(research, element.uid); panel.appendChild(plotsButton);
    button.onclick = () => { panel.hidden = !panel.hidden; button.textContent = panel.hidden ? "Show summary" : "Hide summary"; };
    card.append(button, panel);
  }

  function attach(research, explicitConsole = null) {
    const target = explicitConsole || getConsoleElement();
    if (!target) return showError("Result console not found.");
    if (!target.querySelector(".research-export-bar")) {
      const doc = consoleDocument(target), bar = doc.createElement("div"); bar.className = "research-export-bar";
      bar.innerHTML = `<b>Research data</b><div class="research-window-tabs"><button class="research-window-tab" data-details>Detailed Results</button><button class="research-window-tab" data-spectrum>Spectrum Analysis</button></div><button data-json>Export JSON</button><button data-csv>Export CSV</button><span>Native GNPy values plus analytical filtering reconstruction</span>`;
      bar.querySelector("[data-json]").onclick = () => download("gnpy-research-results.json", JSON.stringify(research, null, 2), "application/json");
      bar.querySelector("[data-csv]").onclick = () => download("gnpy-research-results.csv", csv(research), "text/csv");
      bar.querySelector("[data-details]").onclick = () => openDetailsWindow(research);
      bar.querySelector("[data-spectrum]").onclick = () => openSpectrumWindow(research);
      target.prepend(bar);
    }
    const cards = [...target.querySelectorAll(".result-card")];
    research.elements.forEach(element => {
      const card = cards.find(item => item.dataset.elementUid === element.uid || item.querySelector(".result-card-uid")?.textContent.trim() === element.uid);
      if (card) addCardControls(card, element, research, target);
    });
  }

  function attachWhenReady(research, attempt = 0) {
    const target = getConsoleElement();
    if (target?.querySelectorAll(".result-card").length) return attach(research, target);
    if (attempt < 50) setTimeout(() => attachWhenReady(research, attempt + 1), 100);
  }

  window.gnpyAttachResearchToConsole = target => latestResearch ? (attach(latestResearch, target), true) : false;
  window.gnpyReattachResearch = () => latestResearch && attachWhenReady(latestResearch);
  window.addEventListener("gnpy-research-ready", event => {
    const detail = event.detail || {};
    if (detail.researchError) return showError(detail.researchError);
    if (!detail.research?.elements?.length) return showError("No element-level research data was returned.");
    latestResearch = detail.research;
    attachWhenReady(latestResearch);
  });
})();
