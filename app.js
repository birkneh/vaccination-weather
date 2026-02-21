const OWID_URL =
  "https://raw.githubusercontent.com/owid/covid-19-data/master/public/data/vaccinations/vaccinations.csv";
const OPEN_METEO_BASE = "https://archive-api.open-meteo.com/v1/archive";

const LOCATION_CONFIGS = [
  { label: "United States (Washington, DC)", owid: "United States", lat: 38.9072, lon: -77.0369 },
  { label: "United Kingdom (London)", owid: "United Kingdom", lat: 51.5074, lon: -0.1278 },
  { label: "India (New Delhi)", owid: "India", lat: 28.6139, lon: 77.209 },
  { label: "Brazil (Brasilia)", owid: "Brazil", lat: -15.7939, lon: -47.8828 },
  { label: "Nigeria (Abuja)", owid: "Nigeria", lat: 9.0765, lon: 7.3986 },
  { label: "Egypt (Cairo)", owid: "Egypt", lat: 30.0444, lon: 31.2357 },
  { label: "Kenya (Nairobi)", owid: "Kenya", lat: -1.2921, lon: 36.8219 },
  { label: "Ethiopia (Addis Ababa)", owid: "Ethiopia", lat: 8.9806, lon: 38.7578 },
  { label: "South Africa (Pretoria)", owid: "South Africa", lat: -25.7479, lon: 28.2293 },
];

const state = {
  merged: [],
  lagCorrelations: [],
  summary: [],
  refreshTimerId: null,
};

const dom = {
  locations: document.getElementById("locations"),
  lagLocation: document.getElementById("lag-location"),
  startDate: document.getElementById("start-date"),
  endDate: document.getElementById("end-date"),
  rollingToggle: document.getElementById("rolling-toggle"),
  refreshBtn: document.getElementById("refresh-btn"),
  refreshInterval: document.getElementById("refresh-interval"),
  metrics: document.getElementById("metrics"),
  status: document.getElementById("status"),
  summaryBody: document.querySelector("#summary-table tbody"),
};

function todayISODate() {
  return new Date().toISOString().slice(0, 10);
}

function formatNumber(value, decimals = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "NA";
  return Number(value).toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function pearsonCorrelation(xs, ys) {
  const n = xs.length;
  if (n < 3) return NaN;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  let sumYY = 0;
  for (let i = 0; i < n; i += 1) {
    const x = xs[i];
    const y = ys[i];
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
    sumYY += y * y;
  }
  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt((n * sumXX - sumX * sumX) * (n * sumYY - sumY * sumY));
  if (!Number.isFinite(denominator) || denominator === 0) return NaN;
  return numerator / denominator;
}

function linearTrendline(xValues, yValues) {
  const valid = [];
  for (let i = 0; i < xValues.length; i += 1) {
    if (Number.isFinite(xValues[i]) && Number.isFinite(yValues[i])) {
      valid.push({ x: xValues[i], y: yValues[i] });
    }
  }
  if (valid.length < 3) return null;
  const n = valid.length;
  const sumX = valid.reduce((acc, p) => acc + p.x, 0);
  const sumY = valid.reduce((acc, p) => acc + p.y, 0);
  const sumXY = valid.reduce((acc, p) => acc + p.x * p.y, 0);
  const sumXX = valid.reduce((acc, p) => acc + p.x * p.x, 0);
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  const minX = Math.min(...valid.map((p) => p.x));
  const maxX = Math.max(...valid.map((p) => p.x));
  return {
    x: [minX, maxX],
    y: [slope * minX + intercept, slope * maxX + intercept],
  };
}

function setStatus(message) {
  dom.status.textContent = message;
}

function parseOwidCsv(csvText) {
  return Papa.parse(csvText, { header: true, dynamicTyping: true }).data;
}

function toMapKey(location, dateStr) {
  return `${location}||${dateStr}`;
}

async function fetchVaccinations(startDate, endDate) {
  const response = await fetch(OWID_URL);
  if (!response.ok) throw new Error(`Vaccination fetch failed: ${response.status}`);
  const text = await response.text();
  const rows = parseOwidCsv(text);
  const keep = new Set(LOCATION_CONFIGS.map((c) => c.owid));
  const mapName = Object.fromEntries(LOCATION_CONFIGS.map((c) => [c.owid, c.label]));

  return rows
    .filter((r) => keep.has(r.location))
    .filter((r) => r.date >= startDate && r.date <= endDate)
    .map((r) => ({
      location: mapName[r.location],
      date: r.date,
      dailyVaccinationsPerMillion: Number(r.daily_vaccinations_per_million),
      totalVaccinationsPerHundred: Number(r.total_vaccinations_per_hundred),
      peopleVaccinatedPerHundred: Number(r.people_vaccinated_per_hundred),
      peopleFullyVaccinatedPerHundred: Number(r.people_fully_vaccinated_per_hundred),
    }));
}

async function fetchWeatherForLocation(location, startDate, endDate) {
  const params = new URLSearchParams({
    latitude: String(location.lat),
    longitude: String(location.lon),
    start_date: startDate,
    end_date: endDate,
    daily: "temperature_2m_mean",
    timezone: "UTC",
  });
  const url = `${OPEN_METEO_BASE}?${params.toString()}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Weather fetch failed (${location.label}): ${response.status}`);
  const payload = await response.json();
  if (!payload.daily || !payload.daily.time) {
    throw new Error(`Malformed weather payload for ${location.label}`);
  }
  return payload.daily.time.map((date, idx) => ({
    location: location.label,
    date,
    temperatureMeanC: Number(payload.daily.temperature_2m_mean[idx]),
  }));
}

