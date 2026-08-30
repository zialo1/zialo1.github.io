// main.js - three.js Visualisierung des Rheins.
// Datenquellen und API-Rechte siehe sources.txt
// (FABDEM, Natural Earth, OpenStreetMap, BAFU/LINDAS, PEGELONLINE, three.js).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { fromArrayBuffer } from 'geotiff';

// Minimal YAML parser (fallback, used only if the js-yaml CDN import fails to
// expose a usable `load`). Handles the subset used by conf.yaml: block maps,
// block sequences, flow maps and scalars (int/float/bool/string).
function parseConfYaml(text) {
  const lines = [];
  for (const l of text.split('\n')) {
    const t = l.replace(/\t/g, '  ');
    const tr = t.trim();
    if (tr === '' || tr.startsWith('#')) continue;
    lines.push(t);
  }
  const indentOf = (s) => (s.match(/^ */) || [''])[0].length;
  const splitTop = (s, sep) => {
    const out = []; let depth = 0, inQ = null, cur = '';
    for (const c of s) {
      if (inQ) { cur += c; if (c === inQ) inQ = null; continue; }
      if (c === '"' || c === "'") { inQ = c; cur += c; continue; }
      if (c === '{' || c === '[') depth++;
      if (c === '}' || c === ']') depth--;
      if (c === sep && depth === 0) { out.push(cur); cur = ''; }
      else cur += c;
    }
    if (cur.trim() !== '') out.push(cur);
    return out;
  };
  const splitKV = (s) => {
    let i = 0, inQ = null;
    for (; i < s.length; i++) {
      const c = s[i];
      if (inQ) { if (c === inQ) inQ = null; }
      else if (c === '"' || c === "'") inQ = c;
      else if (c === ':' && (i + 1 === s.length || s[i + 1] === ' ')) break;
    }
    let k = s.slice(0, i).trim();
    if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'")))
      k = k.slice(1, -1);
    return [k, s.slice(i + 1).trim()];
  };
  const coerce = (v) => {
    if (v === '') return null;
    if (v.startsWith('{') && v.endsWith('}')) return parseFlowMap(v);
    if (v === 'true') return true;
    if (v === 'false') return false;
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      return v.slice(1, -1);
    if (/^-?\d+$/.test(v)) return parseInt(v, 10);
    if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
    return v;
  };
  const parseFlowMap = (s) => {
    s = s.slice(1, -1).trim();
    const obj = {};
    if (s === '') return obj;
    for (const p of splitTop(s, ',')) {
      const [k, v] = splitKV(p.trim());
      obj[k] = coerce(v);
    }
    return obj;
  };
  let pos = 0;
  function parseNode(indent) {
    const content = lines[pos].trim();
    return content.startsWith('-') ? parseSeq(indent) : parseMap(indent);
  }
  function parseMap(indent) {
    const obj = {};
    while (pos < lines.length) {
      const ind = indentOf(lines[pos]);
      if (ind < indent) break;
      if (ind > indent) { pos++; continue; }
      const [k, v] = splitKV(lines[pos].trim());
      if (v === '') {
        pos++;
        if (pos < lines.length && indentOf(lines[pos]) > indent)
          obj[k] = parseNode(indentOf(lines[pos]));
        else obj[k] = null;
      } else { obj[k] = coerce(v); pos++; }
    }
    return obj;
  }
  function parseSeq(indent) {
    const arr = [];
    while (pos < lines.length) {
      const ind = indentOf(lines[pos]);
      if (ind < indent) break;
      if (ind > indent) { pos++; continue; }
      const line = lines[pos].trim();
      if (!line.startsWith('-')) break;
      const item = line.slice(1).replace(/^ /, '');
      if (item === '') {
        pos++;
        if (pos < lines.length && indentOf(lines[pos]) > indent)
          arr.push(parseNode(indentOf(lines[pos])));
        else arr.push(null);
      } else if (item.startsWith('{') || item.startsWith('[')) {
        arr.push(coerce(item)); pos++;
      } else if (item.indexOf(':') !== -1 && !item.startsWith('"') && !item.startsWith("'")) {
        const node = {};
        const [k, v] = splitKV(item);
        if (v === '') { pos++; node[k] = parseNode(indentOf(lines[pos])); }
        else { node[k] = coerce(v); pos++; }
        const childIndent = indent + 2;
        while (pos < lines.length && indentOf(lines[pos]) === childIndent
               && !lines[pos].trim().startsWith('-')) {
          const [ck, cv] = splitKV(lines[pos].trim());
          if (cv === '') {
            pos++;
            if (pos < lines.length && indentOf(lines[pos]) > childIndent)
              node[ck] = parseNode(indentOf(lines[pos]));
            else node[ck] = null;
          } else { node[ck] = coerce(cv); pos++; }
        }
        arr.push(node);
      } else { arr.push(coerce(item)); pos++; }
    }
    return arr;
  }
  return parseNode(0);
}

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0f1a);
scene.fog = new THREE.FogExp2(0x0b0f1a, 0.005);

const TARGET = 42;     // groesste Ausdehnung in Szene-Einheiten
const HEIGHT = 18;     // Hoehen-Skalierung (echte Meter * Y_SCALE)
const Z_TOP = 2500;    // feste Obergrenze der Z-Achsen-Legende (oben = 2500 m)

