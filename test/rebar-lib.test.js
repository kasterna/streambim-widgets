const test = require("node:test");
const assert = require("node:assert/strict");
const {
  FIELDS,
  MISSING_POSTNR,
  flattenProperties,
  findProperty,
  objectProperties,
  isRebarObject,
  groupRebar,
  hasGeometry,
  guidSearchRule,
  REBAR_KINDS,
  UNKNOWN_KIND,
  rebarCandidates,
  sameGuidSet,
  filterRows,
  exportItems,
  exportSamples,
  exportGaps,
  sortRows,
  formatLengde,
  moveToTop,
  mapWithConcurrency,
} = require("../sok-armering/rebar-lib.js");
// Ekte getObjectInfo()-svar fra StreamBIM (forkortet, nøytrale navn).
const realInfo = require("./fixtures/object-info.json");

test.describe("objectProperties (ekte StreamBIM-format)", () => {
  test("lifts StreamBIM groups into Pset objects so findProperty can read them", () => {
    const props = objectProperties(realInfo);
    assert.deepEqual(findProperty(props, FIELDS.postnr), {
      key: "KS_Armering~Posisjonsnummer",
      name: "Posisjonsnummer",
      value: "31",
    });
    assert.equal(findProperty(props, FIELDS.diameter).value, "12");
    assert.equal(findProperty(props, FIELDS.lengde).value, "12385");
    assert.equal(findProperty(props, FIELDS.antall).value, "1");
  });

  test("keeps top-level attributes like @kind and Name", () => {
    const props = objectProperties(realInfo);
    assert.equal(props["@kind"], "Reinforcing bar");
    assert.equal(props.Name, "Rebar Bar:K500C-T Ø12:443220");
  });

  test("returns plain properties unchanged when there are no groups", () => {
    assert.deepEqual(objectProperties({ properties: { Posisjonsnummer: ["5"] } }), { Posisjonsnummer: ["5"] });
  });

  test("tolerates missing info, null groups and groups without content", () => {
    assert.deepEqual(objectProperties(null), {});
    assert.deepEqual(objectProperties({ properties: { a: 1 }, groups: null }), { a: 1 });
    assert.deepEqual(objectProperties({ groups: [{ label: "X" }, { content: { properties: [{ key: "k", value: "v" }] } }] }), {});
  });
});

test.describe("findProperty with regular-expression candidates", () => {
  const props = { MERKNADER: { "K200 Pos nr": "A1", "K205 Armeringstekst": "tekst" } };

  test("matches the bare property name, never the pset name", () => {
    assert.equal(findProperty(props, [/^K\d+\s+Pos\.?\s*nr\b/i]).value, "A1");
    assert.equal(findProperty(props, [/MERKNADER/]), undefined);
  });

  test("keeps candidate order: an exact string before it wins over the regex", () => {
    const both = { A: { "K200 Pos nr": "regex", Posisjonsnummer: "streng" } };
    assert.equal(findProperty(both, ["Posisjonsnummer", /^K\d+\s+Pos/i]).value, "streng");
    assert.equal(findProperty(both, [/^K\d+\s+Pos/i, "Posisjonsnummer"]).value, "regex");
  });

  test("returns the matched key and bare name so the search rule can use them", () => {
    assert.deepEqual(findProperty(props, [/^K\d+\s+Pos/i]), { key: "MERKNADER~K200 Pos nr", name: "K200 Pos nr", value: "A1" });
  });

  test("skips empty values like string candidates do", () => {
    assert.equal(findProperty({ P: { "K200 Pos nr": "" } }, [/^K200/]), undefined);
  });

  test("regexes are not confused by the global flag's lastIndex", () => {
    const re = /^K\d+\s+Pos/g;
    assert.equal(findProperty(props, [re]).value, "A1");
    assert.equal(findProperty(props, [re]).value, "A1");
  });
});

