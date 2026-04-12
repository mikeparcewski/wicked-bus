/**
 * CJS shim for wicked-bus.
 * Usage: const bus = await import('wicked-bus');
 * Or: import('wicked-bus').then(bus => { ... });
 */

let _mod;
module.exports = new Proxy({}, {
  get(_, prop) {
    if (!_mod) {
      throw new Error(
        'wicked-bus CJS shim: module not yet loaded. ' +
        'Use: const bus = await import("wicked-bus")'
      );
    }
    return _mod[prop];
  }
});

import('./index.js').then(m => { _mod = m; });
