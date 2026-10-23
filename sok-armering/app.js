const {
  FIELDS,
  REBAR_SEARCHES,
  findProperty,
  groupRebar,
  sortRows,
  formatLengde,
  moveToTop,
  mapWithConcurrency,
} = window.RebarLib;

const SEARCH_LIMIT = 10000;
const INFO_CONCURRENCY = 10;
const HIGHLIGHT_CONCURRENCY = 20;
const CONNECT_TIMEOUT_MS = 15000;
const COLUMNS = ["postnr", "count", "diameter", "lengde", "formkode", "segment"];

const statusEl = document.getElementById("status");
const refreshBtn = document.getElementById("refresh-btn");
const countEl = document.getElementById("count");
const noteEl = document.getElementById("note");
const tableContainer = document.getElementById("table-container");
const tableBody = document.querySelector("#rebar-table tbody");
const headerCells = document.querySelectorAll("#rebar-table th[data-key]");
const debugToggle = document.getElementById("debug-toggle");
const debugPanel = document.getElementById("debug-panel");
const debugOutput = document.getElementById("debug-output");
const logEl = document.getElementById("log");

let rows = []; // grouped rebar rows currently shown
let sortKey = "postnr";
let sortDir = 1;
let selectedKey = null; // postnr of the highlighted row
let lastPickedGuid = null;
let hasLoaded = false;

