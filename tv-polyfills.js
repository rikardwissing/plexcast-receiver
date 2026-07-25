/* Shared old-TV runtime polyfills — loaded by BOTH receivers (the LAN page
   tv.html and the hosted index.html) so the two can never drift.

/* ES2015+ runtime polyfills for 2017-era TV engines (webOS 3.x is
   Chromium 38). hls.js 1.x parses as ES5 but calls Object.assign /
   Object.entries / includes / find at runtime — without these, HLS
   playback dies silently on the TV while working everywhere else. */
(function() {
  /* Every polyfill goes in through defineProperty so it is NON-ENUMERABLE,
     exactly like the native would be. A plain assignment shows up in for-in
     loops — mp4box iterates arrays that way, and on the TV it walked our
     Array.prototype.includes/find/findIndex as if they were sample groups
     and crashed. Chrome 38 supports defineProperty fully. */
  function def(obj, name, fn) {
    if (obj[name]) return;
    try { Object.defineProperty(obj, name, { value: fn, writable: true, configurable: true, enumerable: false }); }
    catch (e) { obj[name] = fn; }
  }
  def(Object, 'assign', function(target) {
    for (var i = 1; i < arguments.length; i++) {
      var source = arguments[i];
      if (source == null) continue;
      for (var key in source) if (Object.prototype.hasOwnProperty.call(source, key)) target[key] = source[key];
    }
    return target;
  });
  def(Object, 'entries', function(obj) {
    var out = [];
    for (var key in obj) if (Object.prototype.hasOwnProperty.call(obj, key)) out.push([key, obj[key]]);
    return out;
  });
  def(Object, 'values', function(obj) {
    var out = [];
    for (var key in obj) if (Object.prototype.hasOwnProperty.call(obj, key)) out.push(obj[key]);
    return out;
  });
  def(String.prototype, 'includes', function(search, start) {
    return this.indexOf(search, start || 0) !== -1;
  });
  def(String.prototype, 'padStart', function(length, pad) {
    var out = String(this); pad = pad === undefined ? ' ' : String(pad);
    while (out.length < length && pad.length) out = pad.charAt(out.length % pad.length) + out;
    return out;
  });
  def(String.prototype, 'padEnd', function(length, pad) {
    var out = String(this); pad = pad === undefined ? ' ' : String(pad);
    while (out.length < length && pad.length) out = out + pad.charAt((out.length - 1) % pad.length);
    return out;
  });
  def(String.prototype, 'startsWith', function(search, start) {
    start = start || 0;
    return this.substring(start, start + search.length) === search;
  });
  def(String.prototype, 'endsWith', function(search, length) {
    if (length === undefined || length > this.length) length = this.length;
    return this.substring(length - search.length, length) === search;
  });
  def(Array.prototype, 'includes', function(item) {
    return this.indexOf(item) !== -1;
  });
  def(Array.prototype, 'find', function(fn) {
    for (var i = 0; i < this.length; i++) if (fn(this[i], i, this)) return this[i];
    return undefined;
  });
  def(Array.prototype, 'findIndex', function(fn) {
    for (var i = 0; i < this.length; i++) if (fn(this[i], i, this)) return i;
    return -1;
  });
  def(Array, 'from', function(like, fn) {
    var out = [];
    for (var i = 0; i < like.length; i++) out.push(fn ? fn(like[i], i) : like[i]);
    return out;
  });
  def(Number, 'isFinite', function(value) {
    return typeof value === 'number' && isFinite(value);
  });
  def(Number, 'isInteger', function(value) {
    return typeof value === 'number' && isFinite(value) && Math.floor(value) === value;
  });
  def(Math, 'trunc', function(value) {
    return value < 0 ? Math.ceil(value) : Math.floor(value);
  });
})();
