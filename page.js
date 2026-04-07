/**
 * Scute++ — page.js  (PAGE world)
 * Refactored for Squaremap (replaces dynmap).
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

  // ── Acquire Leaflet namespace ─────────────────────────────────────────────
  function acquireL(map) {
    if (window.L && window.L.layerGroup) return window.L;
    for (const key of Object.keys(window)) {
      try {
        const v = window[key];
        if (v && typeof v === 'object' && v.version && v.Map && v.map
            && v.layerGroup && v.polyline && v.circleMarker) {
          LOG('Leaflet found at window.' + key);
          window.L = v;
          return v;
        }
      } catch (_) {}
    }
    LOG('WARN: window.L not found, Leaflet is fully encapsulated');
    return null;
  }

  // ── Wait for Squaremap's Leaflet map ─────────────────────────────────────
  function waitForSquaremap(cb) {
    if (window.__scuteMap?.addLayer) {
      LOG('map ready (from hook) ✓');
      cb(window.__scuteMap);
      return;
    }
    const t = setInterval(() => {
      if (window.__scuteMap?.addLayer) {
        clearInterval(t);
        LOG('map ready (polled) ✓');
        cb(window.__scuteMap);
      }
    }, 200);
    setTimeout(() => {
      if (!window.__scuteMap) ERR('map never captured — did hook.js fire?');
    }, 15000);
  }

  // ── Coordinate projection ─────────────────────────────────────────────────
  async function buildProjAsync(map) {
    const L = window.L;
    const SCALE = 32;
    let world = 'minecraft_overworld';

    map.eachLayer((layer) => {
      if (!layer._url) return;
      const m = layer._url.match(/\/?tiles\/([^/?#{}]+)\//);
      if (m && m[1] && !m[1].includes('{')) world = m[1];
    });

    LOG('proj: world =', world, '| scale = 32');

    return {
      world,
      scale: SCALE,
      toLatLng: (x, z) => L.latLng(-z / SCALE, x / SCALE),
      toMC:     (ll)   => ({ x: Math.round(ll.lng * SCALE), z: Math.round(-ll.lat * SCALE) }),
    };
  }

  // ── Sort stations along a route (nearest-neighbour) ──────────────────────
  function sortRoute(stations) {
    if (stations.length <= 2) return stations;
    const remaining = [...stations];
    const sorted    = [remaining.shift()];
    while (remaining.length) {
      const last = sorted[sorted.length - 1];
      let bestIdx = 0, bestDist = Infinity;
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
    const stationById = {};
    for (const s of stations) stationById[s.id] = s;

    const routes = [];
    for (const [netName, netLines] of Object.entries(data.lines || {})) {
      for (const [lineName, lineData] of Object.entries(netLines)) {
        const color = lineData.color ? '#' + lineData.color : null;
        for (const [branchName, branchData] of Object.entries(lineData.branches || {})) {
          const vertices = branchData.vertices || [];
          if (vertices.length < 2) continue;
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

    for (const r of routes) {
      const col = r.color || netColour(r.net);
      const coords = r.vertices.map(([x, z]) => proj.toLatLng(x, z));
      const popup = `<div class="sp">
        <div class="sp-head" style="border-left-color:${col}"><b>${esc(r.net)}</b></div>
        <div class="sp-body">
          <div class="sp-row">🚧 <b>${esc(r.line)}</b></div>
          <div class="sp-row sp-muted">Branch: ${esc(r.branch || 'Main line')}</div>
          <div class="sp-row sp-muted">${r.stops.length} stops</div>
        </div></div>`;
      L.polyline(coords, { color: col, weight: 7,   opacity: 0.18, interactive: false }).addTo(root);
      L.polyline(coords, { color: col, weight: 2.5, opacity: 0.92 })
        .bindPopup(popup, { className: 'scute-popup' })
        .addTo(root);
    }

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
    const tilePane = document.querySelector('.leaflet-tile-pane');
    if (tilePane) tilePane.style.filter = on ? 'brightness(0.55)' : '';
    window.postMessage({ source: 'scute-page', type: 'SET_DARK_MODE', enabled: on }, '*');
  }

  // ── Inject rows into the Leaflet layer control ────────────────────────────
  function injectRow(overlayDiv) {
    if (document.getElementById('scute-ice-cb')) return;
    LOG('injecting rows into overlay div');

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

  function waitForOverlayDiv(cb) {
    function attach(overlayDiv) {
      cb(overlayDiv);
      const guard = new MutationObserver(() => {
        if (!document.getElementById('scute-ice-cb')) {
          LOG('overlay list rebuilt — re-injecting');
          injectRow(overlayDiv);
          const iceCb2 = document.getElementById('scute-ice-cb');
          if (iceCb2 && highwayLayer && _map && _map.hasLayer(highwayLayer)) iceCb2.checked = true;
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
      if (e.data.darkModeEnabled) applyDarkMode(true);
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
  const CHUNK_DARK_STROKE  = '#1a1a1a';
  const CHUNK_DARK_OPACITY = 0.55;

  let _chunkGridLayer  = null;
  let _chunkObserver   = null;
  let _originalColours = null;

  function findChunkLayer(map) {
    try {
      const ctrl = Object.values(map._controlCorners || {})
        .flatMap(corner => Array.from(corner.querySelectorAll('.leaflet-control-layers')))
        .map(el => {
          for (const k of Object.keys(el)) {
            if (el[k] && el[k]._layers) return el[k];
          }
          return null;
        })
        .find(Boolean);

      if (!ctrl) return null;

      for (const entry of Object.values(ctrl._layers)) {
        if (entry.name && entry.name.toLowerCase().includes('chunk')) return entry.layer;
      }
    } catch (_) {}
    return null;
  }

  function recolorChunkPaths(on) {
    if (!_chunkGridLayer) return;
    try {
      _chunkGridLayer.eachLayer && _chunkGridLayer.eachLayer((l) => patchPath(l, on));
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
    if (!_originalColours && _chunkGridLayer.options) {
      _originalColours = {
        color:   _chunkGridLayer.options.color   ?? '#ff0000',
        opacity: _chunkGridLayer.options.opacity ?? 1,
      };
    }
    if (_chunkGridLayer.options) {
      if (on) {
        _chunkGridLayer.options.color   = CHUNK_DARK_STROKE;
        _chunkGridLayer.options.opacity = CHUNK_DARK_OPACITY;
      } else if (_originalColours) {
        _chunkGridLayer.options.color   = _originalColours.color;
        _chunkGridLayer.options.opacity = _originalColours.opacity;
      }
    }
    recolorChunkPaths(on);
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
        applyChunkDark(true);
      } else if (++attempts < 30) {
        setTimeout(tryFind, 500);
      }
    };
    setTimeout(tryFind, 1000);
  }

  // ── Copy Location (Ctrl+C) ────────────────────────────────────────────────
  let _mouseLatLng = null;

  function initCopyLocation(map) {
    const container = map.getContainer();
    container.addEventListener('mousemove', (e) => {
      try { _mouseLatLng = map.mouseEventToLatLng(e); } catch (_) {}
    });
    container.addEventListener('mouseleave', () => { _mouseLatLng = null; });

    document.addEventListener('keydown', (e) => {
      if (!e.ctrlKey || e.key.toLowerCase() !== 'c') return;
      if (!_mouseLatLng) return;
      const active = document.activeElement;
      const isInput = active && (
        active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable
      );
      if (isInput) return;
      if (window.getSelection()?.toString().length > 0) return;

      // Read directly from the coordinate display
      let text = null;
      const coordEl = document.querySelector('.leaflet-control-layers.coordinates');
      if (coordEl) {
        const raw = coordEl.innerText || coordEl.textContent || '';
        const match = raw.match(/([-\d]+,\s*[-\d]+)/);
        if (match) text = match[1].replace(/\s+/g, '');
      }
      // Fallback: project from mouse position
      if (!text) {
        const mc = _proj.toMC(_mouseLatLng);
        text = `${Math.round(mc.x)}, ${Math.round(mc.z)}`;
      }

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

    injectCoordHint();
  }

  // ── Coord toast ───────────────────────────────────────────────────────────
  function injectCoordHint() {
    if (document.getElementById('scute-copy-toast')) return;

    const toast = document.createElement('div');
    toast.id = 'scute-copy-toast';
    toast.textContent = 'Ctrl+C to copy';
    toast.style.cssText = [
      'position:fixed',
      'z-index:99999',
      'pointer-events:none',
      'font-family:Segoe UI,Arial,sans-serif',
      'font-size:10px',
      'background:rgba(0,0,0,0.72)',
      'color:rgba(255,255,255,0.55)',
      'border-radius:4px',
      'padding:2px 7px',
      'transition:opacity 0.3s,color 0.3s',
      'opacity:0',
      'white-space:nowrap',
    ].join(';');
    document.body.appendChild(toast);

    function reposition() {
      const coordEl = document.querySelector('.leaflet-control-layers.coordinates');
      if (!coordEl) return;
      const r = coordEl.getBoundingClientRect();
      toast.style.left = r.left + 'px';
      toast.style.top  = (r.top - toast.offsetHeight - 3) + 'px';
    }

    const mapContainer = _map.getContainer();
    mapContainer.addEventListener('mouseenter', () => {
      reposition();
      toast.textContent = 'Ctrl+C to copy';
      toast.style.color = 'rgba(255,255,255,0.55)';
      toast.style.opacity = '1';
    });
    mapContainer.addEventListener('mouseleave', () => {
      toast.style.opacity = '0';
    });

    window.addEventListener('resize', reposition);
    LOG('copy toast injected ✓');
  }

  function showCopyFlash(text) {
    const toast = document.getElementById('scute-copy-toast');
    if (!toast) return;
    toast.textContent = `✓ ${text}`;
    toast.style.color = '#00ff99';
    toast.style.opacity = '1';
    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => {
      toast.textContent = 'Ctrl+C to copy';
      toast.style.color = 'rgba(255,255,255,0.55)';
    }, 2000);
  }

  // ── Locate Control ────────────────────────────────────────────────────────
  function initLocate(map) {
    const L = window.L;
    let _towns   = [];
    let _nations = [];

    // ── Helper: extract name from a marker using every known field ──────────
    function markerName(marker) {
      const raw =
        marker.tooltip ||
        marker.title   ||
        marker.name    ||
        marker.label   ||
        marker.options?.tooltip ||
        marker.options?.title   ||
        marker.options?.label   ||
        '';
      return raw.replace(/<[^>]+>/g, '').trim();
    }

    // ── Helper: extract popup html from a marker ───────────────────────────
    function markerPopup(marker) {
      return marker.popup || marker.options?.popup || marker.content || '';
    }

    // ── Helper: flatten a points structure to [{x,z}] ────────────────────
    function flattenPoints(pts) {
      if (!pts || !pts.length) return [];
      // [[{x,z},...]] — ring wrapped in array
      if (Array.isArray(pts[0]) && pts[0].length && typeof pts[0][0] === 'object') pts = pts[0];
      // [{x,z}] or [{lat,lng}] or [[x,z]]
      return pts.map(p => {
        if (Array.isArray(p)) return { x: p[0], z: p[1] };
        return { x: p.x ?? p.lng ?? 0, z: p.z ?? p.lat ?? 0 };
      }).filter(p => p.x != null && p.z != null);
    }

    // ── Helper: centroid of points ────────────────────────────────────────
    function centroid(pts) {
      const valid = flattenPoints(pts);
      if (!valid.length) return null;
      return {
        x: valid.reduce((s, p) => s + p.x, 0) / valid.length,
        z: valid.reduce((s, p) => s + p.z, 0) / valid.length,
      };
    }

    async function fetchMarkers() {
      const world = _proj.world;
      LOG('locate: world =', world);

      const candidates = [
        `/tiles/${world}/markers.json`,
        `/tiles/world/markers.json`,
        `/api/markers/${world}`,
        `/api/markers/world`,
      ];

      let data = null;
      for (const url of candidates) {
        try {
          LOG('locate: trying', url);
          const r = await fetch(url);
          if (!r.ok) { LOG('locate:', url, '→ HTTP', r.status); continue; }
          const j = await r.json();
          // Dump raw structure so we can debug if still broken
          LOG('locate: raw response type:', Array.isArray(j) ? 'array[' + j.length + ']' : typeof j);
          if (Array.isArray(j) && j.length) {
            LOG('locate: layer[0] keys:', Object.keys(j[0]).join(', '));
            LOG('locate: layer[0] sample:', JSON.stringify(j[0]).slice(0, 400));
            if (j[1]) LOG('locate: layer[1] sample:', JSON.stringify(j[1]).slice(0, 400));
            data = j;
            LOG('locate: markers found at', url);
            break;
          }
          if (j?.markers && Array.isArray(j.markers)) {
            data = j.markers;
            LOG('locate: markers (wrapped) at', url);
            break;
          }
        } catch (e) { LOG('locate: fetch error', url, e.message); }
      }

      if (!data) { ERR('locate: could not fetch markers'); return; }

      LOG('locate: processing', data.length, 'marker layers');

      const townMap   = {};
      const nationAcc = {};

      for (const layer of data) {
        // Markers may be in layer.markers or layer.data or layer itself if it's an array
        const markerList = layer.markers || layer.data || (Array.isArray(layer) ? layer : []);
        LOG('locate: layer', layer.key || layer.id || layer.label || '?',
            '| marker count:', markerList.length,
            '| first marker keys:', markerList[0] ? Object.keys(markerList[0]).join(', ') : 'none');

        for (const marker of markerList) {
          const type    = (marker.type || marker.shape || marker.markerType || '').toLowerCase();
          const name    = markerName(marker);
          const popup   = markerPopup(marker);

          if (!name) continue;
          const tk = name.toLowerCase();

          // ── Point / icon / dot → town ──────────────────────────────────
 if (type === 'icon' || type === 'dot' || type === 'marker'
    || type === 'pin' || type === 'circle') {
  const x = marker.point?.x ?? marker.x ?? marker.location?.x;
  const z = marker.point?.z ?? marker.z ?? marker.location?.z
         ?? marker.point?.y ?? marker.y;
  if (x == null || z == null) continue;
  const nx = +x, nz = +z;
  if (isNaN(nx) || isNaN(nz)) continue;

  // Town name is everything before the " (NationName)" suffix
  // e.g. "Bornholm (Poland)" → town: "Bornholm", nation: "Poland"
  const nationMatch = name.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  const townName   = nationMatch ? nationMatch[1].trim() : name;
  const nationName = nationMatch ? nationMatch[2].trim() : null;

  const tk = townName.toLowerCase();
  if (!townMap[tk]) townMap[tk] = { name: townName, x: nx, z: nz };

  if (nationName) {
    const nk = nationName.toLowerCase();
    if (!nationAcc[nk]) nationAcc[nk] = { name: nationName, xs: [], zs: [] };
    nationAcc[nk].xs.push(nx);
    nationAcc[nk].zs.push(nz);
  }
}

          // ── Polygon / rectangle / region → town + maybe nation ─────────
          if (type === 'polygon' || type === 'rectangle'
              || type === 'multipolygon' || type === 'region' || type === 'fill') {
            // multipolygon: points[0][0] is the outer ring
            let rawPts = marker.points || marker.vertices || [];
            if (type === 'multipolygon') {
              rawPts = marker.points?.[0]?.[0] || marker.points?.[0] || rawPts;
            }
  const c = centroid(rawPts);
if (!c || isNaN(c.x) || isNaN(c.z)) continue; // ← add isNaN checks
if (!townMap[tk]) townMap[tk] = { name, x: c.x, z: c.z };

            // Nation from popup
            const nm =
              popup.match(/[Nn]ation[^:]*:\s*<[^>]+>([^<]+)</) ||
              popup.match(/[Nn]ation[^:]*:\s*([^\n<,]+)/)       ||
              popup.match(/\(([^)]+)\)/);
            if (nm) {
              const nationName = nm[1].trim();
              const nk = nationName.toLowerCase();
              if (!nationAcc[nk]) nationAcc[nk] = { name: nationName, xs: [], zs: [] };
              nationAcc[nk].xs.push(c.x);
              nationAcc[nk].zs.push(c.z);
            }
          }
        }
      }

      // Average nation centroids
      const nationMap = {};
      for (const [k, v] of Object.entries(nationAcc)) {
        nationMap[k] = {
          name: v.name,
          x: v.xs.reduce((a, b) => a + b, 0) / v.xs.length,
          z: v.zs.reduce((a, b) => a + b, 0) / v.zs.length,
        };
      }

      _towns   = Object.values(townMap).sort((a, b) => a.name.localeCompare(b.name));
      _nations = Object.values(nationMap).sort((a, b) => a.name.localeCompare(b.name));
      LOG('locate: towns:', _towns.length, '  nations:', _nations.length);
    }

    // ── Leaflet control widget ────────────────────────────────────────────
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
                type="text" placeholder="Name…" autocomplete="off" spellcheck="false"/>
              <div id="scute-locate-sug" class="scute-locate-suggestions" style="display:none"></div>
            </div>
          </div>
          <div id="scute-locate-error" class="scute-locate-error" style="display:none"></div>
          <button id="scute-locate-btn" class="scute-locate-btn">Locate</button>
        `;
        return wrap;
      },
    });

    new LocateControl().addTo(map);

    setTimeout(() => {
      const typeEl  = document.getElementById('scute-locate-type');
      const inputEl = document.getElementById('scute-locate-input');
      const sugEl   = document.getElementById('scute-locate-sug');
      const errorEl = document.getElementById('scute-locate-error');
      const btnEl   = document.getElementById('scute-locate-btn');
      if (!typeEl || !inputEl) return;

      let _filtered = [], _selIdx = -1;

      function getList() { return typeEl.value === 'nation' ? _nations : _towns; }
      function norm(s)   { return s.toLowerCase().replace(/[\s_-]+/g, ''); }

      function renderSuggestions(items) {
        _filtered = items; _selIdx = -1;
        if (!items.length) { sugEl.style.display = 'none'; return; }
        sugEl.innerHTML = items.slice(0, 8)
          .map((item, i) => `<div class="scute-sug-item" data-idx="${i}">${esc(item.name)}</div>`)
          .join('');
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

      function hideSug()    { sugEl.style.display = 'none'; }
      function showError(m) {
        errorEl.textContent = m; errorEl.style.display = 'block';
        setTimeout(() => { errorEl.style.display = 'none'; }, 3000);
      }

function doLocate() {
  const q = inputEl.value.trim();
  if (!q) return;
  const qn   = norm(q);
  const list = getList();
  const match =
    list.find(t => t.name.toLowerCase() === q.toLowerCase()) ||
    list.find(t => norm(t.name) === qn)                      ||
    list.find(t => norm(t.name).startsWith(qn))              ||
    list.find(t => norm(t.name).includes(qn));
  if (!match) { showError(`❌ "${q}" not found`); return; }
  if (isNaN(match.x) || isNaN(match.z)) { showError(`❌ No coordinates for "${match.name}"`); return; } // ← add
  const ll   = _proj.toLatLng(match.x, match.z);
  const zoom = typeEl.value === 'nation' ? 2 : Math.max(map.getZoom(), 5);
  map.setView(ll, zoom, { animate: true });
  hideSug(); errorEl.style.display = 'none';
}

      inputEl.addEventListener('input', () => {
        const q = norm(inputEl.value);
        errorEl.style.display = 'none';
        if (!q) { hideSug(); return; }
        renderSuggestions(getList().filter(t => norm(t.name).includes(q)));
      });

      inputEl.addEventListener('keydown', e => {
        if (sugEl.style.display === 'none') { if (e.key === 'Enter') doLocate(); return; }
        if (e.key === 'ArrowDown')     { e.preventDefault(); _selIdx = Math.min(_selIdx + 1, Math.min(_filtered.length, 8) - 1); updateHighlight(); }
        else if (e.key === 'ArrowUp')  { e.preventDefault(); _selIdx = Math.max(_selIdx - 1, -1); updateHighlight(); }
        else if (e.key === 'Enter')    { e.preventDefault(); if (_selIdx >= 0) { inputEl.value = _filtered[_selIdx].name; hideSug(); } else doLocate(); }
        else if (e.key === 'Escape')   { hideSug(); }
      });

      inputEl.addEventListener('blur',  () => setTimeout(hideSug, 150));
      inputEl.addEventListener('focus', () => {
        const q = norm(inputEl.value);
        if (q) renderSuggestions(getList().filter(t => norm(t.name).includes(q)));
      });
      typeEl.addEventListener('change', () => { inputEl.value = ''; hideSug(); errorEl.style.display = 'none'; });
      btnEl.addEventListener('click', doLocate);

      fetchMarkers();
    }, 600);
  }

  // ── Bootstrap ─────────────────────────────────────────────────────────────
  waitForSquaremap(async (map) => {
    _map = map;

    const L = acquireL(map);
    if (!L) {
      ERR('FATAL: Cannot acquire Leaflet namespace.');
      return;
    }
    window.L = L;

    _proj = await buildProjAsync(map);
    LOG('proj ready — world:', _proj.world, 'scale:', _proj.scale);

    initCopyLocation(map);
    initChunkRecolor(map);
    initLocate(map);

    waitForOverlayDiv((overlayDiv) => {
      injectRow(overlayDiv);
      window.postMessage({ source: 'scute-page', type: 'PAGE_READY' }, '*');
    });
  });

})();