const camera = new THREE.PerspectiveCamera(
  55, window.innerWidth / window.innerHeight, 0.1, 2000
);
camera.position.set(34, 46, 58);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.localClippingEnabled = true;
document.body.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(window.innerWidth, window.innerHeight);
labelRenderer.domElement.style.position = 'absolute';
labelRenderer.domElement.style.top = '0';
labelRenderer.domElement.style.left = '0';
labelRenderer.domElement.style.pointerEvents = 'none';
document.body.appendChild(labelRenderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.3;
controls.target.set(0, HEIGHT * 0.35, 0);

const gridHelper = new THREE.GridHelper(60, 60, 0x335577, 0x16223a);
scene.add(gridHelper);

const ambient = new THREE.AmbientLight(0xffffff, 0.9);
scene.add(ambient);
const dir = new THREE.DirectionalLight(0xffffff, 0.6);
dir.position.set(20, 40, 20);
scene.add(dir);

// Clipping-Ebene: schneidet den Teil UNTERHALB der Ebene weg (behaelt y >= Hoehe)
const clipPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

// ---- Konfiguration aus conf.yaml (utf-8) ----
const LOADED_FILES = ['./conf.yaml'];
const _yamlText = await (await fetch('./conf.yaml', { cache: 'no-store' })).text();
let CONF = null;
try {
  const _ymod = await import('js-yaml');
  const _yload = _ymod.load || (_ymod.default && _ymod.default.load);
  if (_yload) CONF = _yload(_yamlText);
} catch (e) {
  console.warn('js-yaml nicht verfuegbar, nutze eingebauten Parser:', e);
}
if (!CONF) CONF = parseConfYaml(_yamlText);
if (!CONF || !CONF.rivers) throw new Error('conf.yaml: "rivers" fehlt');

// Externe API-Endpunkte aus conf.yaml (url:), klassifiziert nach Zugriffsart
//   6-stellige Unique-ID -> { access: 5-stellige Zugriffsart, url: ... }
//   bafusp = BAFU/Lindas SPARQL (access: sparq)
//   pegelo = PEGELONLINE WSV  (access: resta)
//   otopom = OpenTopoMap Tiles (access: tiles)
const URLS = (CONF && CONF.url) || {};

// ---- Fluss-Registry (aus conf.yaml, oben links waehlbar) ----
const RIVERS = CONF.rivers.map((r) => ({
  key: r.key,
  label: r.label || r.key.charAt(0).toUpperCase() + r.key.slice(1),
  file: r.key + '.json',
  contours: r.contours || (r.key + '_contours.json'),
  poi: r.poi || null,
  exit: r.exit || null,
  mouthKey: r['mouth-key'] || null,
}));

// GUI-Standardtexte aus conf.yaml (default-texts) uebernehmen
let DEFAULT_EXIT_TPL = 'Dieser Fluss fliesst hier in {mouth}.';
function applyDefaultTexts() {
  const raw = CONF['default-texts'];
  const dt = { buttons: {}, other: {} };
  if (Array.isArray(raw)) {
    for (const o of raw) {
      if (o && o.buttons) Object.assign(dt.buttons, o.buttons);
      if (o && o.other) Object.assign(dt.other, o.other);
    }
  }
  if (dt.other && dt.other.exit) DEFAULT_EXIT_TPL = dt.other.exit;
  if (dt.buttons) {
    const set = (id, txt) => {
      const el = document.getElementById(id);
      if (el && txt != null) el.textContent = txt;
    };
    set('anim-btn', dt.buttons.travel);
    set('topo-btn', dt.buttons.topobutton);
    set('pano-btn', dt.buttons.panobutton);
    const rp = document.querySelector('#river-pick span');
    if (rp && dt.buttons['river-choice'] != null) rp.textContent = dt.buttons['river-choice'] + ':';
    const lp = document.querySelector('#lang-pick span');
    if (lp && dt.buttons['language-choice'] != null) lp.textContent = dt.buttons['language-choice'] + ':';
    const cap = document.querySelector('#legend .cap');
    if (cap && dt.buttons['altitude-picker'] != null) cap.textContent = dt.buttons['altitude-picker'];
  }
  if (dt.other && dt.other.title) document.title = dt.other.title;
}
applyDefaultTexts();

// Statische Hintergrund-Daten (einmal laden)
LOADED_FILES.push('./geo.json');
const geo = await fetch('./geo.json').then((r) => r.json());
LOADED_FILES.push('./countries.json');
const countriesData = await fetch('./countries.json').then((r) => r.json());
LOADED_FILES.push('./river_plus.json');
const riverPlus = await fetch('./river_plus.json').then((r) => r.json());

// Staedte: Geometrie/Hoehe/Einwohner/Koordinaten ausschliesslich aus conf.yaml (cities);
// der Live-Daten-Link (Tag) wird separat aus lifeurl.csv (river, name, live) geladen.
function buildCitiesFromConf() {
  const out = [];
  for (const river of Object.keys(CONF.cities || {})) {
    if (river === 'size') continue;            // Konfigurations-Schluessel, keine Stadteliste
    const entries = CONF.cities[river];
    if (!entries || typeof entries !== 'object') continue;
    for (const name of Object.keys(entries)) {
      const cm = entries[name] || {};
      if (cm.lon == null || cm.lat == null) continue;   // ohne Koordinaten nicht platzierbar
      out.push({
        river, name,
        lon: +cm.lon, lat: +cm.lat,
        alt: cm.altitude != null ? cm.altitude : 0,
        pop: cm.people != null ? cm.people : 0,
        inConf: true,
        live: '',
      });
    }
  }
  return out;
}
const RIVER_CITIES = buildCitiesFromConf();
// Live-Tags aus lifeurl.csv nachladen (river, name -> live)
LOADED_FILES.push('./lifeurl.csv');
const _liveText = await fetch('./lifeurl.csv', { cache: 'no-store' }).then((r) => r.text());
for (const line of _liveText.trim().split('\n').slice(1)) {
  const p = line.split(',');
  if (p.length < 3) continue;
  const river = p[0].trim(), name = p[1].trim(), live = p[2].trim();
  const c = RIVER_CITIES.find((x) => x.river === river && x.name === name);
  if (c) c.live = live;
}
// Muendungs-Text kommt aus conf.yaml (mouth-key) + TEXTS (siehe unten).

// Texte in der gewaehlten Sprache (conf.yaml -> languages.default)
LOADED_FILES.push('./' + CONF.languages[CONF.languages.default]);
let TEXTS = await fetch('./' + CONF.languages[CONF.languages.default], { headers: { 'Accept': 'text/csv' }, cache: 'no-store' })
  .then((r) => r.text()).then(parseTexts);

// GUI-Standardtexte aus conf.yaml (default-texts) + gewaehlte Sprache (TEXTS)
const DEFAULT_TEXTS = (() => {
  const m = {};
  const raw = CONF['default-texts'];
  if (Array.isArray(raw)) {
    for (const o of raw) {
      if (o && o.buttons) Object.assign(m, o.buttons);
      if (o && o.other) Object.assign(m, o.other);
    }
  }
  return m;
})();
// Text aus der Sprachdatei, sonst aus conf.yaml (default-texts), sonst der Schluessel selbst
function txt(key) {
  const t = TEXTS[key];
  if (t != null && t !== '') return t;
  const d = DEFAULT_TEXTS[key];
  if (d != null && d !== '') return d;
  return key;
}
function applyGuiTexts() {
  const set = (id, t) => { const el = document.getElementById(id); if (el) el.textContent = t; };
  set('anim-btn', txt('travel'));
  set('topo-btn', txt('topobutton'));
  set('pano-btn', txt('panobutton'));
  const rp = document.querySelector('#river-pick span');
  if (rp) rp.textContent = txt('river-choice') + ':';
  const lp = document.querySelector('#lang-pick span');
  if (lp) lp.textContent = txt('language-choice') + ':';
  const cap = document.querySelector('#legend .cap');
  if (cap) cap.textContent = txt('altitude-picker');
  set('info', txt('subtitle'));
  const tt = txt('title');
  if (tt) document.title = tt;
}
applyGuiTexts();

function parseTexts(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('key,')) continue;
    const i = t.indexOf(',');
    if (i < 0) continue;
    let key = t.slice(0, i).trim();
    let val = t.slice(i + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

// Stadt-Anzeigename: aus der aktiven Sprachdatei (texts_de/fr/it) per
// conf.yaml-Schluessel (franzoesischer Name) nachschlagen, sonst den Schluessel zeigen.
function cityName(c) {
  if (!c) return '';
  const t = TEXTS[c.name];
  return (t != null && t !== '') ? t : c.name;
}

// Alle Fluss-Geometrien laden; Fluesse ohne Daten-Datei werden uebersprungen
const RIVER_DATA = {};
const RIVERS_ALL = RIVERS.slice();
const _okKeys = new Set();
await Promise.all(RIVERS_ALL.map(async (rv) => {
  try {
    const res = await fetch('./' + rv.file, { cache: 'no-store' });
    LOADED_FILES.push('./' + rv.file);
    if (!res.ok) { console.warn('Fluss-Daten fehlen:', rv.file); return; }
    RIVER_DATA[rv.key] = await res.json();
    _okKeys.add(rv.key);
  } catch (e) {
    console.warn('Fluss-Daten konnten nicht geladen werden:', rv.file, e);
  }
}));
const MISSING_RIVERS = RIVERS_ALL.filter((r) => !_okKeys.has(r.key)).map((r) => r.key);
RIVERS.length = 0;
for (const rv of RIVERS_ALL) if (_okKeys.has(rv.key)) RIVERS.push(rv);
if (RIVERS.length === 0) throw new Error('Keine Fluss-Datendateien (*.json) gefunden.');

let currentKey = RIVERS[0].key;
let data = RIVER_DATA[currentKey];      // aktueller Fluss (ways)
let rawData = [];                        // flach: [lon, lat, hoehe, abfall]
for (const w of data.ways) for (const p of w) rawData.push(p);
let riverSource = data.source;           // Quelle des aktuellen Flusses

// Feste, flussunabhaengige Projektion (deckt alle Fluesse + Topo-Karte ab)
const GBOX = { lonMin: 3.5, lonMax: 13.5, latMin: 43.0, latMax: 52.5 };
const lonC = (GBOX.lonMin + GBOX.lonMax) / 2;
const latC = (GBOX.latMin + GBOX.latMax) / 2;
const cosLat = Math.cos((latC * Math.PI) / 180);
const dxKm = (GBOX.lonMax - GBOX.lonMin) * cosLat * 111.32;
const dzKm = (GBOX.latMax - GBOX.latMin) * 110.57;
const SCALE = TARGET / Math.max(dxKm, dzKm);

// Globale Hoehen- und Abfallraten-Bereiche (ueber alle Fluesse, einheitliche Skala)
let elevMin = Infinity, elevMax = -Infinity;
const descArr = [];
for (const rv of RIVERS) {
  for (const w of RIVER_DATA[rv.key].ways) for (const p of w) {
    const el = p[2], de = p[3];
    if (el < elevMin) elevMin = el;
    if (el > elevMax) elevMax = el;
    descArr.push(de);
  }
}
const descMin = 0;
let descMaxRaw = 1;
for (const v of descArr) if (v > descMaxRaw) descMaxRaw = v;
const descSorted = descArr.slice().sort((a, b) => a - b);
const robustMax = Math.max(
  1,
  descSorted[Math.min(descSorted.length - 1, Math.floor(descSorted.length * 0.98))]
);
const DESC_MAX = Math.min(descMaxRaw, robustMax) || 1;
const Y_SCALE = HEIGHT / (elevMax || 1);

function projectXZ(lon, lat) {
  const x = (lon - lonC) * cosLat * 111.32 * SCALE;
  const z = -(lat - latC) * 110.57 * SCALE;
  return [x, z];
}
function project(lon, lat, elev) {
  const [x, z] = projectXZ(lon, lat);
  const y = elev * Y_SCALE;
  return [x, y, z];
}

// Farbe nach Abfallrate: hellblau (sehr flach) -> gruen -> gelb -> orange -> rot (sehr steil)
const DESC_STOPS = [
  [0.00, 0.62, 0.72, 0.32], // dunkelblau (sehr flach)
  [0.18, 0.33, 0.70, 0.50], // gruen
  [0.50, 0.15, 0.80, 0.50], // gelb
  [0.80, 0.07, 0.85, 0.50], // orange
  [1.00, 0.00, 0.80, 0.52], // rot (dezenter Touch bei sehr steil)
];
function colorFor(desc) {
  const t = Math.min(1, Math.max(0, (desc - descMin) / ((DESC_MAX - descMin) || 1)));
  let a = DESC_STOPS[0], b = DESC_STOPS[DESC_STOPS.length - 1];
  for (let i = 0; i < DESC_STOPS.length - 1; i++) {
    if (t >= DESC_STOPS[i][0] && t <= DESC_STOPS[i + 1][0]) { a = DESC_STOPS[i]; b = DESC_STOPS[i + 1]; break; }
  }
  const f = (t - a[0]) / ((b[0] - a[0]) || 1);
  const hue = a[1] + (b[1] - a[1]) * f;
  const sat = a[2] + (b[2] - a[2]) * f;
  const lig = a[3] + (b[3] - a[3]) * f;
  return new THREE.Color().setHSL(hue, sat, lig);
}

// ---- Fluss-Gruppe (wird pro gewaehltem Fluss in buildRiver() neu aufgebaut) ----
const riverGroup = new THREE.Group();
scene.add(riverGroup);
let riverPoints = null;   // Punktwolke (Gradient OHNE Topo, navy MIT Topo)
let riverTube = null;     // dicke navy Tube (nur MIT Topo sichtbar)
let riverLine = null;     // durchgehende Linie (immer sichtbar)
let gradientColors = [];  // pro Punkt: Ursprungs-Gradient (Abfallrate)

// ---- Laendergrenzen ----
const borderPos = [];
for (const c of countriesData.countries) {
  for (const l of c.borders) {
    for (let i = 1; i < l.length; i++) {
      const [x1, z1] = projectXZ(l[i - 1][0], l[i - 1][1]);
      const [x2, z2] = projectXZ(l[i][0], l[i][1]);
      borderPos.push(x1, 0.05, z1, x2, 0.05, z2);
    }
  }
}
const borderGeo = new THREE.BufferGeometry();
borderGeo.setAttribute('position', new THREE.Float32BufferAttribute(borderPos, 3));
scene.add(new THREE.LineSegments(
  borderGeo,
  new THREE.LineBasicMaterial({ color: 0x5b7bb5, transparent: true, opacity: 0.55 })
));

// ---- Seen ----
function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (((yi > lat) !== (yj > lat)) &&
        (lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}
function onLake(lon, lat) {
  for (const lake of riverPlus.lakes) {
    if (pointInRing(lon, lat, lake.rings[0])) return true;
    for (const ring of lake.rings) {
      for (const [x, y] of ring) {
        if (Math.hypot((lon - x) * cosLat * 111.32, (lat - y) * 110.57) < 3) return true;
      }
    }
  }
  return false;
}
function addFlatArea(area, color, opacity, labelClass, yLevel) {
  const shape = new THREE.Shape();
  area.rings[0].forEach(([lon, lat], i) => {
    const [x, z] = projectXZ(lon, lat);
    if (i === 0) shape.moveTo(x, -z); else shape.lineTo(x, -z);
  });
  for (let h = 1; h < area.rings.length; h++) {
    const hole = new THREE.Path();
    area.rings[h].forEach(([lon, lat], i) => {
      const [x, z] = projectXZ(lon, lat);
      if (i === 0) hole.moveTo(x, -z); else hole.lineTo(x, -z);
    });
    shape.holes.push(hole);
  }
  const mesh = new THREE.Mesh(
    new THREE.ShapeGeometry(shape),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false })
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = yLevel;
  scene.add(mesh);
  if (area.name) {
    let cx = 0, cy = 0;
    const r0 = area.rings[0];
    for (const [x, y] of r0) { cx += x; cy += y; }
    cx /= r0.length; cy /= r0.length;
    const [lx, lz] = projectXZ(cx, cy);
    const div = document.createElement('div');
    div.className = labelClass;
    div.textContent = area.name;
    const lbl = new CSS2DObject(div);
    lbl.position.set(lx, 0.5, lz);
    scene.add(lbl);
  }
}
for (const lake of riverPlus.lakes) {
  addFlatArea(lake, 0x2a6cff, 0.35, 'lake-label', 0.03);
}
if (riverPlus.sea) {
  addFlatArea(riverPlus.sea, 0x6fb7ff, 0.45, 'sea-label', 0.02);
}

// ---- Hauptstaedte (nur im Korridor sichtbar) ----
const CAP_BBOX = { lonMin: 3.8, latMin: 46.3, lonMax: 10.2, latMax: 52.8 };
const capitalObjs = [];
function inCorridor(lon, lat) {
  return lon >= CAP_BBOX.lonMin && lon <= CAP_BBOX.lonMax &&
          lat >= CAP_BBOX.latMin && lat <= CAP_BBOX.latMax;
}
// Hauptstaedte kommen aus conf.yaml (capitals:)
const CAPITALS = (CONF && CONF.capitals && CONF.capitals.length)
  ? CONF.capitals
  : [
      { name: 'Paris', lon: 2.3522, lat: 48.8566 },
      { name: 'Rom', lon: 12.4964, lat: 41.9028 },
      { name: 'Berlin', lon: 13.4050, lat: 52.5200 },
      { name: 'Madrid', lon: -3.7038, lat: 40.4168 },
      { name: 'Wien', lon: 16.3738, lat: 48.2082 },
      { name: 'Warschau', lon: 21.0122, lat: 52.2297 },
      { name: 'Prag', lon: 14.4378, lat: 50.0755 },
      { name: 'Budapest', lon: 19.0402, lat: 47.4979 },
      { name: 'Bukarest', lon: 26.1025, lat: 44.4268 },
      { name: 'Bern', lon: 7.4474, lat: 46.9480 }
    ];
for (const cap of CAPITALS) {
  const [x, z] = projectXZ(cap.lon, cap.lat);
  // kleiner hohler Kreis auf dem Boden (Hoehe 0)
  const capMarker = new THREE.Mesh(
    new THREE.RingGeometry(0.35, 0.5, 28),
    new THREE.MeshBasicMaterial({ color: 0xff4d6d, side: THREE.DoubleSide, transparent: true, opacity: 0.9 })
  );
  capMarker.rotation.x = -Math.PI / 2;
  capMarker.position.set(x, 0.05, z);
  scene.add(capMarker);
  const div = document.createElement('div');
  div.className = 'capital-label';
  div.textContent = cap.name;
  const lbl = new CSS2DObject(div);
  lbl.position.set(x + 0.9, 0.6, z);
  capitalObjs.push({ marker: capMarker, label: lbl });
}

// ---- Panorama-Modus (flache Uebersicht aller Fluesse + Hauptstaedte) ----
let panoramaMode = false;
let panoramaGroup = null;
let panoramaBuilt = false;
let panoramaLabels = [];
let panoramaBounds = null;
let panoramaLineMats = [];
let panoramaLayer = null;
let panoRiverObjs = {};   // riverKey -> [{ obj, mat }] fuer Hover-Highlight (weiss)
const PANORAMA_LIFT = 0.35; // kleiner Hub ueber der grauen Ebene
// Staedte kommen aus conf.yaml (cities); der Live-Tag aus lifeurl.csv (siehe RIVER_CITIES).

// ---- Staedte: nur die "Rekord"-Staedte entlang des Rheins ----
function nearestRiverDist(lon, lat) {
  let best = 1e9;
  for (let i = 0; i < rawData.length; i++) {
    const d = Math.hypot(
      (lon - rawData[i][0]) * cosLat * 111.32,
      (lat - rawData[i][1]) * 110.57
    );
    if (d < best) best = d;
  }
  return best;
}
function distFromSource(lon, lat) {
  const dx = (lon - riverSource.lon) * cosLat * 111.32;
  const dy = (lat - riverSource.lat) * 110.57;
  return Math.hypot(dx, dy);
}
const NEAR_KM = 10;

// Diese Objekte werden pro Fluss in buildRiver() (neu) aufgebaut
let cityObjs = [];
let contourLevels = [];

function nearestRiverElev(lon, lat) {
  let best = 1e9, belev = 0;
  for (let i = 0; i < rawData.length; i++) {
    const d = Math.hypot(
      (lon - rawData[i][0]) * cosLat * 111.32,
      (lat - rawData[i][1]) * 110.57
    );
    if (d < best) { best = d; belev = rawData[i][2]; }
  }
  return belev;
}

// Einwohnerzahl formatiert mit Apostroph-Tausendertrennung (z.B. 7'300, 870'000)
function fmtPop(p) {
  return Math.round(p).toString().replace(/\B(?=(\d{3})+(?!\d))/g, "'");
}

function updateCity(o) {
  const above = o.elev >= currentElev;
  o.mat.wireframe = !above;                 // unterhalb der Ebene: nur Umriss
  o.mat.color.set(above ? 0xffd24a : 0x707070);
  o.stem.visible = above;                  // Stiel nur oberhalb
  o.lbl.element.style.opacity = above ? '1' : '0.35';
}
function updateVisibility() {
  for (const cl of contourLevels) cl.lines.visible = cl.elev >= currentElev;
  for (const o of cityObjs) updateCity(o);
}

// Im Travel-Modus werden die Staedte als flache Kreise (statt Kugeln) gezeigt
function setCityTravel(on) {
  for (const o of cityObjs) {
    o.marker.visible = !on;
    o.stem.visible = !on;
    if (o.disc) o.disc.visible = on;
  }
}

// Stadt anklicken -> Ebene auf (Stadthoehe - 20 m) setzen, min. 0
function focusCity(o) {
  setValue(Math.max(0, o.elev - 20));
  showFlow(o);
}

// ---------- BAFU Live-Abfluss (LINDAS SPARQL, Open-Use) ----------
// Schweizer Rhein-Stationen (Quelle: BAFU / LINDAS). Nur gueltig bis Basel.
const BAFU_STATIONS = [
  { id: 2289, name: 'Basel, Rheinhalle',        lat: 47.5594, lon: 7.6167,  water: 'Rhein' },
  { id: 2473, name: 'Diepoldsau, Rietbrücke',    lat: 47.3831, lon: 9.6409,  water: 'Rhein' },
  { id: 2602, name: 'Domat/Ems',                lat: 46.8377, lon: 9.4561,  water: 'Rhein' },
  { id: 2387, name: 'Fürstenau',                lat: 46.7151, lon: 9.4473,  water: 'Hinterrhein' },
  { id: 2631, name: 'Hinterrhein, Schiessplatz',lat: 46.5234, lon: 9.1813,  water: 'Hinterrhein' },
  { id: 2033, name: 'Ilanz',                    lat: 46.7758, lon: 9.2064,  water: 'Vorderrhein' },
  { id: 2288, name: 'Neuhausen, Flurlingerbrücke', lat: 47.6815, lon: 8.6263, water: 'Rhein' },
  { id: 2041, name: 'Oberriet, Blatten',        lat: 47.3069, lon: 9.5708,  water: 'Rhein' },
  { id: 2143, name: 'Rekingen',                 lat: 47.5703, lon: 8.3298,  water: 'Rhein' },
  { id: 2091, name: 'Rheinfelden',              lat: 47.5607, lon: 7.7999,  water: 'Rhein' },
];

const BAFU_QUERY = `PREFIX hd: <https://environment.ld.admin.ch/foen/hydro/dimension/>
PREFIX schema: <http://schema.org/>
SELECT ?id ?name ?water ?discharge ?t WHERE {
  ?obs hd:station ?st ; hd:discharge ?discharge ; hd:measurementTime ?t .
  ?st schema:identifier ?id ; schema:name ?name ; schema:containedInPlace ?wb .
  BIND(REPLACE(STR(?wb), ".*/waterbody/", "") AS ?water)
  FILTER(CONTAINS(LCASE(STR(?wb)), "rhein"))
}`;
let bafuCache = null, bafuCacheTime = 0;
async function getBafuDischarges() {
  const now = Date.now();
  if (bafuCache && now - bafuCacheTime < 5 * 60 * 1000) return bafuCache;
  const url = ((URLS.bafusp && URLS.bafusp.url) || 'https://lindas.admin.ch/query') + '?query=' + encodeURIComponent(BAFU_QUERY);
  const r = await fetch(url, { headers: { Accept: 'application/sparql-results+json' } });
  const j = await r.json();
  const map = {};
  for (const b of (j.results && j.results.bindings) || []) {
    const id = b.id && b.id.value;
    if (id == null) continue;
    map[id] = {
      q: b.discharge ? parseFloat(b.discharge.value) : null,
      t: b.t ? b.t.value : null,
      name: b.name ? b.name.value : '',
      water: b.water ? b.water.value : ''
    };
  }
  bafuCache = map; bafuCacheTime = now;
  return map;
}
// ---------- PEGELONLINE (WSV, DE) ----------
const PEGEL_URL = (URLS.pegelo && URLS.pegelo.url) || 'https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations.json?waters=RHEIN&includeTimeseries=true&includeCurrentMeasurement=true';
let pegelCache = null, pegelCacheTime = 0;
async function getPegelStations() {
  const now = Date.now();
  if (pegelCache && now - pegelCacheTime < 5 * 60 * 1000) return pegelCache;
  const r = await fetch(PEGEL_URL, { headers: { Accept: 'application/json' } });
  const j = await r.json();
  const out = [];
  for (const s of j) {
    if (s.latitude == null || s.longitude == null) continue;
    const qts = (s.timeseries || []).find(t => t.shortname === 'Q');
    if (!qts || !qts.currentMeasurement) continue;
    out.push({
      src: 'PEGELONLINE', name: s.longname,
      lat: s.latitude, lon: s.longitude,
      q: parseFloat(qts.currentMeasurement.value),
      t: qts.currentMeasurement.timestamp
    });
  }
  pegelCache = out; pegelCacheTime = now;
  return out;
}

const LIVE_MAX_KM = 150;
const flowInfo = document.getElementById('flow-info');
async function showFlow(o) {
  flowInfo.style.display = 'block';
  flowInfo.textContent = 'Lade Abfluss für ' + cityName(o) + ' …';
  try {
    const [bafu, pegel] = await Promise.all([getBafuDischarges(), getPegelStations()]);
    const cands = [];
    for (const s of BAFU_STATIONS) {
      const d = bafu[s.id];
      if (d && d.q != null) cands.push({ src: 'BAFU', name: s.name, lat: s.lat, lon: s.lon, q: d.q, t: d.t });
    }
    for (const s of pegel) cands.push(s);
    let best = Infinity, pick = null;
    for (const c of cands) {
      const d = Math.hypot(
        (o.lon - c.lon) * Math.cos(o.lat * Math.PI / 180) * 111.32,
        (o.lat - c.lat) * 110.57
      );
      if (d < best) { best = d; pick = c; }
    }
    if (!pick || best > LIVE_MAX_KM) {
      flowInfo.textContent = 'Kein Live-Abfluss für ' + cityName(o) + ' (keine BAFU/PEGELONLINE-Station mit Q in der Nähe)';
      return;
    }
    const q = pick.q.toLocaleString('de-CH', { maximumFractionDigits: 0 });
    const t = pick.t ? new Date(pick.t).toLocaleString('de-CH') : '';
    const srcLabel = pick.src === 'BAFU' ? 'BAFU (CH)' : 'PEGELONLINE (DE)';
    const rlabel = riverLabelByKey(currentKey) || 'Fluss';
    flowInfo.innerHTML = '<b>' + cityName(o) + '</b> · ' + rlabel + '-Abfluss ≈ <b>' + q + ' m³/s</b><br>' +
      srcLabel + ' ' + pick.name + (t ? ' · ' + t : '');
  } catch (e) {
    flowInfo.textContent = 'Abfluss nicht abrufbar (' + e.message + ')';
  }
}

// ---------- OpenTopoMap-Basemap (nur bei Hoehe 0, statt der blauen Ebene) ----------
const OTM_Z = 10;                       // Zoom ~ 1:500k fuer den Rhein-Korridor
const OTM_ATTR = '© OpenTopoMap (CC-BY-SA)';
let topoGroup = null;
let topoState = { decided: false, want: false, loading: false };
let topoPromptEl = null, topoProgEl = null, topoCreditEl = null;

function lonToTileX(lon, z) { const n = 2 ** z; return Math.floor((lon + 180) / 360 * n); }
function latToTileY(lat, z) {
  const n = 2 ** z, r = Math.PI / 180;
  return Math.floor((1 - Math.asinh(Math.tan(lat * r)) / Math.PI) / 2 * n);
}
function tileLatEdges(ty, z) {
  const n = 2 ** z;
  const yToLat = (y) => Math.atan(Math.sinh(Math.PI * ((y / n) * 2 - 1))) * 180 / Math.PI;
  return [yToLat(ty), yToLat(ty + 1)]; // [nord (oben), sued (unten)]
}
function tileLonEdges(tx, z) {
  const n = 2 ** z;
  return [tx / n * 360 - 180, (tx + 1) / n * 360 - 180];
}
function otmTileRange(z = OTM_Z) {
  const n = 2 ** z;
  const x0 = lonToTileX(GBOX.lonMin, z), x1 = lonToTileX(GBOX.lonMax, z);
  const yTop = latToTileY(GBOX.latMax, z), yBot = latToTileY(GBOX.latMin, z);
  const xs = [], ys = [];
  for (let x = x0; x <= x1; x++) xs.push(x);
  for (let y = yBot; y <= yTop; y++) ys.push(y);
  return { n, xs, ys };
}
// Laedt eine Kachel ueber fetch -> Blob (same-origin, daher KEIN Canvas-Taint)
// und speichert sie im Cache. Blob-Bilder koennen gefahrlos auf ein Canvas
// gezeichnet werden, sodass die CanvasTexture niemals schwarz wird.
async function blobToImage(blob) {
  return new Promise((res, rej) => {
    const img = new Image();
    const u = URL.createObjectURL(blob);
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = u;
  });
}
async function loadTile(url) {
  if ('caches' in window) {
    try {
      const cache = await caches.open('otm-tiles');
      const hit = await cache.match(url);
      if (hit) return await blobToImage(await hit.blob());
      const res = await fetch(url);
      if (res.ok) {
        await cache.put(url, res.clone());
        return await blobToImage(await res.blob());
      }
    } catch (e) { /* Cache/Fetch nicht verfuegbar -> Fallback */ }
  }
  return await new Promise((res, rej) => {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => res(im);
    im.onerror = rej;
    im.src = url;
  });
}

async function buildOpenTopoMap() {
  if (topoGroup || topoState.loading) return;
  topoState.loading = true;
  updateTopoProgress(0, 1);
  try {
    const resp = await fetch('./europe_opentopomap.tif');
LOADED_FILES.push('./europe_opentopomap.tif');
    if (!resp.ok) throw new Error('HTTP ' + resp.status + ' beim Laden der TIFF');
    const buf = await resp.arrayBuffer();
    const tiff = await fromArrayBuffer(buf);
    const image = await tiff.getImage();
    const w = image.getWidth(), h = image.getHeight();
    const samples = image.getSamplesPerPixel();
    const rasters = await image.readRasters();
    const bbox = image.getBoundingBox(); // [minX, minY, maxX, maxY] in EPSG:3857
    const r = rasters[0], g = samples > 1 ? rasters[1] : r, b = samples > 2 ? rasters[2] : r;
    const R = 6378137;
    const lonMin = bbox[0] / R * 180 / Math.PI;
    const lonMax = bbox[2] / R * 180 / Math.PI;
    const latMin = (2 * Math.atan(Math.exp(bbox[1] / R)) - Math.PI / 2) * 180 / Math.PI;
    const latMax = (2 * Math.atan(Math.exp(bbox[3] / R)) - Math.PI / 2) * 180 / Math.PI;
    const mercMin = bbox[1], mercMax = bbox[3];

    // Weichzeichnen (Fade) der Karte in weiter Entfernung vom Rhein:
    // innerhalb FADE_KM voll sichtbar, aussen transparent (alpha -> 0).
    const FADE_KM = 300;
    const GW = 256, GH = 256;
    const rpts = [];
    for (const s of riverSamples) rpts.push(s.x, s.z);
    const rN = rpts.length / 2;
    let rminX = Infinity, rmaxX = -Infinity, rminZ = Infinity, rmaxZ = -Infinity;
    for (let k = 0; k < rN; k++) {
      const x = rpts[2 * k], z = rpts[2 * k + 1];
      if (x < rminX) rminX = x; if (x > rmaxX) rmaxX = x;
      if (z < rminZ) rminZ = z; if (z > rmaxZ) rmaxZ = z;
    }
    const cell = Math.max(1e-3, 200 * SCALE); // Rasterzelle ~200 km (Szenen-Einheiten)
    const gw = Math.max(1, Math.ceil((rmaxX - rminX) / cell) + 1);
    const gh = Math.max(1, Math.ceil((rmaxZ - rminZ) / cell) + 1);
    const grid = new Array(gw * gh);
    for (let k = 0; k < rN; k++) {
      const x = rpts[2 * k], z = rpts[2 * k + 1];
      let gx = Math.floor((x - rminX) / cell), gz = Math.floor((z - rminZ) / cell);
      gx = Math.max(0, Math.min(gw - 1, gx)); gz = Math.max(0, Math.min(gh - 1, gz));
      const id = gz * gw + gx;
      (grid[id] || (grid[id] = [])).push(k);
    }
    const nearestKm = (sx, sz) => {
      const gx = Math.floor((sx - rminX) / cell), gz = Math.floor((sz - rminZ) / cell);
      let best = Infinity;
      for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
        const cx = gx + dx, cz = gz + dz;
        if (cx < 0 || cz < 0 || cx >= gw || cz >= gh) continue;
        const b = grid[cz * gw + cx]; if (!b) continue;
        for (const k of b) {
          const ex = rpts[2 * k] - sx, ez = rpts[2 * k + 1] - sz;
          const d = ex * ex + ez * ez; if (d < best) best = d;
        }
      }
      return Math.sqrt(best) / SCALE; // Szenen-Einheiten -> km
    };
    const alphaGrid = new Float32Array(GW * GH);
    for (let gi = 0; gi < GW; gi++) {
      const lon = lonMin + gi / (GW - 1) * (lonMax - lonMin);
      for (let gj = 0; gj < GH; gj++) {
        const lat = latMax - gj / (GH - 1) * (latMax - latMin);
        const [sx, sz] = projectXZ(lon, lat);
        const km = nearestKm(sx, sz);
        alphaGrid[gj * GW + gi] = Math.max(0, Math.min(1, (FADE_KM - km) / FADE_KM));
      }
    }

    // Mercator (EPSG:3857) -> linear Breite (passend zu projectXZ), damit die
    // Karte mit dem Rhein / den Staedten zusammenfaellt.
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let j = 0; j < h; j++) {
      const lat = latMax - (j / (h - 1)) * (latMax - latMin); // Nord oben
      const mercY = R * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 180 / 2));
      let srcRow = (mercMax - mercY) / (mercMax - mercMin) * (h - 1);
      srcRow = Math.max(0, Math.min(h - 1, srcRow));
      const si = Math.round(srcRow) * w, di = j * w;
      const gjf = (latMax - lat) / (latMax - latMin) * (GH - 1);
      const gy0 = Math.floor(gjf), gy1 = Math.min(GH - 1, gy0 + 1), fy = gjf - gy0;
      for (let i = 0; i < w; i++) {
        const lon = lonMin + (i / (w - 1)) * (lonMax - lonMin);
        const gif = (lon - lonMin) / (lonMax - lonMin) * (GW - 1);
        const gx0 = Math.floor(gif), gx1 = Math.min(GW - 1, gx0 + 1), fx = gif - gx0;
        const a00 = alphaGrid[gy0 * GW + gx0], a10 = alphaGrid[gy0 * GW + gx1];
        const a01 = alphaGrid[gy1 * GW + gx0], a11 = alphaGrid[gy1 * GW + gx1];
        const a = (a00 * (1 - fx) + a10 * fx) * (1 - fy) + (a01 * (1 - fx) + a11 * fx) * fy;
        rgba[(di + i) * 4] = r[si + i];
        rgba[(di + i) * 4 + 1] = g[si + i];
        rgba[(di + i) * 4 + 2] = b[si + i];
        rgba[(di + i) * 4 + 3] = Math.round(a * 255);
      }
    }
    // bei Bedarf auf maxTextureSize herunterskaliert
    const maxTex = renderer.capabilities.maxTextureSize;
    const sc = Math.min(1, maxTex / w, maxTex / h);
    const cw = Math.max(1, Math.round(w * sc)), ch = Math.max(1, Math.round(h * sc));
    const tmp = document.createElement('canvas'); tmp.width = w; tmp.height = h;
    tmp.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);
    const canvas = document.createElement('canvas'); canvas.width = cw; canvas.height = ch;
    canvas.getContext('2d').drawImage(tmp, 0, 0, cw, ch);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    // EPSG:3857 -> lon/lat (fuer die Plan-Position)
    const [xMin, zA] = projectXZ(lonMin, latMin);
    const [xMax, zB] = projectXZ(lonMax, latMax);
    const planeW = Math.abs(xMax - xMin), planeH = Math.abs(zB - zA);
    const geo = new THREE.PlaneGeometry(planeW, planeH);
    const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, transparent: true });
    const plane = new THREE.Mesh(geo, mat);
    plane.rotation.x = -Math.PI / 2; // flach, Norden oben (-Z)
    plane.position.set((xMin + xMax) / 2, 0, (zA + zB) / 2);
    topoGroup = new THREE.Group(); topoGroup.visible = false; topoGroup.add(plane);
    scene.add(topoGroup);
    topoState.loading = false;
    updateTopoProgress(1, 1);
    setTopoLoaded();
    applyGround();
  } catch (e) {
    console.error('OpenTopoMap-TIFF laden fehlgeschlagen, Fallback auf Kacheln:', e);
    buildTopoTiles();
  }
}

