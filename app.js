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
      const on = !!st && st.col === i;   // harus boolean: toggle(…, undefined) membalik kelas
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

  ['recentTable', 'contactTable', 'stockTable', 'topTable', 'dailyTable', 'hourTable', 'cashHistory', 'prodOutTable', 'prodBuyTable', 'prodLeftTable', 'prodTable', 'logTable'].forEach(makeSortable);

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
      perms = role ? await DB.myPerms(role) : {};
      opts = role ? await DB.myOptions().catch(() => opts) : opts;
      applyPerms();
      $('whoEmail').textContent = `${session.user?.email || ''}${role ? ' · ' + (role === 'pemilik' ? 'Pemilik' : 'Kasir') : ''}`;
      if (!role) {
        $('catalog').innerHTML = `<div class="empty-state">Akun <b>${esc(session.user?.email)}</b> belum terdaftar sebagai staf. Minta pemilik toko menambahkan email ini di tabel <b>staff</b> di Supabase.</div>`;
        return;
      }
      await loadProducts();
      refreshPendingCount();
      startSync();
    } catch (e) { toast(e.message, true); }
  }
  let role = null, perms = {}, opts = { cash_out_max: 0, cancel_reason_required: false };
  const isOwner = () => role === 'pemilik';
  // Wewenang per staf (diatur pemilik di Pengaturan → Staf). Elemen dengan kelas need-<wewenang>
  // disembunyikan kalau akun tidak punya wewenang itu; database juga menolaknya.
  const can = k => isOwner() || !!perms[k];
  function applyPerms() {
    Object.keys(DB.permDefaults).forEach(k => document.body.classList.toggle('can-' + k, can(k)));
    document.body.classList.toggle('can-stok_ubah', can('stok_masuk') || can('stok_kurang'));
    document.body.classList.toggle('can-kas_ubah_hapus', can('kas_ubah') || can('kas_hapus'));
    if (!can('pesanan')) $('pendingCount').hidden = true;
    // Tab yang sedang terbuka tidak boleh lagi → kembali ke Kasir
    const tab = document.querySelector(`.tab[data-tab="${currentTab}"]`);
    if (tab && getComputedStyle(tab).display === 'none') openTab('kasir');
  }

  $('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    $('loginError').textContent = ''; $('loginBtn').disabled = true;
    try { await DB.signIn($('loginEmail').value.trim(), $('loginPassword').value); }
    catch (err) { $('loginError').textContent = err.message; }
    finally { $('loginBtn').disabled = false; }
  });
  $('logoutBtn').addEventListener('click', async () => {
    stopSync?.(); stopSync = null;
    await DB.signOut(); appShown = false; role = null; perms = {}; document.body.classList.remove('is-owner');
    document.body.className = document.body.className.replace(/\bcan-\S+/g, '').trim();
    resetCart(); showLogin();
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
    if (name === 'kontak') renderContacts();
    if (name === 'pengaturan') renderSettings();
    if (name === 'stok') loadProducts();
    if (name === 'kas') renderCash();
    if (name === 'laporan') renderReport();
    if (name === 'pembelian') renderProduction();
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

  // Stok di dua tempat (013): stock = total, stock_home = di rumah, toko = sisanya. Penjualan dari toko.
  const homeOf = p => p.stock_home || 0, tokoOf = p => p.stock - homeOf(p);
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
      $('cartItems').innerHTML = `<div class="cart-empty">Ketuk produk untuk menambahkan ke pesanan.</div>`;
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

  // Pukul: titik dua selalu tampil sebagai pola jj:mm (1 → "1_:__", 10 → "10:__", 1030 → "10:30").
  // Ketik 4 angka: 2 pertama jam, 2 berikutnya menit; angka ke-5 memulai lagi dari jam.
  // Batas: jam 00–24 (24 hanya 24:00), menit 00–59. Angka jam pertama 3–9 jadi 03–09,
  // angka menit pertama 6–9 jadi 06–09. Nilai disimpan sebagai "HH:MM".
  const timeDigits = () => $('fTime').value.replace(/\D/g, '').slice(0, 4);
  const showTime = d => {
    const inp = $('fTime');
    inp.value = d ? `${d.slice(0, 2).padEnd(2, '_')}:${d.slice(2).padEnd(2, '_')}` : '';
    const pos = d.length <= 2 ? d.length : d.length + 1;   // kursor di angka berikutnya
    if (document.activeElement === inp) inp.setSelectionRange(pos, pos);
  };
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
    const inp = $('fTime');
    e.preventDefault();   // semua perubahan diatur di sini supaya pola jj:mm tetap utuh
    const all = inp.value && inp.selectionStart === 0 && inp.selectionEnd === inp.value.length;
    let d = all ? '' : timeDigits();
    if (e.inputType.startsWith('delete')) return showTime(all ? '' : d.slice(0, -1));
    if (!e.inputType.startsWith('insert')) return;
    for (const ch of (e.data || '').replace(/\D/g, '')) d = addTimeDigit(d, ch);
    showTime(d);
  });
  $('fTime').addEventListener('input', () => showTime(timeDigits()));   // cadangan (mis. isi otomatis browser)
  $('fTime').addEventListener('focus', () => setTimeout(() => showTime(timeDigits()), 0));   // kursor ke posisi berikutnya

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
    ['custName', 'custWa', 'custAddress', 'orderNote', 'fDate', 'fTime', 'ongkir', 'paid'].forEach(id => ($(id).value = ''));
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
    $('custAddress').value = o.address || '';
    setPay(o.pay_method); $('paid').value = o.pay_method === 'tunai' ? rp(o.paid) : '';
    $('cartTitle').textContent = `Ubah nota ${notaNo(o)}`;
    $('editBanner').innerHTML = `Stok dan total dihitung ulang saat disimpan. Harga produk yang sudah ada di nota tetap memakai harga lama.
      <button class="link" id="cancelEditBtn">Batal ubah</button>
      <div class="seq-edit"><label for="editSeq">No. nota (${o.year})</label>
        <input id="editSeq" inputmode="numeric" value="${String(o.seq).padStart(5, '0')}" autocomplete="off">
        <span class="muted" id="seqGaps"></span></div>`;
    $('editBanner').hidden = false;
    // Nomor yang terloncat (belum terpakai) di tahun nota ini, untuk diisi
    DB.notaSeqs(o.year).then(seqs => {
      const used = new Set(seqs), max = Math.max(0, ...seqs), gaps = [];
      for (let n = 1; n < max && gaps.length < 12; n++) if (!used.has(n)) gaps.push(n);
      if (editing?.order.id === o.id) $('seqGaps').textContent = gaps.length
        ? `Nomor terloncat: ${gaps.map(n => String(n).padStart(5, '0')).join(', ')}${gaps.length === 12 ? ', …' : ''}` : 'Tidak ada nomor terloncat.';
    }).catch(() => {});
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
      if (!timeValid()) return err('Pukul belum lengkap atau tidak valid. Ketik 4 angka, mis. 1030 untuk 10:30.');
    }
    if (pay === 'tunai' && toInt($('paid').value) < total) return err('Uang diterima kurang dari total.');
    const seq = editing ? toInt($('editSeq').value) : null;
    if (editing && !seq) return err('Isi nomor nota.');

    const payload = {
      items: [...cart].map(([product_id, qty]) => ({ product_id, qty })),
      customer_name: $('custName').value.trim(),
      customer_wa: $('custWa').value.trim(),
      fulfillment: ful,
      fulfill_date: ful === 'langsung' ? '' : $('fDate').value,
      fulfill_time: ful === 'langsung' ? '' : timeValue(),
      ongkir: ful === 'kirim' ? toInt($('ongkir').value) : 0,
      address: ful === 'kirim' ? $('custAddress').value.trim() : '',
      pay_method: pay,
      paid: pay === 'tunai' ? toInt($('paid').value) : total,
      note: $('orderNote').value.trim(),
      ...(editing ? { seq } : {}),
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
      ...(o.fulfillment === 'kirim' ? [['ONGKIR', rp(o.ongkir)], ...(o.address ? [['ALAMAT', esc(o.address)]] : [])] : []),
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

  // Link WhatsApp ke chat pembeli dengan teks sudah terketik. Dipakai sebagai link biasa (<a href>),
  // bukan window.open, supaya tidak pernah diblokir browser (juga saat dipasang di layar utama).
  // Laptop: WhatsApp Web di tab baru; HP: aplikasi WhatsApp.
  const waGreeting = name => `Hai Kak${name ? ' ' + name : ''}.`;
  const waUrl = (phone, text) => {
    const num = waNumber(phone), t = encodeURIComponent(text);
    return isMobile ? `https://wa.me/${num}?text=${t}` : `https://web.whatsapp.com/send?${num ? 'phone=' + num + '&' : ''}text=${t}`;
  };
  const waTextLink = (phone, text, cls, label) =>
    `<a class="${cls}" href="${esc(waUrl(phone, text))}" target="_blank" rel="noopener">${label}</a>`;
  // Pengingat pesanan ambil/kirim ke pembeli
  function reminderText(o) {
    const today = ymdLocal(new Date()), tomorrow = ymdLocal(new Date(Date.now() + 864e5));
    const when = !o.fulfill_date ? '' : o.fulfill_date === today ? ' hari ini' : o.fulfill_date === tomorrow ? ' besok'
      : ' ' + parseYmd(o.fulfill_date).toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long' });
    return `Hai Kak${o.customer_name ? ' ' + o.customer_name.trim() : ''}, pesanan ${STORE.name} Kakak siap ${o.fulfillment === 'kirim' ? 'dikirim' : 'diambil'}${when}${o.fulfill_time ? ' pukul ' + o.fulfill_time.slice(0, 5) : ''}. Terima kasih.`;
  }
  const waLink = (phone, name, cls, label) =>
    `<a class="${cls}" href="${esc(waUrl(phone, waGreeting((name || '').trim())))}" target="_blank" rel="noopener">${label}</a>`;

  let receiptOrder = null;
  $('waBtn').addEventListener('click', () => {
    if (isMobile) return;
    $('waHint').textContent = 'Chat WhatsApp pembeli dibuka di tab baru dengan isi nota. Tekan Enter untuk mengirim.';
    $('waHint').hidden = false;
  });

  function showReceipt(order, autoPrint = false) {
    receiptOrder = order;
    $('waHint').hidden = true;
    $('waBtn').href = waUrl(order.customer_wa, waText(order));
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
              <div class="order-who">${esc(o.customer_name || '-')} ${o.customer_wa ? `· ${waLink(o.customer_wa, o.customer_name, 'wa-link', esc(o.customer_wa))}` : ''}</div>
              <div class="order-items">${esc(itemsSummary(o))}</div>
              ${o.fulfillment === 'kirim' && o.address ? `<div class="order-items">Alamat: ${esc(o.address)}</div>` : ''}
              ${o.note ? `<div class="order-note">Catatan: ${esc(o.note)}</div>` : ''}
              <div class="order-total"><span>${o.pay_method === 'qris' ? 'QRIS' : 'Tunai'} · Nota ${notaNo(o)}</span><span>${rp(o.total)}</span></div>
              ${o.fulfillment === 'kirim' ? `<div class="muted">Ongkir ${rp(o.ongkir)}</div>` : ''}
              <div class="actions" data-actions>
                <button class="primary small" data-done="${o.id}">Tandai selesai</button>
                ${o.customer_wa ? waTextLink(o.customer_wa, reminderText(o), 'ghost small btn-link', 'Ingatkan via WA') : ''}
                <button class="ghost small" data-reprint="${o.id}">Cetak ulang</button>
                <button class="ghost small danger need-batal" data-cancel="${o.id}">Batalkan</button>
                <button class="ghost small need-ubah_nota" data-editorder="${o.id}">Ubah</button>
                <button class="ghost small danger need-hapus_nota" data-del="${o.id}">Hapus</button>
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
          <td>${statusChip(o.status)}${o.cancel_reason ? `<div class="muted cancel-reason">${esc(o.cancel_reason)}</div>` : ''}</td>
          <td><div class="add-stock" data-actions>
            <button class="ghost small" data-reprint="${o.id}">Cetak ulang</button>
            ${o.status === 'batal' ? '' : `<button class="ghost small need-ubah_nota" data-editorder="${o.id}">Ubah</button>`}
            <button class="ghost small danger need-hapus_nota" data-del="${o.id}">Hapus</button>
          </div></td>
        </tr>`;
      }).join('') : '<tr><td class="empty" colspan="9">Belum ada transaksi.</td></tr>'}</tbody>`;
  }

  $('view-pesanan').addEventListener('click', async e => {
    const t = e.target.closest('button'); if (!t) return;
    const d = t.dataset;
    try {
      if (d.reprint) showReceipt(orderCache.get(Number(d.reprint)));
      else if (d.done) { await DB.markDone(Number(d.done)); toast('Pesanan ditandai selesai'); renderOrders(); }
      else if (d.editorder) startEdit(orderCache.get(Number(d.editorder)));
      else if (d.cancel) {
        const box = t.closest('[data-actions]');
        box.innerHTML = `<div class="confirm">Batalkan pesanan ini? Stok akan dikembalikan.
          <input data-reason placeholder="Alasan pembatalan${opts.cancel_reason_required ? ' (wajib)' : ''}" aria-label="Alasan pembatalan" autocomplete="off">
          <div class="actions"><button class="primary small" data-cancelyes="${d.cancel}">Ya, batalkan</button>
          <button class="ghost small" data-refresh-orders>Tidak</button></div></div>`;
      }
      else if (d.cancelyes) {
        const reason = t.closest('.confirm').querySelector('[data-reason]').value.trim();
        if (!reason && opts.cancel_reason_required) return toast('Isi alasan pembatalan', true);
        await DB.cancelOrder(Number(d.cancelyes), reason); toast('Pesanan dibatalkan, stok dikembalikan'); renderOrders(); loadProducts();
      }
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

  // ---------------------------------------------------------------- Contacts
  // Daftar kontak disusun dari nama & WA yang tercatat di transaksi (tanpa tabel baru).
  // Satu kontak per nomor WA (atau per nama kalau tanpa nomor); nama yang dipakai = nama terakhir.
  let contacts = [];
  async function renderContacts() {
    let rows, hidden;
    try { [rows, hidden] = await Promise.all([DB.listCustomers(), DB.listHiddenContacts()]); } catch (e) { toast(e.message, true); return; }
    const hiddenAt = new Map(hidden.map(h => [h.key, new Date(h.hidden_at)]));
    const map = new Map();
    rows.filter(o => (o.customer_name || '').trim() || (o.customer_wa || '').trim()).forEach(o => {
      const num = waNumber(o.customer_wa), key = num || 'n:' + o.customer_name.trim().toLowerCase();
      const c = map.get(key) || { key, name: '', wa: '', n: 0, spent: 0, last: '' };
      if (o.created_at >= c.last) { c.last = o.created_at; if (o.customer_name.trim()) c.name = o.customer_name.trim(); if (o.customer_wa) c.wa = o.customer_wa.trim(); }
      if ((o.address || '').trim() && o.created_at >= (c.addrAt || '')) { c.address = o.address.trim(); c.addrAt = o.created_at; }
      if (!c.name && o.customer_name.trim()) c.name = o.customer_name.trim();
      if (o.status !== 'batal') { c.n++; c.spent += o.total; }
      map.set(key, c);
    });
    // Kontak yang dihapus disembunyikan, kecuali ada transaksi baru setelah dihapus
    contacts = [...map.values()].filter(c => !(hiddenAt.get(c.key) >= new Date(c.last)))
      .sort((a, b) => b.last.localeCompare(a.last));
    $('contactCount').textContent = `${contacts.length} kontak`;
    $('contactTable').innerHTML = `
      <thead><tr><th>Nama</th><th>WA</th><th class="num">Transaksi</th><th class="num">Total belanja</th><th>Terakhir beli</th><th></th></tr></thead>
      <tbody>${contacts.length ? contacts.map((c, i) => {
        const d = new Date(c.last);
        return `<tr data-search="${esc((c.name + ' ' + c.wa + ' ' + waNumber(c.wa)).toLowerCase())}">
          <td><b>${esc(c.name || '-')}</b></td>
          <td>${esc(c.wa || '-')}</td>
          <td class="num">${c.n}</td>
          <td class="num">${rp(c.spent)}</td>
          <td data-sort="${esc(c.last)}">${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}</td>
          <td><div class="add-stock">
            <button class="primary small" data-neworder="${i}">Pesan baru</button>
            ${c.wa ? waLink(c.wa, c.name, 'ghost small btn-link', 'WhatsApp') : ''}
            <button class="ghost small need-kontak_ubah" data-contactedit="${i}">Ubah</button>
            <button class="ghost small danger need-kontak_hapus" data-contactdel="${i}">Hapus</button>
          </div></td>
        </tr>`;
      }).join('') : '<tr><td class="empty" colspan="6">Belum ada kontak. Nama dan nomor WA pembeli dari transaksi akan muncul di sini.</td></tr>'}</tbody>`;
    filterContacts();
  }
  function filterContacts() {
    const q = $('contactSearch').value.trim().toLowerCase(), qn = q.replace(/\D/g, '').replace(/^0/, '62');
    $('contactTable').querySelectorAll('tbody tr[data-search]').forEach(r => {
      r.hidden = !!q && !r.dataset.search.includes(q) && !(qn && r.dataset.search.includes(qn));
    });
  }
  $('contactSearch').addEventListener('input', filterContacts);
  $('contactTable').addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    const d = b.dataset;
    try {
      if (d.contactedit) {   // Ubah (pemilik): nama & WA diganti di semua transaksi kontak ini
        const c = contacts[Number(d.contactedit)], row = b.closest('tr');
        row.innerHTML = `<td colspan="6"><div class="cash-edit">
          <label>Nama<input data-f="name" value="${esc(c.name)}" autocomplete="off"></label>
          <label>WA<input data-f="wa" value="${esc(c.wa)}" inputmode="tel" autocomplete="off"></label>
          <span class="muted grow">Nama & nomor diganti di ${c.n} transaksi kontak ini.</span>
          <div class="actions"><button class="primary small" data-contactsave="${d.contactedit}">Simpan</button>
          <button class="ghost small" data-contactcancel>Batal</button></div>
        </div></td>`;
        row.querySelector('input').focus();
        return;
      }
      if (d.contactsave) {
        const c = contacts[Number(d.contactsave)], box = b.closest('.cash-edit');
        const name = box.querySelector('[data-f="name"]').value.trim(), wa = box.querySelector('[data-f="wa"]').value.trim();
        if (!name && !wa) return toast('Isi nama atau nomor WA', true);
        const n = await DB.updateContact(c.key, name, wa);
        toast(`Kontak diperbarui (${n} transaksi)`); return renderContacts();
      }
      if ('contactcancel' in d) return renderContacts();
      if (d.contactdel) {    // Hapus (pemilik): hanya dari daftar; transaksi tetap
        const c = contacts[Number(d.contactdel)];
        if (!confirm(`Hapus ${c.name || c.wa} dari daftar kontak? Transaksinya tidak dihapus. Kontak muncul lagi kalau ia belanja lagi.`)) return;
        await DB.hideContact(c.key); toast('Kontak dihapus dari daftar'); return renderContacts();
      }
    } catch (err) { return toast(err.message, true); }
    if (d.neworder) {
      const c = contacts[Number(d.neworder)];
      resetCart();
      $('custName').value = c.name; $('custWa').value = c.wa; $('custAddress').value = c.address || '';
      openTab('kasir');
      toast(`Pesanan baru untuk ${c.name || c.wa}`);
    }
  });

  // ---------------------------------------------------------------- Stock
  let editingId = null;
  function renderStock() {
    const low = products.filter(p => p.active && p.stock <= p.min_stock);
    const tokoEmpty = products.filter(p => p.active && tokoOf(p) <= 0 && homeOf(p) > 0);
    $('stockSummary').innerHTML = (low.length
      ? `<b>${low.length} produk stok menipis:</b> ${low.map(p => esc(p.category + ' ' + p.name)).join(', ')}.`
      : 'Semua stok aman.') + (tokoEmpty.length
      ? `<br><b class="warn-text">Toko kosong, ada di rumah:</b> ${tokoEmpty.map(p => esc(`${p.category} ${p.name} (${homeOf(p)})`)).join(', ')}.` : '');
    $('categoryList').innerHTML = [...new Set(products.map(p => p.category))].map(c => `<option value="${esc(c)}">`).join('');
    $('stockTable').innerHTML = `
      <thead><tr><th>Jenis</th><th>Produk</th><th class="num">Harga</th><th class="num">Toko</th><th class="num">Rumah</th><th class="num">Total</th><th>Status</th><th data-nosort>Tambah stok</th><th></th></tr></thead>
      <tbody>${products.length ? products.map(p => `
        <tr class="${p.active ? '' : 'dim'}">
          <td>${esc(p.category)}</td>
          <td><b>${esc(p.name)}</b>${p.active ? '' : ' <span class="chip plain">Disembunyikan</span>'}</td>
          <td class="num">${rp(p.price)}</td>
          <td class="num stock-num${tokoOf(p) <= 0 ? ' out' : ''}">${tokoOf(p)}</td>
          <td class="num stock-num">${homeOf(p)}</td>
          <td class="num stock-num total">${p.stock}</td>
          <td data-sort="${p.stock - p.min_stock}">${p.stock <= 0 ? stockChip(p) : p.stock <= p.min_stock ? '<span class="chip warn">Menipis</span>' : '<span class="chip ok">Aman</span>'} <span class="muted">min ${p.min_stock}</span></td>
          <td><div class="add-stock need-stok_ubah">
            <input inputmode="numeric" placeholder="0" id="add-${p.id}" aria-label="Tambah stok ${esc(p.name)}">
            <select id="loc-${p.id}" aria-label="Lokasi"><option value="toko">di Toko</option><option value="rumah">di Rumah</option></select>
            <button class="ghost small" data-addstock="${p.id}">Tambah</button>
          </div></td>
          <td><div class="add-stock">
            <button class="ghost small need-stok_pindah" data-move="${p.id}">Pindah</button>
            <button class="ghost small" data-card="${p.id}">Kartu stok</button>
            <button class="ghost small need-produk_ubah" data-edit="${p.id}">Ubah</button>
          </div></td>
        </tr>`).join('') : '<tr><td class="empty" colspan="9">Belum ada produk.</td></tr>'}</tbody>`;
  }

  $('stockTable').addEventListener('click', async e => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.dataset.addstock) {
      const id = Number(t.dataset.addstock);
      const raw = $('add-' + id).value.trim();
      const n = (raw.startsWith('-') ? -1 : 1) * toInt(raw);
      if (!n) return toast('Isi jumlah stok yang mau ditambahkan', true);
      if (n < 0 && !can('stok_kurang')) return toast('Akun ini tidak punya wewenang mengurangi stok', true);
      if (n > 0 && !can('stok_masuk')) return toast('Akun ini tidak punya wewenang menambah stok', true);
      const loc = $('loc-' + id).value;
      try { await DB.addStock(id, n, n > 0 ? 'Tambah stok' : 'Koreksi stok', loc); toast(`Stok ${byId(id).name} di ${loc} ${n > 0 ? '+' : ''}${n}`); loadProducts(); }
      catch (err) { toast(err.message, true); }
    }
    // Pindah stok rumah ↔ toko
    if (t.dataset.move) {
      $('stockTable').querySelector('.move-row')?.remove();
      const p = byId(Number(t.dataset.move));
      t.closest('tr').insertAdjacentHTML('afterend', `<tr class="move-row" data-id="${p.id}"><td colspan="9"><div class="move-stock">
        <b>Pindah ${esc(p.category)} ${esc(p.name)}</b>
        <span class="muted">Toko ${tokoOf(p)} · Rumah ${homeOf(p)}</span>
        <input inputmode="numeric" data-mv="qty" placeholder="Jumlah" aria-label="Jumlah dipindah">
        <select data-mv="to" aria-label="Arah"><option value="toko"${homeOf(p) ? ' selected' : ''}>Rumah → Toko</option><option value="rumah"${homeOf(p) ? '' : ' selected'}>Toko → Rumah</option></select>
        <button class="primary small" data-movesave>Pindahkan</button><button class="ghost small" data-movecancel>Batal</button>
      </div></td></tr>`);
      t.closest('tr').nextElementSibling.querySelector('input').focus();
    }
    if ('movecancel' in t.dataset) t.closest('tr').remove();
    if ('movesave' in t.dataset) {
      const row = t.closest('tr'), id = Number(row.dataset.id), qty = toInt(row.querySelector('[data-mv="qty"]').value), to = row.querySelector('[data-mv="to"]').value;
      if (!qty) return toast('Isi jumlah yang dipindah', true);
      try { await DB.moveStock(id, qty, to); toast(`${qty} ${byId(id).name} dipindah ke ${to}`); loadProducts(); }
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
      <thead><tr><th>Jenis</th><th>Produk</th><th class="num">Sistem toko</th><th>Fisik toko</th><th class="num">Sistem rumah</th><th>Fisik rumah</th><th class="num">Selisih</th></tr></thead>
      <tbody>${list.map(p => `<tr>
        <td>${esc(p.category)}</td><td><b>${esc(p.name)}</b></td>
        <td class="num stock-num">${tokoOf(p)}</td>
        <td><input class="count-in" inputmode="numeric" data-count="${p.id}" data-loc="toko" aria-label="Hitungan fisik toko ${esc(p.category + ' ' + p.name)}"></td>
        <td class="num stock-num">${homeOf(p)}</td>
        <td><input class="count-in" inputmode="numeric" data-count="${p.id}" data-loc="rumah" aria-label="Hitungan fisik rumah ${esc(p.category + ' ' + p.name)}"></td>
        <td class="num" data-diff="${p.id}"></td>
      </tr>`).join('')}</tbody>`;
    $('opnameSum').textContent = '';
    $('opnameForm').hidden = false;
    $('opnameTable').querySelector('input')?.focus();
  }
  // Per produk: { product_id, toko?, rumah? } — kolom yang dikosongkan tidak diubah
  function opnameEntries() {
    const m = new Map();
    $('opnameTable').querySelectorAll('[data-count]').forEach(i => {
      if (i.value.trim() === '') return;
      const id = Number(i.dataset.count), e = m.get(id) || m.set(id, { product_id: id }).get(id);
      e[i.dataset.loc] = toInt(i.value);
    });
    return [...m.values()];
  }
  const opnameTotal = e => { const p = byId(e.product_id); return (e.toko ?? tokoOf(p)) + (e.rumah ?? homeOf(p)); };
  const opnameDiffers = e => { const p = byId(e.product_id); return opnameTotal(e) !== p.stock || (e.rumah ?? homeOf(p)) !== homeOf(p); };
  $('opnameTable').addEventListener('input', e => {
    const inp = e.target.closest('[data-count]'); if (!inp) return;
    const id = Number(inp.dataset.count), cell = $('opnameTable').querySelector(`[data-diff="${id}"]`);
    const en = opnameEntries().find(x => x.product_id === id);
    const d = en ? opnameTotal(en) - byId(id).stock : null;
    cell.innerHTML = d == null ? '' : d === 0 ? `<span class="chip ok">${opnameDiffers(en) ? 'Total cocok' : 'Cocok'}</span>` : `<span class="${d > 0 ? 'in' : 'out'}">${d > 0 ? '+' : '−'}${Math.abs(d)}</span>`;
    const entries = opnameEntries(), diff = entries.filter(opnameDiffers).length;
    $('opnameSum').textContent = entries.length ? `${entries.length} produk dihitung · ${diff} berbeda dari sistem` : '';
  });
  $('opnameTable').addEventListener('keydown', e => {   // Enter pindah ke produk berikutnya
    if (e.key !== 'Enter' || !e.target.matches('[data-count]')) return;
    e.preventDefault();
    const all = [...$('opnameTable').querySelectorAll('[data-count]')];   // toko, rumah, produk berikutnya
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
    const cur = byId(p.id) || p, current = cur.stock;
    const opening = current - moves.reduce((s, m) => s + m.delta, 0);
    const openHome = homeOf(cur) - moves.reduce((s, m) => s + (m.home || 0), 0);
    const rows = moves.filter(m => new Date(m.at) < to);
    let bal = opening, balHome = openHome;
    rows.forEach(m => { m.balance = bal += m.delta; m.home_bal = balHome += (m.home || 0); });
    const inQty = rows.reduce((s, m) => s + Math.max(m.delta, 0), 0);
    const outQty = rows.reduce((s, m) => s - Math.min(m.delta, 0), 0);

    $('cardMetrics').innerHTML = `
      <div class="metric"><small>Stok awal</small><b>${opening}</b><span>${esc(dmy(from))}</span></div>
      <div class="metric"><small>Masuk</small><b class="in">+${inQty}</b></div>
      <div class="metric"><small>Keluar</small><b class="out">−${outQty}</b></div>
      <div class="metric lead"><small>Stok akhir</small><b>${bal}</b><span>${esc(dmy(new Date(+to - 864e5)))} · toko ${bal - balHome} · rumah ${balHome}</span></div>`;

    const desc = m => m.order
      ? `${m.cancel ? 'Batal, stok kembali' : 'Terjual'} · Nota ${notaNo(m.order)}${m.order.customer_name ? ' · ' + esc(m.order.customer_name) : ''}`
      : esc(m.note || (m.delta > 0 ? 'Tambah stok' : 'Koreksi stok'));
    $('cardTable').innerHTML = `
      <thead><tr><th>Tanggal</th><th>Keterangan</th><th class="num">Masuk</th><th class="num">Keluar</th><th class="num">Toko</th><th class="num">Rumah</th><th class="num">Total</th><th>Oleh</th></tr></thead>
      <tbody>
        <tr class="dim"><td>${esc(dmy(from))}</td><td>Stok awal</td><td></td><td></td><td class="num">${opening - openHome}</td><td class="num">${openHome}</td><td class="num">${opening}</td><td></td></tr>
        ${rows.map(m => {
          const d = new Date(m.at);
          return `<tr>
            <td>${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}.${pad(d.getMinutes())}</td>
            <td>${desc(m)}</td>
            <td class="num in">${m.delta > 0 ? m.delta : ''}</td>
            <td class="num out">${m.delta < 0 ? -m.delta : ''}</td>
            <td class="num">${m.balance - m.home_bal}</td>
            <td class="num">${m.home_bal}</td>
            <td class="num"><b>${m.balance}</b></td>
            <td class="muted">${esc((m.by || '').split('@')[0])}</td>
          </tr>`;
        }).join('') || '<tr><td class="empty" colspan="8">Tidak ada mutasi stok di periode ini.</td></tr>'}
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
      ${canceled ? `<div class="metric"><small>Dibatalkan</small><b>${canceled}</b><span>Tidak dihitung</span></div>` : ''}
      <div class="metric need-laba" id="usedMetric"></div><div class="metric lead need-laba" id="profitMetric"></div>`;
    // Laba = penjualan − bahan terpakai (dari tab Produksi) di periode yang sama
    if (can('laba')) {
      const f = ymdLocal(from), t = ymdLocal(new Date(+to - 864e5));
      DB.materialUsed(f, t).then(used => {
        if (range[0] !== from) return;   // periode sudah diganti
        const profit = total - used;
        $('usedMetric').innerHTML = `<small>Bahan terpakai</small><b>Rp ${rp(used)}</b><span>dari catatan pembelian &amp; produksi</span>`;
        $('profitMetric').innerHTML = `<small>Laba</small><b>Rp ${rp(profit)}</b><span>Penjualan − bahan terpakai${total ? ` · ${Math.round(profit / total * 100)}%` : ''}</span>`;
      }).catch(e => { $('profitMetric').innerHTML = `<small>Laba</small><span class="error">${esc(e.message)}</span>`; $('usedMetric').remove(); });
    }

    const top = new Map();
    valid.forEach(o => o.order_items.forEach(i => {
      const k = i.category + ' · ' + i.name;
      const r = top.get(k) || { qty: 0, amount: 0 };
      r.qty += i.qty; r.amount += i.subtotal;
      top.set(k, r);
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
    charts.salesChart = { buckets, label: $('chartTitle').textContent, value: 'amount' }; drawBarChart('salesChart');
    renderHours(valid, from, to, unit === 'hour');

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

  // ---------------------------------------------------------------- Pembelian bahan & produksi (pemilik)
  // Bahan terpakai = harga beli × (jumlah − sisa) / jumlah. Sisa tidak dihitung sebagai biaya saat itu,
  // tapi dibawa ke catatan berikutnya sebagai baris "sisa sebelumnya" (carry, from = id catatan asal)
  // dengan nilainya; biayanya dihitung saat terpakai di sana. Belanja = baris yang bukan sisa sebelumnya.
  // Laba = penjualan (tanpa ongkir) − bahan terpakai di periode yang sama.
  const BAHAN = ['Kulit lunpia', 'Telur', 'Rebung', 'Ayam', 'Udang'];
  const SATUAN = ['kg', 'gr', 'lembar', 'butir', 'ikat', 'liter', 'pcs', 'bungkus'];
  const usedOf = b => Number(b.qty) > 0 ? Number(b.price) * Math.max(0, Number(b.qty) - Number(b.leftover || 0)) / Number(b.qty) : Number(b.price) || 0;
  let productions = [], allProductions = [], prodRange = rangeFor('month');
  $('prodRangeSeg').addEventListener('click', e => {
    const b = e.target.closest('[data-range]'); if (!b) return;
    setSeg($('prodRangeSeg'), b.dataset.range); prodRange = rangeFor(b.dataset.range); renderProduction();
  });
  $('pApply').addEventListener('click', () => {
    if (!$('pFrom').value || !$('pTo').value) return toast('Pilih tanggal awal dan akhir', true);
    const from = parseYmd($('pFrom').value), to = new Date(+parseYmd($('pTo').value) + 864e5);
    if (to <= from) return toast('Tanggal akhir harus setelah tanggal awal', true);
    setSeg($('prodRangeSeg'), ''); prodRange = [from, to]; renderProduction();
  });
  const byNewest = (a, b) => b.day.localeCompare(a.day) || b.id - a.id;
  // Sisa bahan dari satu catatan, bahan & satuan yang sama digabung; nilai = harga × sisa / jumlah
  function leftoversOf(entry) {
    const m = new Map();
    (entry?.purchases || []).forEach(b => {
      const left = Number(b.leftover || 0); if (!left || !Number(b.qty)) return;
      const k = b.item.trim().toLowerCase() + '|' + b.unit;
      const r = m.get(k) || m.set(k, { item: b.item, unit: b.unit, qty: 0, price: 0 }).get(k);
      r.qty += left; r.price += Number(b.price) * left / Number(b.qty);
    });
    return [...m.values()].map(r => ({ ...r, qty: Math.round(r.qty * 1e4) / 1e4, price: Math.round(r.price) }));
  }
  // Catatan terbaru (selain yang sedang diubah) yang sisanya belum dibawa ke catatan lain
  function carrySource(exceptId) {
    const carried = new Set(allProductions.flatMap(p => (p.purchases || []).filter(b => b.carry).map(b => b.from)));
    const last = allProductions.filter(p => p.id !== exceptId).sort(byNewest)[0];
    return last && !carried.has(last.id) && leftoversOf(last).length ? last : null;
  }

  async function renderProduction() {
    const [from, to] = prodRange;
    const fromDay = ymdLocal(from), toDay = ymdLocal(new Date(+to - 864e5));
    $('pFrom').value = fromDay; $('pTo').value = toDay;
    let valid = [];
    try {
      allProductions = await DB.listProductions('2000-01-01', '2999-12-31');
      valid = (await DB.listOrders(from.toISOString(), to.toISOString())).filter(o => o.status !== 'batal');
      productions = allProductions.filter(p => p.day >= fromDay && p.day <= toDay).sort(byNewest);
    } catch (e) {
      productions = allProductions = [];
      $('prodMetrics').innerHTML = `<p class="error">${esc(e.message)}</p>`;
      ['prodOutTable', 'prodBuyTable', 'prodLeftTable', 'prodTable'].forEach(id => ($(id).innerHTML = ''));
      return;
    }
    const buys = productions.flatMap(p => p.purchases || []), outs = productions.flatMap(p => p.outputs || []);
    const bought = buys.filter(b => !b.carry).reduce((s, b) => s + Number(b.price || 0), 0);
    const latest = [...allProductions].sort(byNewest)[0], stockNow = leftoversOf(latest);
    const stockValue = stockNow.reduce((s, r) => s + r.price, 0);
    const used = Math.round(buys.reduce((s, b) => s + usedOf(b), 0));
    const pcs = outs.reduce((s, o) => s + Number(o.qty || 0), 0);
    $('prodMetrics').innerHTML = (productions.length ? `
      <div class="metric"><small>1. Belanja bahan</small><b>Rp ${rp(bought)}</b><span>${productions.length} catatan</span></div>
      <div class="metric"><small>Bahan terpakai</small><b>Rp ${rp(used)}</b><span>${pcs ? `± Rp ${rp(Math.round(used / pcs))} per pcs` : 'Belum ada hasil produksi'}</span></div>
      <div class="metric"><small>2. Hasil produksi</small><b>${rp(pcs)} pcs</b><span>Terjual ${rp(valid.reduce((s, o) => s + o.order_items.reduce((t, i) => t + i.qty, 0), 0))} pcs</span></div>`
      : '<p class="muted">Belum ada catatan pembelian &amp; produksi di periode ini.</p>') + `
      <div class="metric"><small>3. Sisa bahan sekarang</small><b>Rp ${rp(stockValue)}</b><span>${stockNow.length ? `${stockNow.length} bahan` : 'Tidak ada sisa'}</span></div>
`;

    $('prodLeftTable').innerHTML = `<thead><tr><th>Bahan</th><th class="num">Sisa</th><th class="num">Nilai</th></tr></thead>
      <tbody>${stockNow.length ? stockNow.map(r => `<tr><td>${esc(r.item)}</td><td class="num" data-sort="${r.qty}">${dec(r.qty)} ${esc(r.unit)}</td><td class="num">${rp(r.price)}</td></tr>`).join('')
        : '<tr><td class="empty" colspan="3">Tidak ada sisa bahan.</td></tr>'}</tbody>`;

    // Hasil produksi vs terjual per produk
    const per = new Map();
    const row = (id, name) => per.get(id) || per.set(id, { name, made: 0, sold: 0 }).get(id);
    outs.forEach(o => { row(o.product_id, o.name).made += Number(o.qty || 0); });
    valid.forEach(o => o.order_items.forEach(i => { if (per.has(i.product_id)) per.get(i.product_id).sold += i.qty; }));
    const outRows = [...per.values()].sort((a, b) => b.made - a.made);
    $('prodOutTable').innerHTML = `<thead><tr><th>Produk</th><th class="num">Diproduksi</th><th class="num">Terjual</th></tr></thead>
      <tbody>${outRows.length ? outRows.map(r => `<tr><td>${esc(r.name)}</td><td class="num">${rp(r.made)}</td><td class="num">${rp(r.sold)}</td></tr>`).join('')
        : '<tr><td class="empty" colspan="3">—</td></tr>'}</tbody>`;

    // Pembelian per bahan (nama sama digabung)
    const items = new Map();
    buys.forEach(b => {
      const k = (b.item || '').trim().toLowerCase() + '|' + (b.unit || '');
      const r = items.get(k) || items.set(k, { item: b.item, unit: b.unit, qty: 0, price: 0, usedQty: 0, used: 0 }).get(k);
      if (!b.carry) { r.qty += Number(b.qty || 0); r.price += Number(b.price || 0); }
      r.usedQty += Math.max(0, Number(b.qty || 0) - Number(b.leftover || 0)); r.used += usedOf(b);
    });
    const buyRows = [...items.values()].sort((a, b) => b.used - a.used);
    $('prodBuyTable').innerHTML = `<thead><tr><th>Bahan</th><th class="num">Dibeli</th><th class="num">Harga</th><th class="num">Terpakai</th><th class="num">Nilai terpakai</th></tr></thead>
      <tbody>${buyRows.length ? buyRows.map(r => `<tr><td>${esc(r.item)}</td>
        <td class="num" data-sort="${r.qty}">${r.qty ? `${dec(r.qty)} ${esc(r.unit)}` : '—'}</td><td class="num">${rp(r.price)}</td>
        <td class="num" data-sort="${r.usedQty}">${dec(Math.round(r.usedQty * 1e4) / 1e4)} ${esc(r.unit)}</td><td class="num">${rp(Math.round(r.used))}</td></tr>`).join('')
        : '<tr><td class="empty" colspan="5">—</td></tr>'}</tbody>`;

    $('prodTable').innerHTML = `<thead><tr><th>Tanggal</th><th>Pembelian</th><th>Hasil</th><th class="num">Bahan terpakai</th><th>Catatan</th><th></th></tr></thead>
      <tbody>${productions.length ? productions.map(p => `<tr>
        <td data-sort="${p.day}">${dmy(parseYmd(p.day))}</td>
        <td>${esc((p.purchases || []).map(b => `${b.carry ? 'sisa ' : ''}${b.item} ${dec(b.qty)} ${b.unit}${Number(b.leftover) ? ` (sisa ${dec(b.leftover)})` : ''}`).join(', ')) || '—'}</td>
        <td>${esc((p.outputs || []).map(o => `${o.name} ${o.qty}`).join(', ')) || '—'}${p.stocked && p.outputs?.length ? ` <span class="chip ok">masuk stok ${p.location === 'rumah' ? 'rumah' : 'toko'}</span>` : ''}</td>
        <td class="num">${rp(Math.round((p.purchases || []).reduce((s, b) => s + usedOf(b), 0)))}</td>
        <td>${esc(p.note || '')}</td>
        <td><div class="add-stock"><button class="ghost small need-pembelian_catat" data-prodedit="${p.id}">Ubah</button>
          <button class="ghost small danger need-pembelian_hapus" data-proddel="${p.id}">Hapus</button></div></td>
      </tr>`).join('') : '<tr><td class="empty" colspan="6">—</td></tr>'}</tbody>`;
  }

  const prodName = p => `${p.category} ${p.name}`;
  // Baris "sisa sebelumnya" (carry): bahan, jumlah, satuan, nilai terkunci; hanya sisanya yang diisi
  const buyLine = (b = {}) => {
    const ro = b.carry ? ' readonly' : '';
    return `<div class="buy-line${b.carry ? ' carry' : ''}"${b.carry ? ` data-from="${b.from}" data-qty="${b.qty}" data-price="${b.price}"` : ''}>
    <input data-b="item" list="bahanList" value="${esc(b.item || '')}" placeholder="Bahan" aria-label="Bahan"${ro}>
    <input data-b="qty" inputmode="decimal" value="${b.qty != null ? dec(b.qty) : ''}" placeholder="Jumlah" aria-label="Jumlah dibeli"${ro}>
    <input data-b="unit" list="satuanList" value="${esc(b.unit || '')}" placeholder="Satuan" aria-label="Satuan"${ro}>
    <input data-b="price" inputmode="numeric" value="${b.price != null ? rp(b.price) : ''}" placeholder="Harga (Rp)" aria-label="${b.carry ? 'Nilai sisa' : 'Harga total'}"${ro}>
    <input data-b="leftover" inputmode="decimal" value="${Number(b.leftover) ? dec(b.leftover) : ''}" placeholder="${b.carry ? 'Sisa lagi' : 'Sisa'}" aria-label="Sisa">
    ${b.carry ? '<span class="chip plain" title="Sisa dari catatan sebelumnya. Isi Sisa kalau masih ada yang tersisa; kosongkan kalau sudah habis atau dibuang.">sisa lalu</span>'
      : '<button type="button" class="ghost small danger" data-buydel aria-label="Hapus baris">×</button>'}
  </div>`;
  };
  async function openProdForm(entry) {
    if (!products.length) await loadProducts();
    // Catatan baru: sisa dari catatan terakhir ikut dibawa sebagai baris "sisa lalu"
    const src = entry ? null : carrySource();
    const e = entry || {
      day: ymdLocal(new Date()), note: '', outputs: [], stocked: true,
      purchases: [
        ...leftoversOf(src).map(r => ({ ...r, carry: true, from: src.id })),
        ...BAHAN.map(item => ({ item, unit: { 'Kulit lunpia': 'lembar', Telur: 'butir' }[item] || 'kg' })),
      ],
    };
    const outQty = id => (e.outputs || []).find(o => o.product_id === id)?.qty ?? '';
    // Lokasi hasil produksi: dari catatan yang diubah, atau pilihan terakhir di perangkat ini
    let loc = entry?.location; if (!loc) { try { loc = localStorage.getItem('lunpiaProdLoc'); } catch {} }
    loc = loc === 'rumah' ? 'rumah' : 'toko';
    // produk aktif + produk nonaktif yang sudah tercatat di entri ini
    const list = products.filter(p => p.active || (e.outputs || []).some(o => o.product_id === p.id));
    $('prodForm').dataset.id = entry?.id || '';
    $('prodForm').innerHTML = `<div class="prod-edit">
      <b>${entry ? 'Ubah catatan' : 'Catat pembelian & produksi'}</b>
      <label class="short-label">Tanggal <input type="date" data-f="day" value="${esc(e.day)}"></label>
      <h4>Pembelian bahan</h4>
      <p class="muted hint">Harga = total yang dibayar. Sisa = bahan yang belum terpakai (satuan sama), otomatis dibawa ke catatan berikutnya.
        ${src ? `Baris <b>sisa lalu</b> adalah sisa dari catatan ${dmy(parseYmd(src.day))}: isi Sisa kalau masih ada yang tersisa, kosongkan kalau sudah habis atau dibuang (nilainya dihitung terpakai).` : ''}</p>
      <div class="buy-head"><span>Bahan</span><span>Jumlah</span><span>Satuan</span><span>Harga total</span><span>Sisa</span><span></span></div>
      <div class="buy-rows">${(e.purchases?.length ? e.purchases : [{}]).map(buyLine).join('')}</div>
      <button type="button" class="link" data-buyadd>+ Tambah bahan</button>
      <h4>Hasil produksi (pcs)</h4>
      <div class="out-grid">${list.map(p => `<label>${esc(prodName(p))}
        <input data-out="${p.id}" inputmode="numeric" value="${outQty(p.id)}" placeholder="0"></label>`).join('')}</div>
      <div class="prod-stock">
        <label class="check"><input type="checkbox" data-f="stocked"${e.stocked !== false ? ' checked' : ''}>
          Tambahkan hasil produksi ke stok <span class="muted">(tercatat di kartu stok)</span></label>
        <label class="prod-loc">disimpan di
          <select data-f="location" aria-label="Lokasi hasil produksi">
            <option value="toko"${loc === 'toko' ? ' selected' : ''}>Toko</option><option value="rumah"${loc === 'rumah' ? ' selected' : ''}>Rumah</option>
          </select></label>
      </div>
      <label>Catatan <input data-f="note" value="${esc(e.note || '')}" placeholder="opsional"></label>
      <p>Belanja <b data-sum="buy"></b> · bahan terpakai <b data-sum="used"></b> · hasil <b data-sum="pcs"></b></p>
      <div class="actions"><button type="button" class="primary small" data-prodsave>Simpan</button>
        <button type="button" class="ghost small" data-prodcancel>Batal</button></div>
      <datalist id="bahanList">${BAHAN.map(b => `<option value="${b}">`).join('')}</datalist>
      <datalist id="satuanList">${SATUAN.map(u => `<option value="${u}">`).join('')}</datalist>
    </div>`;
    $('prodForm').hidden = false;
    prodCalc();
    $('prodForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function readProdForm() {
    const box = $('prodForm');
    const purchases = [...box.querySelectorAll('.buy-line')].map(l => {
      const f = k => l.querySelector(`[data-b="${k}"]`).value.trim();
      if (l.dataset.from) return { item: f('item'), qty: Number(l.dataset.qty), unit: f('unit'), price: Number(l.dataset.price),
        leftover: num(f('leftover')), carry: true, from: Number(l.dataset.from) };
      return { item: f('item'), qty: num(f('qty')), unit: f('unit'), price: toInt(f('price')), leftover: num(f('leftover')) };
    }).filter(b => b.carry || b.item || b.qty || b.price);
    const outputs = [...box.querySelectorAll('[data-out]')].map(i => {
      const p = byId(Number(i.dataset.out));
      return { product_id: p.id, name: prodName(p), qty: toInt(i.value) };
    }).filter(o => o.qty > 0);
    return { day: box.querySelector('[data-f="day"]').value, note: box.querySelector('[data-f="note"]').value.trim(),
      stocked: box.querySelector('[data-f="stocked"]').checked, location: box.querySelector('[data-f="location"]').value, purchases, outputs };
  }
  function prodCalc() {
    const { purchases, outputs } = readProdForm(), q = k => $('prodForm').querySelector(`[data-sum="${k}"]`);
    q('buy').textContent = 'Rp ' + rp(purchases.filter(b => !b.carry).reduce((s, b) => s + b.price, 0));
    q('used').textContent = 'Rp ' + rp(Math.round(purchases.reduce((s, b) => s + usedOf(b), 0)));
    q('pcs').textContent = rp(outputs.reduce((s, o) => s + o.qty, 0)) + ' pcs';
  }
  $('prodAddBtn').addEventListener('click', () => openProdForm());
  $('prodForm').addEventListener('input', e => {
    if (e.target.dataset.b === 'price') { const v = toInt(e.target.value); e.target.value = v ? rp(v) : ''; }
    prodCalc();
  });
  $('prodForm').addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    const d = b.dataset;
    if ('buyadd' in d) { $('prodForm').querySelector('.buy-rows').insertAdjacentHTML('beforeend', buyLine()); return; }
    if ('buydel' in d) { b.closest('.buy-line').remove(); return prodCalc(); }
    if ('prodcancel' in d) { $('prodForm').hidden = true; $('prodForm').innerHTML = ''; return; }
    if (!('prodsave' in d)) return;
    const x = readProdForm();
    try { localStorage.setItem('lunpiaProdLoc', x.location); } catch {}
    if (!x.day) return toast('Isi tanggal', true);
    if (!x.purchases.length && !x.outputs.length) return toast('Isi pembelian bahan atau hasil produksi', true);
    const bad = x.purchases.find(p => !p.carry && (!p.item || !p.qty || !p.price));
    if (bad) return toast(`Lengkapi bahan, jumlah, dan harga${bad.item ? ' untuk ' + bad.item : ''}`, true);
    const over = x.purchases.find(p => p.leftover > p.qty);
    if (over) return toast(`Sisa ${over.item} lebih banyak dari yang dibeli`, true);
    b.disabled = true;
    try {
      await DB.saveProduction({ id: Number($('prodForm').dataset.id) || null, ...x });
      const id = Number($('prodForm').dataset.id) || null;
      const carriedBy = id && allProductions.find(p => (p.purchases || []).some(b => b.carry && b.from === id));
      toast(carriedBy ? `Catatan disimpan. Sisa bahannya sudah dibawa ke catatan ${dmy(parseYmd(carriedBy.day))}; ubah juga di sana kalau sisanya berubah.`
        : x.stocked && x.outputs.length ? 'Catatan disimpan, stok produk ikut diperbarui' : 'Catatan disimpan');
      $('prodForm').hidden = true; $('prodForm').innerHTML = '';
      renderProduction(); loadProducts();
    } catch (err) { toast(err.message, true); b.disabled = false; }
  });
  $('prodTable').addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.prodedit) return openProdForm(productions.find(p => p.id === Number(b.dataset.prodedit)));
    if (b.dataset.proddel) {
      const p = productions.find(x => x.id === Number(b.dataset.proddel));
      if (!confirm(`Hapus catatan pembelian & produksi tanggal ${dmy(parseYmd(p.day))}?${p.stocked && p.outputs?.length ? '\nStok hasil produksinya ikut dikurangi kembali.' : ''}`)) return;
      try { await DB.deleteProduction(p.id); toast('Catatan dihapus'); renderProduction(); loadProducts(); }
      catch (err) { toast(err.message, true); }
    }
  });

  // ---------------------------------------------------------------- Cash (kas harian)
  // Seharusnya di laci = uang awal + penjualan tunai hari ini (ongkir tidak dihitung).
  const todayRange = () => { const s = new Date(); s.setHours(0, 0, 0, 0); return [s, new Date(+s + 864e5)]; };
  // Seharusnya di laci = uang awal + penjualan tunai + ongkir pesanan Kirim yang dibayar tunai − kas keluar
  async function cashToday() {
    const [from, to] = todayRange(), day = ymdLocal(from);
    const [cd, orders, out] = await Promise.all([
      DB.getCashDay(day), DB.listOrders(from.toISOString(), to.toISOString()),
      DB.listCashOut(day).catch(e => ({ error: e.message })),   // tabel kas keluar (005) belum ada
    ]);
    const tunai = orders.filter(o => o.status !== 'batal' && o.pay_method === 'tunai');
    const cash = tunai.reduce((s, o) => s + o.total, 0);
    const ongkir = tunai.filter(o => o.fulfillment === 'kirim').reduce((s, o) => s + (o.ongkir || 0), 0);
    const outList = Array.isArray(out) ? out : [], outTotal = outList.reduce((s, x) => s + x.amount, 0);
    return { day, cd, cash, ongkir, n: tunai.length, out: outList, outErr: out.error, outTotal,
      expected: cd ? cd.opening + cash + ongkir - outTotal : 0 };
  }
  function cashFigures(c, closed) {
    const { cd } = c;
    return `<div class="metrics" id="cashMetrics">
      <div class="metric"><small>Uang awal</small><b>Rp ${rp(cd.opening)}</b><span>${esc(denomSummary(cd.opening_detail) || (cd.opened_by || '').split('@')[0])}</span></div>
      <div class="metric"><small>Penjualan tunai</small><b>Rp ${rp(c.cash + c.ongkir)}</b><span>${c.n} transaksi${c.ongkir ? ` · termasuk ongkir ${rp(c.ongkir)}` : ''}</span></div>
      <div class="metric"><small>Kas keluar</small><b>Rp ${rp(c.outTotal)}</b><span>${c.out.length} catatan</span></div>
      <div class="metric lead"><small>Seharusnya di laci</small><b>Rp ${rp(closed ? cd.expected : c.expected)}</b><span>${closed ? 'saat tutup kasir' : 'awal + tunai − keluar'}</span></div>
      ${closed ? `<div class="metric"><small>Uang dihitung</small><b>Rp ${rp(cd.counted)}</b><span>${diffTxt(cd.counted - cd.expected)}</span></div>` : ''}
    </div>`;
  }
  function cashOutList(c) {
    if (c.outErr) return `<p class="error">${esc(c.outErr)}</p>`;
    if (!c.out.length) return '<p class="muted">Belum ada kas keluar hari ini.</p>';
    return `<div class="table-wrap"><table class="table">
      <thead><tr><th>Jam</th><th>Keterangan</th><th class="num">Jumlah</th><th>Oleh</th><th class="need-kas_hapus"></th></tr></thead>
      <tbody>${c.out.map(x => { const t = new Date(x.created_at); return `<tr>
        <td>${pad(t.getHours())}.${pad(t.getMinutes())}</td><td>${esc(x.note || '-')}</td>
        <td class="num">${rp(x.amount)}</td><td class="muted">${esc((x.created_by || '').split('@')[0])}</td>
        <td class="need-kas_hapus"><button class="ghost small danger" data-cashout-del="${x.id}">Hapus</button></td>
      </tr>`; }).join('')}</tbody></table></div>`;
  }
  function cashOutSection(c, closed) {
    return `<section class="cash-out">
      <h3>Kas keluar hari ini <span class="muted">(pengeluaran dari laci: beli bahan, bensin, parkir, bayar kurir…)</span></h3>
      <div id="cashOutList">${cashOutList(c)}</div>
      ${closed || c.outErr || !can('kas_keluar') ? '' : `<div class="cash-row">
        <div><label for="outAmount">Jumlah</label><input id="outAmount" inputmode="numeric" placeholder="0" autocomplete="off"></div>
        <div class="grow"><label for="outNote">Keterangan</label><input id="outNote" placeholder="mis. beli rebung" autocomplete="off"></div>
        <button class="ghost" data-cashout-add>Catat kas keluar</button>
        ${opts.cash_out_max ? `<span class="muted cash-max">Maks. Rp ${rp(opts.cash_out_max)} per catatan</span>` : ''}
      </div>`}
    </section>`;
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
    const { cd } = c;
    const resetLink = can('kas_ubah') ? '<p class="cash-reset"><button class="link danger" data-cash-reset>Mulai ulang kas hari ini</button></p>' : '';
    const head = `<div class="view-head"><h2 id="cashTitle">Kas hari ini</h2><span class="muted">${esc(longDate(new Date()))}</span></div>`;
    cashMode = !cd || editOpening ? 'open' : cd.closed_at && !recount ? 'closed' : 'count';
    if (!cd && !can('kas_buka')) {
      $('cashPanel').innerHTML = `${head}<p class="muted">Uang awal hari ini belum diisi. Akun ini tidak punya wewenang mengisi uang awal.</p>`;
      return;
    }
    if (!cd || editOpening) {
      $('cashPanel').innerHTML = `${head}
        <p class="muted">Hitung uang di laci saat toko buka: isi jumlah lembar/keping tiap pecahan.</p>
        ${denomGrid('open', cd?.opening_detail)}
        <div class="actions"><button class="primary" data-cash-open>Simpan uang awal</button>
        ${editOpening ? '<button class="ghost" data-cash-cancel>Batal</button>' : ''}</div>${cd ? resetLink : ''}`;
      return;
    }
    cashExpected = c.expected;
    const closed = cashMode === 'closed';
    const figures = cashFigures(c, closed) + cashOutSection(c, closed);
    if (closed) {
      const t = new Date(cd.closed_at);
      $('cashPanel').innerHTML = `${head}${figures}
        ${cd.counted_detail ? `<p class="muted">Rincian hitungan: ${esc(denomSummary(cd.counted_detail))}</p>` : ''}
        <p class="muted">Kasir ditutup pukul ${pad(t.getHours())}.${pad(t.getMinutes())} oleh ${esc((cd.closed_by || '').split('@')[0])}${cd.note ? ' · ' + esc(cd.note) : ''}
        ${can('kas_ubah') ? ' · <button class="link" data-cash-recount>Hitung ulang</button>' : ''}</p>${resetLink}`;
      return;
    }
    $('cashPanel').innerHTML = `${head}${figures}
      ${!can('kas_tutup') && !recount ? `<p class="muted">Kasir belum ditutup.${can('kas_buka') ? ' <button class="link" data-cash-editopen>Ubah uang awal</button>' : ''}</p>${resetLink}` : `
      <p class="muted">Tutup kasir: hitung uang di laci per pecahan. ${recount || !can('kas_buka') ? '' : '<button class="link" data-cash-editopen>Ubah uang awal</button>'}</p>
      ${denomGrid('count', recount ? cd.counted_detail : null)}
      <p class="cash-diff" id="cashDiff"></p>
      <div class="cash-row">
        <div class="grow"><label for="cashNote">Catatan</label><input id="cashNote" autocomplete="off" value="${recount ? esc(cd.note || '') : ''}"></div>
        <button class="primary" data-cash-close>Tutup kasir</button>
        ${recount ? '<button class="ghost" data-cash-cancel>Batal</button>' : ''}
      </div>${resetLink}`}`;
    updateDenoms('count');
  }
  // Angka kas diperbarui tanpa menghapus isian (mis. ada penjualan dari perangkat lain).
  let cashMode = '';
  async function refreshCashFigures(force = false) {
    if (currentTab !== 'kas' || (document.hidden && !force)) return;
    let c; try { c = await cashToday(); } catch { return; }
    const mode = !c.cd || editOpening ? 'open' : c.cd.closed_at && !recount ? 'closed' : 'count';
    const typing = [...$('cashPanel').querySelectorAll('input')].some(i => i.value.trim());
    if (mode !== cashMode) { if (!typing || force) renderCash(); return; }
    if (mode === 'open') return;
    $('cashMetrics').outerHTML = cashFigures(c, mode === 'closed');
    $('cashOutList').innerHTML = cashOutList(c);
    cashExpected = c.expected;
    if (mode === 'count') updateDenoms('count');
  }
  setInterval(refreshCashFigures, 30000);
  $('cashPanel').addEventListener('blur', e => {
    if (e.target.id === 'outAmount' && e.target.value.trim()) e.target.value = rp(toInt(e.target.value));
  }, true);

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
  // Riwayat kas: harian (31 hari), atau dijumlahkan per minggu (12 minggu), per bulan (12 bulan), per tahun
  let cashView = 'day';
  $('cashViewSeg').addEventListener('click', e => {
    const b = e.target.closest('[data-cv]'); if (!b || b.dataset.cv === cashView) return;
    cashView = b.dataset.cv; setSeg($('cashViewSeg'), cashView); delete sortState.cashHistory; renderCashHistory();
  });
  const weekStart = d => { const x = parseYmd(d); x.setDate(x.getDate() - (x.getDay() + 6) % 7); return x; };
  function cashPeriod(day) {
    if (cashView === 'week') { const s = weekStart(day), e = new Date(+s + 6 * 864e5);
      return [ymdLocal(s), `${s.getDate()} ${s.toLocaleDateString('id-ID', { month: 'short' })} – ${e.getDate()} ${e.toLocaleDateString('id-ID', { month: 'short', year: 'numeric' })}`]; }
    if (cashView === 'month') return [day.slice(0, 7), parseYmd(day).toLocaleDateString('id-ID', { month: 'long', year: 'numeric' })];
    return [day.slice(0, 4), day.slice(0, 4)];
  }
  async function renderCashHistory() {
    const from = new Date(); from.setHours(0, 0, 0, 0);
    if (cashView === 'day') from.setDate(from.getDate() - 30);
    if (cashView === 'week') { from.setTime(+weekStart(ymdLocal(from))); from.setDate(from.getDate() - 7 * 11); }
    if (cashView === 'month') { from.setDate(1); from.setMonth(from.getMonth() - 11); }
    if (cashView === 'year') from.setFullYear(2000, 0, 1);
    $('cashHistoryTitle').textContent = { day: 'Riwayat kas 31 hari terakhir', week: 'Riwayat kas per minggu (12 minggu)',
      month: 'Riwayat kas per bulan (12 bulan)', year: 'Riwayat kas per tahun' }[cashView];
    let days, outs = [];
    try {
      days = await DB.listCashDays(ymdLocal(from));
      if (cashView !== 'day') outs = await DB.listCashOutFrom(ymdLocal(from)).catch(() => []);
    } catch { $('cashHistory').innerHTML = ''; return; }
    const who = e => esc((e || '').split('@')[0]);
    cashRows = new Map(days.map(c => [c.day, c]));
    if (cashView !== 'day') {
      const groups = new Map();
      const g = day => { const [key, label] = cashPeriod(day);
        return groups.get(key) || groups.set(key, { key, label, days: 0, closed: 0, diff: 0, over: 0, short: 0, out: 0 }).get(key); };
      days.forEach(c => {
        const r = g(c.day); r.days++;
        if (c.closed_at) { const d = c.counted - c.expected; r.closed++; r.diff += d; if (d > 0) r.over += d; if (d < 0) r.short -= d; }
      });
      outs.forEach(x => { g(x.day).out += x.amount; });
      const rows = [...groups.values()].sort((a, b) => b.key.localeCompare(a.key));
      $('cashHistory').innerHTML = `
        <thead><tr><th>${{ week: 'Minggu', month: 'Bulan', year: 'Tahun' }[cashView]}</th><th class="num">Hari buka</th><th class="num">Ditutup</th>
          <th class="num">Lebih</th><th class="num">Kurang</th><th>Total selisih</th><th class="num">Kas keluar</th></tr></thead>
        <tbody>${rows.length ? rows.map(r => `<tr>
          <td data-sort="${esc(r.key)}">${esc(r.label)}</td><td class="num">${r.days}</td><td class="num">${r.closed}</td>
          <td class="num">${r.over ? rp(r.over) : '—'}</td><td class="num">${r.short ? rp(r.short) : '—'}</td>
          <td data-sort="${r.diff}">${!r.closed ? '<span class="chip plain">—</span>' : r.diff === 0 ? '<span class="chip ok">Pas</span>' : r.diff > 0 ? `<span class="chip warn">Lebih ${rp(r.diff)}</span>` : `<span class="chip bad">Kurang ${rp(-r.diff)}</span>`}</td>
          <td class="num">${rp(r.out)}</td></tr>`).join('') : '<tr><td class="empty" colspan="7">Belum ada catatan kas.</td></tr>'}</tbody>`;
      return;
    }
    $('cashHistory').innerHTML = `
      <thead><tr><th>Tanggal</th><th class="num">Uang awal</th><th class="num">Seharusnya</th><th class="num">Dihitung</th><th>Selisih</th><th>Ditutup oleh</th><th>Catatan</th><th class="need-kas_ubah_hapus"></th></tr></thead>
      <tbody>${days.length ? days.map(c => {
        const d = c.closed_at ? c.counted - c.expected : null;
        return `<tr data-day="${esc(c.day)}">
          <td data-sort="${esc(c.day)}">${esc(parseYmd(c.day).toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'short' }))}</td>
          <td class="num">${rp(c.opening)}</td>
          <td class="num">${c.closed_at ? rp(c.expected) : '—'}</td>
          <td class="num">${c.closed_at ? rp(c.counted) : '—'}</td>
          <td data-sort="${d ?? ''}">${d == null ? '<span class="chip plain">Belum ditutup</span>' : d === 0 ? '<span class="chip ok">Pas</span>' : d > 0 ? `<span class="chip warn">Lebih ${rp(d)}</span>` : `<span class="chip bad">Kurang ${rp(-d)}</span>`}</td>
          <td class="muted">${who(c.closed_by)}</td>
          <td class="muted">${esc(c.note || '')}</td>
          <td class="need-kas_ubah_hapus"><div class="add-stock">
            <button class="ghost small need-kas_ubah" data-cashedit="${esc(c.day)}">Ubah</button>
            <button class="ghost small danger need-kas_hapus" data-cashdel="${esc(c.day)}">Hapus</button>
          </div></td>
        </tr>`;
      }).join('') : '<tr><td class="empty" colspan="8">Belum ada catatan kas.</td></tr>'}</tbody>`;
  }

  // Ubah / hapus kas di riwayat (pemilik). Ubah: uang awal, uang dihitung (kalau sudah ditutup), catatan;
  // selisih dihitung ulang dari "seharusnya" yang tersimpan saat tutup kasir.
  let cashRows = new Map();
  $('cashHistory').addEventListener('click', async e => {
    const t = e.target.closest('button'); if (!t) return;
    const d = t.dataset;
    try {
      if (d.cashedit) {
        const c = cashRows.get(d.cashedit), row = t.closest('tr');
        row.innerHTML = `<td colspan="8"><div class="cash-edit">
          <b>${esc(parseYmd(c.day).toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }))}</b>
          <label>Uang awal<input inputmode="numeric" data-f="opening" value="${rp(c.opening)}"></label>
          ${c.closed_at ? `<label>Uang dihitung<input inputmode="numeric" data-f="counted" value="${rp(c.counted)}"></label>` : ''}
          <label class="grow">Catatan<input data-f="note" value="${esc(c.note || '')}" autocomplete="off"></label>
          <div class="actions"><button class="primary small" data-cashsave="${esc(c.day)}">Simpan</button>
          <button class="ghost small" data-cashcancel>Batal</button></div>
        </div></td>`;
        row.querySelector('input').focus();
      } else if (d.cashsave) {
        const c = cashRows.get(d.cashsave), box = t.closest('.cash-edit');
        const val = f => box.querySelector(`[data-f="${f}"]`)?.value;
        const f = { opening: toInt(val('opening')), note: val('note').trim() };
        if (f.opening !== c.opening) f.opening_detail = null;            // rincian lama tidak cocok lagi
        if (c.closed_at) { f.counted = toInt(val('counted')); if (f.counted !== c.counted) f.counted_detail = null; }
        await DB.updateCashDay(c.day, f).catch(async err => {
          if (!/opening_detail|counted_detail|PGRST204/.test(err.message)) throw err;   // kolom rincian (003) belum ada
          delete f.opening_detail; delete f.counted_detail; await DB.updateCashDay(c.day, f);
        });
        toast('Kas diperbarui'); renderCash();
      } else if ('cashcancel' in d) renderCashHistory();
      else if (d.cashdel) {
        const c = cashRows.get(d.cashdel);
        if (!confirm(`Hapus catatan kas ${parseYmd(c.day).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })}? Data penjualan tidak berubah.`)) return;
        await DB.deleteCashDay(c.day); toast('Catatan kas dihapus'); renderCash(); refreshNotices();
      }
    } catch (err) { toast(err.message, true); }
  });

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
        await DB.closeCash(day, { expected: c.expected, counted: total, counted_detail: detail, note: $('cashNote').value.trim() });
        recount = false; toast('Kasir ditutup'); renderCash();
      } else if ('cashRecount' in t.dataset) { recount = true; renderCash(); }
      else if ('cashEditopen' in t.dataset) { editOpening = true; renderCash(); }
      else if ('cashCancel' in t.dataset) { recount = editOpening = false; renderCash(); }
      else if ('cashoutAdd' in t.dataset) {
        const amount = toInt($('outAmount').value), note = $('outNote').value.trim();
        if (!amount) return toast('Isi jumlah kas keluar', true);
        if (!note) return toast('Isi keterangan kas keluar', true);
        if (opts.cash_out_max && amount > opts.cash_out_max)
          return toast(`Kas keluar maksimal Rp ${rp(opts.cash_out_max)} per catatan. Lebih dari itu minta pemilik yang mencatat.`, true);
        await DB.addCashOut(day, amount, note);
        $('outAmount').value = ''; $('outNote').value = '';
        toast(`Kas keluar Rp ${rp(amount)} dicatat`); refreshCashFigures(true);
      } else if (t.dataset.cashoutDel) {
        if (!confirm('Hapus catatan kas keluar ini?')) return;
        await DB.deleteCashOut(Number(t.dataset.cashoutDel)); toast('Kas keluar dihapus'); refreshCashFigures(true);
      }
      else if ('cashReset' in t.dataset) {
        if (!confirm('Mulai ulang kas hari ini? Uang awal, hitungan, catatan, dan status tutup kasir hari ini dikosongkan. Data penjualan tidak berubah.')) return;
        await DB.resetCash(day);
        recount = false; editOpening = true;
        toast('Kas hari ini dimulai ulang. Isi uang awal.'); renderCash(); refreshNotices();
      }
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
    if (cd === null && can('kas_buka')) items.push(`<div class="notice warn">Uang awal hari ini belum diisi. <button class="link" data-goto="kas">Isi sekarang</button></div>`);
    if (late && can('pesanan')) items.push(`<div class="notice bad"><b>${late} pesanan terlewat</b> belum diambil/dikirim. <button class="link" data-goto="pesanan">Lihat</button></div>`);
    if ((nToday || nTomorrow) && can('pesanan')) items.push(`<div class="notice">${[nToday && `<b>${nToday} pesanan hari ini</b>`, nTomorrow && `<b>${nTomorrow} pesanan besok</b>`].filter(Boolean).join(' · ')} untuk diambil/dikirim. <button class="link" data-goto="pesanan">Lihat</button></div>`);
    // Pengingat cadangan (pemilik): belum pernah, atau lebih dari 7 hari
    if (isOwner()) {
      const last = await DB.lastBackup().catch(() => undefined);
      const days = last ? Math.floor((Date.now() - new Date(last)) / 864e5) : null;
      if (last === null || days > 7) items.push(`<div class="notice warn">${last === null ? '<b>Belum pernah mengunduh cadangan data.</b>'
        : `<b>Cadangan data terakhir ${days} hari lalu.</b>`} Simpan cadangan seminggu sekali supaya data aman.
        <button class="link" data-backup-now>Unduh cadangan sekarang</button></div>`);
    }
    $('kasirNotices').innerHTML = items.join('');
  }
  $('kasirNotices').addEventListener('click', e => {
    const b = e.target.closest('[data-goto]'); if (b) openTab(b.dataset.goto);
    if (e.target.closest('[data-backup-now]')) downloadBackup();
  });

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

  // ---------------------------------------------------------------- Jam ramai
  // Transaksi dijumlahkan per jam (00–23) untuk seluruh hari di periode. Grafik dan tabel hanya
  // mencakup rentang jam yang ada penjualannya. Ramai = 3 jam dengan transaksi terbanyak, Sepi = 3 tersedikit.
  function renderHours(valid, from, to, singleDay) {
    $('hourPanel').hidden = singleDay;   // periode 1 hari: grafik utama sudah per jam
    if (singleDay) { delete charts.hourChart; return; }
    const hours = Array.from({ length: 24 }, (_, h) => ({ h, n: 0, amount: 0 }));
    valid.forEach(o => { const x = hours[new Date(o.created_at).getHours()]; x.n++; x.amount += o.total; });
    const used = hours.filter(x => x.n);
    const days = Math.max(1, Math.round((to - from) / 864e5));
    if (!used.length) {
      $('hourSum').textContent = ''; $('hourTable').innerHTML = '';
      charts.hourChart = { buckets: hours.map(x => ({ tick: pad(x.h), long: '', n: 0, amount: 0 })), label: 'Transaksi per jam', value: 'n' };
      return drawBarChart('hourChart');
    }
    const span = hours.slice(used[0].h, used[used.length - 1].h + 1);
    const rank = [...span].sort((a, b) => b.n - a.n || b.amount - a.amount);
    const busy = new Set(rank.slice(0, Math.min(3, span.length)).map(x => x.h));
    const quiet = new Set(span.length > 3 ? rank.slice(-Math.min(3, span.length - 3)).map(x => x.h) : []);
    const label = h => `${pad(h)}.00–${pad(h)}.59`;
    const list = hs => [...hs].sort((a, b) => a - b).map(h => `${pad(h)}.00`).join(', ');
    $('hourSum').innerHTML = `Paling ramai: <b>${list(busy)}</b>${quiet.size ? ` · Paling sepi: <b>${list(quiet)}</b>` : ''}`;
    charts.hourChart = {
      buckets: span.map(x => ({ tick: pad(x.h), long: `Pukul ${label(x.h)}`, n: x.n, amount: x.amount })),
      label: 'Transaksi per jam', value: 'n',
    };
    drawBarChart('hourChart');
    $('hourTable').innerHTML = `
      <thead><tr><th>Jam</th><th class="num">Transaksi</th><th class="num">Penjualan</th><th class="num">Rata-rata trx/hari</th><th>Keterangan</th></tr></thead>
      <tbody>${span.map(x => `<tr>
        <td data-sort="${pad(x.h)}">${label(x.h)}</td>
        <td class="num">${x.n}</td>
        <td class="num">${rp(x.amount)}</td>
        <td class="num" data-sort="${x.n / days}">${(x.n / days).toLocaleString('id-ID', { maximumFractionDigits: 1 })}</td>
        <td data-sort="${busy.has(x.h) ? 2 : quiet.has(x.h) ? 0 : 1}">${busy.has(x.h) ? '<span class="chip amoy">Ramai</span>' : quiet.has(x.h) ? '<span class="chip plain">Sepi</span>' : ''}</td>
      </tr>`).join('')}</tbody>`;
  }

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

  // Grafik batang umum. value 'amount' (Rupiah) atau 'n' (jumlah transaksi).
  const charts = {};   // id elemen → { buckets, label, value }
  function drawBarChart(id) {
    const el = $(id), { buckets, label, value = 'amount' } = charts[id] || {};
    const W = el.clientWidth, H = el.clientHeight;
    if (!W || !buckets?.length) return;
    const val = b => b[value];
    const fmt = v => value === 'amount' ? shortRp(v) : v.toLocaleString('id-ID', { maximumFractionDigits: 1 });
    const m = { l: 52, r: 4, t: 22, b: 24 };
    const pw = W - m.l - m.r, ph = H - m.t - m.b;
    const top = value === 'amount' ? niceMax(Math.max(...buckets.map(val))) : Math.max(4, niceMax(Math.max(...buckets.map(val))));
    const y = v => m.t + ph - (v / top) * ph;
    const band = pw / buckets.length;
    const bw = Math.max(2, Math.min(24, band - 2));
    const every = Math.ceil(34 / band);
    const peak = buckets.reduce((a, b) => (val(b) > val(a) ? b : a), buckets[0]);

    const ticks = [0, .25, .5, .75, 1].map(f => f * top);
    const bars = buckets.map((b, i) => {
      const cx = m.l + band * (i + .5), x = cx - bw / 2, yt = y(val(b)), h = m.t + ph - yt;
      const r = Math.min(4, h, bw / 2);
      const bar = h > 0 ? `<path class="bar" data-i="${i}" d="M${x},${m.t + ph}V${yt + r}a${r},${r} 0 0 1 ${r},${-r}H${x + bw - r}a${r},${r} 0 0 1 ${r},${r}V${m.t + ph}Z"/>` : '';
      return `<rect class="hit" data-i="${i}" x="${m.l + band * i}" y="${m.t}" width="${band}" height="${ph}"/>${bar}`;
    }).join('');
    const xLabels = buckets.map((b, i) => (i % every ? '' :
      `<text class="axis" x="${m.l + band * (i + .5)}" y="${H - 6}" text-anchor="middle">${esc(b.tick)}</text>`)).join('');
    const peakX = m.l + band * (buckets.indexOf(peak) + .5);
    const peakLabel = val(peak) ? `<text class="axis" x="${Math.min(Math.max(peakX, m.l + 24), W - 24)}" y="${y(val(peak)) - 6}" text-anchor="middle" font-weight="700">${fmt(val(peak))}${value === 'n' ? ' trx' : ''}</text>` : '';

    el.innerHTML = `<svg role="img" aria-label="${esc(label)}">
      ${ticks.map(t => `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/>
        <text class="axis" x="${m.l - 8}" y="${y(t) + 4}" text-anchor="end">${t ? fmt(t) : '0'}</text>`).join('')}
      ${bars}${xLabels}${peakLabel}
    </svg>${buckets.some(val) ? '' : '<div class="empty-chart">Belum ada penjualan di periode ini.</div>'}
    <div class="chart-tip" hidden></div>`;

    const svg = el.querySelector('svg'), tip = el.querySelector('.chart-tip');
    const show = i => {
      const b = buckets[i];
      el.querySelectorAll('.bar.on').forEach(n => n.classList.remove('on'));
      el.querySelector(`.bar[data-i="${i}"]`)?.classList.add('on');
      tip.innerHTML = `<span>${esc(b.long)}</span><b>Rp ${rp(b.amount)}</b><span>${b.n} transaksi</span>`;
      tip.style.left = Math.min(Math.max(m.l + band * (i + .5), 70), W - 70) + 'px';
      tip.style.top = Math.min(y(val(b)), m.t + ph - 4) + 'px';
      tip.hidden = false;
    };
    svg.addEventListener('pointerover', e => { const i = e.target.dataset?.i; if (i != null) show(Number(i)); });
    svg.addEventListener('pointerleave', () => { tip.hidden = true; el.querySelectorAll('.bar.on').forEach(n => n.classList.remove('on')); });
  }
  let resizeRaf;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => { if (currentTab === 'laporan') Object.keys(charts).forEach(drawBarChart); });
  });

  // ---------------------------------------------------------------- Pengaturan (pemilik)
  $('settingsBtn').addEventListener('click', () => openTab('pengaturan'));
  const num = v => { const n = parseFloat(String(v ?? '').replace(/\./g, '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
  const dec = n => Number(n).toLocaleString('id-ID', { maximumFractionDigits: 4 });
  function saveFile(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function renderSettings() { renderStaff(); renderLog(); }

  // ---- Catatan aktivitas (pemilik)
  let logDays = 7;
  $('logSeg').addEventListener('click', e => {
    const b = e.target.closest('[data-days]'); if (!b) return;
    logDays = Number(b.dataset.days); setSeg($('logSeg'), b.dataset.days); renderLog();
  });
  const payTxt = m => m === 'qris' ? 'QRIS' : 'Tunai';
  function logText(x) {
    const d = x.detail || {}, a = d.sebelum || {}, b = d.sesudah || {};
    const chg = (label, k, f = v => v) => a[k] !== b[k] ? `${label} ${esc(f(a[k]))} → ${esc(f(b[k]))}` : '';
    switch (x.action) {
      case 'batal_nota': return ['Batalkan nota ' + x.ref, `Rp ${rp(d.total)} · ${payTxt(d.pay_method)}${d.customer ? ' · ' + esc(d.customer) : ''} · alasan: ${esc(d.alasan || '-')}`];
      case 'ubah_nota': return ['Ubah nota ' + x.ref, [chg('nomor', 'nota'), chg('total', 'total', v => 'Rp ' + rp(v)), chg('bayar', 'pay_method', payTxt),
        chg('pembeli', 'customer')].filter(Boolean).join(' · ') || 'isi/jadwal pesanan'];
      case 'hapus_nota': return ['Hapus nota ' + x.ref, `Rp ${rp(d.total)} · ${payTxt(d.pay_method)}${d.customer_name ? ' · ' + esc(d.customer_name) : ''} · ${
        esc((d.order_items || []).map(i => `${i.name} ×${i.qty}`).join(', '))}${d.status === 'batal' ? ' (sudah batal)' : ''}`];
      case 'stok': return ['Stok ' + esc(x.ref), `${d.delta > 0 ? '+' : ''}${d.delta} · ${esc(d.note || '')}`];
      case 'produk': return [d.baru ? 'Produk baru' : 'Ubah produk', d.baru ? `${esc(x.ref)} · Rp ${rp(d.price)}`
        : [chg('nama', 'name'), chg('harga', 'price', v => 'Rp ' + rp(v)), a.active !== b.active ? (b.active ? 'ditampilkan' : 'disembunyikan') : ''].filter(Boolean).join(' · ') || esc(x.ref)];
      case 'ubah_kas': return ['Ubah kas ' + dmy(parseYmd(x.ref)), [chg('uang awal', 'opening', v => 'Rp ' + rp(v)), chg('dihitung', 'counted', v => v == null ? '-' : 'Rp ' + rp(v)),
        chg('catatan', 'note'), b.ditutup === false ? 'kas dibuka ulang' : ''].filter(Boolean).join(' · ')];
      case 'hapus_kas': return ['Hapus kas ' + dmy(parseYmd(x.ref)), `uang awal Rp ${rp(d.opening)}${d.counted != null ? ` · dihitung Rp ${rp(d.counted)}` : ''}`];
      case 'kas_keluar': return [(d.hapus ? 'Hapus kas keluar ' : 'Ubah kas keluar ') + dmy(parseYmd(x.ref)),
        d.hapus ? `Rp ${rp(d.amount)} · ${esc(d.note || '')} · dicatat oleh ${esc((d.by || '').split('@')[0])}` : `Rp ${rp(d.sebelum)} → Rp ${rp(d.sesudah)} · ${esc(d.note || '')}`];
      default: return [esc(x.action), esc(JSON.stringify(d))];
    }
  }
  async function renderLog() {
    let list;
    try { list = await DB.listActivity(new Date(Date.now() - logDays * 864e5).toISOString()); }
    catch (e) { $('logTable').innerHTML = `<tbody><tr><td class="error">${esc(e.message)}</td></tr></tbody>`; return; }
    $('logTable').innerHTML = `<thead><tr><th>Waktu</th><th>Oleh</th><th>Kegiatan</th><th>Keterangan</th></tr></thead><tbody>
      ${list.length ? list.map(x => { const t = new Date(x.at), [what, info] = logText(x); return `<tr class="log-${esc(x.action)}">
        <td data-sort="${esc(x.at)}">${pad(t.getDate())}/${pad(t.getMonth() + 1)} ${pad(t.getHours())}.${pad(t.getMinutes())}</td>
        <td>${esc((x.actor || '').split('@')[0])}</td><td><b>${what}</b></td><td>${info}</td></tr>`; }).join('')
        : '<tr><td class="empty" colspan="4">Tidak ada aktivitas di periode ini.</td></tr>'}</tbody>`;
  }

  // ---- Staf
  const roleSelect = r => `<select data-f="role" aria-label="Peran">
    <option value="kasir"${r === 'kasir' ? ' selected' : ''}>Kasir</option>
    <option value="pemilik"${r === 'pemilik' ? ' selected' : ''}>Pemilik</option></select>`;
  // Per tab: [wewenang membuka tab, judul, keterangan, { pilihan di dalam tab }]
  const PERM_TABS = [
    ['pesanan', 'Tab Pesanan', 'Lihat pesanan & riwayat transaksi, tandai selesai, cetak ulang, ingatkan via WA',
      { batal: 'Batalkan pesanan', ubah_nota: 'Ubah nota (termasuk nomor nota)', hapus_nota: 'Hapus nota' }],
    ['kas', 'Tab Kas', 'Lihat kas hari ini & riwayat kas',
      { kas_buka: 'Isi / ubah uang awal', kas_tutup: 'Tutup kasir (hitung uang di laci)', kas_keluar: 'Catat kas keluar',
        kas_ubah: 'Ubah kas yang sudah ditutup, hitung ulang, mulai ulang kas', kas_hapus: 'Hapus riwayat kas & kas keluar' }],
    ['pembelian', 'Tab Produksi', 'Lihat pembelian bahan, hasil produksi & sisa bahan',
      { pembelian_catat: 'Catat & ubah pembelian/produksi', pembelian_hapus: 'Hapus catatan' }],
    ['stok', 'Tab Stok', 'Lihat stok & kartu stok',
      { stok_masuk: 'Tambah stok masuk', stok_pindah: 'Pindah stok toko ↔ rumah', stok_kurang: 'Kurangi stok (koreksi)', opname: 'Stok opname',
        produk_tambah: 'Tambah produk baru', produk_ubah: 'Ubah produk, harga & sembunyikan produk' }],
    ['laporan', 'Tab Laporan', 'Lihat penjualan, grafik, jam ramai, produk terlaris',
      { laporan_unduh: 'Unduh Excel (CSV)', laba: 'Lihat laba (penjualan − bahan terpakai)' }],
    ['kontak', 'Tab Kontak', 'Lihat daftar pembeli, WhatsApp, pesan baru', { kontak_ubah: 'Ubah kontak', kontak_hapus: 'Hapus kontak' }],

  ];
  // Contoh pengaturan (bisa diubah lagi sebelum disimpan)
  const PERM_PRESETS = {
    kasir: { label: 'Kasir biasa', desc: 'Melayani pembeli, buka & tutup kas. Tidak bisa batal/ubah/hapus nota, kurangi stok, atau melihat omzet.',
      reason: true, cashmax: 100000,
      perms: { pesanan: 1, kas: 1, kas_buka: 1, kas_tutup: 1, kas_keluar: 1, stok: 1, stok_pindah: 1, kontak: 1 } },
    kepala: { label: 'Kepala toko', desc: 'Seperti kasir, ditambah batal & ubah nota, stok masuk & opname, produksi, laporan, ubah kontak.',
      reason: true, cashmax: 0,
      perms: { pesanan: 1, batal: 1, ubah_nota: 1, kas: 1, kas_buka: 1, kas_tutup: 1, kas_keluar: 1, pembelian: 1, pembelian_catat: 1,
               stok: 1, stok_masuk: 1, stok_pindah: 1, opname: 1, laporan: 1, kontak: 1, kontak_ubah: 1 } },
    produksi: { label: 'Bagian produksi', desc: 'Hanya mencatat pembelian bahan & hasil produksi, dan melihat stok.',
      reason: true, cashmax: 0,
      perms: { pembelian: 1, pembelian_catat: 1, stok: 1, stok_pindah: 1 } },
  };
  const permRaw = (st, k) => typeof st.perms?.[k] === 'boolean' ? st.perms[k] : DB.permDefaults[k];
  const permOf = (st, k) => permRaw(st, k) && permRaw(st, DB.permParent[k] || k);
  let staffList = [];
  async function renderStaff() {
    let list;
    try { list = staffList = await DB.listStaff(); } catch (e) { $('staffTable').innerHTML = `<tbody><tr><td class="error">${esc(e.message)}</td></tr></tbody>`; return; }
    $('staffTable').innerHTML = `<thead><tr><th>Email</th><th>Nama</th><th>Peran</th><th></th></tr></thead><tbody>
      ${list.map(st => `<tr data-email="${esc(st.email)}">
        <td>${esc(st.email)}</td>
        <td><input data-f="name" value="${esc(st.name || '')}" aria-label="Nama"></td>
        <td>${roleSelect(st.role)}
          <div class="muted perm-sum">${st.role === 'pemilik' ? 'Semua wewenang'
            : `${Object.keys(DB.permDefaults).filter(k => permOf(st, k)).length} dari ${Object.keys(DB.permDefaults).length} wewenang${st.cash_out_max ? ` · kas keluar maks ${rp(st.cash_out_max)}` : ''}`}</div></td>
        <td><div class="add-stock"><button class="ghost small" data-staffsave>Simpan</button>
          ${st.role === 'pemilik' ? '' : '<button class="ghost small" data-staffperm>Wewenang</button>'}
          <button class="ghost small" data-staffpw>Password</button>
          <button class="ghost small danger" data-staffdel>Hapus</button></div></td>
      </tr>`).join('')}
      <tr class="new-row">
        <td><input data-f="email" type="email" placeholder="email@gmail.com" aria-label="Email staf baru"></td>
        <td><input data-f="name" placeholder="Nama" aria-label="Nama staf baru"></td>
        <td>${roleSelect('kasir')}</td>
        <td><button class="primary small" data-staffadd>Tambah staf</button></td>
      </tr></tbody>`;
  }
  // Tab tidak dicentang → pilihan di dalamnya mati
  $('staffTable').addEventListener('input', e => {
    if (e.target.dataset.opt === 'cashmax') { const v = toInt(e.target.value); e.target.value = v ? rp(v) : ''; }
  });
  $('staffTable').addEventListener('change', e => {
    const fs = e.target.closest('[data-tabperm]');
    if (!fs || e.target.dataset.perm !== fs.dataset.tabperm) return;
    setTabPerm(fs, e.target.checked, true);
  });
  // Tab boleh/tidak → pilihan di dalamnya aktif/mati (clear: kosongkan centang pilihan saat tab dimatikan)
  function setTabPerm(fs, on, clear) {
    fs.querySelectorAll('.sub input').forEach(i => { i.disabled = !on; if (!on && clear && i.dataset.perm) i.checked = false; });
    fs.classList.toggle('off', !on);
  }
  $('staffTable').addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    const row = b.closest('tr'), f = k => row.querySelector(`[data-f="${k}"]`)?.value.trim() || '';
    try {
      if ('staffpw' in b.dataset) {
        $('staffTable').querySelector('.pw-row')?.remove();
        row.insertAdjacentHTML('afterend', `<tr class="pw-row" data-email="${esc(row.dataset.email)}"><td colspan="4">
          <div class="pw-form"><b>Password baru untuk ${esc(row.dataset.email)}</b>
            <input type="password" data-f="pw1" autocomplete="new-password" placeholder="Password baru (min. 6 karakter)" aria-label="Password baru">
            <input type="password" data-f="pw2" autocomplete="new-password" placeholder="Ulangi password baru" aria-label="Ulangi password baru">
            <div class="actions"><button class="primary small" data-pwsave>Simpan password</button><button class="ghost small" data-pwcancel>Batal</button></div>
          </div></td></tr>`);
        row.nextElementSibling.querySelector('input').focus();
        return;
      }
      if ('pwcancel' in b.dataset) return row.remove();
      if ('staffperm' in b.dataset) {
        $('staffTable').querySelector('.perm-row')?.remove();
        const st = staffList.find(x => x.email === row.dataset.email);
        row.insertAdjacentHTML('afterend', `<tr class="perm-row" data-email="${esc(st.email)}"><td colspan="4">
          <div class="perm-edit"><b>Wewenang ${esc(st.name || st.email)}</b>
            <p class="muted hint">Centang tab yang boleh dibuka, lalu pilih apa saja yang boleh dilakukan di tab itu. Yang tidak dicentang disembunyikan dari akun ini.</p>
            <div class="perm-presets"><span class="muted">Contoh pengaturan:</span>
              ${Object.entries(PERM_PRESETS).map(([k, pr]) => `<button class="ghost small" data-preset="${k}" title="${esc(pr.desc)}">${pr.label}</button>`).join('')}</div>
            <div class="perm-groups">
              <fieldset><legend>Tab Kasir</legend><p class="muted perm-always">Selalu boleh: transaksi, cetak struk, kirim nota WA.</p></fieldset>
              ${PERM_TABS.map(([tab, title, desc, items]) => `<fieldset data-tabperm="${tab}">
                <legend><label class="check"><input type="checkbox" data-perm="${tab}"${permRaw(st, tab) ? ' checked' : ''}> ${title}</label></legend>
                <p class="muted perm-desc">${desc}</p>
                ${Object.entries(items).map(([k, label]) => `<label class="check sub"><input type="checkbox" data-perm="${k}"${permOf(st, k) ? ' checked' : ''}${permRaw(st, tab) ? '' : ' disabled'}> ${label}</label>
                  ${k === 'batal' ? `<label class="check sub opt"><input type="checkbox" data-opt="reason"${st.cancel_reason_required ?? true ? ' checked' : ''}${permRaw(st, tab) ? '' : ' disabled'}> Wajib isi alasan saat membatalkan</label>` : ''}
                  ${k === 'kas_keluar' ? `<label class="sub opt cashmax">Batas per catatan (Rp)
                    <input data-opt="cashmax" inputmode="numeric" value="${st.cash_out_max ? rp(st.cash_out_max) : ''}" placeholder="tanpa batas"${permRaw(st, tab) ? '' : ' disabled'}></label>` : ''}`).join('')}
              </fieldset>`).join('')}
            </div>
            <p class="muted perm-note">Semua pembatalan, ubah/hapus nota, pengurangan stok, perubahan produk & harga, serta perubahan kas lama tercatat di <b>Catatan aktivitas</b> (bawah halaman ini).</p>
            <div class="actions"><button class="primary small" data-permsave>Simpan wewenang</button><button class="ghost small" data-permcancel>Batal</button></div>
          </div></td></tr>`);
        return;
      }
      if ('permcancel' in b.dataset) return row.remove();
      if (b.dataset.preset) {
        const pr = PERM_PRESETS[b.dataset.preset];
        row.querySelectorAll('[data-perm]').forEach(i => { i.checked = !!pr.perms[i.dataset.perm]; });
        row.querySelector('[data-opt="reason"]').checked = pr.reason;
        row.querySelector('[data-opt="cashmax"]').value = pr.cashmax ? rp(pr.cashmax) : '';
        row.querySelectorAll('[data-tabperm]').forEach(fs => setTabPerm(fs, fs.querySelector(`[data-perm="${fs.dataset.tabperm}"]`).checked, false));
        return toast(`Contoh "${pr.label}" dipasang. Periksa lalu tekan Simpan wewenang.`);
      }
      if ('permsave' in b.dataset) {
        const p = Object.fromEntries([...row.querySelectorAll('[data-perm]')].map(i => [i.dataset.perm, i.checked]));
        const o = { cancel_reason_required: row.querySelector('[data-opt="reason"]').checked,
                    cash_out_max: toInt(row.querySelector('[data-opt="cashmax"]').value) };
        b.disabled = true;
        try { await DB.setStaffPerms(row.dataset.email, p, o); } finally { b.disabled = false; }
        toast(`Wewenang ${row.dataset.email} disimpan. Berlaku setelah akun itu memuat ulang halaman.`);
        return renderStaff();
      }
      if ('pwsave' in b.dataset) {
        const pw = row.querySelector('[data-f="pw1"]').value;
        if (pw.length < 6) return toast('Password minimal 6 karakter', true);
        if (pw !== row.querySelector('[data-f="pw2"]').value) return toast('Kedua password tidak sama', true);
        b.disabled = true;
        try { await DB.setStaffPassword(row.dataset.email, pw); }
        finally { b.disabled = false; }
        row.remove();
        return toast(DB.demo ? 'Mode contoh: password tidak benar-benar diubah' : `Password ${row.dataset.email} diubah`);
      }
      if ('staffadd' in b.dataset) {
        if (!f('email')) return toast('Isi email staf', true);
        await DB.saveStaff(f('email'), f('name'), f('role')); toast(`Staf ${f('email')} ditambahkan`);
      } else if ('staffsave' in b.dataset) {
        await DB.saveStaff(row.dataset.email, f('name'), f('role')); toast('Staf disimpan');
      } else if ('staffdel' in b.dataset) {
        if (!confirm(`Hapus ${row.dataset.email} dari daftar staf? Akun ini tidak bisa memakai kasir lagi.`)) return;
        await DB.deleteStaff(row.dataset.email); toast('Staf dihapus');
      }
      renderStaff();
    } catch (err) { toast(err.message, true); }
  });

  // ---- Cadangan
  async function downloadBackup() {
    $('backupBtn').disabled = true;
    try {
      const data = await DB.backup();
      const json = JSON.stringify({ aplikasi: 'Kasir Lunpia Amoy', dibuat: new Date().toISOString(), data }, null, 1);
      saveFile(new Blob([json], { type: 'application/json' }), `AMOY ${ymdLocal(new Date()).replace(/-/g, ' ')}.json`);
      await DB.markBackup().catch(() => {});
      toast('Cadangan data diunduh. Simpan file ini di laptop atau Google Drive.');
      refreshNotices();
    } catch (err) { toast(err.message, true); }
    finally { $('backupBtn').disabled = false; }
  }
  $('backupBtn').addEventListener('click', downloadBackup);
  $('restoreBtn').addEventListener('click', () => $('restoreFile').click());
  $('restoreFile').addEventListener('change', async () => {
    const file = $('restoreFile').files[0]; $('restoreFile').value = '';
    if (!file) return;
    let data;
    try { const j = JSON.parse(await file.text()); data = j.data ?? j; }
    catch { return toast('File ini bukan file cadangan (.json) yang benar', true); }
    if (!data || !Array.isArray(data.orders) || !Array.isArray(data.products)) return toast('File ini bukan cadangan Kasir Lunpia Amoy', true);
    if (!confirm(DB.demo
      ? `Pulihkan cadangan "${file.name}"? Data contoh sekarang DIGANTI dengan isi file.`
      : `Pulihkan cadangan "${file.name}" (${data.orders.length} nota, ${data.products.length} produk)?\n\nData yang tidak ada di kasir akan ditambahkan kembali. Data yang sekarang ada tidak diubah dan tidak dihapus.`)) return;
    $('restoreBtn').disabled = true;
    try {
      const r = await DB.restore(data) || {};
      const names = { nota: 'nota', produk: 'produk', riwayat_stok: 'riwayat stok', kas_harian: 'kas harian', kas_keluar: 'kas keluar', produksi: 'catatan produksi' };
      const added = Object.entries(names).filter(([k]) => r[k]).map(([k, n]) => `${r[k]} ${n}`);
      toast(added.length ? `Dipulihkan: ${added.join(', ')}` : 'Tidak ada data yang perlu dipulihkan, semua sudah ada');
      await loadProducts(); refreshPendingCount();
    } catch (err) { toast(err.message, true); }
    finally { $('restoreBtn').disabled = false; }
  });

  // Ganti hari saat aplikasi tetap terbuka (mis. ditinggal semalaman): tanggal di Kas, "Hari ini" di
  // Laporan, dan pengingat ikut pindah ke hari baru. Dicek tiap menit dan saat aplikasi dibuka lagi.
  let shownDay = ymdLocal(new Date());
  function checkNewDay() {
    const d = ymdLocal(new Date());
    if (d === shownDay) return;
    shownDay = d;
    const key = $('rangeSeg').querySelector('[aria-checked="true"]')?.dataset.range;
    if (key) range = rangeFor(key);   // rentang tanggal pilihan sendiri tidak diubah
    const pkey = $('prodRangeSeg').querySelector('[aria-checked="true"]')?.dataset.range;
    if (pkey) prodRange = rangeFor(pkey);
    recount = editOpening = false;
    if (role) { openTab(currentTab); refreshNotices(); }
  }
  setInterval(checkNewDay, 60000);

  // ---------------------------------------------------------------- Online / offline & versi baru
  // Status koneksi: dari browser (online/offline) dan cek ke server tiap 30 detik.
  // Begitu tersambung lagi, data tab yang terbuka diambil ulang.
  let online = true;
  function setOnline(on) {
    if (on === online) return;
    online = on;
    $('netStatus').classList.toggle('off', !on);
    $('netStatus').querySelector('em').textContent = on ? 'Online' : 'Offline';
    $('offlineBar').hidden = on;
    if (on && role) { toast('Tersambung lagi'); refreshAll(false); }
  }
  async function checkOnline() { setOnline(navigator.onLine && await DB.ping()); }
  window.addEventListener('online', checkOnline);
  window.addEventListener('offline', () => setOnline(false));
  setInterval(checkOnline, 30000);

  // Versi aplikasi: nomor ?v= di index.html. Kalau di server sudah lebih baru, tampilkan tombol perbarui.
  const APP_VERSION = Number((document.querySelector('script[src*="app.js"]')?.getAttribute('src') || '').match(/v=(\d+)/)?.[1] || 0);
  async function checkVersion() {
    try {
      const html = await (await fetch('./?cek=' + Date.now(), { cache: 'no-store' })).text();
      const v = Number(html.match(/app\.js\?v=(\d+)/)?.[1] || 0);
      $('updateBar').hidden = !(v > APP_VERSION);
      return v > APP_VERSION;
    } catch { return false; }
  }
  setInterval(checkVersion, 5 * 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { checkVersion(); checkOnline(); } });
  async function applyUpdate() {
    $('updateBtn').disabled = true;
    try {
      const regs = await navigator.serviceWorker?.getRegistrations?.() || [];
      await Promise.all(regs.map(r => r.update().catch(() => {})));
      if (window.caches) await Promise.all((await caches.keys()).map(k => caches.delete(k)));
    } catch {}
    location.reload();
  }
  $('updateBtn').addEventListener('click', applyUpdate);

  // Sinkron otomatis antar perangkat: perubahan dari kasir lain (transaksi, stok, kas, produksi)
  // langsung diambil ulang. Tampilan yang sedang diisi (formulir, konfirmasi) tidak diganggu.
  let stopSync = null, syncTimer = null;
  const changed = new Set();
  function startSync() {
    stopSync?.();
    stopSync = DB.subscribe(table => {
      changed.add(table);
      clearTimeout(syncTimer); syncTimer = setTimeout(applyRemoteChanges, 800);
    }, status => { const live = status === 'SUBSCRIBED'; $('netStatus').classList.toggle('live', live); $('netStatus').title = live ? 'Online · sinkron otomatis antar perangkat aktif' : 'Status koneksi'; });
  }
  const busy = id => { const v = $(id); return !!v && (v.querySelector('.confirm, .perm-row, .pw-row, .cash-edit') ||
    (v.contains(document.activeElement) && document.activeElement.matches('input, textarea, select'))); };
  async function applyRemoteChanges() {
    const t = new Set(changed); changed.clear();
    if (!role) return;
    const has = (...xs) => xs.some(x => t.has(x));
    if (has('orders', 'products')) { await loadProducts(); refreshPendingCount(); }
    if (currentTab === 'pesanan' && has('orders') && !busy('view-pesanan')) renderOrders();
    if (currentTab === 'kas' && has('orders', 'cash_days', 'cash_out')) { refreshCashFigures(true); if (!busy('view-kas')) renderCashHistory(); }
    if (currentTab === 'laporan' && has('orders', 'productions')) renderReport();
    if (currentTab === 'pembelian' && has('orders', 'productions') && $('prodForm').hidden) renderProduction();
    if (currentTab === 'kontak' && has('orders') && !busy('view-kontak')) renderContacts();
  }

  // Tombol Segarkan: ambil ulang semua data (produk, pesanan, pengingat, tab yang terbuka) dan cek versi
  async function refreshAll(showToast = true) {
    if (!role) return;
    $('syncBtn').disabled = true;
    try {
      await checkOnline();
      if (!online) return toast('Offline: data belum bisa diambil dari server', true);
      perms = await DB.myPerms(role).catch(() => perms); applyPerms();
      opts = await DB.myOptions().catch(() => opts);
      await loadProducts(); refreshPendingCount();
      openTab(currentTab);
      const newer = await checkVersion();
      if (showToast) toast(newer ? 'Data diperbarui · ada versi aplikasi baru, tekan "Perbarui sekarang"' : 'Data sudah yang terbaru');
    } finally { $('syncBtn').disabled = false; }
  }
  $('syncBtn').addEventListener('click', () => refreshAll(true));
  checkVersion();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkNewDay(); });
  window.addEventListener('focus', checkNewDay);

  boot();
})();