function rollingAverage(values, windowSize = 7, minPeriods = 3) {
  const output = new Array(values.length).fill(NaN);
  for (let i = 0; i < values.length; i += 1) {
    const from = Math.max(0, i - (windowSize - 1));
    const window = values.slice(from, i + 1).filter(Number.isFinite);
    if (window.length >= minPeriods) {
      output[i] = window.reduce((acc, v) => acc + v, 0) / window.length;
    }
  }
  return output;
}

function enrichWithRolling(merged) {
  const byLocation = groupBy(merged, (r) => r.location);
  const out = [];
  Object.keys(byLocation).forEach((location) => {
    const rows = byLocation[location].sort((a, b) => a.date.localeCompare(b.date));
    const vacc = rows.map((r) => r.dailyVaccinationsPerMillion);
    const temps = rows.map((r) => r.temperatureMeanC);
    const vacc7 = rollingAverage(vacc, 7, 3);
    const temp7 = rollingAverage(temps, 7, 3);
    rows.forEach((row, idx) => {
      out.push({
        ...row,
        vaccinations7dAvgPerMillion: vacc7[idx],
        temperature7dAvgC: temp7[idx],
      });
    });
  });
  return out;
}

function computeLagCorrelations(merged, minLag = -30, maxLag = 30) {
  const byLocation = groupBy(merged, (r) => r.location);
  const rows = [];
  Object.keys(byLocation).forEach((location) => {
    const locRows = byLocation[location].sort((a, b) => a.date.localeCompare(b.date));
    const vax = locRows.map((r) => r.dailyVaccinationsPerMillion);
    const temp = locRows.map((r) => r.temperatureMeanC);
    for (let lag = minLag; lag <= maxLag; lag += 1) {
      const xs = [];
      const ys = [];
      for (let i = 0; i < vax.length; i += 1) {
        const j = i + lag;
        if (j < 0 || j >= temp.length) continue;
        const v = vax[i];
        const t = temp[j];
        if (Number.isFinite(v) && Number.isFinite(t)) {
          xs.push(v);
          ys.push(t);
        }
      }
      rows.push({
        location,
        lagDays: lag,
        correlation: xs.length >= 14 ? pearsonCorrelation(xs, ys) : NaN,
        pointsUsed: xs.length,
      });
    }
  });
  return rows;
}

function summarize(merged, lagRows) {
  const byLocation = groupBy(merged, (r) => r.location);
  return Object.keys(byLocation).map((location) => {
    const rows = byLocation[location].sort((a, b) => a.date.localeCompare(b.date));
    const clean = rows.filter(
      (r) => Number.isFinite(r.dailyVaccinationsPerMillion) && Number.isFinite(r.temperatureMeanC),
    );
    const corr = pearsonCorrelation(
      clean.map((r) => r.dailyVaccinationsPerMillion),
      clean.map((r) => r.temperatureMeanC),
    );
    const locLag = lagRows
      .filter((r) => r.location === location && Number.isFinite(r.correlation))
      .sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));
    const best = locLag[0];
    return {
      location,
      recordsUsed: clean.length,
      sameDayCorrelation: corr,
      bestLagDays: best ? best.lagDays : NaN,
      bestLagCorrelation: best ? best.correlation : NaN,
      dateStart: clean[0]?.date || "NA",
      dateEnd: clean[clean.length - 1]?.date || "NA",
    };
  });
}

function groupBy(items, keyFn) {
  const out = {};
  items.forEach((item) => {
    const key = keyFn(item);
    if (!out[key]) out[key] = [];
    out[key].push(item);
  });
  return out;
}

function buildLocationOptions() {
  dom.locations.innerHTML = "";
  dom.lagLocation.innerHTML = "";
  LOCATION_CONFIGS.forEach((location, idx) => {
    const option = document.createElement("option");
    option.value = location.label;
    option.textContent = location.label;
    option.selected = idx < 5;
    dom.locations.appendChild(option);

    const lagOption = document.createElement("option");
    lagOption.value = location.label;
    lagOption.textContent = location.label;
    dom.lagLocation.appendChild(lagOption);
  });
  dom.lagLocation.value = LOCATION_CONFIGS[0].label;
}

