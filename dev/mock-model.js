/* Falsk modell for mock-host.html: armering eksportert fra Tekla og fra RIB, et nett,
 * stenger uten postnr og noen ikke-armeringsobjekter som IKKE skal havne i lista.
 * Egenskapsnavnene er de samme som i ekte Tekla- og RIB-eksporter. */
(function () {
  const objects = [];
  let counter = 0;

  function nextGuid() {
    counter++;
    return `3MockGuid${String(counter).padStart(4, "0")}xxxxxxxxx`.slice(0, 22);
  }

  function add(count, kind, pset, props, name) {
    for (let i = 0; i < count; i++) {
      objects.push({
        guid: nextGuid(),
        name: `${name} #${i + 1}`,
        kind,
        center: [counter * 0.5, i * 0.2, 1.5],
        psets: { [pset]: props },
      });
    }
  }

  const tekla = (postnr, diameter, lengde, formkode, segment) => ({
    "Common Type": "REINFORCINGBAR",
    Posisjonsnummer: postnr,
    "Diameter jern": diameter,
    Armeringslengde: lengde,
    Formkode: formkode,
    Segment: segment,
  });

  const rib = (postnr, diameter, kapplengde, formkode, antall) => ({
    "Common Type": "REINFORCINGBAR",
    "ARM.07 - Posnr": postnr,
    "ARM.08 - Stangdiameter": diameter,
    "ARM.80 - Kapplengde": kapplengde,
    "ARM.81 - Totallengde": kapplengde * antall,
    "ARM.37 - Formkode": formkode,
  });

  // Eksport med kode foran egenskapsnavnene, i pset MERKNADER.
  const kcoded = (postnr, diameter, lengde, formkode) => ({
    "K200 Pos nr.": postnr,
    "K201 Stangdiameter": diameter,
    "K202 Antall": 1,
    "K233 Kapplengde": lengde,
    "K212 Formkode": formkode,
  });

  add(12, "ReinforcingBar", "Tekla Reinforcement", tekla("101", "12", "2450", "00", "S1"), "Tekla pos 101");
  add(3, "ReinforcingBar", "MERKNADER", kcoded("Fx0001.01", "25", "3395", "NB99-01"), "K-kodet pos Fx0001.01");
  add(4, "ReinforcingBar", "MERKNADER", kcoded("Fx0002.01", "16", "5120", "NB00-00"), "K-kodet pos Fx0002.01");
  add(8, "ReinforcingBar", "Tekla Reinforcement", tekla("102", "16", "3200", "21", "S1"), "Tekla pos 102");
  add(20, "ReinforcingBar", "Tekla Reinforcement", tekla("103", "10", "1180", "51", "S2"), "Tekla pos 103");
  add(6, "ReinforcingBar", "ARM", rib("201", "20", 2647.1150383789704, "26", 6), "RIB pos 201");
  add(4, "ReinforcingBar", "ARM", rib("9", "25", 5800.4, "00", 4), "RIB pos 9");
  add(1, "ReinforcingMesh", "Tekla Reinforcement", { "Common Type": "REINFORCINGMESH", Posisjonsnummer: "N1", Formkode: "Nett" }, "Nett N1");
  add(2, "ReinforcingBar", "Tekla Reinforcement", { "Common Type": "REINFORCINGBAR", "Diameter jern": "8" }, "Stang uten postnr");
  add(3, "Wall", "Pset_WallCommon", { "Common Type": "WALL", IsExternal: "True" }, "Vegg");
  add(2, "Slab", "Pset_SlabCommon", { "Common Type": "SLAB", Posisjonsnummer: "101" }, "Dekke med postnr");

  window.MockModel = { objects };
})();