test.describe("K-coded property names (pset MERKNADER)", () => {
  const kcoded = require("./fixtures/object-info-kcoded.json");

  test("finds postnr, diameter, length, form code and count", () => {
    const props = objectProperties(kcoded);
    // Ekte nøkkel har punktum bak: "K200 Pos nr." (sett i rådata fra StreamBIM)
    assert.equal(findProperty(props, FIELDS.postnr).name, "K200 Pos nr.");
    assert.equal(findProperty(props, FIELDS.postnr).value, "Fx0001.01");
    assert.equal(findProperty(props, FIELDS.diameter).value, "25");
    assert.equal(findProperty(props, FIELDS.lengde).value, "5045");
    assert.equal(findProperty(props, FIELDS.formkode).value, "NB99-01");
    assert.equal(findProperty(props, FIELDS.antall).value, "1");
  });

  test("does not mistake other K-coded properties for the columns", () => {
    const props = objectProperties(kcoded);
    for (const field of ["postnr", "diameter", "lengde", "formkode", "antall"]) {
      const hit = findProperty(props, FIELDS[field]);
      assert.ok(
        !/Armeringstekst|Delmål|Senteravstand|Vekt|ElementID|Dordiameter|Plassering|Material|Vinkel|MMI/.test(hit.name),
        `${field} -> ${hit.name}`
      );
    }
  });

  test("groups the bars by the K-coded postnr", () => {
    const { rows, missingPostnr } = groupRebar([{ guid: "g1", properties: objectProperties(kcoded), building: kcoded.building }]);
    assert.equal(missingPostnr, 0);
    assert.equal(rows[0].postnr, "Fx0001.01");
    assert.equal(rows[0].diameter, "25");
    assert.equal(rows[0].lengde, "5045");
    assert.equal(rows[0].count, 1);
    assert.equal(rows[0].missing3d, 0);
  });

  test("sums the K-coded Antall like the Revit one", () => {
    const withFour = objectProperties({
      ...kcoded,
      groups: [{ label: "MERKNADER", content: { properties: [{ key: "K200 Pos nr", value: "B" }, { key: "K202 Antall", value: "4" }] } }],
    });
    assert.equal(groupRebar([{ guid: "a", properties: withFour }]).rows[0].count, 4);
  });

  test("an object without any postnr-like property is still reported as missing", () => {
    const none = objectProperties({ properties: { "@kind": "Reinforcing bar" }, groups: [{ label: "MERKNADER", content: { properties: [{ key: "K001 ElementID", value: "X" }] } }] });
    assert.equal(groupRebar([{ guid: "a", properties: none }]).missingPostnr, 1);
  });
});

test.describe("isRebarObject", () => {
  test("accepts StreamBIM's readable @kind values and IFC class names", () => {
    for (const kind of ["Reinforcing bar", "Reinforcing mesh", "IfcReinforcingBar", "ReinforcingMesh"]) {
      assert.equal(isRebarObject({ "@kind": kind }), true, kind);
    }
  });

  test("rejects other kinds", () => {
    assert.equal(isRebarObject({ "@kind": "Wall" }), false);
    assert.equal(isRebarObject({ "@kind": "Slab" }), false);
  });

  test("keeps objects without @kind, since the search found them as rebar", () => {
    assert.equal(isRebarObject({ Posisjonsnummer: "5" }), true);
    assert.equal(isRebarObject(undefined), true);
  });
});

test.describe("groupRebar with real StreamBIM data", () => {
  test("reads every column from groups and remembers the building for search", () => {
    const { rows } = groupRebar([{ guid: "g", properties: objectProperties(realInfo), building: realInfo.building }]);
    assert.deepEqual(
      { ...rows[0] },
      {
        postnr: "31",
        building: "1000",
        diameter: "12",
        lengde: "12385",
        formkode: "00",
        segment: undefined,
        count: 1,
        missing3d: 0,
        guids: ["g"],
        objects: 1,
      }
    );
  });
});

test.describe("hasGeometry", () => {
  test("is true when StreamBIM's Geometry group has faces", () => {
    assert.equal(hasGeometry({ Geometry: { "Faces Hi": "80", "Faces Lo": "20" } }), true);
    assert.equal(hasGeometry({ Geometry: { "Faces Hi": "0", "Faces Lo": "12" } }), true);
  });

  test("is false when every face count is zero", () => {
    assert.equal(hasGeometry({ Geometry: { "Faces Hi": "0", "Faces Lo": "0" } }), false);
  });

  test("is null (unknown) without a Geometry group or face counts", () => {
    assert.equal(hasGeometry({ KS_Armering: { Posisjonsnummer: "5" } }), null);
    assert.equal(hasGeometry({ Geometry: { "Node List": "[0]" } }), null);
    assert.equal(hasGeometry(undefined), null);
  });
});

