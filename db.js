// Lapisan data. Dua versi dengan fungsi yang sama:
//  - Supabase (online, dipakai bersama banyak perangkat)
//  - Contoh (tersimpan di browser ini saja, untuk mencoba tanpa Supabase)
(() => {
  const cfg = window.APP_CONFIG;
  const isDemo = !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY;

  function fail(error) {
    if (error) throw new Error(error.message || String(error));
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
      async isStaff() { const { data, error } = await sb.rpc('is_staff'); fail(error); return data === true; },

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
      async setStatus(id, status) { const { error } = await sb.from('orders').update({ status }).eq('id', id); fail(error); },
      async cancelOrder(id) { const { error } = await sb.rpc('cancel_order', { p_id: id }); fail(error); },
      // Hapus permanen: stok dikembalikan dulu (cancel_order tidak berbuat apa-apa kalau sudah batal)
      async deleteOrder(id) {
        await this.cancelOrder(id);
        const { error } = await sb.from('orders').delete().eq('id', id); fail(error);
      },

      // Kartu stok: semua perubahan stok satu produk sejak fromIso sampai sekarang.
      // Transaksi batal tidak ikut karena stoknya sudah dikembalikan.
      async stockCard(productId, fromIso) {
        const [moves, sold] = await Promise.all([
          all(() => sb.from('stock_moves').select('id, delta, note, created_by, created_at')
            .eq('product_id', productId).gte('created_at', fromIso).order('id')),
          all(() => sb.from('order_items').select('id, qty, orders!inner(created_at, status, year, seq, customer_name, cashier)')
            .eq('product_id', productId).gte('orders.created_at', fromIso).neq('orders.status', 'batal').order('id')),
        ]);
        return [
          ...moves.map(m => ({ at: m.created_at, delta: m.delta, note: m.note, by: m.created_by })),
          ...sold.map(i => ({ at: i.orders.created_at, delta: -i.qty, order: i.orders, by: i.orders.cashier })),
        ];
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
      async isStaff() { return true; },

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
        const seq = db.orders.filter(o => o.year === year).reduce((m, o) => Math.max(m, o.seq), 0) + 1;
        const ful = p.fulfillment || 'langsung';
        const order = {
          id: db.nextId++, year, seq, created_at: new Date().toISOString(),
          customer_name: p.customer_name || '', customer_wa: p.customer_wa || '',
          fulfillment: ful, fulfill_date: p.fulfill_date || null, fulfill_time: p.fulfill_time || null,
          ongkir: ful === 'kirim' ? Number(p.ongkir) || 0 : 0,
          total, pay_method: p.pay_method, paid, change: paid - total,
          status: ful === 'langsung' ? 'selesai' : 'menunggu',
          order_items: items,
        };
        items.forEach(i => { db.products.find(x => x.id === i.product_id).stock -= i.qty; });
        db.orders.push(order); save();
        return clone(order);
      },
      async listOrders(fromIso, toIso) {
        return clone(load().orders.filter(o => o.created_at >= fromIso && o.created_at < toIso).reverse());
      },
      async listPending() {
        return clone(load().orders.filter(o => o.status === 'menunggu'))
          .sort((a, b) => (a.fulfill_date || '9').localeCompare(b.fulfill_date || '9') || (a.fulfill_time || '').localeCompare(b.fulfill_time || ''));
      },
      async recentOrders(limit = 30) { return clone(load().orders.slice(-limit).reverse()); },
      async setStatus(id, status) { load().orders.find(o => o.id === id).status = status; save(); },
      async cancelOrder(id) {
        const db = load(); const o = db.orders.find(x => x.id === id);
        if (o && o.status !== 'batal') {
          o.order_items.forEach(i => { const pr = db.products.find(x => x.id === i.product_id); if (pr) pr.stock += i.qty; });
          o.status = 'batal'; save();
        }
      },
      async deleteOrder(id) {
        await this.cancelOrder(id);
        const db = load(); db.orders = db.orders.filter(o => o.id !== id); save();
      },
      async stockCard(productId, fromIso) {
        const db = load();
        return [
          ...(db.moves || []).filter(m => m.product_id === productId && m.created_at >= fromIso)
            .map(m => ({ at: m.created_at, delta: m.delta, note: m.note, by: m.created_by })),
          ...db.orders.filter(o => o.status !== 'batal' && o.created_at >= fromIso).flatMap(o =>
            o.order_items.filter(i => i.product_id === productId)
              .map(i => ({ at: o.created_at, delta: -i.qty, order: o, by: 'contoh@lunpia.local' }))),
        ];
      },
      resetDemo() { mem = seed(); save(); },
    };
  }

  window.DB = isDemo ? demoDb() : supabaseDb();
})();