async function buildTopoTiles() {
  if (topoGroup || topoState.loading) return;
  topoState.loading = true;
  // Eine einzige grosse Canvas/Textur (wie im three.js-Beispiel). Zoom so waehlen,
  // dass die Canvas in maxTextureSize passt (sonst "texture too large").
  const maxTex = renderer.capabilities.maxTextureSize;
  let z = OTM_Z;
  let rng = otmTileRange(z);
  while ((rng.xs.length * 256 > maxTex || rng.ys.length * 256 > maxTex) && z > 3) {
    z--; rng = otmTileRange(z);
  }
  const { xs, ys } = rng;
  const nX = xs.length, nY = ys.length;
  const canvas = document.createElement('canvas');
  canvas.width = nX * 256; canvas.height = nY * 256;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#888'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  const group = new THREE.Group();
  group.visible = false;
  const total = nX * nY, queue = [];
  for (const tx of xs) for (const ty of ys) queue.push([tx, ty]);
  let done = 0;
  updateTopoProgress(0, total);
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const [tx, ty] = queue.shift();
      try {
        const tileTpl = (URLS.otomap && URLS.otomap.url) || 'https://a.tile.opentopomap.org/{z}/{tx}/{ty}.png';
        const img = await loadTile(tileTpl.replace('{z}', z).replace('{tx}', tx).replace('{ty}', ty));
        // Nord oben: Reihe = (rng.y_top - ty) * 256, damit die Textur mit dem
        // Szenen-Koordinatensystem (Norden -> -Z) uebereinstimmt.
        ctx.drawImage(img, (tx - xs[0]) * 256, (rng.ys[rng.ys.length - 1] - ty) * 256);
      } catch (e) { /* Kachel ueberspringen */ }
      done++;
      updateTopoProgress(done, total);
    }
  }));
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter; // wie im three.js-Beispiel (kein Mipmap-Limit)
  tex.generateMipmaps = false; // NPOT-Canvas: Mipmaps wuerden Textur unvollstaendig -> schwarz
  // Eine flache Plane ueber das BBox-Spannfeld (rotation.x = -PI/2, wie im Beispiel)
  const [xMin, zA] = projectXZ(lonMin, latMin);
  const [xMax, zB] = projectXZ(lonMax, latMax);
  const w = Math.abs(xMax - xMin), h = Math.abs(zB - zA);
  const geo = new THREE.PlaneGeometry(w, h);
  const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });
  const plane = new THREE.Mesh(geo, mat);
  plane.rotation.x = -Math.PI / 2; // flach wie im three.js-Beispiel
  plane.position.set((xMin + xMax) / 2, 0, (zA + zB) / 2);
  group.add(plane);
  topoGroup = group;
  scene.add(group);
  topoState.loading = false;
  setTopoLoaded();
  applyGround();
}