test.describe("groupRebar counts objects without 3D", () => {
  test("counts objects whose geometry is missing, but not unknown ones", () => {
    const { rows, missing3d } = groupRebar([
      { guid: "a", properties: { Posisjonsnummer: "1", Geometry: { "Faces Hi": "80" } } },
      { guid: "b", properties: { Posisjonsnummer: "1", Geometry: { "Faces Hi": "0", "Faces Lo": "0" } } },
      { guid: "c", properties: { Posisjonsnummer: "2" } },
    ]);
    assert.equal(rows.find((r) => r.postnr === "1").missing3d, 1);
    assert.equal(rows.find((r) => r.postnr === "2").missing3d, 0);
    assert.equal(missing3d, 1);
  });
});

test.describe("guidSearchRule", () => {
  test("matches the rule StreamBIM builds itself for colorCodeObjects (@guid in a|b)", () => {
    assert.deepEqual(guidSearchRule(["a", "b"], "1000"), {
      buildingId: "1000",
      propKey: "@guid",
      operator: "in",
      propValue: "a|b",
    });
  });

  test("leaves out buildingId when it is unknown", () => {
    assert.deepEqual(guidSearchRule(["a", "b"], null), { propKey: "@guid", operator: "in", propValue: "a|b" });
  });

  test("uses plain equality for ONE object: StreamBIM's «in» finds nothing for a single value", () => {
    // Live (2026-10-23): «@guid in <ett guid>» ga «fant 0/1 objekter» for hver enkeltobjekt-gruppe,
    // mens «in» med 2+ guid ga N/N. Vanlig likhet er formen StreamBIM selv bruker for rom.
    assert.deepEqual(guidSearchRule(["a"], "1000"), { buildingId: "1000", propKey: "@guid", propValue: "a" });
    assert.deepEqual(guidSearchRule(["a"], null), { propKey: "@guid", propValue: "a" });
    assert.equal("operator" in guidSearchRule(["a"], "1000"), false);
  });
});

test.describe("rebarCandidates", () => {
  // Live (2026-10-23): findObjects ga «Reinforcing bar» = 2125 av 3624 objekter, mens verdier
  // som ikke finnes i modellen («Reinforcing mesh») ga ALLE 3624.
  const everything = ["bar1", "bar2", "wall", "slab"];

  test("searches StreamBIM's readable @kind values, and the unknown value is not one of them", () => {
    assert.deepEqual(REBAR_KINDS, ["Reinforcing bar", "Reinforcing mesh"]);
    assert.ok(!REBAR_KINDS.includes(UNKNOWN_KIND));
  });

  test("skips a search that returned the same as an unknown value (it did not filter)", () => {
    assert.deepEqual(rebarCandidates({ bar: ["bar1", "bar2"], mesh: everything }, everything), {
      guids: ["bar1", "bar2"],
      kinds: ["bar"],
    });
  });

  test("joins every search that filtered, without duplicates", () => {
    assert.deepEqual(rebarCandidates({ bar: ["bar1", "bar2"], mesh: ["bar2", "mesh1"] }, everything), {
      guids: ["bar1", "bar2", "mesh1"],
      kinds: ["bar", "mesh"],
    });
  });

  test("falls back to everything, with no filtering kind, when no search filtered", () => {
    assert.deepEqual(rebarCandidates({ bar: everything, mesh: everything }, everything), { guids: everything, kinds: [] });
  });

  test("compares content, not size, so a result cut at the limit still counts as filtered", () => {
    assert.deepEqual(rebarCandidates({ bar: ["bar1", "bar2"] }, ["wall", "slab"]).guids, ["bar1", "bar2"]);
  });

  test("ignores failed searches (null) and keeps everything a failed probe leaves", () => {
    assert.deepEqual(rebarCandidates({ bar: null, mesh: ["bar1"] }, everything), { guids: ["bar1"], kinds: ["mesh"] });
    assert.deepEqual(rebarCandidates({ bar: ["bar1"], mesh: everything }, null).guids, ["bar1", "bar2", "wall", "slab"]);
    assert.deepEqual(rebarCandidates({ bar: null, mesh: null }, null), { guids: [], kinds: [] });
  });

  test("returns nothing when every search came back empty", () => {
    assert.deepEqual(rebarCandidates({ bar: [], mesh: [] }, []), { guids: [], kinds: [] });
  });
});

