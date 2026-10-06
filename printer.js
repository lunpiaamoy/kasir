// Printer struk langsung (tanpa jendela Print) + buka laci uang.
// Mengirim perintah ESC/POS ke printer thermal 58 mm (mis. iWare C-58BT) lewat:
//   - Bluetooth BLE (Web Bluetooth)            → Chrome/Edge di Android & laptop
//   - Bluetooth klasik / port COM (Web Serial) → Chrome/Edge di laptop (dan Android versi baru)
//   - Kabel USB (WebUSB)                        → Chrome/Edge di Android & laptop
// Safari (iPhone/iPad) dan Firefox tidak bisa: tetap memakai jendela Print biasa.
// Laci uang dicolok ke port RJ11 printer; dibuka dengan perintah ESC p.
(() => {
  const SET_KEY = 'lunpiaPrinter';
  const COLS = 32;                                   // 58 mm, huruf normal = 32 karakter
  const SPP = '00001101-0000-1000-8000-00805f9b34fb'; // Bluetooth klasik (Serial Port Profile)
  // Layanan BLE yang umum dipakai printer thermal murah
  const BLE_SERVICES = [
    '000018f0-0000-1000-8000-00805f9b34fb', '0000ff00-0000-1000-8000-00805f9b34fb',
    '0000ffe0-0000-1000-8000-00805f9b34fb', '0000fee7-0000-1000-8000-00805f9b34fb',
    '0000ae30-0000-1000-8000-00805f9b34fb', '0000ff80-0000-1000-8000-00805f9b34fb',
    'e7810a71-73ae-499d-8c15-faa9aef0c3f2', '49535343-fe7d-4ae5-8fa9-9fafd205e455',
  ];

  const DEF = { mode: 'browser', drawer: true, logo: true, kick: 'auto' };
  const load = () => { try { return { ...DEF, ...JSON.parse(localStorage.getItem(SET_KEY) || '{}') }; } catch { return { ...DEF }; } };
  // Sinyal buka laci. Tiap printer/laci bisa butuh cara berbeda; 'auto' mengirim beberapa sekaligus.
  const KICKS = {
    a: [0x1b, 0x70, 0x00, 0x19, 0xfa],                     // ESC p, pin 2, pulsa 50 ms (standar)
    b: [0x1b, 0x70, 0x01, 0x19, 0xfa],                     // ESC p, pin 5
    c: [0x1b, 0x70, 0x00, 0x64, 0xfa, 0x1b, 0x70, 0x01, 0x64, 0xfa],  // pulsa panjang 200 ms (laci 12/24 V)
    d: [0x10, 0x14, 0x01, 0x00, 0x05, 0x10, 0x14, 0x01, 0x01, 0x05],  // DLE DC4 (perintah real-time)
  };
  const kickBytes = k => k === 'auto' || !KICKS[k] ? [...KICKS.a, ...KICKS.b, ...KICKS.c] : KICKS[k];
  let settings = load();
  const save = () => { try { localStorage.setItem(SET_KEY, JSON.stringify(settings)); } catch {} };

  const support = {
    ble: !!navigator.bluetooth,
    serial: !!navigator.serial,
    usb: !!navigator.usb,
  };
  support.any = support.ble || support.serial || support.usb;

  // ---------------------------------------------------------------- Sambungan
  let conn = null;   // { kind, name, write(bytes), close() }
  const listeners = new Set();
  const emit = () => listeners.forEach(f => { try { f(); } catch {} });
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function bleOpen(device) {
    const server = await device.gatt.connect();
    let target = null;
    for (const svc of await server.getPrimaryServices()) {
      for (const ch of await svc.getCharacteristics()) {
        if (ch.properties.writeWithoutResponse || ch.properties.write) { target = ch; break; }
      }
      if (target) break;
    }
    if (!target) { device.gatt.disconnect(); throw new Error('Printer tersambung, tapi tidak ditemukan jalur untuk mengirim data. Coba "Bluetooth (cara 2)" atau kabel USB.'); }
    device.addEventListener('gattserverdisconnected', () => { if (conn?.device === device) { conn = null; emit(); } }, { once: true });
    return {
      kind: 'Bluetooth', name: device.name || 'Printer Bluetooth', device,
      async write(bytes) {
        for (let i = 0; i < bytes.length; i += 100) {       // BLE: potongan kecil supaya tidak hilang
          const part = bytes.slice(i, i + 100);
          if (target.properties.writeWithoutResponse) await target.writeValueWithoutResponse(part); else await target.writeValue(part);
          await sleep(15);
        }
      },
      close() { try { device.gatt.disconnect(); } catch {} },
    };
  }
  async function serialOpen(port) {
    if (!port.readable) await port.open({ baudRate: 9600 });
    const info = port.getInfo?.() || {};
    return {
      kind: info.bluetoothServiceClassId ? 'Bluetooth' : 'Port COM', name: info.bluetoothServiceClassId ? 'Printer Bluetooth' : 'Printer (port COM)', port,
      async write(bytes) {
        const w = port.writable.getWriter();
        try { for (let i = 0; i < bytes.length; i += 512) { await w.write(bytes.slice(i, i + 512)); } } finally { w.releaseLock(); }
      },
      async close() { try { await port.close(); } catch {} },
    };
  }
  async function usbOpen(dev) {
    if (!dev.opened) await dev.open();
    if (!dev.configuration) await dev.selectConfiguration(1);
    let ifNum = null, ep = null;
    for (const itf of dev.configuration.interfaces) for (const alt of itf.alternates) {
      const out = alt.endpoints.find(e => e.direction === 'out' && e.type === 'bulk');
      if (out && ep == null) { ifNum = itf.interfaceNumber; ep = out.endpointNumber; }
    }
    if (ep == null) throw new Error('Printer USB tidak punya jalur kirim data yang dikenali.');
    try { await dev.claimInterface(ifNum); }
    catch { throw new Error('Printer USB sedang dipakai sistem (driver printer). Di Windows, pakai "Bluetooth (cara 2)" atau jendela Print.'); }
    return {
      kind: 'USB', name: dev.productName || 'Printer USB', dev,
      async write(bytes) { for (let i = 0; i < bytes.length; i += 4096) await dev.transferOut(ep, bytes.slice(i, i + 4096)); },
      async close() { try { await dev.close(); } catch {} },
    };
  }

  async function setConn(c, how) {
    if (conn && conn !== c) await conn.close?.();
    conn = c; settings.last = how; settings.name = c.name; settings.mode = 'direct'; save(); emit();
    return c;
  }

  // Dipanggil dari tombol (butuh klik pengguna)
  async function connect(how) {
    if (how === 'ble') {
      const device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BLE_SERVICES });
      return setConn(await bleOpen(device), 'ble');
    }
    if (how === 'serial') {
      let port;
      try { port = await navigator.serial.requestPort({ allowedBluetoothServiceClassIds: [SPP] }); }
      catch (e) { if (e.name === 'NotFoundError') throw e; port = await navigator.serial.requestPort(); }
      return setConn(await serialOpen(port), 'serial');
    }
    if (how === 'usb') {
      const dev = await navigator.usb.requestDevice({ filters: [] });
      return setConn(await usbOpen(dev), 'usb');
    }
  }

  // Sambung ulang tanpa klik ke printer yang pernah dipilih (kalau browser mengizinkan)
  async function reconnect() {
    if (conn) return conn;
    try {
      if (settings.last === 'usb' && support.usb) { const [d] = await navigator.usb.getDevices(); if (d) return setConn(await usbOpen(d), 'usb'); }
      if (settings.last === 'serial' && support.serial) { const [p] = await navigator.serial.getPorts(); if (p) return setConn(await serialOpen(p), 'serial'); }
      if (settings.last === 'ble' && navigator.bluetooth?.getDevices) {
        const list = await navigator.bluetooth.getDevices();
        const d = list.find(x => x.name === settings.name) || list[0];
        if (d) return setConn(await bleOpen(d), 'ble');
      }
    } catch {}
    return null;
  }
  async function disconnect() { await conn?.close?.(); conn = null; settings.mode = 'browser'; save(); emit(); }

  // ---------------------------------------------------------------- ESC/POS
  const ESC = 0x1b, GS = 0x1d;
  const ascii = s => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[−–—]/g, '-').replace(/[^\x20-\x7e\n]/g, '');
  class Doc {
    constructor() { this.b = [ESC, 0x40, ESC, 0x74, 0x00]; }   // reset, kode huruf standar
    raw(...x) { this.b.push(...x.flat()); return this; }
    text(s) { for (const ch of ascii(s)) this.b.push(ch.charCodeAt(0)); return this; }
    line(s = '') { return this.text(s).raw(0x0a); }
    align(a) { return this.raw(ESC, 0x61, { left: 0, center: 1, right: 2 }[a]); }
    bold(on) { return this.raw(ESC, 0x45, on ? 1 : 0); }
    big(on) { return this.raw(GS, 0x21, on ? 0x11 : 0x00); }
    rule(ch = '-') { return this.line(ch.repeat(COLS)); }
    lr(l, r, w = COLS) { l = ascii(l); r = ascii(r); const n = Math.max(1, w - l.length - r.length); return this.line(l + ' '.repeat(n) + r); }
    wrap(s, indent = '') {   // potong per kata supaya muat 32 kolom
      const words = ascii(s).split(/\s+/).filter(Boolean); let cur = '';
      for (const w of words) { if ((cur + ' ' + w).trim().length > COLS - indent.length) { this.line(indent + cur.trim()); cur = w; } else cur += ' ' + w; }
      if (cur.trim()) this.line(indent + cur.trim());
      return this;
    }
    kv(k, v) { const label = (ascii(k) + '        ').slice(0, 8) + ': '; return this.wrapKV(label, v); }
    wrapKV(label, v) {
      const width = COLS - label.length, words = ascii(v || '-').split(/\s+/); let cur = '', first = true;
      const flush = () => { this.line((first ? label : ' '.repeat(label.length)) + cur.trim()); first = false; cur = ''; };
      for (const w of words) { if ((cur + ' ' + w).trim().length > width && cur) flush(); cur += ' ' + w; }
      flush(); return this;
    }
    feed(n = 1) { return this.raw(ESC, 0x64, n); }
    drawer(kind = settings.kick) { return this.raw(kickBytes(kind)); }
    cut() { return this.raw(GS, 0x56, 0x42, 0x00); }
    image(bits) { if (bits) this.raw(bits); return this; }
    bytes() { return new Uint8Array(this.b); }
  }

  // Logo → gambar hitam-putih (GS v 0), lebar maks 384 titik (58 mm)
  let logoBits = null;
  async function loadLogo(src = 'icons/logo-transparan.png', width = 200) {
    if (logoBits !== null) return logoBits;
    try {
      const img = new Image(); img.src = src; await img.decode();
      const w = Math.min(width, 384) & ~7, h = Math.round(img.height * w / img.width);
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(img, 0, 0, w, h);
      const px = g.getImageData(0, 0, w, h).data, bw = w / 8, out = [GS, 0x76, 0x30, 0x00, bw & 255, bw >> 8, h & 255, h >> 8];
      for (let y = 0; y < h; y++) for (let x = 0; x < bw; x++) {
        let byte = 0;
        for (let k = 0; k < 8; k++) { const i = (y * w + x * 8 + k) * 4; if (px[i] * .3 + px[i + 1] * .59 + px[i + 2] * .11 < 150) byte |= 0x80 >> k; }
        out.push(byte);
      }
      logoBits = out;
    } catch { logoBits = false; }
    return logoBits;
  }

  const rp = n => (Number(n) || 0).toLocaleString('id-ID');
  const pad = (n, w = 2) => String(n).padStart(w, '0');

  // Susun struk dari data nota (sama isinya dengan struk di layar)
  function receipt(o, store, { logo, drawer } = {}) {
    const d = new Doc(), created = new Date(o.created_at);
    const nota = `(${o.year}) ${pad(o.seq, 5)}`;
    const dmy = x => `${pad(x.getDate())} / ${pad(x.getMonth() + 1)} / ${x.getFullYear()}`;
    if (drawer) d.drawer();
    d.align('center');
    if (logo) d.image(logo).line(); else d.bold(true).big(true).line(store.name || 'Lunpia Amoy').big(false).bold(false);
    if (store.address) d.wrap(store.address);
    if (store.phone) d.line(store.phone);
    d.align('left').rule();
    d.kv('NAMA', (o.customer_name || '-').toUpperCase()).kv('WA', o.customer_wa || '-').rule();
    const cats = new Map();
    (o.order_items || []).forEach(i => { if (!cats.has(i.category)) cats.set(i.category, []); cats.get(i.category).push(i); });
    for (const [cat, items] of cats) {
      d.bold(true).line(String(cat).toUpperCase()).bold(false);
      for (const i of items) { d.wrap(String(i.name).toUpperCase(), ' '); d.lr(`  ${i.qty} x ${rp(i.price)}`, rp(i.subtotal)); }
    }
    d.rule().bold(true).lr('TOTAL', rp(o.total)).bold(false);
    d.lr(o.pay_method === 'qris' ? 'QRIS' : 'TUNAI', rp(o.paid));
    if (o.pay_method === 'tunai') d.lr('KEMBALIAN', rp(o.change));
    d.rule().kv('NO', nota).kv('TANGGAL', dmy(created)).kv('WAKTU', `${pad(created.getHours())}.${pad(created.getMinutes())}`);
    if (o.fulfillment && o.fulfillment !== 'langsung') {
      d.rule().kv(o.fulfillment === 'kirim' ? 'KIRIM' : 'AMBIL', o.fulfill_date ? o.fulfill_date.split('-').reverse().join(' / ') : '-')
        .kv('PUKUL', o.fulfill_time ? o.fulfill_time.slice(0, 5).replace(':', '.') : '-');
      if (o.fulfillment === 'kirim') { d.kv('ONGKIR', rp(o.ongkir)); if (o.address) d.kv('ALAMAT', o.address); }
    }
    if (o.note) d.rule().kv('CATATAN', o.note);
    if (o.status === 'batal') d.rule().align('center').bold(true).line('*** DIBATALKAN ***').bold(false).align('left');
    d.align('center').feed(1).line('Terima kasih').feed(3).cut();
    return d.bytes();
  }
  function testPage(store, logo) {
    const d = new Doc().align('center');
    if (logo) d.image(logo).line();
    d.bold(true).line('TES PRINTER').bold(false).line(store.name || 'Lunpia Amoy').line(new Date().toLocaleString('id-ID'))
      .rule().align('left').lr('Kiri', 'Kanan').lr('Ayam 2 x 25.000', '50.000').rule().align('center').line('Printer siap dipakai').feed(3).cut();
    return d.bytes();
  }

  // ---------------------------------------------------------------- API
  async function ensure() {
    const c = conn || await reconnect();
    if (!c) throw new Error('Printer belum tersambung. Buka 🖨 Printer lalu sambungkan.');
    return c;
  }
  async function send(bytes) {
    const c = await ensure();
    try { await c.write(bytes); }
    catch (e) { conn = null; emit(); throw new Error('Gagal mengirim ke printer: ' + (e.message || e) + '. Pastikan printer menyala lalu sambungkan ulang.'); }
  }
  window.Printer = {
    support, COLS,
    get settings() { return settings; },
    set(k, v) { settings[k] = v; save(); emit(); },
    get connected() { return !!conn; },
    get name() { return conn ? `${conn.name} · ${conn.kind}` : ''; },
    get direct() { return settings.mode === 'direct' && support.any; },
    onChange(f) { listeners.add(f); return () => listeners.delete(f); },
    connect, reconnect, disconnect,
    async printOrder(o, store, { openDrawer = false } = {}) {
      const logo = settings.logo ? await loadLogo() : false;
      await send(receipt(o, store, { logo, drawer: openDrawer }));
    },
    async openDrawer(kind) { await send(new Doc().drawer(kind).bytes()); },
    KICK_NAMES: { auto: 'Otomatis (cara 1–3 sekaligus)', a: 'Cara 1 · standar', b: 'Cara 2 · pin 5', c: 'Cara 3 · sinyal panjang', d: 'Cara 4 · perintah langsung' },
    async test(store) { await send(testPage(store, settings.logo ? await loadLogo() : false)); },
    // untuk pengujian
    _receipt: receipt, _Doc: Doc,
  };
})();
