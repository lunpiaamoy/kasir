(() => {
  const DB = window.DB;
  const STORE = window.APP_CONFIG.store;
  const $ = id => document.getElementById(id);

  // ---------------------------------------------------------------- Helpers
  const rp = n => (Number(n) || 0).toLocaleString('id-ID');
  const toInt = s => Number(String(s ?? '').replace(/[^\d]/g, '')) || 0;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const notaNo = o => `(${o.year}) ${pad(o.seq, 5)}`;
  const dmy = d => `${pad(d.getDate())} / ${pad(d.getMonth() + 1)} / ${d.getFullYear()}`;
  const ymdLocal = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const hhmm = t => (t ? t.slice(0, 5).replace(':', '.') : '');
  const longDate = d => d.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const FUL_LABEL = { langsung: 'Langsung', ambil: 'Ambil', kirim: 'Kirim' };

  let toastTimer;
  function toast(msg, bad = false) {
    const t = $('toast');
    t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : ''); t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 3200);
  }

  function segValue(seg) { return seg.querySelector('[aria-checked="true"]').dataset.val; }
  function setSeg(seg, val) {
    seg.querySelectorAll('button').forEach(b => b.setAttribute('aria-checked', String((b.dataset.val ?? b.dataset.range) === val)));
  }

  // ---------------------------------------------------------------- Sort tabel
  // Klik judul kolom: urut naik, klik lagi: turun. Nilai diambil dari data-sort di sel kalau ada
  // (mis. tanggal ISO), selain itu dari teksnya; angka "Rp 1.250.000" dibandingkan sebagai angka.
  // Urutan dipertahankan saat tabel digambar ulang. Kolom tanpa judul atau data-nosort dilewati.
  const sortState = {};
  const cellKey = td => {
    const raw = (td?.dataset.sort ?? td?.textContent ?? '').trim();
    const n = raw.replace(/^Rp\s*/i, '').replace(/\./g, '').replace(/^[−–]/, '-').replace(',', '.');
    return /^-?\d+(\.\d+)?$/.test(n) ? Number(n) : raw.toLowerCase();
  };
  function applySort(table) {
    const st = sortState[table.id], ths = [...table.querySelectorAll('thead th')];
    ths.forEach((th, i) => {
      const on = st && st.col === i;
      th.classList.toggle('sort-asc', on && st.dir === 1);
      th.classList.toggle('sort-desc', on && st.dir === -1);
      if (th.textContent.trim() && !('nosort' in th.dataset)) { th.classList.add('sortable'); th.tabIndex = 0; th.setAttribute('aria-sort', on ? (st.dir === 1 ? 'ascending' : 'descending') : 'none'); }
    });
    const tbody = table.tBodies[0];
    if (!st || !tbody) return;
    const rows = [...tbody.rows].filter(r => !r.querySelector('td.empty'));
    rows.sort((a, b) => {
      const x = cellKey(a.cells[st.col]), y = cellKey(b.cells[st.col]);
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'id', { numeric: true });
      return c * st.dir;
    });
    rows.forEach(r => tbody.append(r));
  }
  function makeSortable(id) {
    const table = $(id);
    const toggle = th => {
      if (!th?.classList.contains('sortable')) return;
      const col = [...th.parentElement.children].indexOf(th), st = sortState[id];
      sortState[id] = { col, dir: st?.col === col ? -st.dir : 1 };
      applySort(table);
    };
    table.addEventListener('click', e => toggle(e.target.closest('thead th')));
    table.addEventListener('keydown', e => { if (e.key === 'Enter') toggle(e.target.closest('thead th')); });
    // Tabel digambar ulang lewat innerHTML → pasang lagi tanda & urutan
    new MutationObserver(() => applySort(table)).observe(table, { childList: true });
  }

  // ---------------------------------------------------------------- State
  let products = [];
  const cart = new Map();          // product_id -> qty
  let currentTab = 'kasir';

  ['recentTable', 'stockTable', 'topTable', 'dailyTable', 'cashHistory'].forEach(makeSortable);

  // ---------------------------------------------------------------- Auth & start
  async function boot() {
    $('demoBanner').hidden = !DB.demo;
    DB.onAuth(s => (s ? showApp(s) : showLogin()));
    const s = await DB.session();
    s ? showApp(s) : showLogin();
  }

  function showLogin() {
    $('topbar').hidden = true; $('app').hidden = true; $('loginView').hidden = false;
  }

  let appShown = false;
  async function showApp(session) {
    $('loginView').hidden = true; $('topbar').hidden = false; $('app').hidden = false;
    $('whoEmail').textContent = session.user?.email || '';
    if (appShown) return;
    appShown = true;
    try {
      role = await DB.myRole();
      document.body.classList.toggle('is-owner', role === 'pemilik');
      $('whoEmail').textContent = `${session.user?.email || ''}${role ? ' · ' + (role === 'pemilik' ? 'Pemilik' : 'Kasir') : ''}`;
      if (!role) {
        $('catalog').innerHTML = `<div class="empty-state">Akun <b>${esc(session.user?.email)}</b> belum terdaftar sebagai staf. Minta pemilik toko menambahkan email ini di tabel <b>staff</b> di Supabase.</div>`;
        return;
      }
      await loadProducts();
      refreshPendingCount();
    } catch (e) { toast(e.message, true); }
  }
  let role = null;
  const isOwner = () => role === 'pemilik';

  $('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    $('loginError').textContent = ''; $('loginBtn').disabled = true;
    try { await DB.signIn($('loginEmail').value.trim(), $('loginPassword').value); }
    catch (err) { $('loginError').textContent = err.message; }
    finally { $('loginBtn').disabled = false; }
  });
  $('logoutBtn').addEventListener('click', async () => {
    await DB.signOut(); appShown = false; role = null; document.body.classList.remove('is-owner'); resetCart(); showLogin();
  });
  $('resetDemoBtn').addEventListener('click', async () => { DB.resetDemo(); cart.clear(); await loadProducts(); refreshPendingCount(); toast('Data contoh dikosongkan'); });

  // ---------------------------------------------------------------- Tabs
  document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => openTab(btn.dataset.tab)));
  function openTab(name) {
    currentTab = name;
    document.querySelectorAll('.tab').forEach(b => b.toggleAttribute('aria-current', b.dataset.tab === name));
    document.querySelectorAll('.tab[aria-current]').forEach(b => b.setAttribute('aria-current', 'page'));
    document.querySelectorAll('.view').forEach(v => (v.hidden = v.id !== 'view-' + name));
    if (name === 'kasir') { loadProducts(); refreshNotices(); }
    if (name === 'pesanan') renderOrders();
    if (name === 'stok') loadProducts();
    if (name === 'kas') renderCash();
    if (name === 'laporan') renderReport();
  }
  document.querySelectorAll('[data-refresh]').forEach(b => b.addEventListener('click', () => openTab(currentTab)));

  // ---------------------------------------------------------------- Products
  async function loadProducts() {
    try { products = await DB.listProducts(); }
    catch (e) { toast(e.message, true); return; }
    const low = products.filter(p => p.active && p.stock <= p.min_stock).length;
    $('lowCount').hidden = !low; $('lowCount').textContent = low;
    renderCatalog(); renderCart(); renderStock();
  }

  function stockChip(p) {
    if (p.stock <= 0) return `<span class="chip bad">${p.stock < 0 ? 'Kurang ' + Math.abs(p.stock) : 'Habis'}</span>`;
    if (p.stock <= p.min_stock) return `<span class="chip warn">Sisa ${p.stock}</span>`;
    return `<span class="chip ok">Stok ${p.stock}</span>`;
  }

  function groupBy(list, key) {
    const m = new Map();
    list.forEach(x => { if (!m.has(x[key])) m.set(x[key], []); m.get(x[key]).push(x); });
    return m;
  }

  function renderCatalog() {
    const active = products.filter(p => p.active);
    if (!active.length) {
      $('catalog').innerHTML = `<div class="empty-state">Belum ada produk. Tambahkan di menu <b>Stok</b>.</div>`;
      return;
    }
    $('catalog').innerHTML = [...groupBy(active, 'category')].map(([cat, list]) => `
      <div class="cat-group">
        <h3>${esc(cat)}</h3>
        <div class="products">
          ${list.map(p => `
            <button class="product" data-add="${p.id}">
              ${cart.get(p.id) ? `<span class="in-cart">${cart.get(p.id)}</span>` : ''}
              <span class="p-name">${esc(p.name)}</span>
              <span class="p-price">Rp ${rp(p.price)}</span>
              <span class="p-foot">${stockChip(p)}</span>
            </button>`).join('')}
        </div>
      </div>`).join('');
  }
  $('catalog').addEventListener('click', e => {
    const b = e.target.closest('[data-add]'); if (!b) return;
    const id = Number(b.dataset.add);
    cart.set(id, (cart.get(id) || 0) + 1);
    renderCatalog(); renderCart();
  });

  // ---------------------------------------------------------------- Cart
  const byId = id => products.find(p => p.id === id);
  // Saat mengubah nota: produk yang sudah ada di nota memakai harga lama (sama seperti di database)
  let editing = null;   // { order, prices: Map(product_id → harga), oldQty: Map(product_id → qty) }
  const priceOf = id => editing?.prices.get(id) ?? byId(id)?.price ?? 0;
  const cartTotal = () => [...cart].reduce((s, [id, q]) => s + priceOf(id) * q, 0);

  function renderCart() {
    for (const id of [...cart.keys()]) if (!byId(id)) cart.delete(id);
    if (!cart.size) {
      $('cartItems').innerHTML = `<div class="cart-empty">Ketuk produk di sebelah untuk menambahkan.</div>`;
    } else {
      $('cartItems').innerHTML = [...cart].map(([id, q]) => {
        const p = byId(id), avail = p.stock + (editing?.oldQty.get(id) || 0);
        const short = q > avail ? `<span class="l-warn">Stok tinggal ${Math.max(avail, 0)}</span>` : '';
        return `<div class="line">
          <div class="l-name">${esc(p.name)}<small>${esc(p.category)} · ${rp(priceOf(id))}</small>${short}</div>
          <div class="stepper">
            <button type="button" data-dec="${id}" aria-label="Kurangi">−</button>
            <input value="${q}" inputmode="numeric" data-qty="${id}" aria-label="Jumlah ${esc(p.name)}">
            <button type="button" data-inc="${id}" aria-label="Tambah">+</button>
          </div>
          <div class="l-sub">${rp(priceOf(id) * q)}</div>
        </div>`;
      }).join('');
    }
    $('cartTotal').textContent = rp(cartTotal());
    const pcs = [...cart.values()].reduce((s, q) => s + q, 0);
    $('cartJumpCount').textContent = pcs + ' pcs';
    $('cartJumpTotal').textContent = rp(cartTotal());
    $('cartJump').hidden = !cart.size || cartInView;
    renderPayment();
  }

  // Tombol "Lihat pesanan" di HP: sembunyi saat keranjang sudah terlihat
  let cartInView = false;
  new IntersectionObserver(([e]) => { cartInView = e.isIntersecting; $('cartJump').hidden = !cart.size || cartInView; })
    .observe(document.querySelector('.cart'));
  $('cartJump').addEventListener('click', () => document.querySelector('.cart').scrollIntoView({ behavior: 'smooth', block: 'start' }));
  $('cartItems').addEventListener('click', e => {
    const inc = e.target.closest('[data-inc]'), dec = e.target.closest('[data-dec]');
    if (inc) { const id = Number(inc.dataset.inc); cart.set(id, cart.get(id) + 1); }
    else if (dec) { const id = Number(dec.dataset.dec); const q = cart.get(id) - 1; q > 0 ? cart.set(id, q) : cart.delete(id); }
    else return;
    renderCatalog(); renderCart();
  });
  $('cartItems').addEventListener('change', e => {
    const inp = e.target.closest('[data-qty]'); if (!inp) return;
    const id = Number(inp.dataset.qty), q = toInt(inp.value);
    q > 0 ? cart.set(id, q) : cart.delete(id);
    renderCatalog(); renderCart();
  });

  // Diambil kapan
  $('fulfillSeg').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const v = b.dataset.val;
    setFulfill(v);
    if (v !== 'langsung' && !$('fDate').value) $('fDate').value = ymdLocal(new Date());
  });

  // Pukul: ketik 4 angka → 2 pertama jam, 2 berikutnya menit (1030 → 10:30).
  // Angka ke-5 memulai lagi dari jam. Batas: jam 00–24, menit 00–59 (24 hanya 24:00).
  // Angka pertama 3–9 otomatis jadi jam 03–09; angka menit pertama 6–9 jadi menit 06–09.
  // Nilai disimpan sebagai "HH:MM".
  const timeDigits = () => $('fTime').value.replace(/\D/g, '').slice(0, 4);
  const showTime = d => ($('fTime').value = d.length > 2 ? `${d.slice(0, 2)}:${d.slice(2)}` : d);
  const timeValue = () => { const d = timeDigits(); return d.length === 4 ? `${d.slice(0, 2)}:${d.slice(2)}` : ''; };
  const timeValid = () => {
    const d = timeDigits(), h = +d.slice(0, 2), m = +d.slice(2);
    return d.length === 4 && m < 60 && (h < 24 || (h === 24 && m === 0));
  };
  function addTimeDigit(d, ch) {
    if (d.length >= 4) d = '';
    if (d.length === 0) return ch > '2' ? '0' + ch : ch;
    if (d.length === 1) return +(d + ch) > 24 ? d : d + ch;         // jam lebih dari 24 diabaikan
    if (d === '24' || d === '240') return ch === '0' ? d + ch : d;  // 24 hanya boleh 24:00
    if (d.length === 2) return ch > '5' ? d + '0' + ch : d + ch;
    return d + ch;
  }
  $('fTime').addEventListener('beforeinput', e => {
    if (!e.inputType.startsWith('insert')) return;   // hapus/backspace biarkan
    e.preventDefault();
    let d = timeDigits();
    for (const ch of (e.data || '').replace(/\D/g, '')) d = addTimeDigit(d, ch);
    showTime(d);
  });
  $('fTime').addEventListener('input', () => showTime(timeDigits()));   // setelah hapus: rapikan pemisahnya

  // Pembayaran
  $('paySeg').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    setPay(b.dataset.val);
  });
  $('paid').addEventListener('input', renderPayment);
  $('quickCash').addEventListener('click', e => {
    const b = e.target.closest('[data-cash]'); if (!b) return;
    $('paid').value = rp(Number(b.dataset.cash)); renderPayment();
  });
  function renderPayment() {
    const total = cartTotal();
    const opts = new Set();
    if (total) {
      opts.add(total);
      [10000, 20000, 50000, 100000].forEach(step => opts.add(Math.ceil(total / step) * step));
      opts.add(Math.ceil(total / 100000) * 100000 + 100000);
    }
    $('quickCash').innerHTML = [...opts].sort((a, b) => a - b).slice(0, 5)
      .map(v => `<button type="button" data-cash="${v}">${v === total ? 'Uang pas' : rp(v)}</button>`).join('');
    const paid = toInt($('paid').value);
    const change = paid - total;
    $('changeOut').textContent = paid ? (change >= 0 ? rp(change) : 'Kurang ' + rp(-change)) : '0';
    $('changeOut').parentElement.classList.toggle('short', paid > 0 && change < 0);
  }
  ['ongkir', 'paid'].forEach(id => $(id).addEventListener('blur', () => { const v = toInt($(id).value); $(id).value = v ? rp(v) : ''; }));

  function setFulfill(v) {
    setSeg($('fulfillSeg'), v);
    $('fulfillFields').hidden = v === 'langsung';
    $('ongkirField').hidden = v !== 'kirim';
  }
  function setPay(v) { setSeg($('paySeg'), v); $('cashFields').hidden = v !== 'tunai'; }

  function resetCart() {
    cart.clear(); editing = null;
    ['custName', 'custWa', 'orderNote', 'fDate', 'fTime', 'ongkir', 'paid'].forEach(id => ($(id).value = ''));
    setFulfill('langsung'); setPay('tunai');
    $('cartError').textContent = '';
    $('cartTitle').textContent = 'Pesanan baru'; $('editBanner').hidden = true;
    $('saveBtn').textContent = 'Simpan & cetak struk';
    renderCatalog(); renderCart();
  }

  // Ubah nota (pemilik): isi keranjang dan formulir dengan data nota
  function startEdit(o) {
    resetCart();
    editing = {
      order: o,
      prices: new Map(o.order_items.map(i => [i.product_id, i.price])),
      oldQty: new Map(o.order_items.map(i => [i.product_id, i.qty])),
    };
    o.order_items.forEach(i => { if (i.product_id != null) cart.set(i.product_id, (cart.get(i.product_id) || 0) + i.qty); });
    $('custName').value = o.customer_name || ''; $('custWa').value = o.customer_wa || ''; $('orderNote').value = o.note || '';
    setFulfill(o.fulfillment);
    $('fDate').value = o.fulfill_date || ''; showTime((o.fulfill_time || '').replace(/\D/g, '').slice(0, 4));
    $('ongkir').value = o.ongkir ? rp(o.ongkir) : '';
    setPay(o.pay_method); $('paid').value = o.pay_method === 'tunai' ? rp(o.paid) : '';
    $('cartTitle').textContent = `Ubah nota ${notaNo(o)}`;
    $('editBanner').innerHTML = `Stok dan total dihitung ulang saat disimpan. Harga produk yang sudah ada di nota tetap memakai harga lama.
      <button class="link" id="cancelEditBtn">Batal ubah</button>`;
    $('editBanner').hidden = false;
    $('saveBtn').textContent = 'Simpan perubahan';
    openTab('kasir');
    document.querySelector('.cart').scrollIntoView({ block: 'start' });
  }
  $('editBanner').addEventListener('click', e => { if (e.target.id === 'cancelEditBtn') resetCart(); });

  $('saveBtn').addEventListener('click', async () => {
    const err = m => ($('cartError').textContent = m);
    err('');
    const total = cartTotal();
    const ful = segValue($('fulfillSeg')), pay = segValue($('paySeg'));
    if (!cart.size) return err('Keranjang masih kosong.');
    if (ful !== 'langsung') {
      if (!$('custName').value.trim()) return err('Isi nama pembeli untuk pesanan ambil/kirim.');
      if (!$('fDate').value || !timeDigits()) return err('Isi tanggal dan pukul ' + (ful === 'kirim' ? 'kirim.' : 'ambil.'));
      if (!timeValid()) return err('Pukul tidak valid. Ketik 4 angka, mis. 1030 untuk 10.30.');
    }
    if (pay === 'tunai' && toInt($('paid').value) < total) return err('Uang diterima kurang dari total.');

    const payload = {
      items: [...cart].map(([product_id, qty]) => ({ product_id, qty })),
      customer_name: $('custName').value.trim(),
      customer_wa: $('custWa').value.trim(),
      fulfillment: ful,
      fulfill_date: ful === 'langsung' ? '' : $('fDate').value,
      fulfill_time: ful === 'langsung' ? '' : timeValue(),
      ongkir: ful === 'kirim' ? toInt($('ongkir').value) : 0,
      pay_method: pay,
      paid: pay === 'tunai' ? toInt($('paid').value) : total,
      note: $('orderNote').value.trim(),
    };
    $('saveBtn').disabled = true;
    try {
      const wasEdit = !!editing;
      const order = wasEdit ? await DB.updateOrder(editing.order.id, payload) : await DB.createOrder(payload);
      resetCart();
      await loadProducts();
      refreshPendingCount();
      showReceipt(order, !wasEdit);
      toast(`${wasEdit ? 'Perubahan disimpan' : 'Tersimpan'} · Nota ${notaNo(order)}`);
    } catch (e) {
      err(e.message);
    } finally {
      $('saveBtn').disabled = false;
    }
  });

  // ---------------------------------------------------------------- Receipt
  function receiptHtml(o) {
    const cats = groupBy(o.order_items, 'category');
    const created = new Date(o.created_at);
    const kv = rows => `<table class="kv">${rows.map(([k, v]) => `<tr><td>${k}</td><td>: ${v}</td></tr>`).join('')}</table>`;
    const fulRows = o.fulfillment === 'langsung' ? '' : `<div class="r-gap"></div>` + kv([
      [o.fulfillment === 'kirim' ? 'KIRIM' : 'AMBIL', o.fulfill_date ? dmy(parseYmd(o.fulfill_date)) : '-'],
      ['PUKUL', hhmm(o.fulfill_time) || '-'],
      ...(o.fulfillment === 'kirim' ? [['ONGKIR', rp(o.ongkir)]] : []),
    ]);
    return `
      <img src="logo.jpg" alt="">
      <div class="r-c r-store">${esc(STORE.address)}<br>${esc(STORE.phone)}</div>
      <div class="r-gap"></div>
      ${kv([['NAMA', esc(o.customer_name.toUpperCase() || '-')], ['WA', esc(o.customer_wa || '-')]])}
      <div class="r-gap"></div>
      <table class="items">
        <thead><tr><th>PRODUK</th><th>PCS</th><th>RP</th><th>SUB</th></tr></thead>
        <tbody>
          ${[...cats].map(([cat, items]) => `
            <tr class="r-cat"><td colspan="4">${esc(cat.toUpperCase())}</td></tr>
            ${items.map(i => `<tr><td>${esc(i.name.toUpperCase())}</td><td>${i.qty}</td><td>${rp(i.price)}</td><td>${rp(i.subtotal)}</td></tr>`).join('')}
          `).join('')}
        </tbody>
      </table>
      <div class="r-rule"></div>
      <table class="tot">
        <tr><td>TOTAL</td><td>${rp(o.total)}</td></tr>
        <tr><td>${o.pay_method === 'qris' ? 'QRIS' : 'TUNAI'}</td><td>${rp(o.paid)}</td></tr>
        ${o.pay_method === 'tunai' ? `<tr><td>KEMBALIAN</td><td>${rp(o.change)}</td></tr>` : ''}
      </table>
      <div class="r-gap"></div>
      ${kv([['NO', notaNo(o)], ['TANGGAL', dmy(created)], ['WAKTU', `${pad(created.getHours())}.${pad(created.getMinutes())}`]])}
      ${fulRows}
      ${o.note ? `<div class="r-gap"></div>${kv([['CATATAN', esc(o.note)]])}` : ''}
      ${o.status === 'batal' ? '<div class="r-gap"></div><div class="r-c"><b>*** DIBATALKAN ***</b></div>' : ''}
    `;
  }

  async function doPrint() {
    const img = $('receipt').querySelector('img');
    if (img && !img.complete) await new Promise(r => { img.onload = img.onerror = r; });
    window.print();
  }
  // ---- Nota ke WhatsApp sebagai teks ----
  // Chat pembeli dibuka dengan isi nota sudah terketik; kasir tinggal tekan Enter.
  //  - Laptop: WhatsApp Web. Situs lain tidak bisa mengarahkan ke tab WhatsApp Web yang sudah terbuka
  //    (WhatsApp memutus hubungan tab), jadi chat selalu terbuka di tab baru.
  //  - HP: langsung aplikasi WhatsApp.
  const waNumber = s => String(s || '').replace(/\D/g, '').replace(/^0/, '62');
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  // Format pesan mengikuti contoh dari toko
  function waText(o) {
    const d = new Date(o.created_at);
    return [
      `*${STORE.name.toUpperCase()}*`, '',
      ...o.order_items.map(i => `${i.category} ${i.name}\n  ${i.qty} x ${rp(i.price)} = ${rp(i.subtotal)}`), '',
      `*Total: Rp ${rp(o.total)}*`, '',
      ...(o.status === 'batal' ? ['*NOTA INI DIBATALKAN*', ''] : []),
      'Terima Kasih.', '',
      STORE.name, STORE.address, STORE.phone, '',
      notaNo(o), dmy(d), `${pad(d.getHours())}.${pad(d.getMinutes())}`,
    ].join('\n');
  }

  // Nomor WA di kartu pesanan: HP → buka chat di aplikasi; laptop → salin nomor (untuk dicari di WhatsApp Web)
  async function waContact(phone) {
    if (isMobile) return void (location.href = `https://wa.me/${waNumber(phone)}`);
    try { await navigator.clipboard.writeText(phone); toast(`Nomor ${phone} disalin. Tempel di kolom cari WhatsApp Web.`); }
    catch { toast(`Nomor WA: ${phone}`); }
  }

  let receiptOrder = null;
  $('waBtn').addEventListener('click', () => {
    const o = receiptOrder; if (!o) return;
    const num = waNumber(o.customer_wa), text = encodeURIComponent(waText(o));
    if (isMobile) return void (location.href = `https://wa.me/${num}?text=${text}`);
    window.open(`https://web.whatsapp.com/send?${num ? 'phone=' + num + '&' : ''}text=${text}`, '_blank');
    $('waHint').textContent = 'Chat WhatsApp pembeli sudah dibuka di tab baru dengan isi nota. Tekan Enter untuk mengirim.';
    $('waHint').hidden = false;
  });

  function showReceipt(order, autoPrint = false) {
    receiptOrder = order;
    $('waHint').hidden = true;
    $('receipt').innerHTML = receiptHtml(order);
    $('receiptTitle').textContent = 'Struk ' + notaNo(order);
    $('receiptModal').hidden = false;
    if (autoPrint) doPrint();
  }
  $('printBtn').addEventListener('click', doPrint);
  $('closeReceiptBtn').addEventListener('click', () => ($('receiptModal').hidden = true));
  $('receiptModal').addEventListener('click', e => { if (e.target === $('receiptModal')) $('receiptModal').hidden = true; });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') $('receiptModal').hidden = true; });

  // ---------------------------------------------------------------- Orders
  const orderCache = new Map();
  const itemsSummary = o => o.order_items.map(i => `${i.category.replace(/^Lunpia\s+/i, '')} ${i.name} ×${i.qty}`).join(', ');

  async function refreshPendingCount() {
    refreshNotices();
    try {
      const n = (await DB.listPending()).length;
      $('pendingCount').hidden = !n; $('pendingCount').textContent = n;
    } catch {}
  }

  async function renderOrders() {
    let pending, recent;
    try { [pending, recent] = await Promise.all([DB.listPending(), DB.recentOrders(30)]); }
    catch (e) { toast(e.message, true); return; }
    [...pending, ...recent].forEach(o => orderCache.set(o.id, o));
    $('pendingCount').hidden = !pending.length; $('pendingCount').textContent = pending.length;
    refreshNotices();

    const today = ymdLocal(new Date());
    const tomorrow = ymdLocal(new Date(Date.now() + 864e5));
    const nowHm = new Date().toTimeString().slice(0, 5);
    if (!pending.length) {
      $('pendingList').innerHTML = `<div class="empty-state">Tidak ada pesanan yang menunggu diambil atau dikirim.</div>`;
    } else {
      $('pendingList').innerHTML = [...groupBy(pending, 'fulfill_date')].map(([date, list]) => {
        const tag = date < today ? '<span class="chip bad">Terlewat</span>' : date === today ? '<span class="chip amoy">Hari ini</span>' : date === tomorrow ? '<span class="chip plain">Besok</span>' : '';
        return `<div class="day">
          <div class="day-head">${date ? esc(longDate(parseYmd(date))) : 'Tanpa tanggal'} ${tag}</div>
          <div class="orders">${list.map(o => {
            const late = date < today || (date === today && o.fulfill_time && o.fulfill_time.slice(0, 5) < nowHm);
            return `<article class="order${late ? ' late' : ''}" data-order="${o.id}">
              <div class="order-top">
                <span class="order-time">${hhmm(o.fulfill_time) || '--.--'}</span>
                <span class="chip ${o.fulfillment === 'kirim' ? 'warn' : 'plain'}">${FUL_LABEL[o.fulfillment]}</span>
              </div>
              <div class="order-who">${esc(o.customer_name || '-')} ${o.customer_wa ? `· <button class="link wa-link" data-wachat="${esc(o.customer_wa)}">${esc(o.customer_wa)}</button>` : ''}</div>
              <div class="order-items">${esc(itemsSummary(o))}</div>
              ${o.note ? `<div class="order-note">Catatan: ${esc(o.note)}</div>` : ''}
              <div class="order-total"><span>${o.pay_method === 'qris' ? 'QRIS' : 'Tunai'} · Nota ${notaNo(o)}</span><span>${rp(o.total)}</span></div>
              ${o.fulfillment === 'kirim' ? `<div class="muted">Ongkir ${rp(o.ongkir)}</div>` : ''}
              <div class="actions" data-actions>
                <button class="primary small" data-done="${o.id}">Tandai selesai</button>
                <button class="ghost small" data-reprint="${o.id}">Cetak ulang</button>
                <button class="ghost small danger" data-cancel="${o.id}">Batalkan</button>
                <button class="ghost small owner-only" data-editorder="${o.id}">Ubah</button>
                <button class="ghost small danger owner-only" data-del="${o.id}">Hapus</button>
              </div>
            </article>`;
          }).join('')}</div>
        </div>`;
      }).join('');
    }

    const statusChip = s => s === 'batal' ? '<span class="chip bad">Batal</span>' : s === 'menunggu' ? '<span class="chip warn">Menunggu</span>' : '<span class="chip ok">Selesai</span>';
    $('recentTable').innerHTML = `
      <thead><tr><th>Nota</th><th>Tanggal</th><th>Waktu</th><th>Pembeli</th><th>Jenis</th><th>Bayar</th><th class="num">Total</th><th>Status</th><th></th></tr></thead>
      <tbody>${recent.length ? recent.map(o => {
        const d = new Date(o.created_at);
        return `<tr class="${o.status === 'batal' ? 'dim' : ''}">
          <td class="num">${notaNo(o)}</td>
          <td data-sort="${esc(o.created_at)}">${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}</td>
          <td data-sort="${pad(d.getHours())}${pad(d.getMinutes())}">${pad(d.getHours())}.${pad(d.getMinutes())}</td>
          <td>${esc(o.customer_name || '-')}</td>
          <td>${FUL_LABEL[o.fulfillment]}</td>
          <td>${o.pay_method === 'qris' ? 'QRIS' : 'Tunai'}</td>
          <td class="num">${rp(o.total)}</td>
          <td>${statusChip(o.status)}</td>
          <td><div class="add-stock" data-actions>
            <button class="ghost small" data-reprint="${o.id}">Cetak ulang</button>
            ${o.status === 'batal' ? '' : `<button class="ghost small owner-only" data-editorder="${o.id}">Ubah</button>`}
            <button class="ghost small danger owner-only" data-del="${o.id}">Hapus</button>
          </div></td>
        </tr>`;
      }).join('') : '<tr><td class="empty" colspan="9">Belum ada transaksi.</td></tr>'}</tbody>`;
  }

  $('view-pesanan').addEventListener('click', async e => {
    const t = e.target.closest('button'); if (!t) return;
    const d = t.dataset;
    try {
      if (d.reprint) showReceipt(orderCache.get(Number(d.reprint)));
      else if (d.wachat) waContact(d.wachat);
      else if (d.done) { await DB.markDone(Number(d.done)); toast('Pesanan ditandai selesai'); renderOrders(); }
      else if (d.editorder) startEdit(orderCache.get(Number(d.editorder)));
      else if (d.cancel) {
        const box = t.closest('[data-actions]');
        box.innerHTML = `<div class="confirm">Batalkan pesanan ini? Stok akan dikembalikan.
          <div class="actions"><button class="primary small" data-cancelyes="${d.cancel}">Ya, batalkan</button>
          <button class="ghost small" data-refresh-orders>Tidak</button></div></div>`;
      }
      else if (d.cancelyes) { await DB.cancelOrder(Number(d.cancelyes)); toast('Pesanan dibatalkan, stok dikembalikan'); renderOrders(); loadProducts(); }
      else if (d.del) {
        const o = orderCache.get(Number(d.del));
        t.closest('[data-actions]').innerHTML = `<div class="confirm">Hapus nota ${notaNo(o)} secara permanen?
          ${o.status === 'batal' ? 'Transaksi' : 'Stok dikembalikan dan transaksi'} ini hilang dari laporan. Tidak bisa dikembalikan.
          <div class="actions"><button class="primary small" data-delyes="${o.id}">Ya, hapus</button>
          <button class="ghost small" data-refresh-orders>Tidak</button></div></div>`;
      }
      else if (d.delyes) {
        const o = orderCache.get(Number(d.delyes));
        await DB.deleteOrder(o.id); orderCache.delete(o.id);
        toast(`Nota ${notaNo(o)} dihapus`); renderOrders(); loadProducts();
      }
      else if ('refreshOrders' in d) renderOrders();
    } catch (err) { toast(err.message, true); }
  });

  // ---------------------------------------------------------------- Stock
  let editingId = null;
  function renderStock() {
    const low = products.filter(p => p.active && p.stock <= p.min_stock);
    $('stockSummary').innerHTML = low.length
      ? `<b>${low.length} produk stok menipis:</b> ${low.map(p => esc(p.category + ' ' + p.name)).join(', ')}.`
      : 'Semua stok aman.';
    $('categoryList').innerHTML = [...new Set(products.map(p => p.category))].map(c => `<option value="${esc(c)}">`).join('');
    $('stockTable').innerHTML = `
      <thead><tr><th>Jenis</th><th>Produk</th><th class="num">Harga</th><th class="num">Stok</th><th>Status</th><th data-nosort>Tambah stok</th><th></th></tr></thead>
      <tbody>${products.length ? products.map(p => `
        <tr class="${p.active ? '' : 'dim'}">
          <td>${esc(p.category)}</td>
          <td><b>${esc(p.name)}</b>${p.active ? '' : ' <span class="chip plain">Disembunyikan</span>'}</td>
          <td class="num">${rp(p.price)}</td>
          <td class="num stock-num">${p.stock}</td>
          <td data-sort="${p.stock - p.min_stock}">${stockChip(p)} <span class="muted">min ${p.min_stock}</span></td>
          <td><div class="add-stock">
            <input inputmode="numeric" placeholder="0" id="add-${p.id}" aria-label="Tambah stok ${esc(p.name)}">
            <button class="ghost small" data-addstock="${p.id}">Tambah</button>
          </div></td>
          <td><div class="add-stock">
            <button class="ghost small" data-card="${p.id}">Kartu stok</button>
            <button class="ghost small owner-only" data-edit="${p.id}">Ubah</button>
          </div></td>
        </tr>`).join('') : '<tr><td class="empty" colspan="7">Belum ada produk.</td></tr>'}</tbody>`;
  }

  $('stockTable').addEventListener('click', async e => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.dataset.addstock) {
      const id = Number(t.dataset.addstock);
      const raw = $('add-' + id).value.trim();
      const n = (raw.startsWith('-') ? -1 : 1) * toInt(raw);
      if (!n) return toast('Isi jumlah stok yang mau ditambahkan', true);
      if (n < 0 && !isOwner()) return toast('Hanya pemilik yang bisa mengurangi stok', true);
      try { await DB.addStock(id, n, n > 0 ? 'Tambah stok' : 'Koreksi stok'); toast(`Stok ${byId(id).name} ${n > 0 ? '+' : ''}${n}`); loadProducts(); }
      catch (err) { toast(err.message, true); }
    }
    if (t.dataset.edit) openProductForm(byId(Number(t.dataset.edit)));
    if (t.dataset.card) openStockCard(byId(Number(t.dataset.card)));
  });
  $('stockTable').addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.id?.startsWith('add-')) e.target.nextElementSibling.click();
  });

  // ---------------------------------------------------------------- Stock opname (pemilik)
  function openOpname() {
    $('productForm').hidden = true;
    const list = products.filter(p => p.active);
    $('opnameTable').innerHTML = `
      <thead><tr><th>Jenis</th><th>Produk</th><th class="num">Sistem</th><th>Fisik</th><th class="num">Selisih</th></tr></thead>
      <tbody>${list.map(p => `<tr>
        <td>${esc(p.category)}</td><td><b>${esc(p.name)}</b></td>
        <td class="num stock-num">${p.stock}</td>
        <td><input class="count-in" inputmode="numeric" data-count="${p.id}" aria-label="Hitungan fisik ${esc(p.category + ' ' + p.name)}"></td>
        <td class="num" data-diff="${p.id}"></td>
      </tr>`).join('')}</tbody>`;
    $('opnameSum').textContent = '';
    $('opnameForm').hidden = false;
    $('opnameTable').querySelector('input')?.focus();
  }
  function opnameEntries() {
    return [...$('opnameTable').querySelectorAll('[data-count]')]
      .filter(i => i.value.trim() !== '')
      .map(i => ({ product_id: Number(i.dataset.count), counted: toInt(i.value) }));
  }
  $('opnameTable').addEventListener('input', e => {
    const inp = e.target.closest('[data-count]'); if (!inp) return;
    const id = Number(inp.dataset.count), cell = $('opnameTable').querySelector(`[data-diff="${id}"]`);
    const d = inp.value.trim() === '' ? null : toInt(inp.value) - byId(id).stock;
    cell.innerHTML = d == null ? '' : d === 0 ? '<span class="chip ok">Cocok</span>' : `<span class="${d > 0 ? 'in' : 'out'}">${d > 0 ? '+' : '−'}${Math.abs(d)}</span>`;
    const entries = opnameEntries(), diff = entries.filter(x => x.counted !== byId(x.product_id).stock).length;
    $('opnameSum').textContent = entries.length ? `${entries.length} produk dihitung · ${diff} berbeda dari sistem` : '';
  });
  $('opnameTable').addEventListener('keydown', e => {   // Enter pindah ke produk berikutnya
    if (e.key !== 'Enter' || !e.target.matches('[data-count]')) return;
    e.preventDefault();
    const all = [...$('opnameTable').querySelectorAll('[data-count]')];
    all[all.indexOf(e.target) + 1]?.focus();
  });
  $('opnameBtn').addEventListener('click', openOpname);
  $('cancelOpnameBtn').addEventListener('click', () => ($('opnameForm').hidden = true));
  $('opnameForm').addEventListener('submit', async e => {
    e.preventDefault();
    const entries = opnameEntries();
    if (!entries.length) return toast('Isi hitungan fisik minimal satu produk', true);
    try {
      const n = await DB.stockOpname(entries);
      $('opnameForm').hidden = true;
      toast(n ? `Opname disimpan · ${n} produk disesuaikan` : 'Opname disimpan · semua stok cocok');
      loadProducts();
    } catch (err) { toast(err.message, true); }
  });

  function openProductForm(p) {
    $('opnameForm').hidden = true;
    editingId = p?.id ?? null;
    $('productFormTitle').textContent = p ? `Ubah ${p.category} ${p.name}` : 'Tambah produk';
    $('pCategory').value = p?.category ?? '';
    $('pName').value = p?.name ?? '';
    $('pPrice').value = p ? p.price : '';
    $('pMin').value = p ? p.min_stock : 5;
    $('pActive').checked = p ? p.active : true;
    $('productForm').hidden = false;
    $('pCategory').focus();
  }
  $('newProductBtn').addEventListener('click', () => openProductForm(null));
  $('cancelProductBtn').addEventListener('click', () => ($('productForm').hidden = true));
  $('productForm').addEventListener('submit', async e => {
    e.preventDefault();
    const existing = editingId ? byId(editingId) : null;
    const p = {
      id: editingId,
      category: $('pCategory').value.trim(),
      name: $('pName').value.trim(),
      price: toInt($('pPrice').value),
      min_stock: toInt($('pMin').value),
      active: $('pActive').checked,
      sort: existing ? existing.sort : (Math.max(0, ...products.map(x => x.sort)) + 10),
    };
    if (!p.category || !p.name || !p.price) return toast('Lengkapi jenis, nama, dan harga', true);
    try { await DB.saveProduct(p); $('productForm').hidden = true; toast('Produk disimpan'); loadProducts(); }
    catch (err) { toast(err.message, true); }
  });

  // ---------------------------------------------------------------- Stock card
  // Saldo dihitung mundur dari stok sekarang, jadi selalu cocok dengan angka di tabel stok.
  let cardProduct = null, cardRange = null;
  function cardRangeFor(key) {
    const now = new Date(), tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    if (key === 'month') return [new Date(now.getFullYear(), now.getMonth(), 1), tomorrow];
    if (key === 'lastmonth') return [new Date(now.getFullYear(), now.getMonth() - 1, 1), new Date(now.getFullYear(), now.getMonth(), 1)];
    if (key === '90d') return [new Date(now.getFullYear(), now.getMonth(), now.getDate() - 89), tomorrow];
  }
  function openStockCard(p) {
    cardProduct = p; cardRange = cardRangeFor('month');
    setSeg($('cardRangeSeg'), 'month');
    $('cardTitle').textContent = `Kartu stok · ${p.category} ${p.name}`;
    $('cardModal').hidden = false;
    renderStockCard();
  }
  const closeCard = () => ($('cardModal').hidden = true);
  $('closeCardBtn').addEventListener('click', closeCard);
  $('cardModal').addEventListener('click', e => { if (e.target === $('cardModal')) closeCard(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeCard(); });
  $('cardRangeSeg').addEventListener('click', e => {
    const b = e.target.closest('[data-range]'); if (!b) return;
    setSeg($('cardRangeSeg'), b.dataset.range); cardRange = cardRangeFor(b.dataset.range); renderStockCard();
  });
  $('cApply').addEventListener('click', () => {
    if (!$('cFrom').value || !$('cTo').value) return toast('Pilih tanggal awal dan akhir', true);
    const from = parseYmd($('cFrom').value), to = new Date(+parseYmd($('cTo').value) + 864e5);
    if (to <= from) return toast('Tanggal akhir harus setelah tanggal awal', true);
    setSeg($('cardRangeSeg'), ''); cardRange = [from, to]; renderStockCard();
  });

  async function renderStockCard() {
    const p = cardProduct, [from, to] = cardRange;
    $('cFrom').value = ymdLocal(from); $('cTo').value = ymdLocal(new Date(+to - 864e5));
    $('cardTable').innerHTML = '<tbody><tr><td class="empty">Memuat…</td></tr></tbody>';
    let moves;
    try { moves = await DB.stockCard(p.id, from.toISOString()); }
    catch (e) { toast(e.message, true); return; }
    if (cardProduct !== p || cardRange[0] !== from) return;   // sudah ganti produk/periode

    moves.sort((a, b) => new Date(a.at) - new Date(b.at));
    const current = byId(p.id)?.stock ?? p.stock;
    const opening = current - moves.reduce((s, m) => s + m.delta, 0);
    const rows = moves.filter(m => new Date(m.at) < to);
    let bal = opening;
    rows.forEach(m => (m.balance = bal += m.delta));
    const inQty = rows.reduce((s, m) => s + Math.max(m.delta, 0), 0);
    const outQty = rows.reduce((s, m) => s - Math.min(m.delta, 0), 0);

    $('cardMetrics').innerHTML = `
      <div class="metric"><small>Stok awal</small><b>${opening}</b><span>${esc(dmy(from))}</span></div>
      <div class="metric"><small>Masuk</small><b class="in">+${inQty}</b></div>
      <div class="metric"><small>Keluar</small><b class="out">−${outQty}</b></div>
      <div class="metric lead"><small>Stok akhir</small><b>${bal}</b><span>${esc(dmy(new Date(+to - 864e5)))}</span></div>`;

    const desc = m => m.order
      ? `${m.cancel ? 'Batal, stok kembali' : 'Terjual'} · Nota ${notaNo(m.order)}${m.order.customer_name ? ' · ' + esc(m.order.customer_name) : ''}`
      : esc(m.note || (m.delta > 0 ? 'Tambah stok' : 'Koreksi stok'));
    $('cardTable').innerHTML = `
      <thead><tr><th>Tanggal</th><th>Keterangan</th><th class="num">Masuk</th><th class="num">Keluar</th><th class="num">Saldo</th><th>Oleh</th></tr></thead>
      <tbody>
        <tr class="dim"><td>${esc(dmy(from))}</td><td>Stok awal</td><td></td><td></td><td class="num">${opening}</td><td></td></tr>
        ${rows.map(m => {
          const d = new Date(m.at);
          return `<tr>
            <td>${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}.${pad(d.getMinutes())}</td>
            <td>${desc(m)}</td>
            <td class="num in">${m.delta > 0 ? m.delta : ''}</td>
            <td class="num out">${m.delta < 0 ? -m.delta : ''}</td>
            <td class="num"><b>${m.balance}</b></td>
            <td class="muted">${esc((m.by || '').split('@')[0])}</td>
          </tr>`;
        }).join('') || '<tr><td class="empty" colspan="6">Tidak ada mutasi stok di periode ini.</td></tr>'}
      </tbody>`;
  }

  // ---------------------------------------------------------------- Report
  let range = rangeFor('today');
  function rangeFor(key) {
    const now = new Date(), start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const day = 864e5;
    if (key === 'today') return [start, new Date(+start + day)];
    if (key === 'yesterday') return [new Date(+start - day), start];
    if (key === '7d') return [new Date(+start - 6 * day), new Date(+start + day)];
    if (key === 'month') return [new Date(now.getFullYear(), now.getMonth(), 1), new Date(+start + day)];
    if (key === 'year') return [new Date(now.getFullYear(), 0, 1), new Date(+start + day)];
    if (key === 'lastyear') return [new Date(now.getFullYear() - 1, 0, 1), new Date(now.getFullYear(), 0, 1)];
  }
  $('rangeSeg').addEventListener('click', e => {
    const b = e.target.closest('[data-range]'); if (!b) return;
    setSeg($('rangeSeg'), b.dataset.range); range = rangeFor(b.dataset.range); renderReport();
  });
  $('rApply').addEventListener('click', () => {
    if (!$('rFrom').value || !$('rTo').value) return toast('Pilih tanggal awal dan akhir', true);
    const from = parseYmd($('rFrom').value), to = new Date(+parseYmd($('rTo').value) + 864e5);
    if (to <= from) return toast('Tanggal akhir harus setelah tanggal awal', true);
    setSeg($('rangeSeg'), ''); range = [from, to]; renderReport();
  });

  async function renderReport() {
    const [from, to] = range;
    $('rFrom').value = ymdLocal(from); $('rTo').value = ymdLocal(new Date(+to - 864e5));
    let orders;
    try { orders = await DB.listOrders(from.toISOString(), to.toISOString()); }
    catch (e) { toast(e.message, true); return; }
    reportOrders = orders;
    const valid = orders.filter(o => o.status !== 'batal');
    const sum = (list, f) => list.reduce((s, o) => s + f(o), 0);
    const total = sum(valid, o => o.total);
    const cash = sum(valid.filter(o => o.pay_method === 'tunai'), o => o.total);
    const qris = sum(valid.filter(o => o.pay_method === 'qris'), o => o.total);
    const ongkir = sum(valid, o => o.ongkir);
    const canceled = orders.length - valid.length;

    $('metrics').innerHTML = `
      <div class="metric lead"><small>Penjualan</small><b>Rp ${rp(total)}</b><span>${valid.length} transaksi</span></div>
      <div class="metric"><small>Tunai</small><b>Rp ${rp(cash)}</b><span>${valid.filter(o => o.pay_method === 'tunai').length} transaksi</span></div>
      <div class="metric"><small>QRIS</small><b>Rp ${rp(qris)}</b><span>${valid.filter(o => o.pay_method === 'qris').length} transaksi</span></div>
      <div class="metric"><small>Ongkir tercatat</small><b>Rp ${rp(ongkir)}</b><span>Di luar penjualan</span></div>
      ${canceled ? `<div class="metric"><small>Dibatalkan</small><b>${canceled}</b><span>Tidak dihitung</span></div>` : ''}`;

    const top = new Map();
    valid.forEach(o => o.order_items.forEach(i => {
      const k = i.category + ' · ' + i.name;
      const r = top.get(k) || { qty: 0, amount: 0 };
      r.qty += i.qty; r.amount += i.subtotal; top.set(k, r);
    }));
    const topRows = [...top].sort((a, b) => b[1].qty - a[1].qty);
    $('topTable').innerHTML = `<thead><tr><th>Produk</th><th class="num">Terjual</th><th class="num">Omzet</th></tr></thead>
      <tbody>${topRows.length ? topRows.map(([k, r]) => `<tr><td>${esc(k)}</td><td class="num">${r.qty}</td><td class="num">${rp(r.amount)}</td></tr>`).join('')
        : '<tr><td class="empty" colspan="3">Belum ada penjualan di periode ini.</td></tr>'}</tbody>`;

    // Periode ≤ 1 hari: per jam; ≤ 62 hari: per hari; lebih panjang: per bulan
    const days = Math.round((to - from) / 864e5);
    const unit = days <= 1 ? 'hour' : days <= 62 ? 'day' : 'month';
    const buckets = periodBuckets(from, to, unit);
    const byKey = new Map(buckets.map(b => [b.key, b]));
    valid.forEach(o => { const b = byKey.get(bucketKey(new Date(o.created_at), unit)); if (b) { b.n++; b.amount += o.total; } });

    $('chartTitle').textContent = { hour: 'Penjualan per jam', day: 'Penjualan per hari', month: 'Penjualan per bulan' }[unit];
    $('chartSub').textContent = `${dmy(from)} – ${dmy(new Date(+to - 864e5))}`;
    lastChart = buckets; drawSalesChart();

    const listUnit = unit === 'month' ? 'month' : 'day';
    const rows = (unit === listUnit ? buckets : periodBuckets(from, to, 'day').map(b => {
      valid.forEach(o => { if (bucketKey(new Date(o.created_at), 'day') === b.key) { b.n++; b.amount += o.total; } });
      return b;
    })).filter(b => b.n).reverse();
    $('periodTitle').textContent = listUnit === 'month' ? 'Per bulan' : 'Per hari';
    $('dailyTable').innerHTML = `<thead><tr><th>${listUnit === 'month' ? 'Bulan' : 'Tanggal'}</th><th class="num">Transaksi</th><th class="num">Penjualan</th></tr></thead>
      <tbody>${rows.length ? rows.map(b => `<tr><td data-sort="${esc(b.key)}">${esc(b.long)}</td><td class="num">${b.n}</td><td class="num">${rp(b.amount)}</td></tr>`).join('')
        : '<tr><td class="empty" colspan="3">—</td></tr>'}</tbody>`;
  }

  // ---------------------------------------------------------------- Cash (kas harian)
  // Seharusnya di laci = uang awal + penjualan tunai hari ini (ongkir tidak dihitung).
  const todayRange = () => { const s = new Date(); s.setHours(0, 0, 0, 0); return [s, new Date(+s + 864e5)]; };
  async function cashToday() {
    const [from, to] = todayRange();
    const [cd, orders] = await Promise.all([DB.getCashDay(ymdLocal(from)), DB.listOrders(from.toISOString(), to.toISOString())]);
    const tunai = orders.filter(o => o.status !== 'batal' && o.pay_method === 'tunai');
    return { day: ymdLocal(from), cd, cash: tunai.reduce((s, o) => s + o.total, 0), n: tunai.length };
  }

  // Uang dihitung per pecahan (ribuan saja; koin ratusan tidak dihitung)
  const DENOMS = [100000, 50000, 20000, 10000, 5000, 2000, 1000];
  const shortDenom = d => d >= 1000 ? `${d / 1000}rb` : String(d);
  const denomTotal = detail => DENOMS.reduce((s, d) => s + d * (Number(detail?.[d]) || 0), 0);
  const denomSummary = detail => DENOMS.filter(d => Number(detail?.[d]) > 0).map(d => `${shortDenom(d)}×${detail[d]}`).join(' · ');
  function denomGrid(key, detail) {
    return `<div class="denoms" data-denoms="${key}">
      ${DENOMS.map(d => `<label class="denom">
        <span class="d-face">${rp(d)}</span>
        <span class="d-x">×</span>
        <input inputmode="numeric" data-denom="${d}" value="${Number(detail?.[d]) || ''}" placeholder="0" aria-label="Jumlah lembar ${rp(d)}">
        <span class="d-sub" data-sub="${d}">${Number(detail?.[d]) ? rp(d * detail[d]) : ''}</span>
      </label>`).join('')}
      <div class="denom-total">Total <b data-total>Rp ${rp(denomTotal(detail))}</b></div>
    </div>`;
  }
  function readDenoms(key) {
    const detail = {};
    $('cashPanel').querySelectorAll(`[data-denoms="${key}"] [data-denom]`).forEach(i => { const n = toInt(i.value); if (n) detail[i.dataset.denom] = n; });
    return { detail, total: denomTotal(detail), filled: Object.keys(detail).length > 0 };
  }

  let recount = false, editOpening = false, cashExpected = 0;
  const diffTxt = d => d === 0 ? '<span class="chip ok">Pas</span>' : d > 0 ? `<span class="chip warn">Lebih ${rp(d)}</span>` : `<span class="chip bad">Kurang ${rp(-d)}</span>`;
  async function renderCash() {
    renderCashHistory();
    let c;
    try { c = await cashToday(); } catch (e) { $('cashPanel').innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
    const { cd, cash, n } = c;
    const head = `<div class="view-head"><h2 id="cashTitle">Kas hari ini</h2><span class="muted">${esc(longDate(new Date()))}</span></div>`;
    if (!cd || editOpening) {
      $('cashPanel').innerHTML = `${head}
        <p class="muted">Hitung uang di laci saat toko buka: isi jumlah lembar/keping tiap pecahan.</p>
        ${denomGrid('open', cd?.opening_detail)}
        <div class="actions"><button class="primary" data-cash-open>Simpan uang awal</button>
        ${editOpening ? '<button class="ghost" data-cash-cancel>Batal</button>' : ''}</div>`;
      return;
    }
    const expected = cashExpected = cd.opening + cash;
    const closed = cd.closed_at && !recount;
    const figures = `<div class="metrics">
        <div class="metric"><small>Uang awal</small><b>Rp ${rp(cd.opening)}</b><span>${esc(denomSummary(cd.opening_detail) || (cd.opened_by || '').split('@')[0])}</span></div>
        <div class="metric"><small>Penjualan tunai</small><b>Rp ${rp(closed ? cd.expected - cd.opening : cash)}</b><span>${closed ? 'saat tutup' : n + ' transaksi'}</span></div>
        <div class="metric lead"><small>Seharusnya di laci</small><b>Rp ${rp(closed ? cd.expected : expected)}</b><span>Ongkir tidak dihitung</span></div>
        ${closed ? `<div class="metric"><small>Uang dihitung</small><b>Rp ${rp(cd.counted)}</b><span>${diffTxt(cd.counted - cd.expected)}</span></div>` : ''}
      </div>`;
    if (closed) {
      const t = new Date(cd.closed_at);
      $('cashPanel').innerHTML = `${head}${figures}
        ${cd.counted_detail ? `<p class="muted">Rincian hitungan: ${esc(denomSummary(cd.counted_detail))}</p>` : ''}
        <p class="muted">Kasir ditutup pukul ${pad(t.getHours())}.${pad(t.getMinutes())} oleh ${esc((cd.closed_by || '').split('@')[0])}${cd.note ? ' · ' + esc(cd.note) : ''}
        ${isOwner() ? ' · <button class="link" data-cash-recount>Hitung ulang</button>' : ''}</p>`;
      return;
    }
    $('cashPanel').innerHTML = `${head}${figures}
      <p class="muted">Tutup kasir: hitung uang di laci per pecahan. ${recount ? '' : '<button class="link" data-cash-editopen>Ubah uang awal</button>'}</p>
      ${denomGrid('count', recount ? cd.counted_detail : null)}
      <p class="cash-diff" id="cashDiff"></p>
      <div class="cash-row">
        <div class="grow"><label for="cashNote">Catatan</label><input id="cashNote" autocomplete="off" value="${recount ? esc(cd.note || '') : ''}"></div>
        <button class="primary" data-cash-close>Tutup kasir</button>
        ${recount ? '<button class="ghost" data-cash-cancel>Batal</button>' : ''}
      </div>`;
    updateDenoms('count');
  }
  // Subtotal, total, dan selisih ikut berubah saat jumlah lembar diisi
  function updateDenoms(key) {
    const box = $('cashPanel').querySelector(`[data-denoms="${key}"]`); if (!box) return;
    const { detail, total, filled } = readDenoms(key);
    DENOMS.forEach(d => { box.querySelector(`[data-sub="${d}"]`).textContent = detail[d] ? rp(d * detail[d]) : ''; });
    box.querySelector('[data-total]').textContent = `Rp ${rp(total)}`;
    if (key === 'count') $('cashDiff').innerHTML = filled ? `Seharusnya Rp ${rp(cashExpected)} · Selisih: ${diffTxt(total - cashExpected)}` : '';
  }
  $('cashPanel').addEventListener('input', e => {
    const box = e.target.closest('[data-denoms]'); if (box) updateDenoms(box.dataset.denoms);
  });
  $('cashPanel').addEventListener('keydown', e => {   // Enter pindah ke pecahan berikutnya
    if (e.key !== 'Enter' || !e.target.matches('[data-denom]')) return;
    e.preventDefault();
    const all = [...e.target.closest('[data-denoms]').querySelectorAll('[data-denom]')];
    all[all.indexOf(e.target) + 1]?.focus();
  });
  async function renderCashHistory() {
    const from = new Date(); from.setDate(from.getDate() - 13);
    let days;
    try { days = await DB.listCashDays(ymdLocal(from)); } catch { $('cashHistory').innerHTML = ''; return; }
    const who = e => esc((e || '').split('@')[0]);
    $('cashHistory').innerHTML = `
      <thead><tr><th>Tanggal</th><th class="num">Uang awal</th><th class="num">Seharusnya</th><th class="num">Dihitung</th><th>Selisih</th><th>Ditutup oleh</th><th>Catatan</th></tr></thead>
      <tbody>${days.length ? days.map(c => {
        const d = c.closed_at ? c.counted - c.expected : null;
        return `<tr>
          <td data-sort="${esc(c.day)}">${esc(parseYmd(c.day).toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'short' }))}</td>
          <td class="num">${rp(c.opening)}</td>
          <td class="num">${c.closed_at ? rp(c.expected) : '—'}</td>
          <td class="num">${c.closed_at ? rp(c.counted) : '—'}</td>
          <td data-sort="${d ?? ''}">${d == null ? '<span class="chip plain">Belum ditutup</span>' : d === 0 ? '<span class="chip ok">Pas</span>' : d > 0 ? `<span class="chip warn">Lebih ${rp(d)}</span>` : `<span class="chip bad">Kurang ${rp(-d)}</span>`}</td>
          <td class="muted">${who(c.closed_by)}</td>
          <td class="muted">${esc(c.note || '')}</td>
        </tr>`;
      }).join('') : '<tr><td class="empty" colspan="7">Belum ada catatan kas.</td></tr>'}</tbody>`;
  }

  $('cashPanel').addEventListener('click', async e => {
    const t = e.target.closest('button'); if (!t) return;
    const day = ymdLocal(todayRange()[0]);
    try {
      if ('cashOpen' in t.dataset) {
        const { detail, total } = readDenoms('open');
        await DB.openCash(day, total, detail); editOpening = false;
        toast(`Uang awal Rp ${rp(total)} disimpan`); renderCash(); refreshNotices();
      } else if ('cashClose' in t.dataset) {
        const { detail, total, filled } = readDenoms('count');
        if (!filled) return toast('Isi jumlah lembar uang yang dihitung', true);
        const c = await cashToday();   // hitung ulang supaya transaksi terakhir ikut
        await DB.closeCash(day, { expected: c.cd.opening + c.cash, counted: total, counted_detail: detail, note: $('cashNote').value.trim() });
        recount = false; toast('Kasir ditutup'); renderCash();
      } else if ('cashRecount' in t.dataset) { recount = true; renderCash(); }
      else if ('cashEditopen' in t.dataset) { editOpening = true; renderCash(); }
      else if ('cashCancel' in t.dataset) { recount = editOpening = false; renderCash(); }
    } catch (err) { toast(err.message, true); }
  });

  // Pengingat di halaman Kasir: uang awal belum diisi, pesanan hari ini & besok
  async function refreshNotices() {
    if (!role) return;
    let pending, cd = undefined;
    try { pending = await DB.listPending(); } catch { return; }
    try { cd = await DB.getCashDay(ymdLocal(new Date())); } catch {}   // undefined = tabel kas belum ada
    const today = ymdLocal(new Date()), tomorrow = ymdLocal(new Date(Date.now() + 864e5));
    const late = pending.filter(o => o.fulfill_date && o.fulfill_date < today).length;
    const nToday = pending.filter(o => o.fulfill_date === today).length;
    const nTomorrow = pending.filter(o => o.fulfill_date === tomorrow).length;
    const items = [];
    if (DB.needsUpdate) items.push(`<div class="notice bad"><b>Database belum diperbarui.</b> Aplikasi berjalan dengan cara lama: semua staf dianggap pemilik, dan kas harian, stok opname, serta ubah/hapus nota belum bisa dipakai. Jalankan file <b>supabase/002_pembaruan.sql</b> di Supabase (SQL Editor → Run), lalu muat ulang halaman ini.</div>`);
    if (cd === null) items.push(`<div class="notice warn">Uang awal hari ini belum diisi. <button class="link" data-goto="kas">Isi sekarang</button></div>`);
    if (late) items.push(`<div class="notice bad"><b>${late} pesanan terlewat</b> belum diambil/dikirim. <button class="link" data-goto="pesanan">Lihat</button></div>`);
    if (nToday || nTomorrow) items.push(`<div class="notice">${[nToday && `<b>${nToday} pesanan hari ini</b>`, nTomorrow && `<b>${nTomorrow} pesanan besok</b>`].filter(Boolean).join(' · ')} untuk diambil/dikirim. <button class="link" data-goto="pesanan">Lihat</button></div>`);
    $('kasirNotices').innerHTML = items.join('');
  }
  $('kasirNotices').addEventListener('click', e => { const b = e.target.closest('[data-goto]'); if (b) openTab(b.dataset.goto); });

  // ---------------------------------------------------------------- Export
  // CSV dengan pemisah titik koma + BOM supaya langsung rapi dibuka di Excel berbahasa Indonesia.
  // Satu baris per produk dalam nota; transaksi batal ikut dengan status "batal".
  let reportOrders = [];
  $('exportBtn').addEventListener('click', () => {
    const [from, to] = range;
    const cell = v => { const s = String(v ?? ''); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const head = ['Nota', 'Tanggal', 'Waktu', 'Status', 'Pembeli', 'WA', 'Jenis', 'Bayar', 'Kategori', 'Produk',
      'Pcs', 'Harga', 'Subtotal', 'Total nota', 'Ongkir', 'Catatan', 'Kasir'];
    const rows = [...reportOrders].reverse().flatMap(o => {
      const d = new Date(o.created_at);
      return o.order_items.map(i => [notaNo(o), ymdLocal(d), `${pad(d.getHours())}:${pad(d.getMinutes())}`, o.status,
        o.customer_name, o.customer_wa, FUL_LABEL[o.fulfillment], o.pay_method === 'qris' ? 'QRIS' : 'Tunai',
        i.category, i.name, i.qty, i.price, i.subtotal, o.total, o.ongkir, o.note || '', o.cashier || '']);
    });
    if (!rows.length) return toast('Tidak ada transaksi di periode ini', true);
    const csv = '﻿' + [head, ...rows].map(r => r.map(cell).join(';')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `laporan-lunpia-${ymdLocal(from)}_${ymdLocal(new Date(+to - 864e5))}.csv`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  // ---------------------------------------------------------------- Chart
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  function bucketKey(d, unit) {
    if (unit === 'hour') return String(d.getHours());
    if (unit === 'day') return ymdLocal(d);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  }
  function periodBuckets(from, to, unit) {
    const out = [];
    if (unit === 'hour') {
      for (let h = 0; h < 24; h++) out.push({ key: String(h), tick: pad(h), long: `Pukul ${pad(h)}.00–${pad(h)}.59`, n: 0, amount: 0 });
      return out;
    }
    const d = unit === 'day' ? new Date(from) : new Date(from.getFullYear(), from.getMonth(), 1);
    while (d < to) {
      out.push(unit === 'day'
        ? { key: ymdLocal(d), tick: String(d.getDate()), long: d.toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }), n: 0, amount: 0 }
        : { key: bucketKey(d, 'month'), tick: MONTHS[d.getMonth()], long: `${MONTHS[d.getMonth()]} ${d.getFullYear()}`, n: 0, amount: 0 });
      unit === 'day' ? d.setDate(d.getDate() + 1) : d.setMonth(d.getMonth() + 1);
    }
    return out;
  }
  const shortRp = v => v >= 1e6 ? `${(v / 1e6).toLocaleString('id-ID', { maximumFractionDigits: 1 })} jt`
    : v >= 1e3 ? `${(v / 1e3).toLocaleString('id-ID', { maximumFractionDigits: 0 })} rb` : String(v);
  function niceMax(v) {
    if (v <= 0) return 100000;
    const p = 10 ** Math.floor(Math.log10(v));
    return [1, 2, 2.5, 5, 10].map(m => m * p).find(m => m >= v);
  }

  let lastChart = [];
  function drawSalesChart() {
    const el = $('salesChart'), buckets = lastChart;
    const W = el.clientWidth, H = el.clientHeight;
    if (!W) return;
    const m = { l: 52, r: 4, t: 22, b: 24 };
    const pw = W - m.l - m.r, ph = H - m.t - m.b;
    const top = niceMax(Math.max(...buckets.map(b => b.amount)));
    const y = v => m.t + ph - (v / top) * ph;
    const band = pw / buckets.length;
    const bw = Math.max(2, Math.min(24, band - 2));
    const every = Math.ceil(34 / band);
    const peak = buckets.reduce((a, b) => (b.amount > a.amount ? b : a), buckets[0]);

    const ticks = [0, .25, .5, .75, 1].map(f => f * top);
    const bars = buckets.map((b, i) => {
      const cx = m.l + band * (i + .5), x = cx - bw / 2, yt = y(b.amount), h = m.t + ph - yt;
      const r = Math.min(4, h, bw / 2);
      const bar = h > 0 ? `<path class="bar" data-i="${i}" d="M${x},${m.t + ph}V${yt + r}a${r},${r} 0 0 1 ${r},${-r}H${x + bw - r}a${r},${r} 0 0 1 ${r},${r}V${m.t + ph}Z"/>` : '';
      return `<rect class="hit" data-i="${i}" x="${m.l + band * i}" y="${m.t}" width="${band}" height="${ph}"/>${bar}`;
    }).join('');
    const xLabels = buckets.map((b, i) => (i % every ? '' :
      `<text class="axis" x="${m.l + band * (i + .5)}" y="${H - 6}" text-anchor="middle">${esc(b.tick)}</text>`)).join('');
    const peakX = m.l + band * (buckets.indexOf(peak) + .5);
    const peakLabel = peak.amount ? `<text class="axis" x="${Math.min(Math.max(peakX, m.l + 24), W - 24)}" y="${y(peak.amount) - 6}" text-anchor="middle" font-weight="700">${shortRp(peak.amount)}</text>` : '';

    el.innerHTML = `<svg role="img" aria-label="${esc($('chartTitle').textContent)}">
      ${ticks.map(t => `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/>
        <text class="axis" x="${m.l - 8}" y="${y(t) + 4}" text-anchor="end">${t ? shortRp(t) : '0'}</text>`).join('')}
      ${bars}${xLabels}${peakLabel}
    </svg>${buckets.some(b => b.amount) ? '' : '<div class="empty-chart">Belum ada penjualan di periode ini.</div>'}
    <div class="chart-tip" hidden></div>`;

    const svg = el.querySelector('svg'), tip = el.querySelector('.chart-tip');
    const show = i => {
      const b = buckets[i];
      el.querySelectorAll('.bar.on').forEach(n => n.classList.remove('on'));
      el.querySelector(`.bar[data-i="${i}"]`)?.classList.add('on');
      tip.innerHTML = `<span>${esc(b.long)}</span><b>Rp ${rp(b.amount)}</b><span>${b.n} transaksi</span>`;
      tip.style.left = Math.min(Math.max(m.l + band * (i + .5), 70), W - 70) + 'px';
      tip.style.top = Math.min(y(b.amount), m.t + ph - 4) + 'px';
      tip.hidden = false;
    };
    svg.addEventListener('pointerover', e => { const i = e.target.dataset?.i; if (i != null) show(Number(i)); });
    svg.addEventListener('pointerleave', () => { tip.hidden = true; el.querySelectorAll('.bar.on').forEach(n => n.classList.remove('on')); });
  }
  let resizeRaf;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => { if (currentTab === 'laporan' && lastChart.length) drawSalesChart(); });
  });

  boot();
})();