function ensureTopoUI() {
  if (topoPromptEl) return;
  topoPromptEl = document.createElement('div');
  topoPromptEl.style.cssText = 'position:fixed;left:50%;top:38%;transform:translate(-50%,-50%);' +
    'background:rgba(10,15,26,.93);color:#e8eef5;border:1px solid #2b3a4a;border-radius:10px;' +
    'padding:16px 18px;font:14px/1.5 system-ui,sans-serif;max-width:360px;z-index:60;';
  topoPromptEl.style.display = 'none';
  topoPromptEl.innerHTML =
    '<div id="topo-msg"></div>' +
    '<div style="margin-top:14px;display:flex;gap:10px;justify-content:flex-end">' +
    '<button id="topo-no" style="cursor:pointer;background:#22304a;color:#cfe3ff;border:1px solid #3a4d68;border-radius:6px;padding:6px 12px;font:13px system-ui">Nein</button>' +
    '<button id="topo-yes" style="cursor:pointer;background:#2a6cff;color:#fff;border:none;border-radius:6px;padding:6px 14px;font:13px system-ui">Ja, laden</button>' +
    '</div>';
  document.body.appendChild(topoPromptEl);
  topoPromptEl.querySelector('#topo-yes').onclick = () => {
    topoState.decided = true; topoState.want = true;
    topoPromptEl.style.display = 'none';
    buildOpenTopoMap();
  };
  topoPromptEl.querySelector('#topo-no').onclick = () => {
    topoState.decided = true; topoState.want = false;
    topoPromptEl.style.display = 'none';
    applyGround();
  };
}
function showTopoPrompt(msg) {
  ensureTopoUI();
  topoPromptEl.querySelector('#topo-msg').textContent = msg;
  topoPromptEl.style.display = 'block';
}
function updateTopoProgress(done, total) {
  if (!topoProgEl) {
    topoProgEl = document.createElement('div');
    topoProgEl.style.cssText = 'position:fixed;right:10px;top:50px;' +
      'background:rgba(10,15,26,.85);color:#cfe3ff;border:1px solid #2b3a4a;border-radius:6px;' +
      'padding:6px 10px;font:12px system-ui;z-index:60;';
    document.body.appendChild(topoProgEl);
  }
  const pct = total ? Math.round(done / total * 100) : 0;
  const mbNow = done * 30 / 1024;
  const mbTot = total * 30 / 1024;
  topoProgEl.textContent = `loading ${pct}% · ${mbNow.toFixed(1)} / ${mbTot.toFixed(1)} MB`;
  topoProgEl.style.display = 'block';
}
function setTopoLoaded() {
  if (!topoProgEl) return;
  topoProgEl.textContent = 'loaded';
  topoProgEl.style.display = 'block';
}
function hideTopoProgress() { if (topoProgEl) topoProgEl.style.display = 'none'; }
function ensureTopoCredit() {
  if (topoCreditEl) return;
  topoCreditEl = document.createElement('div');
  topoCreditEl.textContent = OTM_ATTR;
  topoCreditEl.style.cssText = 'position:fixed;right:8px;bottom:6px;color:#9fb3ff;' +
    'font:11px system-ui;opacity:.8;z-index:60;pointer-events:none;display:none;';
  document.body.appendChild(topoCreditEl);
}
function applyGround() {
  const showTopo = topoState.want && topoGroup && !panoramaMode;
  if (gridHelper) gridHelper.visible = !showTopo && !travelMode && !panoTravel; // Gitternetz in der Reise ausblenden (Z-Fighting mit Basisebene)
  if (heightPlane) heightPlane.visible = !showTopo && !travelMode && !panoTravel; // blaue Ebene waehrend der Reise ausblenden
  if (topoGroup) {
    topoGroup.visible = !!showTopo;
    topoGroup.position.y = 0; // flache Basiskarte auf Hoehe 0, unter dem Rhein
    for (const o of capitalObjs) { o.marker.visible = !showTopo; o.label.visible = !showTopo; }
  }
  if (topoCreditEl) topoCreditEl.style.display = showTopo ? 'block' : 'none';
  // Reise: im Panorama erst rotieren, wenn der Punkt den Fluss entlanglaeuft;
  // in der normalen Reise gar nicht; sonst wie ueblich (Topo -> keine Rotation).
  controls.autoRotate = !panoTravel && !travelMode && !showTopo; // im Panorama-Reisemodus niemals rotieren
  applyRiverStyle();
}

// ---- Panorama-Modus: flache Gesamtuebersicht (alle Fluesse + Hauptstaedte) ----
// Vollstaendige, ungefadete OpenTopoMap als Hintergrund der Panorama-Ansicht.
async function buildPanoramaTopo() {
  const resp = await fetch('./europe_opentopomap.tif');
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const buf = await resp.arrayBuffer();
  const tiff = await fromArrayBuffer(buf);
  const image = await tiff.getImage();
  const w = image.getWidth(), h = image.getHeight();
  const samples = image.getSamplesPerPixel();
  const rasters = await image.readRasters();
  const bbox = image.getBoundingBox();
  const r = rasters[0], g = samples > 1 ? rasters[1] : r, b = samples > 2 ? rasters[2] : r;
  const R = 6378137;
  const lonMin = bbox[0] / R * 180 / Math.PI;
  const lonMax = bbox[2] / R * 180 / Math.PI;
  const latMin = (2 * Math.atan(Math.exp(bbox[1] / R)) - Math.PI / 2) * 180 / Math.PI;
  const latMax = (2 * Math.atan(Math.exp(bbox[3] / R)) - Math.PI / 2) * 180 / Math.PI;
  // gleiche Mercator->Breite-Warpung wie buildOpenTopoMap (Reise/Rhein-Ansicht)
  const mercMin = bbox[1], mercMax = bbox[3];
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let j = 0; j < h; j++) {
    const lat = latMax - (j / (h - 1)) * (latMax - latMin); // Nord oben
    const mercY = R * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 180 / 2));
    let srcRow = (mercMax - mercY) / (mercMax - mercMin) * (h - 1);
    srcRow = Math.max(0, Math.min(h - 1, srcRow));
    const si = Math.round(srcRow) * w, di = j * w;
    for (let i = 0; i < w; i++) {
      rgba[(di + i) * 4] = r[si + i];
      rgba[(di + i) * 4 + 1] = g[si + i];
      rgba[(di + i) * 4 + 2] = b[si + i];
      rgba[(di + i) * 4 + 3] = 255; // vollstaendig, ohne Fade
    }
  }
  const maxTex = renderer.capabilities.maxTextureSize;
  const sc = Math.min(1, maxTex / w, maxTex / h);
  const cw = Math.max(1, Math.round(w * sc)), ch = Math.max(1, Math.round(h * sc));
  const tmp = document.createElement('canvas'); tmp.width = w; tmp.height = h;
  tmp.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);
  const canvas = document.createElement('canvas'); canvas.width = cw; canvas.height = ch;
  canvas.getContext('2d').drawImage(tmp, 0, 0, cw, ch);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  const [xMin, zA] = projectXZ(lonMin, latMin);
  const [xMax, zB] = projectXZ(lonMax, latMax);
  const planeW = Math.abs(xMax - xMin), planeH = Math.abs(zB - zA);
  const geo = new THREE.PlaneGeometry(planeW, planeH);
  const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });
  const plane = new THREE.Mesh(geo, mat);
  plane.rotation.x = -Math.PI / 2;
  plane.position.set((xMin + xMax) / 2, 0, (zA + zB) / 2);
  return plane;
}

async function buildPanoramaGroup() {
  panoRiverObjs = {};
  const g = new THREE.Group();
  const base = new THREE.Group();   // fest (gedimmter Hintergrund + gelbe Ebene)
  const layer = new THREE.Group();  // bewegt sich mit dem Z-Slider
  g.add(base); g.add(layer);
  panoramaLayer = layer;

  // Einfache Uebersicht (KEINE Topokarte): blaue Ebene + 2D Laenderformen
  const [gx0, gz0] = projectXZ(GBOX.lonMin, GBOX.latMin);
  const [gx1, gz1] = projectXZ(GBOX.lonMax, GBOX.latMax);
  const bMinX = Math.min(gx0, gx1), bMaxX = Math.max(gx0, gx1);
  const bMinZ = Math.min(gz0, gz1), bMaxZ = Math.max(gz0, gz1);
  panoramaBounds = { minX: bMinX, maxX: bMaxX, minZ: bMinZ, maxZ: bMaxZ };

  // Topokarte (OpenTopoMap) als Hintergrund
  const g2 = await buildPanoramaTopo();
  base.add(g2);
  // graue Ebene unter der Topokarte (falls Transparenz/Luecken)
  const grey = new THREE.Mesh(
    new THREE.PlaneGeometry((bMaxX - bMinX) * 1.05, (bMaxZ - bMinZ) * 1.05),
    new THREE.MeshBasicMaterial({ color: 0x33415a, side: THREE.DoubleSide })
  );
  grey.rotation.x = -Math.PI / 2;
  grey.position.set((bMinX + bMaxX) / 2, -0.02, (bMinZ + bMaxZ) / 2);
  base.add(grey);

  // alle Fluesse aus conf.yaml flach zeichnen: dunkel, breit, mit hellblauer 2px-Kontur
  const outlineMat = new LineMaterial({ color: 0x88c0ff, linewidth: 9, worldUnits: false });
  const fillMat = new LineMaterial({ color: 0x0a2a6b, linewidth: 5, worldUnits: false });
  outlineMat.resolution.set(window.innerWidth, window.innerHeight);
  fillMat.resolution.set(window.innerWidth, window.innerHeight);
  panoramaLineMats.push(outlineMat, fillMat);
  for (const rv of RIVERS) {
    let ways = null;
    try {
      const res = await fetch('./' + rv.key + '.json');
      if (res.ok) { const d = await res.json(); ways = d.ways; }
    } catch (e) { console.warn('Panorama: Flussdaten fehlen:', rv.key, e); }
    if (!ways) continue;
    for (const w of ways) {
      const pts = [];
      for (const p of w) { const [x, z] = projectXZ(p[0], p[1]); pts.push(x, 0, z); }
      if (pts.length < 6) continue;
      const geo = new LineGeometry();
      geo.setPositions(pts);
      const outline = new Line2(geo, outlineMat);
      outline.position.y = PANORAMA_LIFT - 0.02;
      outline.renderOrder = 1;
      outline.userData.riverKey = rv.key;
      const fill = new Line2(geo, fillMat);
      fill.position.y = PANORAMA_LIFT + 0.02;
      fill.renderOrder = 2;
      fill.userData.riverKey = rv.key;
      layer.add(outline);
      layer.add(fill);
      (panoRiverObjs[rv.key] = panoRiverObjs[rv.key] || []).push({ obj: outline, mat: outlineMat });
      (panoRiverObjs[rv.key] = panoRiverObjs[rv.key] || []).push({ obj: fill, mat: fillMat });
    }
  }

  // Hauptstaedte (Kontinental-Europa) als kleine Kreise wie in der Normalansicht
  for (const cap of CAPITALS) {
    const [x, z] = projectXZ(cap.lon, cap.lat);
    const mk = new THREE.Mesh(
      new THREE.RingGeometry(0.35, 0.5, 28),
      new THREE.MeshBasicMaterial({ color: 0xff4d6d, side: THREE.DoubleSide, transparent: true, opacity: 0.9 })
    );
    mk.rotation.x = -Math.PI / 2;
    mk.position.set(x, PANORAMA_LIFT + 0.05, z);
    layer.add(mk);
    const div = document.createElement('div');
    div.className = 'capital-label';
    div.textContent = cap.name;
    const lbl = new CSS2DObject(div);
    lbl.position.set(x + 0.9, PANORAMA_LIFT + 0.6, z);
    layer.add(lbl);
    panoramaLabels.push(lbl);
  }

  scene.add(g);
  panoramaGroup = g;
  panoramaBuilt = true;
}

async function enterPanorama() {
  panoramaMode = true;
  riverGroup.visible = false;
  for (const c of capitalObjs) { c.marker.visible = false; if (c.label) c.label.visible = false; }
  for (const o of cityObjs) { o.marker.visible = false; if (o.lbl) o.lbl.visible = false; if (o.stem) o.stem.visible = false; if (o.disc) o.disc.visible = false; }
  if (!panoramaBuilt) await buildPanoramaGroup();
  panoramaGroup.visible = true;
  panoramaLabels.forEach((l) => { l.visible = true; });
  if (topoGroup) topoGroup.visible = false; // Rhein/Reise-Topokarte ausblenden (Panorama hat eigene)
  heightPlane.visible = false;
  if (gridHelper) gridHelper.visible = false; // gedimmter Hintergrund
  // senkrechte Draufsicht, keine Rotation, ganze Topokarte erfassen
  const b = panoramaBounds || (() => {
    const [a, z0] = projectXZ(GBOX.lonMin, GBOX.latMin);
    const [c, z1] = projectXZ(GBOX.lonMax, GBOX.latMax);
    return { minX: Math.min(a, c), maxX: Math.max(a, c), minZ: Math.min(z0, z1), maxZ: Math.max(z0, z1) };
  })();
  const ccx = (b.minX + b.maxX) / 2, ccz = (b.minZ + b.maxZ) / 2;
  const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
  camera.position.set(ccx, span * 1.05 * 1.15, ccz);
  controls.target.set(ccx, 0, ccz);
  controls.autoRotate = false;
  controls.update();
  updateCursor();
}

function exitPanorama() {
  if (!panoramaMode) return;
  panoramaMode = false;
  if (panoramaGroup) { panoramaGroup.visible = false; panoramaLabels.forEach((l) => { l.visible = false; }); }
  riverGroup.visible = true;
  for (const c of capitalObjs) { c.marker.visible = true; if (c.label) c.label.visible = true; }
  for (const o of cityObjs) { o.marker.visible = true; if (o.lbl) o.lbl.visible = true; if (o.stem) o.stem.visible = true; if (o.disc) o.disc.visible = true; }
  if (gridHelper) gridHelper.visible = true;
  riverTooltip.style.display = 'none';
  camera.position.copy(initialCam);
  controls.target.copy(initialTarget);
  controls.update();
  applyGround();
}

function requestTopo() {
  if (topoGroup) { topoState.want = !topoState.want; applyGround(); syncModeButtons(); return; }
  topoState.want = !topoState.want;
  if (topoState.want) buildOpenTopoMap(); else applyGround();
  syncModeButtons();
}
ensureTopoCredit();
const topoBtn = document.getElementById('topo-btn');
topoBtn.addEventListener('click', requestTopo);

function syncModeButtons() {
  topoBtn.classList.toggle('active', !!topoState.want);
  panoBtn.classList.toggle('active', !!panoTravel);
  animBtn.classList.toggle('active', !!travelMode);
}

// Klick auf die Stadtkugel (unabhaengig von der Ebene) und auf Fluesse
const raycaster = new THREE.Raycaster();
raycaster.params.Line2 = { threshold: 5 };
raycaster.params.Line.threshold = 3;
const ndc = new THREE.Vector2();
let pickDown = null;
renderer.domElement.addEventListener('pointerdown', (e) => { pickDown = { x: e.clientX, y: e.clientY }; });
function pickRiverKey() {
  let hits;
  if (panoramaMode && panoramaGroup) {
    hits = raycaster.intersectObjects([panoramaGroup], true);
  } else if (riverTube || riverLine) {
    const objs = [];
    if (riverTube) objs.push(riverTube);
    if (riverLine) objs.push(riverLine);
    hits = raycaster.intersectObjects(objs, false);
  } else {
    return null;
  }
  for (const h of hits) {
    let o = h.object;
    while (o) { if (o.userData && o.userData.riverKey) return o.userData.riverKey; o = o.parent; }
  }
  return null;
}
function selectRiverFromDropdown(key) {
  if (!key) return;
  // Im Panorama Modus:
  //  - ohne aktiven Weg-in-Panorama (topo/Lupe) -> normale 3D-Flussansicht
  //  - mit aktivem Weg-in-Panorama (topo-Button geklickt) -> Lupe/Travel fuer diesen Fluss
  if (panoramaMode) {
    if (panoTravel) startPanoRiver(key);
    else selectRiver(key);
    return;
  }
  selectRiver(key);
}
// Hover-Tooltip mit Flussnamen in der Panorama-Ansicht
const riverTooltip = document.createElement('div');
riverTooltip.style.cssText = 'position:fixed;pointer-events:none;z-index:50;display:none;' +
  'background:rgba(10,16,28,.85);color:#cfe3ff;border:1px solid #2a6cff;border-radius:6px;' +
  'padding:3px 8px;font:13px system-ui;white-space:nowrap;';