function selectedLocations() {
  return Array.from(dom.locations.selectedOptions).map((opt) => opt.value);
}

function filterMergedData() {
  const selected = new Set(selectedLocations());
  const startDate = dom.startDate.value;
  const endDate = dom.endDate.value;
  return state.merged.filter(
    (r) => selected.has(r.location) && r.date >= startDate && r.date <= endDate,
  );
}

function renderMetrics(filtered) {
  dom.metrics.innerHTML = "";
  const selected = selectedLocations();
  const vKey = dom.rollingToggle.checked
    ? "vaccinations7dAvgPerMillion"
    : "dailyVaccinationsPerMillion";
  const tKey = dom.rollingToggle.checked ? "temperature7dAvgC" : "temperatureMeanC";
  selected.slice(0, 4).forEach((location) => {
    const rows = filtered.filter((r) => r.location === location);
    if (!rows.length) return;
    const latest = rows[rows.length - 1];
    const card = document.createElement("article");
    card.className = "metric-card";
    card.innerHTML = `
      <p class="metric-location">${location}</p>
      <p class="metric-main">${formatNumber(latest[vKey], 1)} vax/M</p>
      <p class="metric-sub">${formatNumber(latest[tKey], 1)} C</p>
    `;
    dom.metrics.appendChild(card);
  });
}

function renderLineCharts(filtered) {
  const selected = selectedLocations();
  const vKey = dom.rollingToggle.checked
    ? "vaccinations7dAvgPerMillion"
    : "dailyVaccinationsPerMillion";
  const tKey = dom.rollingToggle.checked ? "temperature7dAvgC" : "temperatureMeanC";

  const vaccTraces = selected.map((location) => {
    const rows = filtered.filter((r) => r.location === location);
    return {
      type: "scatter",
      mode: "lines",
      name: location,
      x: rows.map((r) => r.date),
      y: rows.map((r) => r[vKey]),
    };
  });
  const tempTraces = selected.map((location) => {
    const rows = filtered.filter((r) => r.location === location);
    return {
      type: "scatter",
      mode: "lines",
      name: location,
      x: rows.map((r) => r.date),
      y: rows.map((r) => r[tKey]),
    };
  });

  const baseLayout = {
    margin: { t: 14, r: 8, b: 42, l: 52 },
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    font: { color: "#eef3f8" },
    xaxis: { gridcolor: "#2c3e4d" },
    yaxis: { gridcolor: "#2c3e4d" },
    legend: { orientation: "h", y: 1.12 },
  };

  Plotly.newPlot("vaccinations-chart", vaccTraces, {
    ...baseLayout,
    yaxis: { ...baseLayout.yaxis, title: "Vaccinations per million" },
  }, { responsive: true, displaylogo: false });

  Plotly.newPlot("temperature-chart", tempTraces, {
    ...baseLayout,
    yaxis: { ...baseLayout.yaxis, title: "Temperature (C)" },
  }, { responsive: true, displaylogo: false });
}

function renderScatter(filtered) {
  const vKey = dom.rollingToggle.checked
    ? "vaccinations7dAvgPerMillion"
    : "dailyVaccinationsPerMillion";
  const tKey = dom.rollingToggle.checked ? "temperature7dAvgC" : "temperatureMeanC";
  const selected = new Set(selectedLocations());
  const rows = filtered.filter(
    (r) => selected.has(r.location) && Number.isFinite(r[vKey]) && Number.isFinite(r[tKey]),
  );
  const byLocation = groupBy(rows, (r) => r.location);
  const traces = Object.keys(byLocation).map((location) => ({
    type: "scatter",
    mode: "markers",
    name: location,
    x: byLocation[location].map((r) => r[tKey]),
    y: byLocation[location].map((r) => r[vKey]),
    marker: { size: 7, opacity: 0.72 },
  }));

  const trend = linearTrendline(
    rows.map((r) => r[tKey]),
    rows.map((r) => r[vKey]),
  );
  if (trend) {
    traces.push({
      type: "scatter",
      mode: "lines",
      name: "Linear trend",
      x: trend.x,
      y: trend.y,
      line: { color: "#ffffff", dash: "dash" },
    });
  }

  Plotly.newPlot("scatter-chart", traces, {
    margin: { t: 14, r: 8, b: 42, l: 52 },
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    font: { color: "#eef3f8" },
    legend: { orientation: "h", y: 1.12 },
    xaxis: { title: "Temperature (C)", gridcolor: "#2c3e4d" },
    yaxis: { title: "Vaccinations per million", gridcolor: "#2c3e4d" },
  }, { responsive: true, displaylogo: false });
}

