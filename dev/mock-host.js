/* Lokal etterligning av StreamBIM-verten: legger widgeten i en iframe og svarer på de
 * samme API-kallene via StreamBIM.connectToChild() (samme penpal-transport som ekte
 * StreamBIM bruker). Klikk på en rute i "3D-visningen" = pickedObject til widgeten.
 *
 * Innstillinger via URL: ?widget=../sok-armering/index.html&format=flat|tilde|nested
 *   &kind=1|0 (støtter @kind-søk) &search=1|0 (støtter applyObjectSearch/zoomToSearchResult)
 * Med kind=0 og search=0 testes reservestiene i widgeten. */
(function () {
  const params = new URLSearchParams(location.search);
  const settings = {
    widget: params.get("widget") || "../sok-armering/index.html",
    format: params.get("format") || "flat",
    kind: params.get("kind") !== "0",
    search: params.get("search") !== "0",
  };

  const { objects } = window.MockModel;
  const byGuid = new Map(objects.map((o) => [o.guid, o]));
  const highlighted = new Set();
  let activeSearch = null; // { guids: Set, mode }
  let camera = "Hjem";
  let visualizationMode = "FADED";

  const viewEl = document.getElementById("view");
  const cameraEl = document.getElementById("camera");
  const callsEl = document.getElementById("calls");
  const frame = document.getElementById("widget-frame");

  /** Bygger properties i valgt form — de tre formene widgeten skal tåle. */
  function propertiesFor(obj) {
    const entries = Object.entries(obj.props);
    if (settings.format === "tilde") {
      return Object.fromEntries(entries.map(([k, v]) => [`${obj.pset}~${k}`, v]));
    }
    if (settings.format === "nested") {
      return { [obj.pset]: Object.fromEntries(entries) };
    }
    return Object.fromEntries(entries.map(([k, v]) => [k, [v]]));
  }

  function matches(obj, key, value) {
    if (key === "@kind") return settings.kind && obj.kind === value;
    return Object.prototype.hasOwnProperty.call(obj.props, key) && String(obj.props[key]) === String(value);
  }

  function search({ key, value, limit = 100 }) {
    return objects.filter((o) => matches(o, key, value)).slice(0, limit).map((o) => o.guid);
  }

  function logCall(name, args) {
    const li = document.createElement("li");
    li.textContent = `${name}(${args.map((a) => JSON.stringify(a)).join(", ")})`;
    callsEl.prepend(li);
    while (callsEl.children.length > 200) callsEl.lastChild.remove();
  }

  function unsupported(name) {
    return () => Promise.reject({ code: "MOCK_NOT_SUPPORTED", detail: `${name} er slått av i mock-verten` });
  }

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const api = {
    getProjectId: async () => "mock-project",
    getUserEmail: async () => "mock@example.com",
    setShowExpandButton: async () => true,
    findObjects: async (query) => {
      await delay(20);
      return search(query);
    },
    getObjectInfo: async (guid) => {
      await delay(5);
      const obj = byGuid.get(guid);
      if (!obj) throw { code: "OBJECT_NOT_FOUND", detail: guid };
      return { guid, name: obj.name, center: obj.center, properties: propertiesFor(obj) };
    },
    highlightObject: async (guid) => highlighted.add(guid) && true,
    deHighlightObject: async (guid) => highlighted.delete(guid),
    deHighlightAllObjects: async () => {
      highlighted.clear();
      return true;
    },
    gotoObject: async (guid) => {
      camera = `Objekt ${byGuid.get(guid) ? byGuid.get(guid).name : guid}`;
      return true;
    },
    applyObjectSearch: settings.search
      ? async (query) => {
          const guids = search(query);
          activeSearch = { guids: new Set(guids) };
          return guids;
        }
      : unsupported("applyObjectSearch"),
    setSearchVisualizationMode: settings.search
      ? async (mode) => {
          visualizationMode = mode;
          return true;
        }
      : unsupported("setSearchVisualizationMode"),
    zoomToSearchResult: settings.search
      ? async () => {
          camera = activeSearch ? `Søkeresultat (${activeSearch.guids.size} objekter)` : "Ingen aktivt søk";
          return true;
        }
      : unsupported("zoomToSearchResult"),
    resetObjectSearch: async () => {
      activeSearch = null;
      return true;
    },
  };

  /** Pakker hver API-metode slik at kallet logges og visningen tegnes på nytt. */
  const methods = Object.fromEntries(
    Object.entries(api).map(([name, fn]) => [
      name,
      async (...args) => {
        logCall(name, args);
        try {
          return await fn(...args);
        } finally {
          render();
        }
      },
    ])
  );

  function render() {
    cameraEl.textContent = `Kamera: ${camera} · søk: ${activeSearch ? `${activeSearch.guids.size} treff (${visualizationMode})` : "ingen"}`;
    viewEl.replaceChildren(
      ...objects.map((obj) => {
        const tile = document.createElement("button");
        tile.type = "button";
        tile.className = `tile kind-${obj.kind}`;
        tile.dataset.guid = obj.guid;
        if (highlighted.has(obj.guid)) tile.classList.add("highlighted");
        if (activeSearch && !activeSearch.guids.has(obj.guid) && visualizationMode === "FADED") tile.classList.add("faded");
        tile.textContent = obj.name;
        tile.title = obj.guid;
        tile.addEventListener("click", () => pick(obj));
        return tile;
      })
    );
  }

  function pick(obj) {
    if (!StreamBIM.API) return;
    highlighted.clear();
    highlighted.add(obj.guid);
    render();
    StreamBIM.API.pickedObject({ guid: obj.guid, point: obj.center }).catch((err) => console.error(err));
  }

  document.querySelectorAll("[data-setting]").forEach((input) => {
    const key = input.dataset.setting;
    if (input.type === "checkbox") input.checked = settings[key];
    else input.value = settings[key];
    input.addEventListener("change", () => {
      const next = new URLSearchParams(location.search);
      next.set(key, input.type === "checkbox" ? (input.checked ? "1" : "0") : input.value);
      location.search = next.toString();
    });
  });

  render();
  frame.src = settings.widget;
  StreamBIM.connectToChild(frame, methods)
    .then(() => {
      document.getElementById("host-status").textContent = "Widget tilkoblet ✔";
      window.mockHost = { api: StreamBIM.API, objects, highlighted, pick, get camera() { return camera; } };
    })
    .catch((err) => {
      document.getElementById("host-status").textContent = "Tilkobling feilet: " + JSON.stringify(err);
    });
})();