document.body.appendChild(riverTooltip);
// Hover in Panorama (ohne Animation): Liste aller Fluss-Labels
const panoAllLabels = document.createElement('div');
panoAllLabels.style.cssText = 'position:fixed;left:20px;top:84px;z-index:50;display:none;' +
  'background:rgba(10,16,28,.82);color:#cfe3ff;border:1px solid #2a6cff;border-radius:8px;' +
  'padding:8px 10px;font:13px system-ui;max-height:62vh;overflow:auto;';
panoAllLabels.innerHTML = RIVERS.map((r) =>
      '<div data-key="' + r.key + '" style="cursor:pointer;padding:2px 4px;white-space:nowrap">' + riverLabelByKey(r.key) + '</div>'
).join('');
panoAllLabels.querySelectorAll('div[data-key]').forEach((el) => {
  el.addEventListener('click', () => selectRiverFromDropdown(el.dataset.key));
});
document.body.appendChild(panoAllLabels);
function riverLabelByKey(key) {
  const t = TEXTS[key + '-label'];
  if (t != null && t !== '') return t;
  const r = RIVERS.find((x) => x.key === key);
  return r ? r.label : key;
}
// Hover-Highlight: Fluss unter dem Mauszeiger waehrend der Auswahl weiss einfaerben
const panoHiMat = new LineMaterial({ color: 0xffffff, linewidth: 11, worldUnits: false });
panoHiMat.resolution.set(window.innerWidth, window.innerHeight);
let hoveredRiverKey = null;
function highlightRiver(key) {
  if (hoveredRiverKey === key) return;
  if (hoveredRiverKey && panoRiverObjs[hoveredRiverKey]) {
    for (const e of panoRiverObjs[hoveredRiverKey]) e.obj.material = e.mat;
  }
  hoveredRiverKey = key;
  if (key && panoRiverObjs[key]) {
    for (const e of panoRiverObjs[key]) e.obj.material = panoHiMat;
  }
}
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!panoramaMode || travelMode) {
    riverTooltip.style.display = 'none';
    panoAllLabels.style.display = 'none';
    if (panoPhase === 'select') cloudCursor.style.display = 'none';
    return;
  }
  const rect = renderer.domElement.getBoundingClientRect();
  ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  const key = pickRiverKey();
  if (key) {
    highlightRiver(key);   // Fluss unter dem Cursor waehrend der Reise weiss hervorheben
    riverTooltip.textContent = riverLabelByKey(key);
    riverTooltip.style.left = (e.clientX + 12) + 'px';
    riverTooltip.style.top = (e.clientY + 12) + 'px';
    riverTooltip.style.display = 'block';
  } else {
    highlightRiver(null);
    riverTooltip.style.display = 'none';
  }
  // Wolke folgt der Maus nur in der Auswahl; im Lauf steckt sie in der Lupe
  if (panoPhase === 'select') {
    cloudCursor.style.left = (e.clientX + 26) + 'px';
    cloudCursor.style.top = (e.clientY - 6) + 'px';
    cloudCursor.style.display = 'block';
  }
});
renderer.domElement.addEventListener('pointerleave', () => {
  riverTooltip.style.display = 'none';
  panoAllLabels.style.display = 'none';
  highlightRiver(null);
});
// Maus ausserhalb einer zentralen 85%-Box -> Panorama/Travel deaktivieren

renderer.domElement.addEventListener('click', (e) => {
  if (travelMode) return;
  if (pickDown) {
    const dx = e.clientX - pickDown.x, dy = e.clientY - pickDown.y;
    if (Math.hypot(dx, dy) > 6) return; // Drehgeste, kein Klick
  }
  if (panoTravel) {  // Auswahl oder Lauf: Klick auf anderen Fluss startet sofort dort neu
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const key = pickRiverKey();
    if (key) startPanoRiver(key);
    return;
  }
  const rect = renderer.domElement.getBoundingClientRect();
  ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  if (!panoramaMode) {
    const hits = raycaster.intersectObjects(cityObjs.map((o) => o.marker), false);
    if (hits.length) {
      const o = cityObjs.find((c) => c.marker === hits[0].object);
      if (o) { focusCity(o); return; }
    }
  }
  const key = pickRiverKey();
  if (key) selectRiverFromDropdown(key);
});

// ---- Hoehen-Marker (Ebene) ----
const heightPlane = new THREE.Mesh(
  new THREE.PlaneGeometry(TARGET * 1.4, TARGET * 1.4),
  new THREE.MeshBasicMaterial({
    color: 0x2a6cff, transparent: true, opacity: 0.18,
    side: THREE.DoubleSide, depthWrite: false
  })
);
heightPlane.rotation.x = -Math.PI / 2;
scene.add(heightPlane);

// ---- Legende / Interaktion ----
const legendBar = document.getElementById('legend-bar');
const legendScale = document.getElementById('legend-scale');
const legendTop = document.getElementById('legend-top');
const legendBottom = document.getElementById('legend-bottom');
// Feste Z-Achsen-Skala 0..2500 m: oben weiss (2500 m), unten (letzte 50 m) schwarz, dazwischen Verlauf
const BLACK_FRAC = 50 / Z_TOP; // unterste 50 m durchgehend schwarz
legendBar.style.background =
  `linear-gradient(to bottom, #ffffff 0%, #000000 ${((1 - BLACK_FRAC) * 100).toFixed(2)}%, #000000 100%)`;
legendTop.textContent = Z_TOP + ' m';
legendBottom.textContent = '0 m';

// Staedte als gestrichelte Linien in der Z-Achsen-Legende (Hoehe der Stadt)
function updateLegendCities(cities) {
  legendScale.querySelectorAll('.city-mark').forEach((e) => e.remove());
  const LABEL_H = 14; // grob die Hoehe einer Stadtbeschriftung (px)
  const items = cities.map((c) => {
    const f = Math.min(1, Math.max(0, c.alt / Z_TOP));
    return { c, top: (1 - f) * BAR_H };
  }).sort((a, b) => a.top - b.top);
  // Cluster benachbarter (zu naher) Beschriftungen bilden
  let i = 0;
  while (i < items.length) {
    let j = i;
    while (j + 1 < items.length && Math.abs(items[j + 1].top - items[j].top) < LABEL_H) j++;
    const len = j - i + 1;
    if (len === 2) {
      // Paar zu nah: Beschriftungen horizontal versetzen (auseinander schieben)
      items[i].offset = 22;
      items[i + 1].offset = 60;
    } else {
      for (let k = i; k <= j; k++) items[k].offset = 22; // einzeln oder 3+ : nichts tun
    }
    i = j + 1;
  }
  for (const it of items) {
    const mk = document.createElement('div');
    mk.className = 'city-mark';
    mk.style.top = it.top + 'px';
    mk.title = cityName(it.c) + ' · ' + it.c.alt + ' m';
    const nm = document.createElement('span');
    nm.className = 'city-mark-name';
    nm.textContent = cityName(it.c);
    nm.style.right = it.offset + 'px';
    mk.appendChild(nm);
    legendScale.appendChild(mk);
  }
}

// separate Gefaelle-Legende (oben = steil/rot, unten = flach/dunkelblau)
const descBar = document.getElementById('desc-bar');
const descTop = document.getElementById('desc-top');
const descBottom = document.getElementById('desc-bottom');
descBar.style.background =
  `linear-gradient(to top, ${DESC_STOPS.map((s) => colorFor(s[0] * DESC_MAX).getStyle() + ' ' + (s[0] * 100).toFixed(0) + '%').join(', ')})`;
descTop.textContent = (DESC_MAX * 10).toFixed(0);
descBottom.textContent = '0';

const BAR_H = 220;
const cursor = document.getElementById('cursor');
const zval = cursor.querySelector('.zval');
let currentElev = 0; // Start: ganzer Fluss sichtbar (nichts unter 0 m weggeschnitten)
let travelMode = false; // Travel-of-Rain-Modus (ganzer Fluss sichtbar, Clip deaktiviert)
let savedElev = 0; // Clip-Hoehe vor dem Travel-Modus (beim Beenden wiederhergestellt)

function updateCursor() {
  const f = currentElev / Z_TOP;
  const clamped = Math.min(1, Math.max(0, f));
  cursor.style.top = ((1 - clamped) * BAR_H - 7) + 'px';
  zval.textContent = 'H = ' + currentElev.toFixed(0) + ' m';
  if (travelMode) return; // im Travel-Modus nur Cursor zeigen, Clip + Sichtbarkeit bleiben unveraendert
  if (panoramaMode) {
    if (panoramaLayer) panoramaLayer.position.y = currentElev * Y_SCALE;
    return;
  }
  const sceneY = currentElev * Y_SCALE;
  heightPlane.position.y = sceneY;
  clipPlane.constant = -sceneY; // behaelt y >= sceneY (schneidet darunter)
  updateVisibility();
}
function setValue(v) {
  currentElev = Math.min(Z_TOP, Math.max(0, v));
  updateCursor();
}
updateCursor();
legendBar.addEventListener('click', (e) => {
  const rect = legendBar.getBoundingClientRect();
  const f = 1 - (e.clientY - rect.top) / rect.height;
  setValue(f * Z_TOP);
});
const step = Z_TOP / 50;
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && (travelMode || panoTravel)) {
    e.preventDefault();
    if (animPopup.style.display === 'block') { animPopup.click(); return; } // Popup schliesst und startet
    if (animActive) {                                                        // Pause
      animActive = false;
      controls.autoRotate = false;                                          // Blickperspektive waehrend der Pause einfrieren
      animPauseEl.style.display = 'block';                                 // grosser "PAUSE"-Schriftzug
      if (travelMode && !panoTravel) controls.enabled = true;              // im normalen Travel darf waehrend der Pause geneigt werden
    } else {                                                                // Fortsetzen an der aktuellen Position
      animDistLabel.style.display = 'block';
      animActive = true;
      animPauseEl.style.display = 'none';
      if (travelMode && !panoTravel) controls.enabled = false;             // Kamera folgt wieder dem Flusspunkt
      controls.autoRotate = false;                                         // im Panorama-Reisemodus niemals rotieren
    }
    return;
  }
  if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { setValue(currentElev + step); e.preventDefault(); }
  else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { setValue(currentElev - step); e.preventDefault(); }
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  labelRenderer.setSize(window.innerWidth, window.innerHeight);
  for (const m of panoramaLineMats) m.resolution.set(window.innerWidth, window.innerHeight);
});

// ---------- Travel of Rain: Rhein-Animation (20 km/s, simulierte Reisezeit) ----------
// rhein.json enthaelt viele einzelne OSM-Segmente (ways) in beliebiger Reihenfolge.
// Fuer die Animation werden sie zu einem durchgaengigen Hauptstrom (Quelle -> Meer)
// zusammengefuegt, indem ab dem hoechsten Punkt immer das tiefer gelegene, verbundene
// Segment angehaengt wird (greedy Abwaerts). So folgt der Punkt dem echten Flusslauf.
function buildMainStem(ways) {
  // Kuerzester Pfad von Quelle nach Muendung ueber den Wege-Graphen. Das
  // behandelt Seen/Verzweigungen korrekt und vermeidet Ruecklaeufe zur Quelle
  // (z.B. Ticino am Lago Maggiore), im Gegensatz zur rein gierigen Verkettung.
  const keyOf = (p) => Math.round(p[0] * 1e5) + ',' + Math.round(p[1] * 1e5);
  const adj = new Map();
  const link = (u, v, w) => {
    if (!adj.has(u)) adj.set(u, []);
    adj.get(u).push({ v, w });
    if (!adj.has(v)) adj.set(v, []);
    adj.get(v).push({ u, w });
  };
  for (const w of ways) link(keyOf(w[0]), keyOf(w[w.length - 1]), w);

  // naechste Wege-Endpunkte zu Quelle / Muendung
  let srcKey = null, mtKey = null, sd = 1e18, md = 1e18;
  for (const w of ways) {
    for (const p of [w[0], w[w.length - 1]]) {
      const k = keyOf(p);
      const ds = Math.hypot(p[0] - data.source[0], p[1] - data.source[1]);
      if (ds < sd) { sd = ds; srcKey = k; }
      const dm = Math.hypot(p[0] - data.mouth[0], p[1] - data.mouth[1]);
      if (dm < md) { md = dm; mtKey = k; }
    }
  }

  const wlen = (w) => {
    let L = 0;
    for (let i = 1; i < w.length; i++) {
      const a = projectXZ(w[i - 1][0], w[i - 1][1]);
      const b = projectXZ(w[i][0], w[i][1]);
      L += Math.hypot(a[0] - b[0], a[1] - b[1]);
    }
    return L;
  };

  // Dijkstra (Gewicht = Wege-Laenge in Szene-Einheiten)
  const dist = new Map(); dist.set(srcKey, 0);
  const prev = new Map();
  const pq = [[0, srcKey]];
  while (pq.length) {
    pq.sort((x, y) => x[0] - y[0]);
    const [dd, u] = pq.shift();
    if (dd > (dist.get(u) ?? 1e18)) continue;
    if (u === mtKey) break;
    for (const e of (adj.get(u) || [])) {
      const nd = dd + wlen(e.w);
      if (nd < (dist.get(e.v) ?? 1e18)) {
        dist.set(e.v, nd);
        prev.set(e.v, { u, w: e.w });
        pq.push([nd, e.v]);
      }
    }
  }

  // Wege in Quell->Muendung-Reihenfolge zusammenbauen
  const ordered = [];
  let cur = mtKey, guard = 0;
  while (cur !== srcKey && guard++ < ways.length + 5) {
    const pr = prev.get(cur);
    if (!pr) break;
    const w = pr.w;
    ordered.push(keyOf(w[0]) === pr.u ? w : w.slice().reverse());
    cur = pr.u;
  }
  ordered.reverse();

  const path = [];
  for (const w of ordered) for (const p of w) path.push(p);
  if (path.length === 0) {
    for (const w of ways) for (const p of w) path.push(p); // Fallback
  }
  return path;
}
let riverSamples = [];
let totalKm = 1;
let viewCx = 0, viewCz = 0, viewH = 100;
const followH = 20; // Aufsicht-Zoom: etwas mehr Rhein sichtbar, Kamera folgt dem Punkt
const savedFog = scene.fog;
let initialCam = camera.position.clone();
let initialTarget = controls.target.clone();

// Raumt die Fluss-Gruppe auf (Geometrien/Materialien freigeben)
function clearGroup(g) {
  for (let i = g.children.length - 1; i >= 0; i--) {
    const c = g.children[i];
    g.remove(c);
    if (c.geometry) c.geometry.dispose();
    if (c.material) {
      if (Array.isArray(c.material)) c.material.forEach((m) => m.dispose());
      else c.material.dispose();
    }
  }
}

