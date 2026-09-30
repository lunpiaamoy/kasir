// Lapisan data. Dua versi dengan fungsi yang sama:
//  - Supabase (online, dipakai bersama banyak perangkat)
//  - Contoh (tersimpan di browser ini saja, untuk mencoba tanpa Supabase)
(() => {
  const cfg = window.APP_CONFIG;
  const isDemo = !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY;

  // Fungsi/tabel/kolom belum ada di database → 002_pembaruan.sql belum dijalankan
  const NOT_UPDATED = ['PGRST202', 'PGRST205', '42P01', '42703', '42883'];
  function fail(error) {
    if (!error) return;
    if (NOT_UPDATED.includes(error.code))
      throw new Error('Database belum diperbarui. Jalankan file supabase/002_pembaruan.sql di Supabase (SQL Editor → Run).');
    throw new Error(error.message || String(error));
  }

  // Kartu stok: gabungan riwayat stok manual dan transaksi sejak `fromIso`.
  // Transaksi batal: keluar saat dibuat, masuk kembali saat dibatalkan. Pembatalan lama
  // (sebelum waktu batal dicatat) tidak ditampilkan sama sekali karena efeknya nol.
  function cardEvents(moves, orderRows, fromIso) {
    const from = new Date(fromIso);
    const ev = moves.map(m => ({ at: m.created_at, delta: m.delta, note: m.note, by: m.created_by }));
    orderRows.forEach(o => {
      if (new Date(o.created_at) >= from) ev.push({ at: o.created_at, delta: -o.qty, order: o, by: o.cashier });
      if (o.status === 'batal' && o.cancelled_at && new Date(o.cancelled_at) >= from)
        ev.push({ at: o.cancelled_at, delta: o.qty, order: o, cancel: true });
    });
    return ev;
  }

  // ------------------------------------------------------------------ Supabase
  function supabaseDb() {
    const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    // Supabase membatasi 1000 baris per permintaan; ambil per halaman sampai habis.
    const all = async build => {
      const rows = [];
      for (let i = 0; ; i += 1000) {
        const { data, error } = await build().range(i, i + 999);
        fail(error); rows.push(...data);
        if (data.length < 1000) return rows;
      }
    };
    return {
      demo: false,
      async session() { const { data } = await sb.auth.getSession(); return data.session; },
      // Callback dijalankan lewat setTimeout: memanggil Supabase langsung di dalam
      // onAuthStateChange bisa membuat supabase-js macet (deadlock) saat login/refresh.
      onAuth(cb) { sb.auth.onAuthStateChange((_e, s) => { setTimeout(() => cb(s), 0); }); },
      async signIn(email, password) {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (!error) return;
        if (error.message === 'Invalid login credentials') throw new Error('Email atau password salah.');
        if (error.message === 'Email not confirmed') throw new Error('Email belum dikonfirmasi. Centang "Auto Confirm User" atau konfirmasi user di Supabase.');
        throw new Error('Gagal masuk: ' + error.message);
      },
      async signOut() { await sb.auth.signOut(); },
      // 'pemilik', 'kasir', atau null kalau email belum terdaftar sebagai staf.
      // Kalau 002_pembaruan.sql belum dijalankan, my_role belum ada: pakai is_staff (semua staf
      // dianggap pemilik, seperti sebelumnya) dan tandai needsUpdate supaya aplikasi memberi tahu.
      needsUpdate: false,
      async myRole() {
        const { data, error } = await sb.rpc('my_role');
        if (!error) return data || null;
        if (error.code !== 'PGRST202') fail(error);
        this.needsUpdate = true;
        const r = await sb.rpc('is_staff'); fail(r.error);
        return r.data === true ? 'pemilik' : null;
      },

      async listProducts() {
        const { data, error } = await sb.from('products').select('*').order('sort').order('id');
        fail(error); return data;
      },
      async saveProduct(p) {
        const row = { category: p.category, name: p.name, price: p.price, min_stock: p.min_stock, active: p.active, sort: p.sort };
        const q = p.id ? sb.from('products').update(row).eq('id', p.id) : sb.from('products').insert({ ...row, stock: 0 });
        const { error } = await q; fail(error);
      },
      async addStock(id, delta, note) {
        const { error } = await sb.rpc('add_stock', { p_product: id, p_delta: delta, p_note: note }); fail(error);
      },
      // [{ product_id, counted }] → jumlah produk yang stoknya disesuaikan
      async stockOpname(list) { const { data, error } = await sb.rpc('stock_opname', { p: list }); fail(error); return data; },

      async createOrder(payload) {
        const { data, error } = await sb.rpc('create_order', { p: payload }); fail(error); return data;
      },
      async listOrders(fromIso, toIso) {
        return all(() => sb.from('orders').select('*, order_items(*)')
          .gte('created_at', fromIso).lt('created_at', toIso)
          .order('created_at', { ascending: false }).order('id', { ascending: false }));
      },
      async listPending() {
        const { data, error } = await sb.from('orders').select('*, order_items(*)').eq('status', 'menunggu')
          .order('fulfill_date', { ascending: true, nullsFirst: false }).order('fulfill_time', { ascending: true });
        fail(error); return data;
      },
      async recentOrders(limit = 30) {
        const { data, error } = await sb.from('orders').select('*, order_items(*)')
          .order('created_at', { ascending: false }).limit(limit);
        fail(error); return data;
      },
      async updateOrder(id, payload) {
        const { data, error } = await sb.rpc('update_order', { p_id: id, p: payload }); fail(error); return data;
      },
      // Semua pembeli yang pernah dicatat (untuk daftar kontak)
      async listCustomers() {
        return all(() => sb.from('orders').select('id, customer_name, customer_wa, total, status, created_at').order('id'));
      },
      async markDone(id) {
        const { error } = await sb.rpc('mark_done', { p_id: id });
        if (error?.code === 'PGRST202') {   // database belum diperbarui: cara lama
          const r = await sb.from('orders').update({ status: 'selesai' }).eq('id', id); fail(r.error); return;
        }
        fail(error);
      },
      async cancelOrder(id) { const { error } = await sb.rpc('cancel_order', { p_id: id }); fail(error); },
      // Stok dikembalikan dan nota dihapus dalam satu transaksi database (khusus pemilik)
      async deleteOrder(id) { const { error } = await sb.rpc('delete_order', { p_id: id }); fail(error); },

      async stockCard(productId, fromIso) {
        const cols = 'id, qty, orders!inner(created_at, cancelled_at, status, year, seq, customer_name, cashier)';
        const [moves, sold, cancelled] = await Promise.all([
          all(() => sb.from('stock_moves').select('id, delta, note, created_by, created_at')
            .eq('product_id', productId).gte('created_at', fromIso).order('id')),
          all(() => sb.from('order_items').select(cols)
            .eq('product_id', productId).gte('orders.created_at', fromIso).neq('orders.status', 'batal').order('id')),
          all(() => sb.from('order_items').select(cols)
            .eq('product_id', productId).eq('orders.status', 'batal').gte('orders.cancelled_at', fromIso).order('id')),
        ]);
        return cardEvents(moves, [...sold, ...cancelled].map(i => ({ ...i.orders, qty: i.qty })), fromIso);
      },

      // Kas harian (tanggal = 'YYYY-MM-DD')
      async getCashDay(day) {
        const { data, error } = await sb.from('cash_days').select('*').eq('day', day).maybeSingle(); fail(error); return data;
      },
      async listCashDays(fromDay) {
        const { data, error } = await sb.from('cash_days').select('*').gte('day', fromDay).order('day', { ascending: false });
        fail(error); return data;
      },
      // Rincian pecahan (opening_detail/counted_detail) butuh 003_pecahan_kas.sql. Kalau kolomnya
      // belum ada (PGRST204), simpan totalnya saja supaya kas tetap bisa dibuka/ditutup.
      async openCash(day, opening, opening_detail = null) {
        const run = row => sb.from('cash_days').upsert(row, { onConflict: 'day' });
        let { error } = await run({ day, opening, opening_detail });
        if (error?.code === 'PGRST204') ({ error } = await run({ day, opening }));
        fail(error);
      },
      async closeCash(day, f) {
        const { data: s } = await sb.auth.getSession();
        const run = row => sb.from('cash_days')
          .update({ ...row, closed_at: new Date().toISOString(), closed_by: s.session?.user?.email })
          .eq('day', day).select();
        let { data, error } = await run(f);
        if (error?.code === 'PGRST204') { const { counted_detail, ...rest } = f; ({ data, error } = await run(rest)); }
        fail(error);
        if (!data.length) throw new Error('Kas ini sudah ditutup. Hanya pemilik yang bisa mengubahnya.');
      },
    };
  }

  // ------------------------------------------------------------------ Contoh
  function demoDb() {
    const KEY = 'lunpiaPosDemo';
    const seed = () => ({
      nextId: 100,
      products: [
        { id: 1, category: 'Lunpia Basah', name: 'Ayam', price: 25000, stock: 30, min_stock: 5, active: true, sort: 10 },
        { id: 2, category: 'Lunpia Basah', name: 'Udang', price: 25000, stock: 24, min_stock: 5, active: true, sort: 20 },
        { id: 3, category: 'Lunpia Goreng', name: 'Udang Ayam', price: 26000, stock: 40, min_stock: 5, active: true, sort: 30 },
        { id: 4, category: 'Lunpia Frozen', name: 'Udang Ayam isi 5', price: 150000, stock: 2, min_stock: 3, active: true, sort: 40 },
        { id: 5, category: 'Ngoyang', name: 'Ayam', price: 20000, stock: 12, min_stock: 5, active: true, sort: 50 },
      ],
      orders: [],
    });
    let mem = null;
    const load = () => {
      if (mem) return mem;
      try { mem = JSON.parse(localStorage.getItem(KEY)); } catch { mem = null; }
      return (mem = mem || seed());
    };
    const save = () => { try { localStorage.setItem(KEY, JSON.stringify(mem)); } catch {} };
    const clone = x => JSON.parse(JSON.stringify(x));
    const jakartaYear = () => Number(new Intl.DateTimeFormat('en', { year: 'numeric', timeZone: 'Asia/Jakarta' }).format(new Date()));
    let signedIn = true;
    let authCb = () => {};

    return {
      demo: true,
      async session() { return signedIn ? { user: { email: 'contoh@lunpia.local' } } : null; },
      onAuth(cb) { authCb = cb; },
      async signIn() { signedIn = true; authCb({ user: { email: 'contoh@lunpia.local' } }); },
      async signOut() { signedIn = false; },
      // Mode contoh selalu pemilik (untuk mencoba tampilan kasir: localStorage lunpiaPosDemoRole = 'kasir')
      async myRole() { try { return localStorage.getItem('lunpiaPosDemoRole') || 'pemilik'; } catch { return 'pemilik'; } },

      async listProducts() { return clone(load().products).sort((a, b) => a.sort - b.sort || a.id - b.id); },
      async saveProduct(p) {
        const db = load();
        if (p.id) Object.assign(db.products.find(x => x.id === p.id), p);
        else db.products.push({ ...p, id: db.nextId++, stock: 0 });
        save();
      },
      async addStock(id, delta, note = '') {
        const db = load();
        db.products.find(x => x.id === id).stock += delta;
        (db.moves ||= []).push({ product_id: id, delta, note, created_by: 'contoh@lunpia.local', created_at: new Date().toISOString() });
        save();
      },
      async stockOpname(list) {
        const db = load(); let n = 0;
        list.forEach(({ product_id, counted }) => {
          const p = db.products.find(x => x.id === product_id);
          if (!p || counted === p.stock) return;
          (db.moves ||= []).push({ product_id, delta: counted - p.stock, note: `Stok opname · sistem ${p.stock}, fisik ${counted}`,
            created_by: 'contoh@lunpia.local', created_at: new Date().toISOString() });
          p.stock = counted; n++;
        });
        save(); return n;
      },

      async createOrder(p) {
        const db = load();
        if (!p.items.length) throw new Error('Keranjang masih kosong');
        const items = p.items.map(it => {
          const prod = db.products.find(x => x.id === it.product_id);
          if (!prod) throw new Error('Produk tidak ditemukan');
          return { product_id: prod.id, category: prod.category, name: prod.name, qty: it.qty, price: prod.price, subtotal: prod.price * it.qty };
        });
        const total = items.reduce((s, i) => s + i.subtotal, 0);
        const paid = p.pay_method === 'qris' ? total : Number(p.paid) || 0;
        if (paid < total) throw new Error('Uang yang dibayar kurang dari total');
        const year = jakartaYear();
        db.counters ||= {};
        const seq = db.counters[year] = Math.max(db.counters[year] || 0,
          db.orders.filter(o => o.year === year).reduce((m, o) => Math.max(m, o.seq), 0)) + 1;
        const ful = p.fulfillment || 'langsung';
        const order = {
          id: db.nextId++, year, seq, created_at: new Date().toISOString(),
          customer_name: p.customer_name || '', customer_wa: p.customer_wa || '',
          fulfillment: ful, fulfill_date: p.fulfill_date || null, fulfill_time: p.fulfill_time || null,
          ongkir: ful === 'kirim' ? Number(p.ongkir) || 0 : 0,
          total, pay_method: p.pay_method, paid, change: paid - total,
          status: ful === 'langsung' ? 'selesai' : 'menunggu',
          note: p.note || '', cancelled_at: null, cashier: 'contoh@lunpia.local',
          order_items: items,
        };
        items.forEach(i => { db.products.find(x => x.id === i.product_id).stock -= i.qty; });
        db.orders.push(order); save();
        return clone(order);
      },
      async updateOrder(id, p) {
        const db = load(); const o = db.orders.find(x => x.id === id);
        if (!o) throw new Error('Nota tidak ditemukan');
        if (o.status === 'batal') throw new Error('Nota yang sudah dibatalkan tidak bisa diubah');
        if (!p.items.length) throw new Error('Keranjang masih kosong');
        const oldPrice = new Map(o.order_items.map(i => [i.product_id, i.price]));
        const items = p.items.map(it => {
          const prod = db.products.find(x => x.id === it.product_id);
          if (!prod) throw new Error('Produk tidak ditemukan');
          const price = oldPrice.get(prod.id) ?? prod.price;
          return { product_id: prod.id, category: prod.category, name: prod.name, qty: it.qty, price, subtotal: price * it.qty };
        });
        const total = items.reduce((s, i) => s + i.subtotal, 0);
        const paid = p.pay_method === 'qris' ? total : Number(p.paid) || 0;
        if (paid < total) throw new Error('Uang yang dibayar kurang dari total');
        o.order_items.forEach(i => { const pr = db.products.find(x => x.id === i.product_id); if (pr) pr.stock += i.qty; });
        items.forEach(i => { db.products.find(x => x.id === i.product_id).stock -= i.qty; });
        const ful = p.fulfillment || 'langsung';
        Object.assign(o, {
          customer_name: p.customer_name || '', customer_wa: p.customer_wa || '',
          fulfillment: ful, fulfill_date: p.fulfill_date || null, fulfill_time: p.fulfill_time || null,
          ongkir: ful === 'kirim' ? Number(p.ongkir) || 0 : 0,
          total, pay_method: p.pay_method, paid, change: paid - total, note: p.note || '',
          status: ful === 'langsung' ? 'selesai' : o.fulfillment === 'langsung' ? 'menunggu' : o.status,
          edited_at: new Date().toISOString(), order_items: items,
        });
        save(); return clone(o);
      },
      async listOrders(fromIso, toIso) {
        return clone(load().orders.filter(o => o.created_at >= fromIso && o.created_at < toIso).reverse());
      },
      async listPending() {
        return clone(load().orders.filter(o => o.status === 'menunggu'))
          .sort((a, b) => (a.fulfill_date || '9').localeCompare(b.fulfill_date || '9') || (a.fulfill_time || '').localeCompare(b.fulfill_time || ''));
      },
      async recentOrders(limit = 30) { return clone(load().orders.slice(-limit).reverse()); },
      async listCustomers() {
        return load().orders.map(({ id, customer_name, customer_wa, total, status, created_at }) => ({ id, customer_name, customer_wa, total, status, created_at }));
      },
      async markDone(id) { const o = load().orders.find(x => x.id === id); if (o?.status === 'menunggu') o.status = 'selesai'; save(); },
      async cancelOrder(id) {
        const db = load(); const o = db.orders.find(x => x.id === id);
        if (o && o.status !== 'batal') {
          o.order_items.forEach(i => { const pr = db.products.find(x => x.id === i.product_id); if (pr) pr.stock += i.qty; });
          o.status = 'batal'; o.cancelled_at = new Date().toISOString(); save();
        }
      },
      async deleteOrder(id) {
        await this.cancelOrder(id);
        const db = load(); db.orders = db.orders.filter(o => o.id !== id); save();
      },
      async stockCard(productId, fromIso) {
        const db = load(), from = new Date(fromIso);
        const rows = db.orders
          .filter(o => new Date(o.created_at) >= from || (o.cancelled_at && new Date(o.cancelled_at) >= from))
          .flatMap(o => o.order_items.filter(i => i.product_id === productId).map(i => ({ ...o, qty: i.qty })));
        return cardEvents((db.moves || []).filter(m => m.product_id === productId && new Date(m.created_at) >= from), rows, fromIso);
      },

      async getCashDay(day) { return clone((load().cash || {})[day] || null); },
      async listCashDays(fromDay) {
        return clone(Object.values(load().cash || {}).filter(c => c.day >= fromDay).sort((a, b) => b.day.localeCompare(a.day)));
      },
      async openCash(day, opening, opening_detail = null) {
        const db = load(); db.cash ||= {};
        db.cash[day] = { ...(db.cash[day] || { day, opened_by: 'contoh@lunpia.local', opened_at: new Date().toISOString() }), opening, opening_detail };
        save();
      },
      async closeCash(day, f) {
        const db = load(); if (!db.cash?.[day]) throw new Error('Isi uang awal dulu');
        Object.assign(db.cash[day], f, { closed_at: new Date().toISOString(), closed_by: 'contoh@lunpia.local' }); save();
      },
      resetDemo() { mem = seed(); save(); },
    };
  }

  window.DB = isDemo ? demoDb() : supabaseDb();
})();
