(function () {
  'use strict';

  function hookL(L) {
    var origMap = L.map.bind(L);
    L.map = function (el, opts) {
      var m = origMap(el, opts);
      window.__scuteMap = m;
      console.log('[Scute++ hook] map captured ✓');
      return m;
    };
    // Also patch class-style instantiation
    var OrigMap = L.Map;
    L.Map = function (el, opts) {
      var m = new OrigMap(el, opts);
      window.__scuteMap = m;
      return m;
    };
    Object.assign(L.Map, OrigMap);
    L.Map.prototype = OrigMap.prototype;
    console.log('[Scute++ hook] L.map hooked ✓');
  }

  if (window.L && window.L.map) {
    hookL(window.L);
  } else {
    // L not assigned yet — intercept the window.L setter
    var _L;
    Object.defineProperty(window, 'L', {
      configurable: true,
      get: function () { return _L; },
      set: function (v) {
        _L = v;
        if (v && v.map) {
          hookL(v);
          Object.defineProperty(window, 'L', { value: v, writable: true, configurable: true });
        }
      }
    });
    console.log('[Scute++ hook] window.L intercept armed ✓');
  }
})();