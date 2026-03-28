/**
 * Scute++ — page.js  (PAGE world — has access to window.dynmap, window.L, etc.)
 * Injected as a <script> tag by content.js.
 */
(function () {
  'use strict';

  const HIGHWAYS_URL =
    'https://raw.githubusercontent.com/nokteholda/WorldMC-Ice-Highways-Map/refs/heads/main/highways.json';

  const LOG = (...a) => console.log('[Scute++ page]', ...a);
  const ERR = (...a) => console.error('[Scute++ page]', ...a);

  // ── Colours ─────────────────────────────────────────────────────────────
  const PALETTE = [
    '#00cfff','#ff6b35','#a8ff3e','#ff3ec8','#ffe83e',
    '#3effb0','#b03eff','#ff3e3e','#3e8fff','#ffaa3e',
    '#3effd4','#d43eff','#ff3ea8','#3effff','#ffff3e',
  ];
  const colourCache = {};
  let ci = 0;
  function netColour(n) {
    if (!colourCache[n]) colourCache[n] = PALETTE[ci++ % PALETTE.length];
    return colourCache[n];
  }
  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Wait for window.dynmap.map to be ready ───────────────────────────────
  function waitForDynmap(cb) {
    // dynmap sets window.dynmap and then window.dynmap.map after async config load
    const check = () => {
      if (window.dynmap && window.dynmap.map && window.dynmap.map.addLayer) {
        LOG('dynmap.map found ✓');
        cb(window.dynmap.map);
      } else {
        setTimeout(check, 300);
      }
    };
    check();
  }

  // ── Coordinate projection ─────────────────────────────────────────────────
  function buildProj() {
    if (window.dynmap && window.dynmap.getProjection) {
      try {
        const p = window.dynmap.getProjection();
        const t = p.fromLocationToLatLng({ x: 0, y: 64, z: 0 });
        if (t && isFinite(t.lat)) {
          LOG('proj: dynmap API');
          return {
            toLatLng: (x, z) => p.fromLocationToLatLng({ x, y: 64, z }),
            toMC:     (ll)   => p.fromLatLngToLocation(ll, 64),
          };
        }
      } catch (_) {}
    }
    LOG('proj: generic /2 fallback');
    return {
      toLatLng: (x, z) => window.L.latLng(-z / 2, x / 2),
      toMC:     (ll)   => ({ x: ll.lng * 2, z: -ll.lat * 2 }),
    };
  }

  // ── Sort stations along a route (nearest-neighbour) ──────────────────────
  // Stations in the JSON are not necessarily in geographic order.
  // Without sorting, polylines zigzag all over the map.
  function sortRoute(stations) {
    if (stations.length <= 2) return stations;

    const remaining = [...stations];
    const sorted    = [remaining.shift()];

    while (remaining.length) {
      const last = sorted[sorted.length - 1];
      let bestIdx  = 0;
      let bestDist = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const dx = remaining[i].x - last.x;
        const dz = remaining[i].z - last.z;
        const d  = dx * dx + dz * dz;
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
      sorted.push(remaining.splice(bestIdx, 1)[0]);
    }

    return sorted;
  }

// ── Parse highways.json ───────────────────────────────────────────────────
function parse(data) {
  const stations = data.stations || [];

  // Station lookup by id
  const stationById = {};
  for (const s of stations) stationById[s.id] = s;

  // Walk data.lines → network → lineName → { color, branches → { vertices, stations } }
  const routes = [];
  for (const [netName, netLines] of Object.entries(data.lines || {})) {
    for (const [lineName, lineData] of Object.entries(netLines)) {
      const color = lineData.color ? '#' + lineData.color : null;
      for (const [branchName, branchData] of Object.entries(lineData.branches || {})) {
        const vertices = branchData.vertices || [];
        if (vertices.length < 2) continue;

        // stations entries are either a plain id (number) or [id, "other branch name"]
        const stops = (branchData.stations || [])
          .map(s => stationById[Array.isArray(s) ? s[0] : s])
          .filter(Boolean);

        routes.push({ net: netName, line: lineName, branch: branchName, color, vertices, stops });
      }
    }
  }

  return { stations, stationById, routes };
}

// ── Build Leaflet layer ───────────────────────────────────────────────────
function buildLayer(data, proj) {
  const L = window.L;
  const { stations, routes } = parse(data);
  const root = L.layerGroup();

  // ── Draw route polylines from explicit vertex geometry ──
  for (const r of routes) {
    const col = r.color || netColour(r.net);
    // vertices are [x, z] pairs — convert to Leaflet LatLng
    const coords = r.vertices.map(([x, z]) => proj.toLatLng(x, z));
    const label = `${esc(r.net)} · ${esc(r.line)}${r.branch ? ' · ' + esc(r.branch) : ''}`;
    const popup = `<div class="sp">
      <div class="sp-head" style="border-left-color:${col}"><b>${esc(r.net)}</b></div>
      <div class="sp-body">
        <div class="sp-row">🚧 <b>${esc(r.line)}</b></div>
        <div class="sp-row sp-muted">Branch: ${esc(r.branch || 'Main line')}</div>
        <div class="sp-row sp-muted">${r.stops.length} stops</div>
      </div></div>`;

    // Glow halo + solid line
    L.polyline(coords, { color: col, weight: 7,   opacity: 0.18, interactive: false }).addTo(root);
    L.polyline(coords, { color: col, weight: 2.5, opacity: 0.92 })
      .bindPopup(popup, { className: 'scute-popup' })
      .addTo(root);
  }

  // ── Draw station markers ──
  const seen = new Set();
  for (const s of stations) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);

    const nets = Object.keys(s.lines || {});
    const col  = nets.length ? netColour(nets[0]) : '#00cfff';
    const jct  = s.type === 'jct';

    let lh = '';
    for (const [net, sl] of Object.entries(s.lines || {})) {
      const c = netColour(net);
      lh += `<div class="sp-line-row"><span class="sp-dot" style="background:${c}"></span><span>${esc(net)}</span>`;
      for (const [ln, br] of Object.entries(sl)) {
        lh += `<div class="sp-branch">→ ${esc(ln)} · ${esc(br.filter(Boolean).join(', ') || 'Main line')}</div>`;
      }
      lh += '</div>';
    }

    L.circleMarker(proj.toLatLng(s.x, s.z), {
      radius: jct ? 5 : 4,
      color: jct ? '#fff' : col,
      fillColor: jct ? col : '#08142e',
      fillOpacity: 1,
      weight: jct ? 2 : 1.5,
    }).bindPopup(`<div class="sp">
      <div class="sp-head" style="border-left-color:${col}">
        ${jct ? '🔀' : '🧊'} <b>${esc(s.name)}</b>${jct ? '<span class="sp-jct">JCT</span>' : ''}
      </div>
      <div class="sp-body">
        <div class="sp-row sp-muted" style="font-family:monospace">X:${s.x} Z:${s.z}</div>
        ${lh}
      </div></div>`, { className: 'scute-popup' }).addTo(root);
  }

  LOG('layer built:', stations.length, 'stations,', routes.length, 'route segments');
  return root;
}

  // ── State ─────────────────────────────────────────────────────────────────
  let highwayLayer = null;
  let highwayData  = null;
  let _map         = null;
  let _proj        = null;
  let _darkMode    = false;

  async function enable() {
    setSpinner(true);
    try {
      if (!highwayData) {
        LOG('fetching highways.json…');
        const r = await fetch(HIGHWAYS_URL);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        highwayData = await r.json();
        LOG('fetched:', highwayData.stations?.length, 'stations');
      }
      if (highwayLayer) _map.removeLayer(highwayLayer);
      highwayLayer = buildLayer(highwayData, _proj);
      highwayLayer.addTo(_map);
    } catch (e) {
      ERR('Failed to load highways:', e);
      const cb = document.getElementById('scute-ice-cb');
      if (cb) cb.checked = false;
      window.postMessage({ source: 'scute-page', type: 'SET_ICE_HIGHWAYS', enabled: false }, '*');
    } finally {
      setSpinner(false);
    }
  }

  function disable() {
    if (highwayLayer && _map) _map.removeLayer(highwayLayer);
  }

  function setOn(on) {
    if (on) enable(); else disable();
    window.postMessage({ source: 'scute-page', type: 'SET_ICE_HIGHWAYS', enabled: on }, '*');
  }

  function setSpinner(on) {
    const el = document.getElementById('scute-spinner');
    if (el) el.style.display = on ? 'inline' : 'none';
  }

  function applyDarkMode(on) {
  _darkMode = on;
  document.body.classList.toggle('scute-dark', on);
  const cb = document.getElementById('scute-dark-cb');
  if (cb) cb.checked = on;

  // Dim the map tiles only
  const tilePane = document.querySelector('.leaflet-tile-pane');
  if (tilePane) tilePane.style.filter = on ? 'brightness(0.55)' : '';

  window.postMessage({ source: 'scute-page', type: 'SET_DARK_MODE', enabled: on }, '*');
}
  // ── Inject rows into the Leaflet layer control ────────────────────────────
  function injectRow(overlayDiv) {
    if (document.getElementById('scute-ice-cb')) return;
    LOG('injecting rows into overlay div');

    // ── Ice Highways row ──
    const iceLabel = document.createElement('label');
    const iceDiv   = document.createElement('div');
    const iceCb    = document.createElement('input');
    iceCb.type = 'checkbox';
    iceCb.id   = 'scute-ice-cb';
    iceCb.className = 'leaflet-control-layers-selector';
    const iceSpan = document.createElement('span');
    iceSpan.innerHTML = ' 🧊 Ice Highways<span id="scute-spinner" style="display:none;margin-left:3px;font-size:10px">⏳</span>';
    iceDiv.appendChild(iceCb);
    iceDiv.appendChild(iceSpan);
    iceLabel.appendChild(iceDiv);
    overlayDiv.appendChild(iceLabel);
    iceCb.addEventListener('change', () => setOn(iceCb.checked));

    // ── Dark Mode row ──
    const darkLabel = document.createElement('label');
    const darkDiv   = document.createElement('div');
    const darkCb    = document.createElement('input');
    darkCb.type = 'checkbox';
    darkCb.id   = 'scute-dark-cb';
    darkCb.className = 'leaflet-control-layers-selector';
    darkCb.checked = _darkMode;
    const darkSpan = document.createElement('span');
    darkSpan.textContent = ' 🌙 Dark Mode';
    darkDiv.appendChild(darkCb);
    darkDiv.appendChild(darkSpan);
    darkLabel.appendChild(darkDiv);
    overlayDiv.appendChild(darkLabel);
    darkCb.addEventListener('change', () => applyDarkMode(darkCb.checked));

    LOG('rows injected ✓');
  }

  // ── Wait for overlay div, then KEEP our row alive ────────────────────────
  // Dynmap calls Control.Layers._update() every time it adds/removes a layer,
  // which completely rebuilds the innerHTML of .leaflet-control-layers-overlays.
  // We use a MutationObserver on the div itself to re-inject whenever our
  // checkbox disappears.
  function waitForOverlayDiv(cb) {
    function attach(overlayDiv) {
      cb(overlayDiv);   // first injection

      // Watch for Dynmap rebuilding the list
      const guard = new MutationObserver(() => {
        if (!document.getElementById('scute-ice-cb')) {
          LOG('overlay list rebuilt by Dynmap — re-injecting');
          injectRow(overlayDiv);
          // Restore checked states
          const iceCb2 = document.getElementById('scute-ice-cb');
          if (iceCb2 && highwayLayer && _map && _map.hasLayer(highwayLayer)) {
            iceCb2.checked = true;
          }
          const darkCb2 = document.getElementById('scute-dark-cb');
          if (darkCb2) darkCb2.checked = _darkMode;
        }
      });
      guard.observe(overlayDiv, { childList: true });
    }

    const el = document.querySelector('.leaflet-control-layers-overlays');
    if (el) { attach(el); return; }

    const obs = new MutationObserver(() => {
      const found = document.querySelector('.leaflet-control-layers-overlays');
      if (found) { obs.disconnect(); attach(found); }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => obs.disconnect(), 60000);
  }

  // ── Listen for messages from content.js ──────────────────────────────────
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== 'scute-ext') return;

    if (e.data.type === 'INIT') {
      if (e.data.iceHighwaysEnabled && _map) {
        const cb = document.getElementById('scute-ice-cb');
        if (cb) cb.checked = true;
        enable();
      }
      if (e.data.darkModeEnabled) {
        applyDarkMode(true);
      }
    }

    if (e.data.type === 'TOGGLE_ICE_HIGHWAYS') {
      const cb = document.getElementById('scute-ice-cb');
      if (cb) cb.checked = e.data.enabled;
      setOn(e.data.enabled);
    }

    if (e.data.type === 'TOGGLE_DARK_MODE') {
      applyDarkMode(e.data.enabled);
    }
  });

  // ── Chunk Grid Recolor ────────────────────────────────────────────────────
  // Dynmap renders chunk grid lines as SVG <path> elements with inline stroke
  // attributes. We find the "Grid - Chunks" layer via the layer control and
  // patch both its color option AND any already-rendered SVG paths.
  // A MutationObserver keeps new paths recolored as the user pans/zooms.

  const CHUNK_DARK_STROKE  = '#1a1a1a';
  const CHUNK_DARK_FILL    = 'none';
  const CHUNK_DARK_OPACITY = 0.55;

  let _chunkGridLayer  = null;
  let _chunkObserver   = null;
  let _originalColours = null; // { color, fillColor, opacity }

  function findChunkLayer(map) {
    // Leaflet stores all layers in map._layers keyed by id.
    // Dynmap's regiongrid layer has an options.name or is labelled in the control.
    // We find it by checking the layer control's _layers array for "Grid - Chunks".
    try {
      // Walk every control attached to the map
      const ctrl = Object.values(map._controlCorners || {})
        .flatMap(corner => Array.from(corner.querySelectorAll('.leaflet-control-layers')))
        .map(el => {
          // Leaflet attaches the control instance to the element
          for (const k of Object.keys(el)) {
            if (el[k] && el[k]._layers) return el[k];
          }
          return null;
        })
        .find(Boolean);

      if (!ctrl) return null;

      for (const entry of Object.values(ctrl._layers)) {
        if (entry.name && entry.name.toLowerCase().includes('chunk')) {
          return entry.layer;
        }
      }
    } catch (_) {}
    return null;
  }

  function recolorChunkPaths(on) {
    // Recolor any already-rendered SVG paths belonging to the chunk layer
    if (!_chunkGridLayer) return;

    // Leaflet SVG renderer: each path has ._path (the SVG element)
    try {
      _chunkGridLayer.eachLayer && _chunkGridLayer.eachLayer((l) => {
        patchPath(l, on);
      });
      // Also try direct _path if it's a single layer
      if (_chunkGridLayer._path) patchPath(_chunkGridLayer, on);
    } catch (_) {}
  }

  function patchPath(layer, on) {
    if (!layer._path) return;
    if (on) {
      layer._path.setAttribute('stroke', CHUNK_DARK_STROKE);
      layer._path.setAttribute('stroke-opacity', CHUNK_DARK_OPACITY);
      layer._path.style.stroke = CHUNK_DARK_STROKE;
    } else if (_originalColours) {
      layer._path.setAttribute('stroke', _originalColours.color || '#ff0000');
      layer._path.setAttribute('stroke-opacity', _originalColours.opacity ?? 1);
      layer._path.style.stroke = '';
    }
  }

  function applyChunkDark(on) {
    if (!_chunkGridLayer) {
      _chunkGridLayer = findChunkLayer(_map);
      if (!_chunkGridLayer) return;
    }

    // Save original colours on first apply
    if (!_originalColours && _chunkGridLayer.options) {
      _originalColours = {
        color:   _chunkGridLayer.options.color   ?? '#ff0000',
        opacity: _chunkGridLayer.options.opacity ?? 1,
      };
    }

    // Patch Leaflet layer options so newly created paths use the right colour
    if (_chunkGridLayer.options) {
      if (on) {
        _chunkGridLayer.options.color   = CHUNK_DARK_STROKE;
        _chunkGridLayer.options.opacity = CHUNK_DARK_OPACITY;
      } else if (_originalColours) {
        _chunkGridLayer.options.color   = _originalColours.color;
        _chunkGridLayer.options.opacity = _originalColours.opacity;
      }
    }

    // Recolor already-rendered paths
    recolorChunkPaths(on);

    // Watch the overlay SVG for new chunk paths being added (pan/zoom)
    if (on && !_chunkObserver) {
      const overlaySvg = document.querySelector('.leaflet-overlay-pane svg');
      if (overlaySvg) {
        _chunkObserver = new MutationObserver(() => recolorChunkPaths(true));
        _chunkObserver.observe(overlaySvg, { childList: true, subtree: true, attributes: true, attributeFilter: ['stroke'] });
      }
    } else if (!on && _chunkObserver) {
      _chunkObserver.disconnect();
      _chunkObserver = null;
    }
  }

  function initChunkRecolor(map) {
    let attempts = 0;
    const tryFind = () => {
      _chunkGridLayer = findChunkLayer(map);
      if (_chunkGridLayer) {
        LOG('chunk grid layer found ✓');
        applyChunkDark(true); // always dark regardless of dark mode
      } else if (++attempts < 30) {
        setTimeout(tryFind, 500);
      }
    };
    setTimeout(tryFind, 1000);
  }
  let _mouseLatLng = null;

  function initCopyLocation(map) {
    // Track mouse position over the Leaflet map container via native DOM events
    // (Leaflet's mousemove only fires when the map has focus/interaction)
    const container = map.getContainer();

    container.addEventListener('mousemove', (e) => {
      // Convert DOM mouse event → Leaflet latlng
      _mouseLatLng = map.mouseEventToLatLng(e);
    });
    container.addEventListener('mouseleave', () => {
      _mouseLatLng = null;
    });

    // Ctrl+C → copy MC coordinates
    document.addEventListener('keydown', (e) => {
      if (!e.ctrlKey || e.key.toLowerCase() !== 'c') return;
      if (!_mouseLatLng) return;

      // Don't intercept if user is in a text input or has selected text
      const active = document.activeElement;
      const isInput = active && (
        active.tagName === 'INPUT' ||
        active.tagName === 'TEXTAREA' ||
        active.isContentEditable
      );
      if (isInput) return;
      if (window.getSelection()?.toString().length > 0) return;

      const mc = _proj.toMC(_mouseLatLng);
      const x  = Math.round(mc.x);
      const z  = Math.round(mc.z);
      const text = `${x}, ${z}`;

      navigator.clipboard.writeText(text).then(() => {
        showCopyFlash(text);
      }).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        showCopyFlash(text);
      });

      e.preventDefault();
    });

    // Inject the hint below the coord display
    injectCoordHint();
  }

