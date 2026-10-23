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
  groupSearchQueries,
  isUsableGroupSearch,
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
  test("reads every column from groups and remembers pset and building for search", () => {
    const { rows } = groupRebar([{ guid: "g", properties: objectProperties(realInfo), building: realInfo.building }]);
    assert.deepEqual(
      { ...rows[0] },
      {
        postnr: "31",
        searchKey: "Posisjonsnummer",
        searchPset: "KS_Armering",
        building: "1000",
        diameter: "12",
        lengde: "12385",
        formkode: "00",
        segment: undefined,
        count: 1,
        guids: ["g"],
        objects: 1,
      }
    );
  });
});

test.describe("groupSearchQueries", () => {
  test("tries a pset rule first, then plain key/value", () => {
    const row = { postnr: "31", searchKey: "Posisjonsnummer", searchPset: "KS_Armering", building: "1000" };
    const queries = groupSearchQueries(row, 500);
    assert.deepEqual(
      queries.map((q) => q.query),
      [
        {
          filter: { rules: [[{ buildingId: "1000", psetName: "KS_Armering", propKey: "Posisjonsnummer", propValue: "31" }]] },
          page: { limit: 500, skip: 0 },
        },
        { key: "Posisjonsnummer", value: "31", limit: 500 },
      ]
    );
  });

  test("leaves out buildingId and the pset rule when they are unknown", () => {
    assert.deepEqual(
      groupSearchQueries({ postnr: "7", searchKey: "Posisjonsnummer", searchPset: null, building: undefined }, 10).map((q) => q.query),
      [{ key: "Posisjonsnummer", value: "7", limit: 10 }]
    );
    const [rule] = groupSearchQueries({ postnr: "7", searchKey: "P", searchPset: "S", building: undefined }, 10);
    assert.deepEqual(rule.query.filter.rules, [[{ psetName: "S", propKey: "P", propValue: "7" }]]);
  });

  test("returns nothing for the missing-postnr group", () => {
    assert.deepEqual(groupSearchQueries({ postnr: MISSING_POSTNR, searchKey: null }, 10), []);
  });
});

test.describe("isUsableGroupSearch", () => {
  const row = { guids: ["a", "b"], objects: 2 };

  test("accepts hits that contain the group", () => {
    assert.equal(isUsableGroupSearch(["a", "b", "x"], row, 255), true);
  });

  test("rejects empty hits and hits that miss the group", () => {
    assert.equal(isUsableGroupSearch([], row, 255), false);
    assert.equal(isUsableGroupSearch(undefined, row, 255), false);
    assert.equal(isUsableGroupSearch(["x", "y"], row, 255), false);
  });

  test("rejects a search that returned everything for a smaller group (filter ignored)", () => {
    const everything = Array.from({ length: 255 }, (_, i) => (i === 0 ? "a" : `o${i}`));
    assert.equal(isUsableGroupSearch(everything, row, 255), false);
  });

  test("accepts everything when the group really is everything", () => {
    assert.equal(isUsableGroupSearch(["a", "b"], { guids: ["a", "b"], objects: 2 }, 2), true);
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

  test("records the bare property name used for postnr as search key", () => {
    const { rows } = groupRebar(items);
    assert.equal(rows.find((r) => r.postnr === "101").searchKey, "Posisjonsnummer");
    assert.equal(rows.find((r) => r.postnr === "201").searchKey, "ARM.07 - Posnr");
  });

  test("collects bars without postnr in their own group and counts them", () => {
    const { rows, missingPostnr } = groupRebar(items);
    const missing = rows.find((r) => r.postnr === MISSING_POSTNR);
    assert.deepEqual(missing.guids, ["g4"]);
    assert.equal(missing.searchKey, null);
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
    assert.deepEqual(groupRebar([]), { rows: [], missingPostnr: 0 });
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