test.describe("sameGuidSet", () => {
  test("is true for the same guids in any order", () => {
    assert.equal(sameGuidSet(["a", "b"], ["b", "a"]), true);
    assert.equal(sameGuidSet([], []), true);
  });

  test("is false when one list has more, fewer or other guids", () => {
    assert.equal(sameGuidSet(["a"], ["a", "b"]), false);
    assert.equal(sameGuidSet(["a", "c"], ["a", "b"]), false);
  });
});

test.describe("filterRows (søkefeltet)", () => {
  const rows = [{ postnr: "Fd1500" }, { postnr: "fd1501" }, { postnr: "31" }, { postnr: MISSING_POSTNR }];

  test("keeps rows whose postnr contains the text, ignoring case and surrounding spaces", () => {
    assert.deepEqual(filterRows(rows, " FD15 ").map((r) => r.postnr), ["Fd1500", "fd1501"]);
    assert.deepEqual(filterRows(rows, "3").map((r) => r.postnr), ["31"]);
  });

  test("returns every row for an empty search", () => {
    assert.equal(filterRows(rows, "").length, 4);
    assert.equal(filterRows(rows, "   ").length, 4);
    assert.equal(filterRows(rows, undefined).length, 4);
  });

  test("returns an empty list when nothing matches, and never changes the input", () => {
    assert.deepEqual(filterRows(rows, "xyz"), []);
    assert.equal(rows.length, 4);
  });
});

test.describe("exportItems (svaret fra getObjectInfoForSearch)", () => {
  // Formatet fra StreamBIM sin søkeeksport (/ifc-searches/export/json), slik StreamBIM selv
  // leser det: header med feltnavn og én rad per objekt, med "Pset~Egenskap"-nøkler.
  const response = {
    header: [{ id: "GUID" }, { id: "Name" }, { id: "KS_Armering~Posisjonsnummer", pset: "KS_Armering", datatype: "str" }],
    data: [
      { GUID: "g1", Name: "Stang", "KS_Armering~Posisjonsnummer": "31", "KS_Armering~Antall": "4", "Geometry~Faces Hi": "80" },
      { GUID: "g2", "MERKNADER~K200 Pos nr.": "Fd1000" },
      { Name: "uten GUID" },
    ],
  };

  test("turns each row into {guid, properties} with psets as nested objects", () => {
    const [first] = exportItems(response);
    assert.equal(first.guid, "g1");
    assert.deepEqual(first.properties, {
      GUID: "g1",
      Name: "Stang",
      KS_Armering: { Posisjonsnummer: "31", Antall: "4" },
      Geometry: { "Faces Hi": "80" },
    });
  });

  test("lets findProperty, groupRebar and hasGeometry read the rows like getObjectInfo", () => {
    const items = exportItems(response);
    const { rows } = groupRebar(items);
    assert.deepEqual(rows.map((r) => [r.postnr, r.count]), [["31", 4], ["Fd1000", 1]]);
    assert.equal(hasGeometry(items[0].properties), true);
  });

  test("skips rows without a GUID and tolerates a missing or odd response", () => {
    assert.deepEqual(exportItems(response).map((i) => i.guid), ["g1", "g2"]);
    assert.deepEqual(exportItems(null), []);
    assert.deepEqual(exportItems({ data: "x" }), []);
    assert.deepEqual(exportItems([]), []);
  });
});

test.describe("exportSamples", () => {
  const item = (guid, properties) => ({ guid, properties });

  test("takes one object per postnr naming scheme, so every model in the building is checked", () => {
    const items = [
      item("a", { KS_Armering: { Posisjonsnummer: "1" } }),
      item("b", { KS_Armering: { Posisjonsnummer: "2" } }),
      item("c", { MERKNADER: { "K200 Pos nr.": "Fd1" } }),
      item("d", { Name: "uten postnr" }),
    ];
    const guids = exportSamples(items).map((s) => s.guid);
    for (const guid of ["a", "c", "d"]) assert.ok(guids.includes(guid), guid);
  });

  test("adds the middle and last object, never the same twice, and stays small", () => {
    const items = Array.from({ length: 9 }, (_, i) => item(`g${i}`, { KS_Armering: { Posisjonsnummer: "1" } }));
    assert.deepEqual(exportSamples(items).map((s) => s.guid), ["g0", "g4", "g8"]);
    assert.equal(exportSamples([]).length, 0);
  });
});