function renderLagChart() {
  const location = dom.lagLocation.value;
  const rows = state.lagCorrelations.filter((r) => r.location === location);
  Plotly.newPlot(
    "lag-chart",
    [
      {
        type: "scatter",
        mode: "lines+markers",
        x: rows.map((r) => r.lagDays),
        y: rows.map((r) => r.correlation),
        marker: { color: "#5ed3c6", size: 6 },
        line: { color: "#5ed3c6" },
        name: location,
      },
    ],
    {
      margin: { t: 14, r: 8, b: 42, l: 52 },
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      font: { color: "#eef3f8" },
      xaxis: { title: "Lag days", gridcolor: "#2c3e4d" },
      yaxis: { title: "Pearson correlation", gridcolor: "#2c3e4d" },
      shapes: [
        {
          type: "line",
          x0: -30,
          x1: 30,
          y0: 0,
          y1: 0,
          line: { color: "#7f8ea0", width: 1, dash: "dot" },
        },
      ],
    },
    { responsive: true, displaylogo: false },
  );
}

function renderSummaryTable() {
  const selected = new Set(selectedLocations());
  const rows = state.summary
    .filter((r) => selected.has(r.location))
    .sort((a, b) => a.location.localeCompare(b.location));
  dom.summaryBody.innerHTML = "";
  rows.forEach((r) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${r.location}</td>
      <td>${r.recordsUsed}</td>
      <td>${formatNumber(r.sameDayCorrelation, 3)}</td>
      <td>${Number.isFinite(r.bestLagDays) ? r.bestLagDays : "NA"}</td>
      <td>${formatNumber(r.bestLagCorrelation, 3)}</td>
      <td>${r.dateStart}</td>
      <td>${r.dateEnd}</td>
    `;
    dom.summaryBody.appendChild(tr);
  });
}

function renderAll() {
  const filtered = filterMergedData().sort((a, b) => a.date.localeCompare(b.date));
  renderMetrics(filtered);
  renderLineCharts(filtered);
  renderScatter(filtered);
  renderLagChart();
  renderSummaryTable();
}

function setupAutoRefresh() {
  if (state.refreshTimerId) clearInterval(state.refreshTimerId);
  const minutes = Number(dom.refreshInterval.value);
  if (!minutes) return;
  state.refreshTimerId = setInterval(() => {
    hydrateData(true);
  }, minutes * 60 * 1000);
}

async function hydrateData(isBackground = false) {
  const startDate = dom.startDate.value;
  const endDate = dom.endDate.value;
  try {
    if (!isBackground) setStatus("Loading live vaccination and weather data...");
    const [vaccRows, weatherRowsByLocation] = await Promise.all([
      fetchVaccinations(startDate, endDate),
      Promise.all(
        LOCATION_CONFIGS.map((location) => fetchWeatherForLocation(location, startDate, endDate)),
      ),
    ]);

    const weatherMap = new Map();
    weatherRowsByLocation.flat().forEach((r) => {
      weatherMap.set(toMapKey(r.location, r.date), r.temperatureMeanC);
    });

    const merged = vaccRows
      .map((r) => {
        const temp = weatherMap.get(toMapKey(r.location, r.date));
        return {
          ...r,
          temperatureMeanC: Number(temp),
        };
      })
      .filter(
        (r) =>
          Number.isFinite(r.temperatureMeanC) && Number.isFinite(r.dailyVaccinationsPerMillion),
      );

    state.merged = enrichWithRolling(merged);
    state.lagCorrelations = computeLagCorrelations(state.merged);
    state.summary = summarize(state.merged, state.lagCorrelations);

    renderAll();
    const stamp = new Date().toLocaleString();
    setStatus(`Last updated: ${stamp}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown loading error";
    setStatus(`Failed to load data: ${msg}`);
  }
}

function initializeControls() {
  buildLocationOptions();
  dom.startDate.value = "2021-01-01";
  dom.endDate.value = todayISODate();

  dom.locations.addEventListener("change", () => {
    const selected = selectedLocations();
    if (selected.length && !selected.includes(dom.lagLocation.value)) {
      dom.lagLocation.value = selected[0];
    }
    renderAll();
  });

  dom.lagLocation.addEventListener("change", renderLagChart);
  dom.startDate.addEventListener("change", () => hydrateData());
  dom.endDate.addEventListener("change", () => hydrateData());
  dom.rollingToggle.addEventListener("change", renderAll);
  dom.refreshBtn.addEventListener("click", () => hydrateData());
  dom.refreshInterval.addEventListener("change", setupAutoRefresh);
}

async function main() {
  initializeControls();
  setupAutoRefresh();
  await hydrateData();
}

main();
