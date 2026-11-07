// Bygger data.json fra ChordPro-filene i sanger/ + extra-songs.json (lenkesanger) + sets.json.
// Kjøres som build-steg: node build-data.mjs
// Valgfritt: node build-data.mjs --compare data.old.json  (viser sanger som ville blitt duplikater i arkivet)
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const DIR = "sanger";
const CP_EXT = /\.(txt|cho|chopro|chordpro|crd|pro)$/i;   // samme som arkivet
const read = (f, fallback) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : fallback);
const norm = (s) => (s || "").normalize("NFC").trim().toLowerCase();
const key = (s) => norm(s.title) + "||" + norm(s.artist);   // samme nøkkel som arkivet bruker ved sammenslåing

// ── Les mappen (maks 2 undernivåer, hopp over filer/mapper som starter med . eller _) ──
function listFiles(dir, depth = 0) {
  if (!existsSync(dir)) return [];
  let out = [];
  for (const name of readdirSync(dir)) {
    if (/^[._]/.test(name)) continue;
    const p = `${dir}/${name}`;
    if (statSync(p).isDirectory()) { if (depth < 2) out = out.concat(listFiles(p, depth + 1)); }
    else if (CP_EXT.test(name)) out.push(p.normalize("NFC"));
  }
  return out;
}

// ── Metadata: arkivet bruker bare {title} og {artist}. {comment} leses kun fra toppen av filen,
//    siden konverteren også bruker {comment: Vers 1} o.l. som seksjonsoverskrifter i selve teksten. ──
const ALIAS = { t: "title", st: "subtitle", su: "subtitle", c: "comment", ci: "comment" };
function readMeta(text) {
  const meta = { title: "", artist: "", comments: [] };
  for (const raw of text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#")) continue;
    const m = line.match(/^\{\s*([^:}\s]+)\s*(?::\s*|\s+)?(.*?)\s*\}$/);
    if (!m) { if (line === "") { if (meta.title || meta.artist || meta.comments.length) break; else continue; } break; }
    const name = ALIAS[m[1].toLowerCase()] || m[1].toLowerCase();
    if (name === "title") meta.title = m[2];
    else if (name === "artist") meta.artist = m[2];
    else if (name === "comment" && m[2]) meta.comments.push(m[2]);
  }
  return meta;
}
const filenameTitle = (p) => p.split("/").pop().replace(/\.[^.]+$/, "").replace(/_/g, " ").replace(/\s+[A-H][#b]?m?$/, "").trim();

// ── id: stabil, utledet fra filstien (arkivet lager egne lokale id-er; denne brukes bare til å koble sett) ──
const fileId = (p) => "f" + createHash("sha1").update(p).digest("hex").slice(0, 12);

// ── added: 1) added.json  2) tidspunkt for første commit (hvis full git-historikk)  3) 0 ──
//    0 betyr at arkivet setter «nå» første gang sangen dukker opp i en nettleser.
const addedLedger = read("added.json", {});
let gitFull = false;
try { gitFull = execFileSync("git", ["rev-parse", "--is-shallow-repository"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() === "false"; } catch {}
function addedFor(p) {
  if (addedLedger[p]) return addedLedger[p];
  if (gitFull) {
    try {
      const out = execFileSync("git", ["log", "--diff-filter=A", "--format=%at", "--", p], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim().split("\n").filter(Boolean);
      if (out.length) return Number(out[out.length - 1]) * 1000;
    } catch {}
  }
  return 0;
}

// ── Filsanger ──
const fileSongs = listFiles(DIR)
  .sort((a, b) => a.localeCompare(b, "nb"))
  .map((p) => {
    const meta = readMeta(readFileSync(p, "utf8"));
    return {
      id: fileId(p),
      title: (meta.title || filenameTitle(p)).trim(),
      artist: (meta.artist || "").trim(),
      url: "",
      comment: meta.comments.join("; "),
      file: p,
      added: addedFor(p),
    };
  });

// ── Lenkesanger som ikke er konvertert ennå. Hoppes over hvis en filsang har samme tittel,
//    eller samme artist og den ene tittelen inneholder den andre («Blå ballong» / «Jeg Vil Ha En Blå Ballong»). ──
const covers = (a, b) => a && b && (a === b || a.includes(b) || b.includes(a));
const fileKeys = fileSongs.map((s) => ({ t: norm(s.title), a: norm(s.artist), s }));
const extra = [];
for (const e of read("extra-songs.json", [])) {
  const t = norm(e.title), a = norm(e.artist);
  const hit = fileKeys.find((f) => f.t === t || (a && f.a === a && covers(f.t, t)));
  if (hit) { console.log(`Hopper over lenkesang «${e.title}» – finnes som fil: ${hit.s.file}`); continue; }
  extra.push({ ...e, comment: e.comment ?? "", file: undefined });
}

// ── Duplikatvarsel (to oppføringer med samme tittel+artist) ──
const all = [...fileSongs, ...extra];
const seen = new Map();
for (const s of all) {
  const k = key(s);
  if (seen.has(k)) console.warn(`ADVARSEL: «${s.title}» (${s.artist || "ingen artist"}) finnes to ganger: ${seen.get(k)} og ${s.file || s.url}`);
  else seen.set(k, s.file || s.url);
}

// ── Sett: sets.json er [{ "name": "Konsert", "songs": ["sanger/Jenter_G.txt", "Tomanas vise"] }]. Sanger oppgis med filsti eller tittel. ──
const sets = read("sets.json", []).map((st) => ({
  id: "s" + createHash("sha1").update(st.name).digest("hex").slice(0, 12),
  name: st.name,
  songIds: (st.songs || []).flatMap((ref) => {
    const hit = all.find((s) => s.file === ref.normalize("NFC")) || all.find((s) => norm(s.title) === norm(ref));
    if (!hit) console.warn(`ADVARSEL: sett «${st.name}» refererer til «${ref}», som ikke finnes`);
    return hit ? [hit.id] : [];
  }),
}));

writeFileSync("data.json", JSON.stringify({ songs: all, sets }, null, 2) + "\n");
console.log(`${fileSongs.length} filsanger + ${extra.length} lenkesanger, ${sets.length} sett → data.json`);

// ── Sjekk mot gammel data.json: filsanger som får annen tittel/artist enn før blir duplikater i arkivet ──
const ci = process.argv.indexOf("--compare");
if (ci > 0) {
  const old = read(process.argv[ci + 1], { songs: [] }).songs;
  for (const o of old.filter((s) => s.file)) {
    const n = fileSongs.find((s) => s.file === o.file.normalize("NFC"));
    if (!n) console.warn(`SJEKK: filen ${o.file} (${o.title}) finnes ikke i sanger/`);
    else if (key(n) !== key(o)) console.warn(`SJEKK: ${o.file}: arkivet har «${o.title}» / «${o.artist}», filen gir «${n.title}» / «${n.artist}» → duplikat`);
  }
}