test.describe("exportGaps (stikkprøve mot getObjectInfo)", () => {
  const info = objectProperties(realInfo); // KS_Armering: postnr 31, diameter 12, lengde 12385, formkode 00, antall 1

  test("is empty when the export has the same column values", () => {
    const row = { KS_Armering: { Posisjonsnummer: "31", Diameter: 12, Armeringslengde: "12385", Formkode: "00", Antall: "1" } };
    assert.deepEqual(exportGaps(row, info), []);
  });

  test("names columns the export lacks or has a different value for", () => {
    const row = { KS_Armering: { Posisjonsnummer: "31", Diameter: "16" } };
    assert.deepEqual(exportGaps(row, info), ["diameter", "lengde", "formkode", "antall"]);
  });

  test("treats equal numbers in different notation as the same value", () => {
    const row = { KS_Armering: { Posisjonsnummer: "31", Diameter: "12.0", Armeringslengde: 12385, Formkode: "00", Antall: 1 } };
    assert.deepEqual(exportGaps(row, info), []);
  });

  test("reports missing 3D information when getObjectInfo has it and the export does not", () => {
    const withGeometry = { ...info, Geometry: { "Faces Hi": "80", "Faces Lo": "20" } };
    const row = { KS_Armering: { Posisjonsnummer: "31", Diameter: "12", Armeringslengde: "12385", Formkode: "00", Antall: "1" } };
    assert.deepEqual(exportGaps(row, withGeometry), ["3D-geometri"]);
  });
});

test.describe("flattenProperties", () => {
  test("returns empty list for missing or non-object input", () => {
    assert.deepEqual(flattenProperties(undefined), []);
    assert.deepEqual(flattenProperties(null), []);
    assert.deepEqual(flattenProperties("tekst"), []);
  });

  test("normalizes array values to their first element", () => {
    const entries = flattenProperties({ "System Global Id": ["abc", "def"] });
    assert.deepEqual(entries, [{ key: "System Global Id", name: "System Global Id", value: "abc" }]);
  });

  test("splits Pset~Egenskap keys into key and bare name", () => {
    const [entry] = flattenProperties({ "ARM~ARM.07 - Posnr": "12" });
    assert.equal(entry.key, "ARM~ARM.07 - Posnr");
    assert.equal(entry.name, "ARM.07 - Posnr");
  });

  test("flattens nested pset objects with ~ separated keys", () => {
    const entries = flattenProperties({ "Tekla Reinforcement": { Posisjonsnummer: "101", Formkode: "00" } });
    assert.deepEqual(entries, [
      { key: "Tekla Reinforcement~Posisjonsnummer", name: "Posisjonsnummer", value: "101" },
      { key: "Tekla Reinforcement~Formkode", name: "Formkode", value: "00" },
    ]);
  });
});

test.describe("findProperty", () => {
  test("finds a flat property by exact name", () => {
    const hit = findProperty({ Posisjonsnummer: "101" }, ["Posisjonsnummer"]);
    assert.deepEqual(hit, { key: "Posisjonsnummer", name: "Posisjonsnummer", value: "101" });
  });

  test("accepts a single name instead of a list", () => {
    assert.equal(findProperty({ Segment: "S1" }, "Segment").value, "S1");
  });

  test("candidate order wins over property order in the object", () => {
    const props = { "ARM.07 - Posnr": "rib", Posisjonsnummer: "tekla" };
    assert.equal(findProperty(props, ["Posisjonsnummer", "ARM.07 - Posnr"]).value, "tekla");
  });

  test("matches the bare name inside Pset~Egenskap keys", () => {
    const hit = findProperty({ "Pset_ARM~ARM.07 - Posnr": "201" }, ["Posisjonsnummer", "ARM.07 - Posnr"]);
    assert.equal(hit.value, "201");
    assert.equal(hit.name, "ARM.07 - Posnr");
  });

  test("falls back to case-insensitive match after all exact candidates", () => {
    const props = { "diameter jern": "12" };
    assert.equal(findProperty(props, ["Diameter jern"]).value, "12");
  });

  test("an exact match on a later candidate beats a case-insensitive match on an earlier one", () => {
    const props = { posisjonsnummer: "lower", "ARM.07 - Posnr": "exact" };
    assert.equal(findProperty(props, ["Posisjonsnummer", "ARM.07 - Posnr"]).value, "exact");
  });

  test("skips empty values and tries the next candidate", () => {
    const props = { Posisjonsnummer: "", "ARM.07 - Posnr": "7" };
    assert.equal(findProperty(props, ["Posisjonsnummer", "ARM.07 - Posnr"]).value, "7");
  });

  test("keeps numeric zero as a real value", () => {
    assert.equal(findProperty({ Segment: 0 }, "Segment").value, 0);
  });

  test("returns undefined when nothing matches", () => {
    assert.equal(findProperty({ Name: "Vegg" }, ["Posisjonsnummer"]), undefined);
    assert.equal(findProperty(undefined, ["Posisjonsnummer"]), undefined);
  });
});

