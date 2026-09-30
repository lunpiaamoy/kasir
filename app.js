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

  // ---------------------------------------------------------------- State
  let products = [];
  const cart = new Map();          // product_id -> qty
  let currentTab = 'kasir';

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
      if (!(await DB.isStaff())) {
        $('catalog').innerHTML = `<div class="empty-state">Akun <b>${esc(session.user?.email)}</b> belum terdaftar sebagai staf. Minta pemilik toko menambahkan email ini di tabel <b>staff</b> di Supabase.</div>`;
        return;
      }
      await loadProducts();
      refreshPendingCount();
    } catch (e) { toast(e.message, true); }
  }

  $('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    $('loginError').textContent = ''; $('loginBtn').disabled = true;
    try { await DB.signIn($('loginEmail').value.trim(), $('loginPassword').value); }
    catch (err) { $('loginError').textContent = err.message; }
    finally { $('loginBtn').disabled = false; }
  });
  $('logoutBtn').addEventListener('click', async () => { await DB.signOut(); appShown = false; showLogin(); });
  $('resetDemoBtn').addEventListener('click', async () => { DB.resetDemo(); cart.clear(); await loadProducts(); refreshPendingCount(); toast('Data contoh dikosongkan'); });

  // ---------------------------------------------------------------- Tabs
  document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => openTab(btn.dataset.tab)));
  function openTab(name) {
    currentTab = name;
    document.querySelectorAll('.tab').forEach(b => b.toggleAttribute('aria-current', b.dataset.tab === name));
    document.querySelectorAll('.tab[aria-current]').forEach(b => b.setAttribute('aria-current', 'page'));
    document.querySelectorAll('.view').forEach(v => (v.hidden = v.id !== 'view-' + name));
    if (name === 'kasir') loadProducts();
    if (name === 'pesanan') renderOrders();
    if (name === 'stok') loadProducts();
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
  const cartTotal = () => [...cart].reduce((s, [id, q]) => s + (byId(id)?.price || 0) * q, 0);

  function renderCart() {
    for (const id of [...cart.keys()]) if (!byId(id)) cart.delete(id);
    if (!cart.size) {
      $('cartItems').innerHTML = `<div class="cart-empty">Ketuk produk di sebelah untuk menambahkan.</div>`;
    } else {
      $('cartItems').innerHTML = [...cart].map(([id, q]) => {
        const p = byId(id);
        const short = q > p.stock ? `<span class="l-warn">Stok tinggal ${Math.max(p.stock, 0)}</span>` : '';
        return `<div class="line">
          <div class="l-name">${esc(p.name)}<small>${esc(p.category)} · ${rp(p.price)}</small>${short}</div>
          <div class="stepper">
            <button type="button" data-dec="${id}" aria-label="Kurangi">−</button>
            <input value="${q}" inputmode="numeric" data-qty="${id}" aria-label="Jumlah ${esc(p.name)}">
            <button type="button" data-inc="${id}" aria-label="Tambah">+</button>
          </div>
          <div class="l-sub">${rp(p.price * q)}</div>
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
    setSeg($('fulfillSeg'), b.dataset.val);
    const v = b.dataset.val;
    $('fulfillFields').hidden = v === 'langsung';
    $('ongkirField').hidden = v !== 'kirim';
    if (v !== 'langsung' && !$('fDate').value) $('fDate').value = ymdLocal(new Date());
  });

  // Pembayaran
  $('paySeg').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    setSeg($('paySeg'), b.dataset.val);
    $('cashFields').hidden = b.dataset.val !== 'tunai';
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

  function resetCart() {
    cart.clear();
    ['custName', 'custWa', 'fDate', 'fTime', 'ongkir', 'paid'].forEach(id => ($(id).value = ''));
    setSeg($('fulfillSeg'), 'langsung'); $('fulfillFields').hidden = true; $('ongkirField').hidden = true;
    setSeg($('paySeg'), 'tunai'); $('cashFields').hidden = false;
    $('cartError').textContent = '';
    renderCatalog(); renderCart();
  }

  $('saveBtn').addEventListener('click', async () => {
    const err = m => ($('cartError').textContent = m);
    err('');
    const total = cartTotal();
    const ful = segValue($('fulfillSeg')), pay = segValue($('paySeg'));
    if (!cart.size) return err('Keranjang masih kosong.');
    if (ful !== 'langsung') {
      if (!$('custName').value.trim()) return err('Isi nama pembeli untuk pesanan ambil/kirim.');
      if (!$('fDate').value || !$('fTime').value) return err('Isi tanggal dan pukul ' + (ful === 'kirim' ? 'kirim.' : 'ambil.'));
    }
    if (pay === 'tunai' && toInt($('paid').value) < total) return err('Uang diterima kurang dari total.');

    const payload = {
      items: [...cart].map(([product_id, qty]) => ({ product_id, qty })),
      customer_name: $('custName').value.trim(),
      customer_wa: $('custWa').value.trim(),
      fulfillment: ful,
      fulfill_date: ful === 'langsung' ? '' : $('fDate').value,
      fulfill_time: ful === 'langsung' ? '' : $('fTime').value,
      ongkir: ful === 'kirim' ? toInt($('ongkir').value) : 0,
      pay_method: pay,
      paid: pay === 'tunai' ? toInt($('paid').value) : total,
    };
    $('saveBtn').disabled = true;
    try {
      const order = await DB.createOrder(payload);
      resetCart();
      await loadProducts();
      refreshPendingCount();
      showReceipt(order, true);
      toast(`Tersimpan · Nota ${notaNo(order)}`);
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
    const fulRows = o.fulfillment === 'langsung' ? '' : `<div class="r-rule"></div>` + kv([
      [o.fulfillment === 'kirim' ? 'KIRIM' : 'AMBIL', o.fulfill_date ? dmy(parseYmd(o.fulfill_date)) : '-'],
      ['PUKUL', hhmm(o.fulfill_time) || '-'],
      ...(o.fulfillment === 'kirim' ? [['ONGKIR', rp(o.ongkir)]] : []),
    ]);
    return `
      <img src="logo.jpg" alt="">
      <div class="r-c r-store">${esc(STORE.address)}<br>${esc(STORE.phone)}</div>
      <div class="r-rule"></div>
      ${kv([['NAMA', esc(o.customer_name.toUpperCase() || '-')], ['WA', esc(o.customer_wa || '-')]])}
      <div class="r-rule"></div>
      <table class="items">
        <thead><tr><th>PRODUK</th><th>JML</th><th>HARGA</th><th>SUB</th></tr></thead>
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
      <div class="r-rule"></div>
      ${kv([['NO', notaNo(o)], ['TANGGAL', dmy(created)]])}
      ${fulRows}
      ${o.status === 'batal' ? '<div class="r-rule"></div><div class="r-c"><b>*** DIBATALKAN ***</b></div>' : ''}
    `;
  }

  async function doPrint() {
    const img = $('receipt').querySelector('img');
    if (img && !img.complete) await new Promise(r => { img.onload = img.onerror = r; });
    window.print();
  }
  function showReceipt(order, autoPrint = false) {
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
              <div class="order-who">${esc(o.customer_name || '-')} ${o.customer_wa ? `· <a href="https://wa.me/${esc(o.customer_wa.replace(/\D/g, '').replace(/^0/, '62'))}" target="_blank" rel="noopener">${esc(o.customer_wa)}</a>` : ''}</div>
              <div class="order-items">${esc(itemsSummary(o))}</div>
              <div class="order-total"><span>${o.pay_method === 'qris' ? 'QRIS' : 'Tunai'} · Nota ${notaNo(o)}</span><span>${rp(o.total)}</span></div>
              ${o.fulfillment === 'kirim' ? `<div class="muted">Ongkir ${rp(o.ongkir)}</div>` : ''}
              <div class="actions" data-actions>
                <button class="primary small" data-done="${o.id}">Tandai selesai</button>
                <button class="ghost small" data-reprint="${o.id}">Cetak ulang</button>
                <button class="ghost small danger" data-cancel="${o.id}">Batalkan</button>
                <button class="ghost small danger" data-del="${o.id}">Hapus</button>
              </div>
            </article>`;
          }).join('')}</div>
        </div>`;
      }).join('');
    }

    const statusChip = s => s === 'batal' ? '<span class="chip bad">Batal</span>' : s === 'menunggu' ? '<span class="chip warn">Menunggu</span>' : '<span class="chip ok">Selesai</span>';
    $('recentTable').innerHTML = `
      <thead><tr><th>Nota</th><th>Waktu</th><th>Pembeli</th><th>Jenis</th><th>Bayar</th><th class="num">Total</th><th>Status</th><th></th></tr></thead>
      <tbody>${recent.length ? recent.map(o => {
        const d = new Date(o.created_at);
        return `<tr class="${o.status === 'batal' ? 'dim' : ''}">
          <td class="num">${notaNo(o)}</td>
          <td>${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}.${pad(d.getMinutes())}</td>
          <td>${esc(o.customer_name || '-')}</td>
          <td>${FUL_LABEL[o.fulfillment]}</td>
          <td>${o.pay_method === 'qris' ? 'QRIS' : 'Tunai'}</td>
          <td class="num">${rp(o.total)}</td>
          <td>${statusChip(o.status)}</td>
          <td><div class="add-stock" data-actions>
            <button class="ghost small" data-reprint="${o.id}">Cetak ulang</button>
            <button class="ghost small danger" data-del="${o.id}">Hapus</button>
          </div></td>
        </tr>`;
      }).join('') : '<tr><td class="empty" colspan="8">Belum ada transaksi.</td></tr>'}</tbody>`;
  }

  $('view-pesanan').addEventListener('click', async e => {
    const t = e.target.closest('button'); if (!t) return;
    const d = t.dataset;
    try {
      if (d.reprint) showReceipt(orderCache.get(Number(d.reprint)));
      else if (d.done) { await DB.setStatus(Number(d.done), 'selesai'); toast('Pesanan ditandai selesai'); renderOrders(); }
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
      <thead><tr><th>Jenis</th><th>Produk</th><th class="num">Harga</th><th class="num">Stok</th><th>Status</th><th>Tambah stok</th><th></th></tr></thead>
      <tbody>${products.length ? products.map(p => `
        <tr class="${p.active ? '' : 'dim'}">
          <td>${esc(p.category)}</td>
          <td><b>${esc(p.name)}</b>${p.active ? '' : ' <span class="chip plain">Disembunyikan</span>'}</td>
          <td class="num">${rp(p.price)}</td>
          <td class="num stock-num">${p.stock}</td>
          <td>${stockChip(p)} <span class="muted">min ${p.min_stock}</span></td>
          <td><div class="add-stock">
            <input inputmode="numeric" placeholder="0" id="add-${p.id}" aria-label="Tambah stok ${esc(p.name)}">
            <button class="ghost small" data-addstock="${p.id}">Tambah</button>
          </div></td>
          <td><div class="add-stock">
            <button class="ghost small" data-card="${p.id}">Kartu stok</button>
            <button class="ghost small" data-edit="${p.id}">Ubah</button>
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
      try { await DB.addStock(id, n, n > 0 ? 'Tambah stok' : 'Koreksi stok'); toast(`Stok ${byId(id).name} ${n > 0 ? '+' : ''}${n}`); loadProducts(); }
      catch (err) { toast(err.message, true); }
    }
    if (t.dataset.edit) openProductForm(byId(Number(t.dataset.edit)));
    if (t.dataset.card) openStockCard(byId(Number(t.dataset.card)));
  });
  $('stockTable').addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.id?.startsWith('add-')) e.target.nextElementSibling.click();
  });

  function openProductForm(p) {
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
      ? `Terjual · Nota ${notaNo(m.order)}${m.order.customer_name ? ' · ' + esc(m.order.customer_name) : ''}`
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
      <tbody>${rows.length ? rows.map(b => `<tr><td>${esc(b.long)}</td><td class="num">${b.n}</td><td class="num">${rp(b.amount)}</td></tr>`).join('')
        : '<tr><td class="empty" colspan="3">—</td></tr>'}</tbody>`;
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