// ── Locate Control ─────────────────────────────────────────────────────────
function initLocate(map) {
  const L = window.L;
  let _towns   = [];
  let _nations = [];

  async function fetchMarkers() {
    let world = 'world';
    try {
      const dyn = window.dynmap;
      world = dyn.defaultworld
           || dyn.current_world
           || (typeof dyn.world === 'string' ? dyn.world : null)
           || dyn.worlds?.[0]?.name
           || dyn.model?.worlds?.[0]?.name
           || 'world';
      if (typeof world !== 'string') world = 'world';
      LOG('locate: world name resolved to:', world);
    } catch (_) {}

    const candidates = [
      `/tiles/_markers_/marker_${world}.json`,
      `/tiles/_markers_/marker_world.json`,
      `/standalone/markers.json`,
    ];

    let data = null;
    for (const url of candidates) {
      try {
        LOG('locate: trying', url);
        const r = await fetch(url);
        if (!r.ok) { LOG('locate:', url, '→ HTTP', r.status); continue; }
        const j = await r.json();
        if (j && j.sets) { data = j; LOG('locate: marker data found at', url); break; }
      } catch (e) {
        LOG('locate: fetch error for', url, e.message);
      }
    }

    if (!data) {
      // last resort: try world from URL hash
      try {
        const fromHash = window.location.hash.split(';')[0].replace('#','').trim();
        if (fromHash) {
          const r = await fetch(`/tiles/_markers_/marker_${fromHash}.json`);
          if (r.ok) { const j = await r.json(); if (j?.sets) data = j; }
        }
      } catch (_) {}
    }

    if (!data) { ERR('locate: could not fetch any marker file'); return; }

 LOG('locate: sets:', Object.keys(data.sets || {}).join(' | '));

const townMap   = {};
const nationAcc = {}; // nation → { name, xs[], zs[] } for centroid averaging

const townySet = data.sets['towny.markerset'];
if (townySet) {
  for (const area of Object.values(townySet.areas || {})) {
    // ── Extract town name ──
    const townName = (area.label || '').replace(/<[^>]+>/g, '').trim();
    if (!townName) continue;

    // ── Extract nation name from desc: "TownName (NationName)" ──
    const nationMatch = (area.desc || '').match(/\(([^)]+)\)/);
    const nationName  = nationMatch ? nationMatch[1].trim() : null;

    // ── Coords ──
    let x, z;
    if (area.x != null && !Array.isArray(area.x)) {
      x = area.x; z = area.z;
    } else {
      const xs = Array.isArray(area.x) ? area.x : [];
      const zs = Array.isArray(area.z) ? area.z : [];
      if (!xs.length) continue;
      x = xs.reduce((a, b) => a + b, 0) / xs.length;
      z = zs.reduce((a, b) => a + b, 0) / zs.length;
    }

    // ── Store town ──
    const tk = townName.toLowerCase();
    if (!townMap[tk]) townMap[tk] = { name: townName, x, z };

    // ── Accumulate nation centroid ──
    if (nationName) {
      const nk = nationName.toLowerCase();
      if (!nationAcc[nk]) nationAcc[nk] = { name: nationName, xs: [], zs: [] };
      nationAcc[nk].xs.push(x);
      nationAcc[nk].zs.push(z);
    }
  }
}

// Also ingest any other marker sets (chunky etc.) as towns
for (const [setKey, setVal] of Object.entries(data.sets || {})) {
  if (setKey === 'towny.markerset') continue;
  for (const marker of Object.values(setVal.markers || {})) {
    const name = (marker.label || '').replace(/<[^>]+>/g, '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (!townMap[key]) townMap[key] = { name, x: marker.x, z: marker.z };
  }
}

// Average nation coords
const nationMap = {};
for (const [k, v] of Object.entries(nationAcc)) {
  const x = v.xs.reduce((a, b) => a + b, 0) / v.xs.length;
  const z = v.zs.reduce((a, b) => a + b, 0) / v.zs.length;
  nationMap[k] = { name: v.name, x, z };
}

_towns   = Object.values(townMap).sort((a, b) => a.name.localeCompare(b.name));
_nations = Object.values(nationMap).sort((a, b) => a.name.localeCompare(b.name));
LOG('locate: towns:', _towns.length, '  nations:', _nations.length);
  }

  const LocateControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const wrap = L.DomUtil.create('div', 'scute-locate-wrap');
      L.DomEvent.disableClickPropagation(wrap);
      L.DomEvent.disableScrollPropagation(wrap);
      wrap.innerHTML = `
        <div class="scute-locate-title">Locate</div>
        <div class="scute-locate-row">
          <select id="scute-locate-type" class="scute-locate-select">
            <option value="town">Town</option>
            <option value="nation">Nation</option>
          </select>
          <div class="scute-locate-input-wrap">
            <input id="scute-locate-input" class="scute-locate-input"
              type="text" placeholder="Name..." autocomplete="off" spellcheck="false"/>
            <div id="scute-locate-sug" class="scute-locate-suggestions" style="display:none"></div>
          </div>
        </div>
        <div id="scute-locate-error" class="scute-locate-error" style="display:none"></div>
        <button id="scute-locate-btn" class="scute-locate-btn">Locate</button>
      `;
      return wrap;
    }
  });

  new LocateControl().addTo(map);

  setTimeout(() => {
    const typeEl  = document.getElementById('scute-locate-type');
    const inputEl = document.getElementById('scute-locate-input');
    const sugEl   = document.getElementById('scute-locate-sug');
    const errorEl = document.getElementById('scute-locate-error');
    const btnEl   = document.getElementById('scute-locate-btn');
    if (!typeEl || !inputEl) return;

    let _filtered = [];
    let _selIdx   = -1;

    function getList() {
      return typeEl.value === 'nation' ? _nations : _towns;
    }

    function norm(s) { return s.toLowerCase().replace(/[\s_-]+/g, ''); }

    function renderSuggestions(items) {
      _filtered = items;
      _selIdx   = -1;
      if (!items.length) { sugEl.style.display = 'none'; return; }
      sugEl.innerHTML = items.slice(0, 8).map((item, i) =>
        `<div class="scute-sug-item" data-idx="${i}">${esc(item.name)}</div>`
      ).join('');
      sugEl.style.display = 'block';
      sugEl.querySelectorAll('.scute-sug-item').forEach(el => {
        el.addEventListener('mousedown', e => {
          e.preventDefault();
          inputEl.value = _filtered[+el.dataset.idx].name;
          sugEl.style.display = 'none';
          errorEl.style.display = 'none';
        });
      });
    }

    function updateHighlight() {
      sugEl.querySelectorAll('.scute-sug-item').forEach((el, i) =>
        el.classList.toggle('scute-sug-active', i === _selIdx)
      );
    }

    function hideSug() { sugEl.style.display = 'none'; }

    function showError(msg) {
      errorEl.textContent = msg;
      errorEl.style.display = 'block';
      setTimeout(() => errorEl.style.display = 'none', 3000);
    }

function doLocate() {
  const q = inputEl.value.trim();
  if (!q) return;
  const qn = norm(q);
  const list = getList();

  const match =
    list.find(t => t.name.toLowerCase() === q.toLowerCase()) ||
    list.find(t => norm(t.name) === qn) ||
    list.find(t => norm(t.name).startsWith(qn)) ||
    list.find(t => norm(t.name).includes(qn));

  if (!match) { showError(`❌ "${q}" not found`); return; }

  const ll = _proj.toLatLng(match.x, match.z);
  const zoom = typeEl.value === 'nation' ? 2 : Math.max(map.getZoom(), 5);
  map.setView(ll, zoom, { animate: true });
  hideSug();
  errorEl.style.display = 'none';
}

    inputEl.addEventListener('input', () => {
      const q = norm(inputEl.value);
      errorEl.style.display = 'none';
      if (!q) { hideSug(); return; }
      renderSuggestions(getList().filter(t => norm(t.name).includes(q)));
    });

    inputEl.addEventListener('keydown', e => {
      if (sugEl.style.display === 'none') {
        if (e.key === 'Enter') doLocate();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        _selIdx = Math.min(_selIdx + 1, Math.min(_filtered.length, 8) - 1);
        updateHighlight();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        _selIdx = Math.max(_selIdx - 1, -1);
        updateHighlight();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (_selIdx >= 0) {
          inputEl.value = _filtered[_selIdx].name;
          hideSug();
        } else {
          doLocate();
        }
      } else if (e.key === 'Escape') {
        hideSug();
      }
    });

    inputEl.addEventListener('blur',  () => setTimeout(hideSug, 150));
    inputEl.addEventListener('focus', () => {
      const q = norm(inputEl.value);
      if (q) renderSuggestions(getList().filter(t => norm(t.name).includes(q)));
    });

    typeEl.addEventListener('change', () => {
      inputEl.value = '';
      hideSug();
      errorEl.style.display = 'none';
    });

    btnEl.addEventListener('click', doLocate);

    fetchMarkers();
  }, 600);
}

  function showCopyFlash(text) {
    const hint = document.getElementById('scute-coord-hint');
    if (hint) {
      hint.textContent = `✓ Copied ${text}`;
      hint.style.color = '#00ff99';
      setTimeout(() => {
        hint.textContent = '(Ctrl+C to copy location)';
        hint.style.color = '';
      }, 1800);
    }
  }

  function injectCoordHint() {
    if (document.getElementById('scute-coord-hint')) return;

    // DOM structure: <div class="coord-control leaflet-control">
    //   <span class="coord-control-label">Location: </span><br>
    //   <span class="coord-control-value">---,---,---</span>
    // </div>
    const coordCtrl =
      document.querySelector('.coord-control') ||
      document.querySelector('#coord') ||
      document.querySelector('.dynmap-coord');

    if (coordCtrl) {
      appendHint(coordCtrl);
      return;
    }

    // Wait for it
    const obs = new MutationObserver(() => {
      const el = document.querySelector('.coord-control') ||
                 document.querySelector('#coord') ||
                 document.querySelector('.dynmap-coord');
      if (el && !document.getElementById('scute-coord-hint')) {
        obs.disconnect();
        appendHint(el);
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => obs.disconnect(), 30000);
  }

  function appendHint(coordEl) {
    const hint = document.createElement('div');
    hint.id = 'scute-coord-hint';
    hint.textContent = '(Ctrl+C to copy location)';
    hint.style.cssText = [
      'font-size:10px',
      'color:rgba(255,255,255,0.45)',
      'font-family:inherit',
      'margin-top:1px',
      'pointer-events:none',
      'white-space:nowrap',
      'transition:color 0.2s',
    ].join(';');

    // Append inside the coord control div (after the value span)
    coordEl.appendChild(hint);
    LOG('coord hint injected ✓');
  }

  // ── Bootstrap ─────────────────────────────────────────────────────────────
  waitForDynmap((map) => {
    _map  = map;
    _proj = buildProj();
    LOG('map ready, waiting for overlay div…');

    initCopyLocation(map);
    initChunkRecolor(map);
      initLocate(map);  

    waitForOverlayDiv((overlayDiv) => {
      injectRow(overlayDiv);
      // Ask content.js for the saved state (INIT message)
      // content.js sends INIT right after injection, but page.js may not be ready yet.
      // Re-request by sending a ready signal:
      window.postMessage({ source: 'scute-page', type: 'PAGE_READY' }, '*');
    });
  });

})();