test.describe("groupRebar", () => {
  const items = [
    { guid: "g1", properties: { Posisjonsnummer: ["101"], "Diameter jern": ["12"], Armeringslengde: ["2450"], Formkode: ["00"], Segment: ["S1"] } },
    { guid: "g2", properties: { Posisjonsnummer: ["101"], "Diameter jern": ["12"] } },
    { guid: "g3", properties: { "ARM~ARM.07 - Posnr": "201", "ARM~ARM.08 - Stangdiameter": "20", "ARM~ARM.80 - Kapplengde": 2647.115, "ARM~ARM.37 - Formkode": "26" } },
    { guid: "g4", properties: { Name: "Uten postnr" } },
  ];

  test("groups Tekla and RIB bars by postnr with counts and guids", () => {
    const { rows } = groupRebar(items);
    const byPostnr = Object.fromEntries(rows.map((r) => [r.postnr, r]));
    assert.deepEqual(byPostnr["101"].guids, ["g1", "g2"]);
    assert.equal(byPostnr["101"].count, 2);
    assert.equal(byPostnr["201"].count, 1);
    assert.equal(byPostnr["201"].diameter, "20");
    assert.equal(byPostnr["201"].lengde, 2647.115);
    assert.equal(byPostnr["201"].formkode, "26");
  });

  test("takes column values from the first bar in the group", () => {
    const { rows } = groupRebar(items);
    const row = rows.find((r) => r.postnr === "101");
    assert.equal(row.lengde, "2450");
    assert.equal(row.segment, "S1");
  });

  test("collects bars without postnr in their own group and counts them", () => {
    const { rows, missingPostnr } = groupRebar(items);
    const missing = rows.find((r) => r.postnr === MISSING_POSTNR);
    assert.deepEqual(missing.guids, ["g4"]);
    assert.equal(missingPostnr, 1);
  });

  test("stringifies numeric postnr so 12 and '12' land in the same group", () => {
    const { rows } = groupRebar([
      { guid: "a", properties: { Posisjonsnummer: 12 } },
      { guid: "b", properties: { Posisjonsnummer: "12" } },
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].count, 2);
  });

  test("returns no rows for an empty input", () => {
    assert.deepEqual(groupRebar([]), { rows: [], missingPostnr: 0, missing3d: 0 });
  });

  test("counts bars from Antall when one IFC object is a whole bar set", () => {
    const { rows } = groupRebar([
      { guid: "set1", properties: { "KS_Armering~Posisjonsnummer": "5", "KS_Armering~Antall": 38 } },
      { guid: "set2", properties: { "KS_Armering~Posisjonsnummer": "5", "KS_Armering~Antall": "12" } },
    ]);
    assert.equal(rows[0].count, 50);
    assert.equal(rows[0].objects, 2);
    assert.deepEqual(rows[0].guids, ["set1", "set2"]);
  });

  test("counts one bar per object when Antall is missing or not a positive number", () => {
    const { rows } = groupRebar([
      { guid: "a", properties: { Posisjonsnummer: "7" } },
      { guid: "b", properties: { Posisjonsnummer: "7", Antall: "ukjent" } },
      { guid: "c", properties: { Posisjonsnummer: "7", Antall: 0 } },
    ]);
    assert.equal(rows[0].count, 3);
    assert.equal(rows[0].objects, 3);
  });

  test("recognizes a plain Diameter property (Revit export)", () => {
    const { rows } = groupRebar([{ guid: "a", properties: { "KS_Armering~Posisjonsnummer": "5", "KS_Armering~Diameter": 10 } }]);
    assert.equal(rows[0].diameter, 10);
  });
});