function log(msg) {
  const time = new Date().toLocaleTimeString();
  logEl.value += `[${time}] ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

/** StreamBIM avviser med {code, detail}, penpal med Error — vis det som finnes. */
function errText(err) {
  if (!err) return "ukjent feil";
  return err.code || err.message || JSON.stringify(err);
}

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = cls || "";
}

function showNote(text) {
  noteEl.textContent = text;
  noteEl.classList.toggle("show", Boolean(text));
}

/** Kjører alle søkene i REBAR_SEARCHES og slår sammen GUID-ene (armering = IFC-klasse
 *  ELLER Common Type). Antall treff per søk logges, så første
 *  live-test viser hvilken strategi StreamBIM faktisk støtter. */
async function findAllRebarGuids() {
  const guids = new Set();
  for (const search of REBAR_SEARCHES) {
    let hits = 0;
    for (const value of search.values) {
      try {
        const found = (await StreamBIM.API.findObjects({ key: search.key, value, limit: SEARCH_LIMIT })) || [];
        found.forEach((guid) => guids.add(guid));
        hits += found.length;
      } catch (err) {
        log(`findObjects({key:"${search.key}", value:"${value}"}) feilet: ${errText(err)}`);
      }
    }
    log(`Søk på ${search.label}: ${hits} treff.`);
  }
  return Array.from(guids);
}

async function fetchRebarInfo(guids) {
  const infos = await mapWithConcurrency(
    guids,
    INFO_CONCURRENCY,
    (guid) =>
      StreamBIM.API.getObjectInfo(guid).catch((err) => {
        log(`getObjectInfo(${guid}) feilet: ${errText(err)}`);
        return null;
      }),
    (done, total) => setStatus(`Henter egenskaper ${done}/${total}...`, "busy")
  );
  return infos
    .map((info, i) => (info ? { guid: guids[i], properties: info.properties || {} } : null))
    .filter(Boolean);
}

async function fetchRebarList() {
  refreshBtn.disabled = true;
  setStatus("Søker etter armering...", "busy");
  showNote("");

  try {
    const guids = await findAllRebarGuids();
    if (guids.length === 0) {
      rows = [];
      hasLoaded = true;
      renderTable();
      countEl.textContent = "0 armeringselementer funnet.";
      showNote(
        "Fant ingen armering via @kind (ReinforcingBar/ReinforcingMesh) eller Common Type. " +
        "Klikk et armeringselement i 3D-vieweren og åpne \"Feilsøking\" nederst for å se hvilke " +
        "egenskaper StreamBIM faktisk har på elementet."
      );
      setStatus("Tilkoblet StreamBIM ✔ (0 treff)", "ok");
      return;
    }

    const items = await fetchRebarInfo(guids);
    const { rows: grouped, missingPostnr } = groupRebar(items);
    rows = sortRows(grouped, sortKey, sortDir);
    selectedKey = null;
    hasLoaded = true;
    renderTable();

    const bars = rows.reduce((sum, row) => sum + row.count, 0);
    countEl.textContent = `${bars} stenger i ${items.length} IFC-objekter (${rows.length} unike postnr).`;
    if (missingPostnr > 0) {
      showNote(
        `${missingPostnr} elementer manglet postnr-egenskapen. Klikk ett av dem i 3D-vieweren og ` +
        "åpne \"Feilsøking\" for å se hva postnr heter i denne modellen."
      );
    }
    setStatus("Tilkoblet StreamBIM ✔", "ok");
    log(`Hentet ${items.length} IFC-objekter med ${bars} stenger, ${rows.length} unike postnr.`);
  } catch (err) {
    setStatus("Feil ved henting av armering ✘", "error");
    log("Feil: " + errText(err));
  } finally {
    refreshBtn.disabled = false;
  }
}

/** Bygger cellene med textContent — verdiene kommer fra modellen og skal aldri tolkes
 *  som HTML. */
function renderTable() {
  tableBody.replaceChildren();

  if (rows.length === 0) {
    const tr = document.createElement("tr");
    tr.id = "empty-row";
    const td = document.createElement("td");
    td.colSpan = COLUMNS.length;
    td.textContent = hasLoaded ? "Ingen armering i lista." : "Lista lastes når widgeten er koblet til StreamBIM.";
    tr.appendChild(td);
    tableBody.appendChild(tr);
  }

  for (const row of rows) {
    const tr = document.createElement("tr");
    if (row.postnr === selectedKey) tr.className = "selected";
    const values = [row.postnr, row.count, row.diameter, formatLengde(row.lengde), row.formkode, row.segment];
    for (const value of values) {
      const td = document.createElement("td");
      td.textContent = value ?? "";
      tr.appendChild(td);
    }
    tr.addEventListener("click", () => selectAndZoom(row));
    tableBody.appendChild(tr);
  }

  headerCells.forEach((th) => {
    th.classList.toggle("sorted", th.dataset.key === sortKey);
    th.classList.toggle("desc", th.dataset.key === sortKey && sortDir === -1);
  });
}

/** StreamBIM har bare enkelt-GUID highlightObject() og ingen samlet "velg disse", så
 *  hele gruppen highlightes én og én med begrenset samtidighet. */
async function highlightGroup(row) {
  await StreamBIM.API.deHighlightAllObjects();
  await mapWithConcurrency(row.guids, HIGHLIGHT_CONCURRENCY, (guid) => StreamBIM.API.highlightObject(guid));
}

/** Rammer inn HELE postnr-gruppen via applyObjectSearch() + zoomToSearchResult() på
 *  postnr-egenskapen (visningsmodus ORIGINAL, så resten av modellen ikke tones ned).
 *  UVERIFISERT: feiler søket eller gir 0 treff,
 *  zoomes det til første stang med gotoObject() i stedet. */
async function zoomToGroup(row) {
  if (row.searchKey) {
    try {
      const hits = await StreamBIM.API.applyObjectSearch(
        { key: row.searchKey, value: row.postnr, limit: SEARCH_LIMIT },
        true
      );
      if (hits && hits.length > 0) {
        await StreamBIM.API.setSearchVisualizationMode("ORIGINAL");
        await StreamBIM.API.zoomToSearchResult();
        return "hele gruppen";
      }
      log(`applyObjectSearch på "${row.searchKey}" = "${row.postnr}" ga 0 treff.`);
    } catch (err) {
      log(`Zoom til hele gruppen feilet (${errText(err)}).`);
    }
  }
  await StreamBIM.API.gotoObject(row.guids[0]);
  return "første stang";
}

/** Liste → modell: highlight og zoom til alle stenger med samme postnr. */
async function selectAndZoom(row) {
  selectedKey = row.postnr;
  renderTable();
  try {
    await highlightGroup(row);
    const target = await zoomToGroup(row);
    log(`Valgt postnr ${row.postnr} (${row.count} stk), zoomet til ${target}.`);
  } catch (err) {
    log("Feil ved valg/zoom: " + errText(err));
  }
}

/** Modell → liste: et klikk i 3D-vieweren (StreamBIM sitt pickedObject) utvider valget
 *  til alle stenger med samme postnr og flytter raden øverst. pickedObject kommer kun
 *  fra brukerklikk, ikke fra våre egne highlightObject()-kall, så det trengs ingen
 *  vakt mot tilbakekobling. */
async function handlePickedObject(result) {
  const guid = result && result.guid;
  if (!guid) return;
  lastPickedGuid = guid;
  if (debugPanel.classList.contains("show")) updateDebugPanel(guid);

  const moved = moveToTop(rows, (row) => row.guids.includes(guid));
  if (!moved) {
    log(`Klikket element (${guid}) er ikke i lista${hasLoaded ? "" : " ennå"}.`);
    return;
  }

  rows = moved.rows;
  selectedKey = moved.row.postnr;
  renderTable();
  tableContainer.scrollTop = 0;
  log(`Postnr ${moved.row.postnr} klikket i 3D-viewer (${moved.row.count} stk, utvider valg).`);

  try {
    await highlightGroup(moved.row);
  } catch (err) {
    log("Feil ved utvidelse av valg: " + errText(err));
  }
}

/** Viser hvilket egenskapsnavn hver kolonne traff på, pluss hele getObjectInfo()-svaret —
 *  slik at ekte egenskapsnavn kan leses av uten nettleserkonsoll. */
async function updateDebugPanel(guid) {
  try {
    const info = await StreamBIM.API.getObjectInfo(guid);
    const feltkobling = Object.fromEntries(
      Object.entries(FIELDS).map(([field, names]) => {
        const hit = findProperty(info && info.properties, names);
        return [field, hit ? `${hit.key} = ${hit.value}` : "IKKE FUNNET"];
      })
    );
    debugOutput.value = JSON.stringify({ guid, feltkobling, getObjectInfo: info }, null, 2);
  } catch (err) {
    debugOutput.value = `getObjectInfo(${guid}) feilet: ${errText(err)}`;
  }
}

debugToggle.addEventListener("click", () => {
  debugPanel.classList.toggle("show");
  if (debugPanel.classList.contains("show") && lastPickedGuid) updateDebugPanel(lastPickedGuid);
});

headerCells.forEach((th) => {
  th.addEventListener("click", () => {
    const key = th.dataset.key;
    sortDir = sortKey === key ? -sortDir : 1;
    sortKey = key;
    rows = sortRows(rows, sortKey, sortDir);
    renderTable();
  });
});

refreshBtn.addEventListener("click", fetchRebarList);

/** connectToParent() godtar kun meldinger fra document.referrer sin origin. Åpnes siden
 *  direkte (ikke som iframe i StreamBIM), eller sender verten ingen referrer, blir det
 *  aldri noen tilkobling — vakthunden gir da en forklaring i stedet for evig "kobler til". */
async function main() {
  renderTable();
  log(`Referrer: ${document.referrer || "(ingen)"}`);

  if (window.parent === window) {
    setStatus("Åpnet utenfor StreamBIM ✘", "error");
    showNote("Denne siden er en StreamBIM-widget og må åpnes som widget inni et StreamBIM-prosjekt.");
    return;
  }

  const watchdog = setTimeout(() => {
    setStatus("Ingen kontakt med StreamBIM ✘", "error");
    showNote(
      "Fikk ikke svar fra StreamBIM innen 15 sekunder." +
      (document.referrer ? "" : " Siden fikk ingen referrer, og da avviser API-et alle meldinger fra verten.")
    );
  }, CONNECT_TIMEOUT_MS);

  try {
    await StreamBIM.connectToParent(window.parent, { pickedObject: handlePickedObject });
    clearTimeout(watchdog);
    showNote("");
    log("StreamBIM.connectToParent() lyktes.");
    StreamBIM.API.setShowExpandButton(true).catch((err) => log("setShowExpandButton feilet: " + errText(err)));
    await fetchRebarList();
  } catch (err) {
    clearTimeout(watchdog);
    setStatus("Kunne ikke koble til StreamBIM ✘", "error");
    log("Feil: " + errText(err));
  }
}

main();
