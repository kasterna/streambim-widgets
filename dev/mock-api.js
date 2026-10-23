/* Falsk StreamBIM-API, delt av mock-host.html (StreamBIM som forelder til widgeten) og
 * fake-viewer.html (StreamBIM som barn i embedded-modus, for å teste
 * streambim-host.html). Svarer på de samme kallene som ekte StreamBIM.
 *
 * Objektene har formen {guid, name, kind, center, psets: {Pset: {Egenskap: verdi}}} —
 * enten de oppdiktede i mock-model.js eller en ekte modell fra tools/ifc-til-testmodell.py.
 *
 * Innstillinger: format=flat|tilde|nested (formen på getObjectInfo().properties),
 * kind=false (ingen støtte for @kind-søk), search=false (ingen applyObjectSearch). */
(function () {
  function readSettings(params) {
    return {
      format: params.get("format") || "flat",
      kind: params.get("kind") !== "0",
      search: params.get("search") !== "0",
    };
  }

  function createMockApi(settings, onCall, objects = window.MockModel.objects) {
    const byGuid = new Map(objects.map((o) => [o.guid, o]));
    const state = {
      highlighted: new Set(),
      activeSearch: null, // Set med GUID-er
      camera: "Hjem",
      focus: [], // GUID-er kameraet sist ble bedt om å ramme inn (3D-visningen zoomer dit)
      focusVersion: 0,
      visualizationMode: "FADED",
    };

    function setFocus(guids, text) {
      state.focus = guids;
      state.focusVersion++;
      state.camera = text;
    }

    /** Bygger properties i valgt form — de tre formene widgeten skal tåle. Ved flat form
     *  vinner siste Pset hvis samme egenskapsnavn finnes i flere. */
    function propertiesFor(obj) {
      const entries = Object.entries(obj.psets).flatMap(([pset, props]) =>
        Object.entries(props).map(([key, value]) => ({ pset, key, value }))
      );
      if (settings.format === "tilde") return Object.fromEntries(entries.map((e) => [`${e.pset}~${e.key}`, e.value]));
      if (settings.format === "nested") return obj.psets;
      return Object.fromEntries(entries.map((e) => [e.key, [e.value]]));
    }

    function matches(obj, key, value) {
      if (key === "@kind") return settings.kind && obj.kind === value;
      return Object.values(obj.psets).some(
        (props) => Object.prototype.hasOwnProperty.call(props, key) && String(props[key]) === String(value)
      );
    }

    function search({ key, value, limit = 100 }) {
      return objects.filter((o) => matches(o, key, value)).slice(0, limit).map((o) => o.guid);
    }

    function unsupported(name) {
      return async () => {
        throw { code: "MOCK_NOT_SUPPORTED", detail: `${name} er slått av i mocken` };
      };
    }

    // Ingen kunstig forsinkelse: i en skjult fane strupes setTimeout til ~1 s, og da tok
    // 250 getObjectInfo()-kall mange sekunder.
    const api = {
      getProjectId: async () => "mock-project",
      getUserEmail: async () => "mock@example.com",
      setShowExpandButton: async () => true,
      getFloors: async () => [{ id: 1, name: "Plan 1", height: 0 }, { id: 2, name: "Plan 2", height: 3.6 }],
      getLayers: async () => ({ RIB: true, ARK: false }),
      getCameraState: async () => ({ position: [10, 10, 10], quaternion: [1, 0, 0, 0] }),
      findObjects: async (query) => search(query),
      getObjectInfo: async (guid) => {
        const obj = byGuid.get(guid);
        if (!obj) throw { code: "OBJECT_NOT_FOUND", detail: guid };
        return { guid, name: obj.name, center: obj.center, properties: propertiesFor(obj) };
      },
      highlightObject: async (guid) => {
        state.highlighted.add(guid);
        return true;
      },
      deHighlightObject: async (guid) => state.highlighted.delete(guid),
      deHighlightAllObjects: async () => {
        state.highlighted.clear();
        return true;
      },
      gotoObject: async (guid) => {
        setFocus([guid], `Objekt ${byGuid.has(guid) ? byGuid.get(guid).name : guid}`);
        return true;
      },
      applyObjectSearch: settings.search
        ? async (query) => {
            const guids = search(query);
            state.activeSearch = new Set(guids);
            return guids;
          }
        : unsupported("applyObjectSearch"),
      setSearchVisualizationMode: settings.search
        ? async (mode) => {
            state.visualizationMode = mode;
            return true;
          }
        : unsupported("setSearchVisualizationMode"),
      zoomToSearchResult: settings.search
        ? async () => {
            if (!state.activeSearch) {
              state.camera = "Ingen aktivt søk";
              return true;
            }
            setFocus([...state.activeSearch], `Søkeresultat (${state.activeSearch.size} objekter)`);
            return true;
          }
        : unsupported("zoomToSearchResult"),
      resetObjectSearch: async () => {
        state.activeSearch = null;
        return true;
      },
    };

    /** Pakker hver metode slik at kallet meldes til `onCall` (logg + ny tegning). */
    const methods = Object.fromEntries(
      Object.entries(api).map(([name, fn]) => [
        name,
        async (...args) => {
          try {
            return await fn(...args);
          } finally {
            onCall(name, args);
          }
        },
      ])
    );

    return { objects, state, methods };
  }

  function cameraText(state) {
    const searchText = state.activeSearch ? `${state.activeSearch.size} treff (${state.visualizationMode})` : "ingen";
    return `Kamera: ${state.camera} · søk: ${searchText}`;
  }

  /** Tegner kamera-linja og én klikkbar rute per objekt (brukes uten 3D-modell). */
  function renderMockView(mock, viewEl, cameraEl, onPick) {
    const { state } = mock;
    cameraEl.textContent = cameraText(state);
    viewEl.replaceChildren(
      ...mock.objects.map((obj) => {
        const tile = document.createElement("button");
        tile.type = "button";
        tile.className = `tile kind-${obj.kind}`;
        if (state.highlighted.has(obj.guid)) tile.classList.add("highlighted");
        if (state.activeSearch && !state.activeSearch.has(obj.guid) && state.visualizationMode === "FADED") {
          tile.classList.add("faded");
        }
        tile.textContent = obj.name;
        tile.title = obj.guid;
        tile.addEventListener("click", () => onPick(obj));
        return tile;
      })
    );
  }

  /** Simulerer et brukerklikk: highlight bare det objektet og send pickedObject. */
  function pickObject(mock, obj, remote, point = obj.center) {
    mock.state.highlighted.clear();
    mock.state.highlighted.add(obj.guid);
    if (remote) remote.pickedObject({ guid: obj.guid, point }).catch((err) => console.error(err));
  }

  window.MockApi = { readSettings, createMockApi, renderMockView, pickObject, cameraText };
})();