test.describe("sortRows", () => {
  const rows = [{ postnr: "10" }, { postnr: "9" }, { postnr: "B2" }, { postnr: "a1" }, { postnr: undefined }];

  test("sorts numbers numerically and text alphabetically, ascending", () => {
    assert.deepEqual(sortRows(rows, "postnr", 1).map((r) => r.postnr), ["9", "10", "a1", "B2", undefined]);
  });

  test("reverses order for descending", () => {
    assert.deepEqual(sortRows(rows, "postnr", -1).map((r) => r.postnr), [undefined, "B2", "a1", "10", "9"]);
  });

  test("does not mutate the input list", () => {
    const before = rows.map((r) => r.postnr);
    sortRows(rows, "postnr", 1);
    assert.deepEqual(rows.map((r) => r.postnr), before);
  });

  test("always keeps the missing-postnr group last, in both directions", () => {
    const withMissing = [{ postnr: MISSING_POSTNR, count: 99 }, { postnr: "5", count: 1 }, { postnr: "A", count: 2 }];
    assert.deepEqual(sortRows(withMissing, "postnr", 1).map((r) => r.postnr), ["5", "A", MISSING_POSTNR]);
    assert.deepEqual(sortRows(withMissing, "postnr", -1).map((r) => r.postnr), ["A", "5", MISSING_POSTNR]);
    assert.deepEqual(sortRows(withMissing, "count", -1).map((r) => r.postnr), ["A", "5", MISSING_POSTNR]);
  });

  test("breaks numeric ties with text comparison", () => {
    const tied = [{ postnr: "12b" }, { postnr: "12a" }];
    assert.deepEqual(sortRows(tied, "postnr", 1).map((r) => r.postnr), ["12a", "12b"]);
  });
});

test.describe("formatLengde", () => {
  test("rounds to whole millimetres", () => {
    assert.equal(formatLengde(2647.1150383789704), "2647");
    assert.equal(formatLengde("2450.6"), "2451");
  });

  test("returns empty text for missing values", () => {
    assert.equal(formatLengde(undefined), "");
    assert.equal(formatLengde(null), "");
    assert.equal(formatLengde(""), "");
  });

  test("passes non-numeric values through as text", () => {
    assert.equal(formatLengde("ca. 2 m"), "ca. 2 m");
  });
});

test.describe("moveToTop", () => {
  const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];

  test("moves the matching row first and keeps the rest in order", () => {
    const result = moveToTop(rows, (r) => r.id === 3);
    assert.deepEqual(result.rows.map((r) => r.id), [3, 1, 2]);
    assert.equal(result.row.id, 3);
  });

  test("returns null when nothing matches", () => {
    assert.equal(moveToTop(rows, (r) => r.id === 99), null);
  });

  test("does not mutate the input list", () => {
    moveToTop(rows, (r) => r.id === 2);
    assert.deepEqual(rows.map((r) => r.id), [1, 2, 3]);
  });
});

test.describe("mapWithConcurrency", () => {
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  test("keeps result order even when calls finish out of order", async () => {
    const result = await mapWithConcurrency([30, 5, 15], 3, async (ms) => {
      await delay(ms);
      return ms * 2;
    });
    assert.deepEqual(result, [60, 10, 30]);
  });

  test("never runs more than the limit at once", async () => {
    let running = 0;
    let maxRunning = 0;
    await mapWithConcurrency(Array.from({ length: 12 }, (_, i) => i), 4, async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await delay(2);
      running--;
    });
    assert.equal(maxRunning, 4);
  });

  test("reports progress after each finished item", async () => {
    const progress = [];
    await mapWithConcurrency(["a", "b", "c"], 2, async (x) => x, (done, total) => progress.push(`${done}/${total}`));
    assert.deepEqual(progress, ["1/3", "2/3", "3/3"]);
  });

  test("handles an empty list", async () => {
    assert.deepEqual(await mapWithConcurrency([], 10, async () => 1), []);
  });
});