// Baut alle flussspezifischen Objekte (Punktwolke, dicke Tube, Staedte, Hoehenlinien,
// Animations-Pfad) fuer den gewaehlten Fluss neu auf und richtet die Kamera aus.
async function buildRiver(key) {
  currentKey = key;
  data = RIVER_DATA[key];
  rawData = [];
  for (const w of data.ways) for (const p of w) rawData.push(p);
  riverSource = data.source;

  clearGroup(riverGroup);
  cityObjs = [];
  contourLevels = [];

  // --- Staedte ausschliesslich aus conf.yaml (cities) via RIVER_CITIES ---
  const rv = RIVERS.find((r) => r.key === key);
  const shown = RIVER_CITIES.filter((c) => c.river === key);
  for (const c of shown) {
    const [x, z] = projectXZ(c.lon, c.lat);
    const citySize = (CONF.cities && CONF.cities.size != null) ? CONF.cities.size : 1.0;
    const radius = citySize * (0.5 + Math.sqrt(c.pop) / 1000); // Marker groesser mit Einwohnerzahl
    const yBase = Math.max(c.alt, 0) * Y_SCALE;    // Stadt auf ihrer echten Hoehe
    const markerY = yBase + radius;
    const elev = c.alt;
    const mat = new THREE.MeshBasicMaterial({ color: 0xffd24a });
    const marker = new THREE.Mesh(new THREE.SphereGeometry(radius, 14, 14), mat);
    marker.position.set(x, markerY, z);
    riverGroup.add(marker);
    const stemGeo = new THREE.BufferGeometry();
    stemGeo.setAttribute('position', new THREE.Float32BufferAttribute([x, 0, z, x, yBase, z], 3));
    const stem = new THREE.Line(stemGeo, new THREE.LineBasicMaterial({ color: 0xffd24a, transparent: true, opacity: 0.6 }));
    riverGroup.add(stem);
    // flache Kreisscheibe (nur im Travel-Modus sichtbar)
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(radius * 1.3, 28),
      new THREE.MeshBasicMaterial({ color: 0xffd24a, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
    );
    disc.rotation.x = -Math.PI / 2; // flach auf den Boden
    disc.position.set(x, 0.05, z);
    disc.visible = travelMode;
    riverGroup.add(disc);
    // Einwohnerzahl als Beschriftung neben dem Punkt (Format xyz'000)
    const div = document.createElement('div');
    div.className = 'city-label';
    div.textContent = c.inConf ? fmtPop(c.pop) : '';
    const lbl = new CSS2DObject(div);
    lbl.position.set(x, markerY + 0.3, z);
    riverGroup.add(lbl);
    const obj = { name: c.name, lon: c.lon, lat: c.lat, elev, mat, marker, stem, lbl, disc };
    cityObjs.push(obj);
    div.style.cursor = 'pointer';
    div.title = 'Ebene 20 m unter ' + cityName(c) + ' setzen';
    div.addEventListener('click', () => focusCity(obj));
  }
  updateLegendCities(shown);

  // --- Hoehenlinien (FABDEM-Isolinien, 100 m) ---
  let contours = null;
  try {
    const cres = await fetch('./' + rv.contours, { cache: 'no-store' });
    LOADED_FILES.push('./' + rv.contours);
    if (cres.ok) contours = await cres.json();
    else console.warn('Hoehenlinien fehlen:', rv.contours);
  } catch (e) {
    console.warn('Hoehenlinien konnten nicht geladen werden:', rv.contours, e);
  }
  if (contours) for (const lvl of contours.levels) {
    const pos = [];
    const y = lvl.elev * Y_SCALE;
    for (const seg of lvl.segments) {
      const [x1, z1] = projectXZ(seg[0][0], seg[0][1]);
      const [x2, z2] = projectXZ(seg[1][0], seg[1][1]);
      pos.push(x1, y, z1, x2, y, z2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const m = new THREE.LineBasicMaterial({ color: 0xbcd0e0, transparent: true, opacity: 0.55 });
    const lines = new THREE.LineSegments(g, m);
    riverGroup.add(lines);
    contourLevels.push({ elev: lvl.elev, lines });
  }

  // --- Hauptstrom + Animation samples + navy Punktwolke + dicke Tube ---
  const path = buildMainStem(data.ways);
  const acc0 = [0];
  for (let i = 1; i < path.length; i++) {
    const p = path[i], q = path[i - 1];
    const dx = (p[0] - q[0]) * cosLat * 111.32, dy = (p[1] - q[1]) * 110.57;
    acc0.push(acc0[i - 1] + Math.hypot(dx, dy));
  }
  const arr = [];
  const STEP = 0.5;
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    const [x, z] = projectXZ(p[0], p[1]);
    const y = p[2] * Y_SCALE;
    if (i > 0) {
      const q = path[i - 1];
      const [qx, qz] = projectXZ(q[0], q[1]);
      const qy = q[2] * Y_SCALE;
      const dist = Math.hypot(x - qx, z - qz);
      const k = Math.ceil(dist / STEP);
      if (k > 1) {
        for (let j = 1; j < k; j++) {
          const t = j / k;
          arr.push({
            d: acc0[i - 1] + (acc0[i] - acc0[i - 1]) * t,
            x: qx + (x - qx) * t, z: qz + (z - qz) * t, y: qy + (y - qy) * t,
            desc: q[3] + (p[3] - q[3]) * t
          });
        }
      }
    }
    arr.push({ d: acc0[i], x, z, y, desc: p[3] });
  }
  riverSamples = arr;
  totalKm = riverSamples.length ? riverSamples[riverSamples.length - 1].d : 1;

  // Staedte mit Fluss-Distanz (fuer Reisemodus-Hinweis: naechste Stadt / Muendung)
  travelCityList = [];
  for (const c of shown) {
    const [cx, cz] = projectXZ(c.lon, c.lat);
    let best = Infinity, bd = 0;
    for (const s of riverSamples) {
      const dd = (s.x - cx) * (s.x - cx) + (s.z - cz) * (s.z - cz);
      if (dd < best) { best = dd; bd = s.d; }
    }
    travelCityList.push({ name: cityName(c), alt: c.alt, d: bd });
  }
  travelCityList.sort((a, b) => a.d - b.d);

  const ptsN = riverSamples.length;
  const ptsPos = new Float32Array(ptsN * 3);
  const ptsCol = new Float32Array(ptsN * 3);
  gradientColors = [];
  for (let i = 0; i < ptsN; i++) {
    const s = riverSamples[i];
    ptsPos.set([s.x, s.y, s.z], i * 3);
    const c = colorFor(s.desc);          // Ursprungs-Gradient (Abfallrate)
    gradientColors.push(c);
    ptsCol.set([c.r, c.g, c.b], i * 3);
  }
  const ptsGeo = new THREE.BufferGeometry();
  ptsGeo.setAttribute('position', new THREE.BufferAttribute(ptsPos, 3));
  ptsGeo.setAttribute('color', new THREE.BufferAttribute(ptsCol, 3));
  const points = new THREE.Points(ptsGeo, new THREE.PointsMaterial({ size: 0.3, vertexColors: true, sizeAttenuation: true, clippingPlanes: [clipPlane] }));
  riverGroup.add(points);
  riverPoints = points;
  // durchgehende Linie (immer sichtbar, damit der Fluss auch ohne Topo-Karte als Linie erscheint)
  const line = new THREE.Line(ptsGeo, new THREE.LineBasicMaterial({ vertexColors: true, clippingPlanes: [clipPlane] }));
  riverGroup.add(line);
  riverLine = line;
  riverLine.userData.riverKey = key;

  if (riverSamples.length) {
    const curvePts = riverSamples.map((s) => new THREE.Vector3(s.x, s.y, s.z));
    const curve = new THREE.CatmullRomCurve3(curvePts, false, 'catmullrom', 0.2);
    const tubeGeo = new THREE.TubeGeometry(curve, riverSamples.length, 0.42, 10, false);
    const tubeMat = new THREE.MeshBasicMaterial({ color: 0x66ccff, clippingPlanes: [clipPlane] });
    const tube = new THREE.Mesh(tubeGeo, tubeMat);
    riverGroup.add(tube);
    riverTube = tube;
    riverTube.userData.riverKey = key;
  }

  // Kamera auf den Fluss ausrichten
  let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity;
  for (const s of riverSamples) {
    if (s.x < mnx) mnx = s.x; if (s.x > mxx) mxx = s.x;
    if (s.z < mnz) mnz = s.z; if (s.z > mxz) mxz = s.z;
  }
  viewCx = (mnx + mxx) / 2; viewCz = (mnz + mxz) / 2;
  viewH = Math.max(mxx - mnx, mxz - mnz) * 1.3 + 50;
  camera.position.set(viewCx, viewH * 0.7, viewCz + viewH * 0.6 * 0.7);
  controls.target.set(viewCx, 0, viewCz);
  controls.update();
  initialCam = camera.position.clone();
  initialTarget = controls.target.clone();

  // Animation zuruecksetzen
  animActive = false;
  animMarker.visible = false;
  animHud.style.display = 'none';
  animDistLabel.style.display = 'none';
  animPopup.style.display = 'none';
  travelMode = false;
  camera.up.set(0, 1, 0);
  scene.fog = savedFog;
  clipPlane.constant = -currentElev * Y_SCALE;
  for (const o of capitalObjs) { o.marker.visible = !topoGroup; o.label.visible = !topoGroup; }

  updateVisibility();
  applyGround();
  applyRiverStyle();
}

// Fluss-Darstellung an den Topo-Karten-Modus anpassen:
//  - OHNE Topo: Original-Gradient (Abfallrate), KEINE dicke Tube
//  - MIT Topo:  navy-farben, dicke Tube sichtbar
function applyRiverStyle() {
  if (!riverPoints) return;
  const navy = !!topoState.want;
  const colAttr = riverPoints.geometry.getAttribute('color');
  const nav = new THREE.Color(0x0a1f5c);
  for (let i = 0; i < gradientColors.length; i++) {
    const c = navy ? nav : gradientColors[i];
    colAttr.setXYZ(i, c.r, c.g, c.b);
  }
  colAttr.needsUpdate = true;
  if (riverTube) riverTube.visible = navy;
}

function sampleAt(d) {
  if (d <= 0) return riverSamples[0];
  if (d >= totalKm) return riverSamples[riverSamples.length - 1];
  let lo = 0, hi = riverSamples.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (riverSamples[mid].d < d) lo = mid + 1; else hi = mid; }
  const a = riverSamples[lo - 1], b = riverSamples[lo];
  const t = (d - a.d) / ((b.d - a.d) || 1);
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, y: a.y + (b.y - a.y) * t };
}

// Simulierte Reisezeit (Tage) ab Quelle. Bodensee = 1 h (statt mehrere Jahre).
const SPEED_WP = [
  [0, 0], [35, 0.75], [100, 2.0],   [130, 2.0 + 1 / 24],
  [400, 2.0 + 1 / 24 + 0.25], [480, 2.0 + 1 / 24 + 0.75], [550, 2.0 + 1 / 24 + 1.5],
  [620, 2.0 + 1 / 24 + 2.5], [900, 2.0 + 1 / 24 + 5.5], [1100, 2.0 + 1 / 24 + 7.5]
];
function simDays(d) {
  if (d <= 0) return 0;
  for (let i = 1; i < SPEED_WP.length; i++) {
    if (d <= SPEED_WP[i][0]) {
      const d0 = SPEED_WP[i - 1][0], t0 = SPEED_WP[i - 1][1];
      const d1 = SPEED_WP[i][0], t1 = SPEED_WP[i][1];
      const f = (d - d0) / ((d1 - d0) || 1);
      return t0 + (t1 - t0) * f;
    }
  }
  return SPEED_WP[SPEED_WP.length - 1][1];
}
function fmtDur(days) {
  days = Math.max(0, days);
  const d = Math.floor(days);
  const h = Math.floor((days - d) * 24);
  const m = Math.floor(((days - d) * 24 - h) * 60);
  return d + ' Tage ' + String(h).padStart(2, '0') + ' h ' + String(m).padStart(2, '0') + ' m';
}
function currentSpeedKmPerDay(d) {
  const a = Math.max(0, d - 1), b = Math.min(totalKm, d + 1);
  const dt = simDays(b) - simDays(a);
  if (dt <= 1e-9) return Infinity;
  return (b - a) / dt;
}

const animBtn = document.getElementById('anim-btn');
const animPopup = document.getElementById('anim-popup');
const animHud = document.getElementById('anim-hud');
const animMarker = new THREE.Mesh(
  new THREE.SphereGeometry(0.6, 16, 16),
  new THREE.MeshBasicMaterial({ color: 0xff3b3b })
);
animMarker.visible = false;
scene.add(animMarker);

const animDistLabel = document.createElement('div');
animDistLabel.style.cssText = 'position:fixed;pointer-events:none;background:rgba(10,15,26,.85);' +
  'color:#ffd2d2;border:1px solid #5a2b2b;border-radius:6px;padding:3px 7px;font:12px system-ui;' +
  'z-index:60;display:none;transform:translate(16px,-50%);';
document.body.appendChild(animDistLabel);

// Grosser "PAUSE"-Schriftzug hinter der Zeitanzeige (waehrend der Pause)
const animPauseEl = document.createElement('div');
animPauseEl.textContent = 'PAUSE';
animPauseEl.style.cssText = 'position:fixed;left:50%;top:92px;transform:translateX(-50%);' +
  'pointer-events:none;z-index:39;color:rgba(255,210,210,.9);' +
  'font:800 72px/1 system-ui,sans-serif;letter-spacing:8px;' +
  'text-shadow:0 0 14px #000,0 0 4px #000;display:none;';
document.body.appendChild(animPauseEl);

// Reisemodus: Flussname + naechste Stadt + Muendung (unter dem Zeit-Cursor, gross)
let travelCityList = [];
const animTravelLine = document.createElement('div');
animTravelLine.style.cssText = 'position:fixed;right:20px;top:calc(50% + 178px);z-index:46;' +
  'pointer-events:none;color:#eaf1f8;font:600 18px/1.3 system-ui,sans-serif;' +
  'white-space:nowrap;text-shadow:0 0 6px #000,0 0 6px #000;display:none;';
document.body.appendChild(animTravelLine);
function updateTravelLine() {
  const rv = RIVERS.find((r) => r.key === currentKey);
    const riverName = rv ? riverLabelByKey(rv.key) : currentKey;
  const mouthName = (rv && rv.mouthKey && TEXTS['mouth-' + rv.mouthKey]) || '';
  const mouthAlt = riverSamples.length ? Math.max(0, riverSamples[riverSamples.length - 1].y / Y_SCALE) : 0;
  let line = riverName;
  let nextCity = null;
  for (const c of travelCityList) { if (c.d > animDist + 0.5) { nextCity = c; break; } }
  if (nextCity) line += '   → nächste: ' + cityName(nextCity) + ' (' + Math.round(nextCity.alt) + ' m ü. M.)';
  line += '   Mündung: ' + mouthName + ' (' + Math.round(mouthAlt) + ' m ü. M.)';
  animTravelLine.textContent = line;
}

// ---- Panorama / Weg in Panorama Modus: Wolke -> Regen -> Tropfen ----
const legendZcap = document.getElementById('legend-zcap');
function setZLayerVisible(v) {
  const d = v ? '' : 'none';
  legendZcap.style.display = d;
  legendTop.style.display = d;
  legendScale.style.display = d;
  legendBottom.style.display = d;
}

const CLOUD_Y = 60;      // Wolkenhoehe ueber dem Fluss (Welt-Einheiten)
const CLOUD_HEIGHT = 31; // vertikale Wolkenausdehnung (fuer Regenlaenge)
const RAIN_SPEED = 26;   // Fallgeschw. des Regens
const DROP_DUR = 700;    // ms: einzelner Tropfen faellt zur Quelle

let panoTravel = false;
let panoPhase = 'idle';  // idle | select | rain | drop | moving
let panoRainTimer = null;
let panoDropStart = 0;
let panoSrcY = 0;
let panoSeq = 0;

// DOM-Wolke (gezeichneter Sprite), die dem Mauszeiger im Auswahl-Modus folgt
const cloudCursor = document.createElement('div');
cloudCursor.style.cssText = 'position:fixed;z-index:55;pointer-events:none;' +
  'display:none;transform:translate(-50%,-50%);';
