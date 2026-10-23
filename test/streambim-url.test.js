const test = require("node:test");
const assert = require("node:assert/strict");
const { buildEmbeddedUrl, findProjectId, DEFAULT_APP } = require("../dev/streambim-url.js");

test.describe("findProjectId", () => {
  test("reads projectId from a query string", () => {
    assert.equal(findProjectId("https://app.streambim.com/webapp/default/#/viewer?projectId=1234&buildingId=1000"), "1234");
  });

  test("reads the id from a /projects/<id> path", () => {
    assert.equal(findProjectId("https://app.streambim.com/webapp/default/#/projects/abc-77/models"), "abc-77");
  });

  test("returns null when there is no id", () => {
    assert.equal(findProjectId("https://app.streambim.com/webapp/default/#/login"), null);
  });
});

test.describe("buildEmbeddedUrl", () => {
  test("builds the default app URL from a bare project id", () => {
    assert.equal(buildEmbeddedUrl(" 1234 "), `${DEFAULT_APP}#/viewer?projectId=1234&embedded=true`);
  });

  test("keeps host, path and viewer params from a pasted viewer URL", () => {
    const url = buildEmbeddedUrl("https://custom.streambim.no/webapp/firma/#/viewer?projectId=55&buildingId=1000");
    assert.equal(url, "https://custom.streambim.no/webapp/firma/#/viewer?projectId=55&buildingId=1000&embedded=true");
  });

  test("forces embedded=true even when the URL says otherwise", () => {
    const url = buildEmbeddedUrl("https://app.streambim.com/webapp/default/#/viewer?projectId=9&embedded=false");
    assert.equal(url, "https://app.streambim.com/webapp/default/#/viewer?projectId=9&embedded=true");
  });

  test("turns a non-viewer project URL into a viewer URL", () => {
    const url = buildEmbeddedUrl("https://app.streambim.com/webapp/default/#/projects/abc-77/models?tab=2");
    assert.equal(url, "https://app.streambim.com/webapp/default/#/viewer?projectId=abc-77&embedded=true");
  });

  test("rejects empty input", () => {
    assert.throws(() => buildEmbeddedUrl("  "), /Lim inn/);
  });

  test("rejects a bare id with odd characters", () => {
    assert.throws(() => buildEmbeddedUrl("12 34"), /prosjekt-ID/);
  });

  test("rejects plain http", () => {
    assert.throws(() => buildEmbeddedUrl("http://app.streambim.com/#/viewer?projectId=1"), /https/);
  });

  test("rejects a URL without a project id", () => {
    assert.throws(() => buildEmbeddedUrl("https://app.streambim.com/webapp/default/#/login"), /Fant ingen prosjekt-ID/);
  });

  test("rejects text that is not a URL", () => {
    assert.throws(() => buildEmbeddedUrl("https://"), /gyldig URL/);
  });
});
