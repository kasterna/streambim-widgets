/* Bygger StreamBIM-adressen for embedded-modus fra det brukeren limer inn: hele
 * prosjekt-URL-en fra adressefeltet, eller bare prosjekt-ID-en. Lastes som <script>
 * (window.StreamBimUrl) og som CommonJS-modul i testene. */
(function (root, factory) {
  const lib = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = lib;
  else root.StreamBimUrl = lib;
})(typeof self !== "undefined" ? self : this, function () {
  const DEFAULT_APP = "https://app.streambim.com/webapp/default/";

  function findProjectId(text) {
    const match = text.match(/[?&]projectId=([^&#]+)/i) || text.match(/\/projects?\/([^/?#&]+)/i);
    return match ? decodeURIComponent(match[1]) : null;
  }

  /** Returnerer `<app>#/viewer?projectId=...&embedded=true`. Andre viewer-parametre
   *  (f.eks. buildingId) beholdes når den innlimte adressen allerede er en viewer-URL.
   *  Kaster Error med norsk melding som kan vises rett til brukeren. */
  function buildEmbeddedUrl(input) {
    const text = String(input || "").trim();
    if (!text) throw new Error("Lim inn prosjekt-URL-en fra StreamBIM, eller prosjekt-ID-en.");

    if (!text.includes("://")) {
      if (!/^[\w-]+$/.test(text)) throw new Error("Det ser ikke ut som en prosjekt-ID eller en URL.");
      return `${DEFAULT_APP}#/viewer?projectId=${encodeURIComponent(text)}&embedded=true`;
    }

    let url;
    try {
      url = new URL(text);
    } catch {
      throw new Error("Det ser ikke ut som en gyldig URL.");
    }
    if (url.protocol !== "https:") throw new Error("StreamBIM-URL-en må starte med https://");

    const projectId = findProjectId(text);
    if (!projectId) {
      throw new Error("Fant ingen prosjekt-ID i URL-en. Åpne modellen i StreamBIM og kopier adressen derfra.");
    }

    const isViewer = url.hash.startsWith("#/viewer");
    const query = new URLSearchParams(isViewer ? url.hash.split("?")[1] || "" : "");
    query.set("projectId", projectId);
    query.set("embedded", "true");
    return `${url.origin}${url.pathname}#/viewer?${query.toString()}`;
  }

  return { DEFAULT_APP, findProjectId, buildEmbeddedUrl };
});