(() => {
  const cv = document.createElement('canvas');
  cv.width = 76; cv.height = 62;
  const x = cv.getContext('2d');
  const ox = 38, oy = 20;
  // Wolke (anderes Grau)
  x.fillStyle = '#8b95a1';
  x.strokeStyle = '#566069';
  x.lineWidth = 2;
  const puffs = [[-18,4,12],[0,9,16],[18,4,12],[-9,0,9],[9,0,9],[0,-4,13]];
  x.beginPath();
  for (const [px,py,pr] of puffs) {
    x.moveTo(ox+px+pr, oy+py);
    x.arc(ox+px, oy+py, pr, 0, Math.PI*2);
  }
  x.fill();
  x.stroke();
  // parallele graue Linien durch die Wolke
  x.strokeStyle = '#6f7884';
  x.lineWidth = 1.5;
  x.beginPath();
  x.moveTo(ox-26, oy+18); x.lineTo(ox+26, oy-14);
  x.moveTo(ox-20, oy+22); x.lineTo(ox+32, oy-10);
  x.stroke();
  // Regen (hellblau, parallel, unter der Wolke, 10° geneigt)
  x.strokeStyle = '#7ec8ff';
  x.lineWidth = 2;
  const tilt = 10 * Math.PI / 180, Lr = 26;
  const dxr = Math.sin(tilt) * Lr, dyr = Math.cos(tilt) * Lr;
  for (let i = -3; i <= 3; i++) {
    const rx = ox + i * 7;
    x.beginPath();
    x.moveTo(rx, oy + 20);
    x.lineTo(rx + dxr, oy + 20 + dyr);
    x.stroke();
  }
  cloudCursor.appendChild(cv);
})();
document.body.appendChild(cloudCursor);

// Wolken-Mittelpunkt (die Wolke ist nur ein 2D-Sprite, siehe cloudCursor)
let cloudX = 0, cloudZ = 0;

const dropMesh = new THREE.Mesh(
  new THREE.SphereGeometry(2.2, 16, 16),
  new THREE.MeshBasicMaterial({ color: 0x66ccff })
);
dropMesh.visible = false;
scene.add(dropMesh);

// Sichtbarer (hellblauer) Kreis, der im Panorama-Weg waechst und dann den Fluss entlanglaeuft
const travelCircle = new THREE.Mesh(
  new THREE.CircleGeometry(1, 48),
  new THREE.MeshBasicMaterial({ color: 0x66ccff, transparent: true, opacity: 0.95, side: THREE.DoubleSide })
);
travelCircle.visible = false;
scene.add(travelCircle);
// Weisser Kreisumriss (am Ende sichtbar, dann laufend)
const travelRing = new THREE.Mesh(
  new THREE.RingGeometry(0.82, 1.0, 48),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, side: THREE.DoubleSide })
);
travelRing.visible = false;
scene.add(travelRing);
const LENS_MAG = 10;     // 10x Vergroesserung in der Lupe
const GROW_DUR = 2000;   // ms: grosser blauer Kreis schrumpft zur kleinen Kreis
let panoGrowStart = 0;

// Wolke in die Lupe (das schauende Glas) verschieben bzw. zurueck in den Body
function moveCloudToLens() {
  cloudCursor.style.position = 'absolute';
  cloudCursor.style.left = '50%';
  cloudCursor.style.top = '38px';
  cloudCursor.style.transform = 'translate(-50%, -50%)';
  cloudCursor.style.display = 'block';
  magnifier.appendChild(cloudCursor);
}
function restoreCloud() {
  cloudCursor.style.position = 'fixed';
  cloudCursor.style.left = '0';
  cloudCursor.style.top = '0';
  cloudCursor.style.transform = 'translate(-50%, -50%)';
  cloudCursor.style.display = 'none';
  document.body.appendChild(cloudCursor);
}

// --- Lupen-Zoomfenster (Wolke/Regen) als schauende Lupe mit Holzgriff ---
const magnifier = document.createElement('div');
magnifier.className = 'magnifier';
magnifier.innerHTML =
  '<canvas class="lens-canvas"></canvas>' +
  '<svg class="lens-frame" viewBox="0 0 338 416">' +
    '<defs>' +
      '<linearGradient id="woodg" x1="0" y1="0" x2="1" y2="1">' +
        '<stop offset="0" stop-color="#7a4a22"/><stop offset="0.5" stop-color="#a9703f"/>' +
        '<stop offset="1" stop-color="#5e3417"/>' +
      '</linearGradient>' +
      '<linearGradient id="brassg" x1="0" y1="0" x2="1" y2="1">' +
        '<stop offset="0" stop-color="#e8c66a"/><stop offset="0.5" stop-color="#b8862f"/>' +
        '<stop offset="1" stop-color="#8a5e1c"/>' +
      '</linearGradient>' +
    '</defs>' +
    '<g transform="translate(169 169) scale(1.3) translate(-130 -130)">' +
      '<circle cx="130" cy="130" r="112" fill="none" stroke="url(#brassg)" stroke-width="16"/>' +
      '<circle cx="130" cy="130" r="112" fill="none" stroke="#3c260d" stroke-width="2" opacity="0.5"/>' +
      '<g transform="rotate(45 130 130)">' +
        '<rect x="196" y="116" width="156" height="28" rx="14" fill="url(#woodg)" stroke="#3c260d" stroke-width="2"/>' +
        '<rect x="196" y="118" width="156" height="8" rx="4" fill="#ffffff" opacity="0.14"/>' +
      '</g>' +
    '</g>' +
  '</svg>';
document.body.appendChild(magnifier);
const lensCanvas = magnifier.querySelector('.lens-canvas');
// Lupe 30% groesser im Radius (unabhaengig von CSS erzwingen)
magnifier.style.width = '338px';
magnifier.style.height = '416px';
lensCanvas.style.width = '312px';
lensCanvas.style.height = '312px';
const lensRenderer = new THREE.WebGLRenderer({ canvas: lensCanvas, antialias: true, alpha: false });
lensRenderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
lensRenderer.setSize(312, 312, false);
lensRenderer.setClearColor(0x0b0f1a, 1);
const lensCam = new THREE.PerspectiveCamera(42, 1, 0.1, 8000);

let rainGroup = null, rainSegs = null, rainInfo = null;
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -PANORAMA_LIFT);
const _tmpV = new THREE.Vector3();

function buildRain(cx, cz) {
  const n = 110, R = 60, L = 2 * CLOUD_HEIGHT;
  const tilt = 10 * Math.PI / 180;
  const dx = Math.sin(tilt) * L, dy = Math.cos(tilt) * L;   // parallel, 10° geneigt
  const x = [], z = [];
  const positions = new Float32Array(n * 6);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * R;
    const px = cx + Math.cos(a) * r;
    const pz = cz + Math.sin(a) * r;
    x.push(px); z.push(pz);
    // statische, parallele Linien, beginnend unter der Wolke (keine Animation)
    positions[i*6+0] = px;          positions[i*6+1] = CLOUD_Y;      positions[i*6+2] = pz;
    positions[i*6+3] = px + dx;     positions[i*6+4] = CLOUD_Y - dy; positions[i*6+5] = pz;
  }
  rainSegs = new THREE.BufferGeometry();
  rainSegs.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  if (rainGroup) scene.remove(rainGroup);
  rainGroup = new THREE.LineSegments(rainSegs, new THREE.LineBasicMaterial({ color: 0x9ad4ff, transparent: true, opacity: 0.55 }));
  rainGroup.frustumCulled = false;
  rainGroup.visible = false;
  scene.add(rainGroup);
  rainInfo = { n, R, L, x, z, dx, dy };
}

function startPanoRiver(key) {
  const seq = ++panoSeq;
  panoPhase = 'grow';
  animActive = false;            // vorherige Bewegung sofort stoppen
  animDist = 0;
  labelLastStep = -1;            // Label-Position beim Neustart zuruecksetzen
  panoGrowStart = 0;             // verhindert vorzeitiges StartMoving waehrend des async Builds
  animPauseEl.style.display = 'none';
  travelCircle.visible = false;
  travelRing.visible = false;
  panoAllLabels.style.display = 'none';
  riverTooltip.style.display = 'none';
  highlightRiver(null);
  markActiveRiver(key);
  buildRiver(key).then(() => {
    if (!panoTravel || panoSeq !== seq) return; // zwischenzeitlich beendet/neu gestartet
    updatePoi(key);
    const s = riverSamples[0];
    panoSrcY = s.y + 0.2;
    cloudX = s.x; cloudZ = s.z;
    moveCloudToLens(); // Wolke in die Lupe verschieben
    // Grosser blauer Kreis an der Quelle, der auf den kleinen Kreis schrumpft
    dropMesh.visible = false;
    travelRing.visible = false;
    travelCircle.position.set(s.x, s.y + 2.4, s.z);
    travelCircle.scale.setScalar(4.0);
    travelCircle.visible = true;
    if (rainGroup) rainGroup.visible = false;
    // Hauptansicht: Zoom wie zu Beginn der Reise (Aussen bleibt auf gleichem Niveau)
    camera.position.set(s.x, 150, s.z + 1);
    controls.target.set(s.x, 0, s.z);
    controls.update();
    panoGrowStart = performance.now();
  });
}

function startMoving() {
  if (!riverSamples.length) return;   // Sicherheit: nur wenn der Fluss geladen ist
  panoPhase = 'moving';
  dropMesh.visible = false;
  // travelCircle (der gewachsene Kreis) wird jetzt zum laufenden Punkt
  animActive = true; animDist = 0;
  labelLastStep = -1;            // Label-Position beim Neustart zuruecksetzen
  const s0 = sampleAt(0);
  animSmooth.set(s0.x, s0.y + 0.2, s0.z);
  animMarker.visible = false;
  // kleiner blauer Kreis mit weissem Umriss als laufender Punkt
  travelCircle.position.copy(animSmooth);
  travelCircle.scale.setScalar(0.85);
  travelRing.position.copy(animSmooth);
  travelRing.scale.setScalar(0.85);
  travelRing.visible = true;
  restoreCloud(); // Wolke nur vor dem Lauf zeigen, nicht waehrend der Bewegung
  animHud.style.display = 'block';
  animDistLabel.style.display = 'block';
}

function updatePanoFx() {
  if (panoPhase === 'grow' && riverSamples.length && panoGrowStart > 0) {
    const k = Math.min(1, (performance.now() - panoGrowStart) / GROW_DUR);
    // Grosser blauer Kreis schrumpft auf den kleinen Kreis (15% kleiner)
    travelCircle.scale.setScalar(4.0 - 3.15 * k);
    travelCircle.lookAt(camera.position);
    if (k >= 1) startMoving();
  }
}

function exitPanoTravel() {
  panoSeq++;
  panoTravel = false; panoPhase = 'idle';
  if (panoRainTimer) clearTimeout(panoRainTimer);
  if (rainGroup) rainGroup.visible = false;
  dropMesh.visible = false;
  travelCircle.visible = false;
  travelRing.visible = false;
  restoreCloud();
  animActive = false; animMarker.visible = false;
  animHud.style.display = 'none'; animDistLabel.style.display = 'none';
  animTravelLine.style.display = 'none'; animPopup.style.display = 'none';
  animPauseEl.style.display = 'none';
  setZLayerVisible(true);
  controls.enabled = true;
  if (panoramaMode) exitPanorama();
  applyGround(); // Zustand (Ebene, Rotation, Topo) nach der Panorama-Reise wiederherstellen
}

// ESC: Reise abbrechen und zurueck zur Flussauswahl (Panorama-"Beginn").
// Der Fluss selbst bleibt unveraendert; nur die Auswahl wird markiert.
function abortPanoTravel() {
  panoSeq++;
  panoTravel = false; panoPhase = 'select';
  if (panoRainTimer) clearTimeout(panoRainTimer);
  if (rainGroup) rainGroup.visible = false;
  dropMesh.visible = false;
  travelCircle.visible = false;
  travelRing.visible = false;
  restoreCloud();
  animActive = false; animMarker.visible = false;
  animHud.style.display = 'none'; animDistLabel.style.display = 'none';
  animTravelLine.style.display = 'none'; animPopup.style.display = 'none';
  animPauseEl.style.display = 'none';
  magnifier.style.display = 'none';
  setZLayerVisible(false);
  // Flussauswahl anzeigen, gereisten Fluss markieren (Fluss selbst unveraendert).
  // Kamera/Zoom ("Scale") bewusst nicht zuruecksetzen - aktuelle Ansicht beibehalten.
  panoAllLabels.style.display = 'block';
  markActiveRiver(currentKey);
  riverTooltip.style.display = 'none';
}

const panoBtn = document.getElementById('pano-btn');
panoBtn.addEventListener('click', async () => {
  if (panoTravel) { exitPanoTravel(); return; }
  panoTravel = true;
  if (heightPlane) heightPlane.visible = false; // blaue Ebene in der Panorama-Reise ausblenden
  // laufende (3D-)Reise stoppen
  if (travelMode) { travelMode = false; currentElev = savedElev; updateCursor(); }
  animActive = false; animMarker.visible = false;
  animHud.style.display = 'none'; animDistLabel.style.display = 'none';
  animTravelLine.style.display = 'none'; animPopup.style.display = 'none';
  if (!panoramaMode) await enterPanorama();
  topoState.want = true;        // Topokarte immer zeigen
  controls.enabled = false;     // 3D-Modell nicht bewegbar
  setZLayerVisible(false);      // Z-Hoehen-Layer waehrend der Reise ausblenden
  panoPhase = 'select';
  panoAllLabels.style.display = 'none';
  riverTooltip.style.display = 'none';
});

let animActive = false, animDist = 0;
let labelStepX = 0, labelStepY = 0, labelLastStep = -1;
const animClock = new THREE.Clock();
const animSmooth = new THREE.Vector3(); // geglaettete (nachlaufende) Position
const _panoTarget = new THREE.Vector3();
const _panoOffset = new THREE.Vector3();
const ANIM_LAG = 0.12; // kleiner Nachlauf -> weiches Gleiten und weiches Abbiegen

function animMinMax() {
  let sMin = Infinity, sMax = -Infinity;
  for (let i = 1; i < SPEED_WP.length; i++) {
    const dt = SPEED_WP[i][1] - SPEED_WP[i - 1][1];
    if (dt > 1e-9) {
      const s = (SPEED_WP[i][0] - SPEED_WP[i - 1][0]) / dt;
      sMin = Math.min(sMin, s); sMax = Math.max(sMax, s);
    }
  }
  return { sMin, sMax };
}

function showTravelPopup() {
  const { sMin, sMax } = animMinMax();
  const speedTxt = (TEXTS['geschwindigkeit'] || '')
    .replace('{sMin}', sMin.toFixed(0))
    .replace('{sMax}', sMax.toFixed(0));
  animPopup.textContent =
    speedTxt + '\n\n' + (TEXTS['verweilzeit'] || '') + '\n\n' + '(Klicken zum Schließen)';
  animPopup.style.display = 'block';
}

animBtn.addEventListener('click', async () => {
  if (panoTravel) exitPanoTravel();   // Weg-in-Panorama beenden -> danach normaler Travel; Panorama-Button wieder verfuegbar
  if (!travelMode) {
    // im Panorama (oder ohne geladenen Fluss) erst einen Fluss laden
    if (!riverSamples || riverSamples.length === 0) {
      const key = currentKey;
      exitPanorama();
      if (topoGroup) { scene.remove(topoGroup); topoGroup = null; topoState.want = true; }
      await buildRiver(key);
      updatePoi(key);
      if (topoState.want) buildOpenTopoMap();
    }
    travelMode = true;
    panoAllLabels.style.display = 'none';
    if (panoTravel) setZLayerVisible(false);   // Panorama-Reise: Z-Achse ausblenden
    else setZLayerVisible(true);               // normale Reise: Z-Achse mit Staedten + rotem Slider zeigen
    savedElev = currentElev; // Clip-Hoehe merken, um sie beim Beenden wiederherzustellen
    controls.autoRotate = false;
    controls.enabled = false;
    camera.up.set(0, 0, -1);
    scene.fog = null;
    clipPlane.constant = 1e9; // Clip waehrend der Reise deaktivieren (ganzer Rhein sichtbar)
    for (const o of capitalObjs) { o.marker.visible = false; o.label.visible = false; }
    setCityTravel(true);
    for (const cl of contourLevels) cl.lines.visible = false; // Hoehenlinien im Travel-Modus ausblenden
    applyGround(); // Topo-Ebene + Gitternetz waehrend der Reise ausblenden
    if (heightPlane) heightPlane.visible = false; // blaue Ebene in der normalen Reise ausblenden
    const dy0 = currentElev * Y_SCALE + 1;
    camera.position.set(riverSamples[0].x, dy0 + followH, riverSamples[0].z);
    controls.target.set(riverSamples[0].x, dy0, riverSamples[0].z);
    controls.update();
    showTravelPopup();
  } else {
    travelMode = false;
    setZLayerVisible(true); // Z-Hoehen-Layer nach der Reise wieder einblenden
    currentElev = savedElev; // Clip-Hoehe vor dem Travel-Modus wiederherstellen
    updateCursor();
    animActive = false;
    animMarker.visible = false;
    animHud.style.display = 'none';
    animDistLabel.style.display = 'none';
    animPauseEl.style.display = 'none';
    animTravelLine.style.display = 'none';
    animPopup.style.display = 'none';
    camera.up.set(0, 1, 0);
    camera.position.copy(initialCam);
    controls.target.copy(initialTarget);
    controls.enabled = true;
    controls.autoRotate = true;
    controls.update();
    scene.fog = savedFog;
    clipPlane.constant = -currentElev * Y_SCALE; // Clip wieder aktivieren
    for (const o of capitalObjs) { o.marker.visible = true; o.label.visible = true; }
    setCityTravel(false);
    applyGround(); // Zustand (blaue Ebene, Rotation, Topo) nach der Reise wiederherstellen
  }
});
animPopup.addEventListener('click', () => {
  animPopup.style.display = 'none';
  animActive = true; animDist = 0;
  labelLastStep = -1;            // Label-Position beim Neustart zuruecksetzen
  const s0 = sampleAt(0);
  animSmooth.set(s0.x, s0.y + 0.2, s0.z); // Startpunkt uebernehmen, damit nicht herueberspringt
  animMarker.visible = true;
  animMarker.material.color.set(panoTravel ? 0x66ccff : 0xff3b3b);
  if (panoTravel) setZLayerVisible(false); // Panorama-Reise: Z-Achse ausgeblendet
  if (panoTravel) { panoPhase = 'moving'; controls.enabled = false; } // Panorama-Reise: niemals rotieren
  animHud.style.display = 'block';
  animDistLabel.style.display = 'block';
  animPauseEl.style.display = 'none';
});

function updateAnim() {
  const dt = animClock.getDelta();
  if (!animActive) return;
  if (!riverSamples || !riverSamples.length) return;   // Fluss noch nicht geladen
  animTravelLine.style.display = 'block';
  updateTravelLine();
  animDist += 20 * dt;
  if (animDist >= totalKm) {
    animDist = totalKm; animActive = false;
    controls.enabled = true; // Orbit in Aufsicht erlauben
    animDistLabel.style.display = 'none';
    animTravelLine.style.display = 'none';
    setZLayerVisible(true); // Z-Hoehen-Layer nach der Reise wieder einblenden
    const _rv = RIVERS.find((r) => r.key === currentKey);
    const m = (_rv && _rv.mouthKey && TEXTS['mouth-' + _rv.mouthKey]) || 'ein anderes Gewaesser';
    const _exitTpl = (_rv && _rv.exit) ? _rv.exit : DEFAULT_EXIT_TPL;
    animPopup.textContent = (_exitTpl.replace('{mouth}', m)) + '\n\n(Klicken zum Neustart)';
    animPopup.style.display = 'block';
  }
  const p = sampleAt(animDist);
  const dy = p.y + 0.2; // Punkt exakt auf der Rhein-Linie (kein Hoehen-Parallax)
  if (!panoTravel) setValue(p.y / Y_SCALE); // Z-Slider folgt der Hoehe (im Panorama-Modus ausgeblendet)
  // nachlaufende (geglaettete) Position: rundet Kurven und daempft Ruckel
  animSmooth.x += (p.x - animSmooth.x) * ANIM_LAG;
  animSmooth.z += (p.z - animSmooth.z) * ANIM_LAG;
  animSmooth.y += (dy - animSmooth.y) * ANIM_LAG;
  if (panoTravel) {
    travelCircle.position.copy(animSmooth);   // sichtbarer Kreis im Panorama-Weg
    travelCircle.lookAt(camera.position);
    travelRing.position.copy(animSmooth);
    travelRing.lookAt(camera.position);
  } else {
    animMarker.position.copy(animSmooth);
  }
  // Kamera folgt dem Punkt, behaelt aber die aktuelle Blickperspektive bei
  // (kein Reset auf Senkrecht, wenn die Reise nach einer Pause weiterlaeuft).
  _panoTarget.copy(controls.target);
  controls.target.copy(animSmooth);
  _panoOffset.copy(camera.position).sub(_panoTarget);
  camera.position.copy(animSmooth).add(_panoOffset);
  // Distanz-Label: nur 10-km-Schritte ab 0; Position 30px links / 2px unter
  // der Kreismitte, aktualisiert jeweils wenn die Distanz um 10 km steigt.
  const v = animSmooth.clone().project(camera);
  const sx = (v.x * 0.5 + 0.5) * window.innerWidth;
  const sy = (-v.y * 0.5 + 0.5) * window.innerHeight;
  const step = Math.floor(animDist / 10);
  if (step !== labelLastStep) {
    labelLastStep = step;
    labelStepX = sx - 130;
    labelStepY = sy + 80;
    animDistLabel.style.left = labelStepX + 'px';
    animDistLabel.style.top = labelStepY + 'px';
    animDistLabel.textContent = (step * 10) + ' km';
  }
  const days = simDays(animDist);
  const sp = currentSpeedKmPerDay(animDist);
  let scaleStr;
  if (isFinite(sp)) {
    scaleStr = sp.toFixed(0) + ' km/Tag';
  } else {
    scaleStr = 'sehr schnell';
  }
  const dInt = Math.floor(days), hInt = Math.floor((days - dInt) * 24);
  animHud.textContent = 'Zeit: ' + dInt + ' Tage ' + String(hInt).padStart(2, '0') + ' h - ' + scaleStr;
}

// ---- Fluss-Auswahl (oben links) initialisieren und ersten Fluss bauen ----
const riverListEl = document.getElementById('river-list');
const poiEl = document.getElementById('poi');
const debugEl = document.getElementById('debug');

function updatePoi(key) {
  const rv = RIVERS.find((r) => r.key === key);
  if (rv && rv.poi && rv.poi.url) {
    poiEl.innerHTML = 'Mehr erfahren: <a href="' + rv.poi.url +
      '" target="_blank" rel="noopener">' + (rv.poi.name || riverLabelByKey(rv.key)) + '</a>';
    poiEl.style.display = 'block';
  } else {
    poiEl.style.display = 'none';
  }
}

function markActiveRiver(key) {
  for (const b of riverListEl.querySelectorAll('.river-btn'))
    b.classList.toggle('active', b.dataset.key === key);
}


async function selectRiver(key) {
  // Waehrend des Weg-in-Panorama Modus: Lupe beenden, wenn ein anderer Fluss
  // (oder ueber die Liste) gewaehlt wird. Die linke "Panorama"-Taste bleibt verfuegbar.
  if (panoTravel && key !== 'panorama') exitPanoTravel();
  if (key === 'panorama') { await enterPanorama(); updatePoi('panorama'); markActiveRiver('panorama'); return; }
  exitPanorama();
  // Topo-Karte bei Flusswechsel neu laden (Fade bezieht sich auf den neuen Fluss)
  if (topoGroup) {
    scene.remove(topoGroup);
    topoGroup = null;
    topoState.want = true;
  }
  await buildRiver(key);
  updatePoi(key);
  if (topoState.want) buildOpenTopoMap();
  markActiveRiver(key);
}

for (const rv of RIVERS) {
  const b = document.createElement('button');
  b.className = 'river-btn';
  b.dataset.key = rv.key;
  b.textContent = riverLabelByKey(rv.key);
  b.addEventListener('click', () => {
    if (panoramaMode && panoTravel) startPanoRiver(rv.key);
    else selectRiver(rv.key);
  });
  riverListEl.appendChild(b);
}
const panBtn = document.createElement('button');
panBtn.className = 'river-btn';
panBtn.dataset.key = 'panorama';
panBtn.textContent = 'Panorama';
  panBtn.addEventListener('click', () => selectRiver('panorama'));
riverListEl.appendChild(panBtn);

markActiveRiver('panorama');
await enterPanorama();
updatePoi('panorama');

// ---- Sprach-Auswahl (unter der Fluss-Auswahl) ----
const langSelect = document.getElementById('lang-select');
let currentLang = (CONF.languages && CONF.languages.default) || 'de';
for (const k of Object.keys(CONF.languages || {})) {
  if (k === 'default') continue;
  const opt = document.createElement('option');
  opt.value = k;
    opt.textContent = riverLabelByKey(k);
  langSelect.appendChild(opt);
}
langSelect.value = currentLang;
function refreshRiverLabels() {
  for (const b of riverListEl.querySelectorAll('button.river-btn')) {
    if (b.dataset.key === 'panorama') continue;
    b.textContent = riverLabelByKey(b.dataset.key);
  }
  for (const opt of langSelect.options) opt.textContent = riverLabelByKey(opt.value);
}
langSelect.addEventListener('change', async () => {
  currentLang = langSelect.value;
  const file = (CONF.languages && CONF.languages[currentLang]) || null;
  if (!file) return;
  try {
    TEXTS = await fetch('./' + file, { headers: { 'Accept': 'text/csv' }, cache: 'no-store' })
      .then((r) => r.text()).then(parseTexts);
    refreshRiverLabels();
    applyGuiTexts();
    if (travelMode && animPopup.style.display === 'block') showTravelPopup();
  } catch (e) {
    console.warn('Sprachdatei konnte nicht geladen werden:', file, e);
  }
});

// ---- Debug-Modus: Taste 'd' schaltet ein Informations-Overlay um ----
let debugOn = false;
async function renderDebug() {
  let html = '<b>Debug — Rhein-Visualisierung</b>\n\n';
  // Sprachen
  const langs = CONF.languages ? Object.keys(CONF.languages).filter((k) => k !== 'default') : [];
  html += 'Sprachen verfuegbar: ' + (langs.length ? langs.join(', ') : '?') + '\n';
  html += 'Standard-Sprache: ' + (CONF.languages && CONF.languages.default ? CONF.languages.default : '?') + '\n\n';
  // Fluesse
  html += 'Fluesse (' + RIVERS.length + '):\n';
  for (const r of RIVERS) {
    html += '  - ' + r.key + '  →  ' + riverLabelByKey(r.key) +
      (r.poi && r.poi.url ? '   [POI: ' + r.poi.name + ' ' + r.poi.url + ']' : '') + '\n';
  }
  if (typeof MISSING_RIVERS !== 'undefined' && MISSING_RIVERS.length)
    html += '  (ohne Daten, uebersprungen: ' + MISSING_RIVERS.join(', ') + ')\n';
  html += '\n';
  // Geladene lokale Dateien
  const local = LOADED_FILES.slice().sort();
  html += 'Geladene lokale Dateien (' + local.length + '):\n';
  for (const f of local) html += '  - ' + f + '\n';
  html += '\n';
  // Staedte
  html += 'Staedte (' + RIVER_CITIES.length + '):\n';
  for (const c of RIVER_CITIES) {
    const _rk = RIVERS.find((r) => r.key === c.river);
    const _mt = (_rk && _rk.mouthKey && TEXTS['mouth-' + _rk.mouthKey]) || '';
    html += '  ' + c.river + ' | ' + cityName(c) + ' | ' + c.alt + ' m | ' + c.pop +
      ' Einw. | muendet: ' + _mt + '\n';
  }
  // Copyrights / Quellen
  html += '\nCopyrights / Quellen:\n';
  try {
    const cr = await (await fetch('./sources.txt')).text();
    html += cr.trim() + '\n';
  } catch (e) {
    html += '  (sources.txt nicht gefunden)\n';
  }
  debugEl.textContent = html;
}
window.addEventListener('keydown', (e) => {
  if (e.key === 'd' || e.key === 'D') {
    debugOn = !debugOn;
    debugEl.style.display = debugOn ? 'block' : 'none';
    if (debugOn) renderDebug();
  }
});


function animate() {
  requestAnimationFrame(animate);
  updateAnim();
  updatePanoFx();
  controls.update();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
  // Lupen-Zoomfenster (Panorama-Uebersicht + Wolke/Regen/Travel) - sofort beim
  // Druck auf den Panorama-Button sichtbar (Phase 'select'), danach waehrend der Reise
  if (panoramaMode && (panoPhase === 'select' || panoPhase === 'rain' || panoPhase === 'grow' || panoPhase === 'moving')) {
    let fx, fy, fz;                                  // Brennpunkt der Lupe
    if (panoPhase === 'select') {
      fx = controls.target.x; fy = controls.target.y; fz = controls.target.z;
      lensCam.position.set(fx + 28, CLOUD_Y + 55, fz + 92);
      lensCam.fov = 42; lensCam.updateProjectionMatrix();
      lensCam.lookAt(fx, CLOUD_Y * 0.45, fz);
      magnifier.style.right = '24px'; magnifier.style.bottom = '24px';
      magnifier.style.left = 'auto'; magnifier.style.top = 'auto';
      magnifier.style.transformOrigin = 'right bottom';
      magnifier.style.transform = 'scale(1.0)';   // Auswahl-Lupe etwas kleiner (nur Basis ~1.3x)
    } else {
      // Reise: Lupe am Flussanfang (10x vergroessert), Aussenansicht bleibt gleich
      fx = (panoPhase === 'moving') ? animSmooth.x : cloudX;
      fy = (panoPhase === 'moving') ? animSmooth.y : panoSrcY;
      fz = (panoPhase === 'moving') ? animSmooth.z : cloudZ;
      lensCam.position.copy(camera.position);
      lensCam.fov = camera.fov / LENS_MAG; lensCam.updateProjectionMatrix();
      lensCam.lookAt(fx, fy, fz);
      // Lupe ueber dem Brennpunkt auf dem Bildschirm platzieren (in die Quelle geschoben)
      const v = new THREE.Vector3(fx, fy, fz).project(camera);
      const sx = (v.x * 0.5 + 0.5) * window.innerWidth;
      const sy = (-v.y * 0.5 + 0.5) * window.innerHeight;
      magnifier.style.right = 'auto'; magnifier.style.bottom = 'auto';
      magnifier.style.left = (sx - 169) + 'px';
      magnifier.style.top = (sy - 169) + 'px';
      magnifier.style.transformOrigin = '169px 169px';
      magnifier.style.transform = 'scale(1.3)';   // Reise-Lupe groesser (~1.69x gesamt) - unveraendert
    }
    lensRenderer.render(scene, lensCam);
    magnifier.style.display = 'block';
  } else {
    magnifier.style.display = 'none';
  }
}
animate();
