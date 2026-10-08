// Lapisan data. Dua versi dengan fungsi yang sama:
//  - Supabase (online, dipakai bersama banyak perangkat)
//  - Contoh (tersimpan di browser ini saja, untuk mencoba tanpa Supabase)
(() => {
  const cfg = window.APP_CONFIG;
  const isDemo = !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY;

  // Fungsi/tabel/kolom belum ada di database → file SQL pembaruan belum dijalankan
  const NOT_UPDATED = ['PGRST202', 'PGRST205', '42P01', '42703', '42883'];
  const UPDATE_MSG = 'Database belum diperbarui. Pembaruan terpasang otomatis beberapa menit setelah merge: tunggu sebentar lalu tekan ↻. Kalau tetap muncul, buka GitHub → Actions → Pembaruan database untuk melihat sebabnya.';
  const DENIED_MSG = 'Akun ini tidak punya wewenang untuk ini. Minta pemilik mengaturnya di Pengaturan → Staf → Wewenang.';
  // Wewenang kasir per tab dan bawaannya (sama dengan perm_defaults()/perm_parent() di 008).
  // Pilihan di dalam tab hanya berlaku kalau tabnya boleh. Pemilik selalu boleh semua.
  const PERM_DEFAULTS = {
    pesanan: true, batal: true, ubah_nota: false, hapus_nota: false,
    stok: true, stok_masuk: true, stok_pindah: true, stok_kurang: false, opname: false, produk_tambah: false, produk_ubah: false,
    kas: true, kas_buka: true, kas_tutup: true, kas_keluar: true, kas_ubah: false, kas_hapus: false, laci: true,
    laporan: false, laporan_unduh: false,
    pembelian: false, pembelian_catat: false, pembelian_hapus: false, laba: false,
    kontak: false, kontak_ubah: false, kontak_hapus: false };
  const PERM_PARENT = {};
  [['pesanan', 'batal ubah_nota hapus_nota'], ['stok', 'stok_masuk stok_pindah stok_kurang opname produk_tambah produk_ubah'],
   ['kas', 'kas_buka kas_tutup kas_keluar kas_ubah kas_hapus laci'], ['laporan', 'laporan_unduh laba'],
   ['pembelian', 'pembelian_catat pembelian_hapus'], ['kontak', 'kontak_ubah kontak_hapus']]
    .forEach(([tab, keys]) => keys.split(' ').forEach(k => (PERM_PARENT[k] = tab)));
  const permsFor = (role, perms) => {
    const on = k => typeof perms?.[k] === 'boolean' ? perms[k] : PERM_DEFAULTS[k];
    return Object.fromEntries(Object.keys(PERM_DEFAULTS).map(k => [k, role === 'pemilik' || (on(k) && on(PERM_PARENT[k] || k))]));
  };
  function fail(error) {
    if (!error) return;
    // Sertakan apa yang belum ada (nama fungsi/tabel/kolom) supaya tahu file SQL mana yang perlu dijalankan
    if (NOT_UPDATED.includes(error.code)) throw new Error(`${UPDATE_MSG} (Yang belum ada: ${String(error.message || error.code).slice(0, 160)})`);
    if (error.code === '42501') throw new Error(DENIED_MSG);
    if (/Failed to fetch|NetworkError|Load failed|network/i.test(error.message || ''))
      throw new Error('Tidak tersambung ke server (offline). Periksa internet, lalu coba lagi.');
    throw new Error(error.message || String(error));
  }

  // Kartu stok: gabungan riwayat stok manual dan transaksi sejak `fromIso`.
  // Transaksi batal: keluar saat dibuat, masuk kembali saat dibatalkan. Pembatalan lama
  // (sebelum waktu batal dicatat) tidak ditampilkan sama sekali karena efeknya nol.
  function cardEvents(moves, orderRows, fromIso) {
    const from = new Date(fromIso);
    const ev = moves.map(m => ({ at: m.created_at, delta: m.delta, home: m.home_delta || 0, note: m.note, by: m.created_by }));
    orderRows.forEach(o => {
      if (new Date(o.created_at) >= from) ev.push({ at: o.created_at, delta: -o.qty, order: o, by: o.cashier });
      if (o.status === 'batal' && o.cancelled_at && new Date(o.cancelled_at) >= from)
        ev.push({ at: o.cancelled_at, delta: o.qty, order: o, cancel: true });
    });
    return ev;
  }

  // ------------------------------------------------------------------ Supabase
  function supabaseDb() {
    // "Ingat saya": sesi login disimpan di localStorage (tetap masuk setelah browser ditutup)
    // atau sessionStorage (keluar otomatis saat browser/tab ditutup).
    const remember = () => { try { return localStorage.getItem('lunpiaRemember') !== '0'; } catch { return true; } };
    const store = () => (remember() ? localStorage : sessionStorage);
    const storage = {
      getItem: k => { try { return store().getItem(k); } catch { return null; } },
      setItem: (k, v) => { try { store().setItem(k, v); } catch {} },
      removeItem: k => { try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch {} },
    };
    const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, { auth: { storage, persistSession: true } });
    // Data nota ikut membawa pembayaran (018). Sebelum 018 terpasang, tanpa pembayaran.
    let hasPayments = true;
    const ORDER_SEL = () => hasPayments ? '*, order_items(*), order_payments(*)' : '*, order_items(*)';
    sb.from('order_payments').select('id').limit(1).then(({ error }) => { if (error) hasPayments = false; });
    const withPay = async fn => {
      try { return await fn(); }
      catch (e) { if (hasPayments && /order_payments/.test(e.message || '')) { hasPayments = false; return fn(); } throw e; }
    };
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
      // Cek koneksi ke server (database) — true kalau server menjawab
      async ping() {
        try {
          const r = await fetch(cfg.SUPABASE_URL + '/rest/v1/', { method: 'HEAD', cache: 'no-store', headers: { apikey: cfg.SUPABASE_ANON_KEY } });
          return r.status < 500;
        } catch { return false; }
      },
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
      permDefaults: PERM_DEFAULTS, permParent: PERM_PARENT,
      // Wewenang akun yang sedang masuk; sebelum 008 dijalankan: sesuai peran seperti dulu
      async myPerms(role) {
        const { data, error } = await sb.rpc('my_perms');
        if (error?.code === 'PGRST202') return permsFor(role, null);
        fail(error); return permsFor(role, data);
      },
      // opts: { cash_out_max (0 = tanpa batas), cancel_reason_required } (011)
      async setStaffPerms(email, perms, opts = {}) {
        const { error } = await sb.rpc('set_staff_perms', { p_email: email, p_perms: perms,
          p_cash_out_max: opts.cash_out_max ?? null, p_cancel_reason_required: opts.cancel_reason_required ?? null });
        fail(error);
      },
      async myOptions() {
        const { data, error } = await sb.rpc('my_options');
        if (error?.code === 'PGRST202') return { cash_out_max: 0, cancel_reason_required: false };
        fail(error); return data;
      },
      // Catatan aktivitas (pemilik, 011)
      async listActivity(fromIso) {
        const { data, error } = await sb.from('activity_log').select('*').gte('at', fromIso).order('id', { ascending: false }).limit(1000);
        fail(error); return data;
      },
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
      // location: 'toko' atau 'rumah' (013)
      async addStock(id, delta, note, location = 'toko') {
        let { error } = await sb.rpc('add_stock', { p_product: id, p_delta: delta, p_note: note, p_location: location });
        if (error?.code === 'PGRST202' && location === 'toko')   // sebelum 013: tanpa lokasi
          ({ error } = await sb.rpc('add_stock', { p_product: id, p_delta: delta, p_note: note }));
        fail(error);
      },
      // Pindah stok antar tempat; to = 'toko' (dari rumah) atau 'rumah' (dari toko)
      async moveStock(id, qty, to) { const { error } = await sb.rpc('move_stock', { p_product: id, p_qty: qty, p_to: to }); fail(error); },
      // [{ product_id, toko, rumah }] → jumlah produk yang stoknya disesuaikan
      async stockOpname(list) { const { data, error } = await sb.rpc('stock_opname', { p: list }); fail(error); return data; },

      async createOrder(payload) {
        const { data, error } = await sb.rpc('create_order', { p: payload }); fail(error); return data;
      },
      // Buka laci tanpa transaksi (019): dicatat di catatan aktivitas. Sebelum 019: tidak dicatat.
      async logDrawer(note = '') {
        const { error } = await sb.rpc('log_drawer', { p_note: note });
        if (error && !['PGRST202', '42883'].includes(error.code)) fail(error);
      },
      // Pembayaran (018): pelunasan / bayar sisa
      async addPayment(id, method, amount, tendered = null) {
        const { data, error } = await sb.rpc('add_payment', { p_order: id, p_method: method, p_amount: amount, p_tendered: tendered });
        fail(error); return data;
      },
      // Pembayaran di rentang waktu (untuk kas & laporan). null kalau 018 belum terpasang.
      async listPayments(fromIso, toIso) {
        try {
          return await all(() => sb.from('order_payments')
            .select('order_id, at, method, amount, orders!inner(status, fulfillment, ongkir, created_at, pay_method, total)')
            .gte('at', fromIso).lt('at', toIso).order('at'));
        } catch { return null; }
      },
      async listOrders(fromIso, toIso) {
        return withPay(() => all(() => sb.from('orders').select(ORDER_SEL())
          .gte('created_at', fromIso).lt('created_at', toIso)
          .order('created_at', { ascending: false }).order('id', { ascending: false })));
      },
      async listPending() {
        return withPay(async () => {
          const { data, error } = await sb.from('orders').select(ORDER_SEL()).eq('status', 'menunggu')
            .order('fulfill_date', { ascending: true, nullsFirst: false }).order('fulfill_time', { ascending: true });
          fail(error); return data;
        });
      },
      async recentOrders(limit = 30) {
        return withPay(async () => {
          const { data, error } = await sb.from('orders').select(ORDER_SEL())
            .order('created_at', { ascending: false }).limit(limit);
          fail(error); return data;
        });
      },
      async updateOrder(id, payload) {
        const { data, error } = await sb.rpc('update_order', { p_id: id, p: payload }); fail(error); return data;
      },
      // Nomor nota yang terpakai di satu tahun (untuk mencari nomor yang terloncat)
      async notaSeqs(year) {
        return (await all(() => sb.from('orders').select('seq').eq('year', year).order('seq'))).map(r => r.seq);
      },
      // Semua pembeli yang pernah dicatat (untuk daftar kontak)
      async listCustomers() {
        return all(() => sb.from('orders').select('*').order('id'));   // '*': tetap jalan walau kolom address (005) belum ada
      },
      async markDone(id) {
        const { error } = await sb.rpc('mark_done', { p_id: id });
        if (error?.code === 'PGRST202') {   // database belum diperbarui: cara lama
          const r = await sb.from('orders').update({ status: 'selesai' }).eq('id', id); fail(r.error); return;
        }
        fail(error);
      },
      async cancelOrder(id, reason = '') {
        let { error } = await sb.rpc('cancel_order', { p_id: id, p_reason: reason });
        if (error?.code === 'PGRST202') ({ error } = await sb.rpc('cancel_order', { p_id: id }));   // sebelum 011
        fail(error);
      },
      // Stok dikembalikan dan nota dihapus dalam satu transaksi database (khusus pemilik)
      async deleteOrder(id) { const { error } = await sb.rpc('delete_order', { p_id: id }); fail(error); },

      async stockCard(productId, fromIso) {
        const cols = 'id, qty, orders!inner(created_at, cancelled_at, status, year, seq, customer_name, cashier)';
        const [moves, sold, cancelled] = await Promise.all([
          all(() => sb.from('stock_moves').select('*')
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
      // ---- Pengaturan (pemilik, 005) ----
      async listStaff() { const { data, error } = await sb.from('staff').select('*').order('role').order('email'); fail(error); return data; },
      async saveStaff(email, name, role) { const { error } = await sb.rpc('save_staff', { p_email: email, p_name: name, p_role: role }); fail(error); },
      async deleteStaff(email) { const { error } = await sb.rpc('delete_staff', { p_email: email }); fail(error); },
      // Pembelian bahan & hasil produksi (pemilik, 006)
      async listProductions(fromDay, toDay) {
        return all(() => sb.from('productions').select('*').gte('day', fromDay).lte('day', toDay).order('day', { ascending: false }).order('id', { ascending: false }));
      },
      // Lewat fungsi database (007) supaya hasil produksi ikut menambah/mengurangi stok
      async saveProduction(x) { const { error } = await sb.rpc('save_production', { p: x }); fail(error); },
      async deleteProduction(id) { const { error } = await sb.rpc('delete_production', { p_id: id }); fail(error); },
      // Total bahan terpakai di rentang tanggal, untuk laba di Laporan (010)
      async materialUsed(fromDay, toDay) {
        const { data, error } = await sb.rpc('material_used', { p_from: fromDay, p_to: toDay }); fail(error); return Number(data) || 0;
      },
      // Membuat akun login (kalau belum ada) atau mengganti password-nya (014)
      async setStaffPassword(email, password) {
        const { error } = await sb.rpc('set_staff_password', { p_email: email, p_password: password }); fail(error);
      },
      // Email staf yang sudah punya akun login; null = belum bisa dicek (014 belum dijalankan)
      async staffLogins() {
        const { data, error } = await sb.rpc('staff_logins');
        return error ? null : new Set(data.map(e => (typeof e === 'string' ? e : Object.values(e)[0]).toLowerCase()));
      },
      // Pulihkan: data di file yang belum ada di database ditambahkan (006); data yang ada tidak diubah
      async restore(data) {
        const { data: res, error } = await sb.rpc('restore_backup', { d: data }); fail(error); return res;
      },
      // Cadangan: semua tabel yang bisa dibaca pemilik
      // Waktu cadangan terakhir (012). undefined = belum bisa dicek (tabel belum ada)
      async lastBackup() {
        const { data, error } = await sb.from('app_state').select('value, updated_at').eq('key', 'last_backup').maybeSingle();
        if (error) return undefined;
        return data ? data.updated_at : null;
      },
      async markBackup() {
        await sb.from('app_state').upsert({ key: 'last_backup', value: { at: new Date().toISOString() }, updated_at: new Date().toISOString() });
      },
      // Sinkron otomatis: panggil cb(namaTabel) setiap ada perubahan dari perangkat lain (012).
      // Hasil: fungsi untuk berhenti mendengarkan.
      // Siapa yang sedang login (017): tanda "masih aktif" per perangkat
      async heartbeat(device, info) { const { error } = await sb.rpc('heartbeat', { p_device: device, p_info: info }); fail(error); },
      async heartbeatEnd(device) { await sb.rpc('heartbeat_end', { p_device: device }); },
      async onlineDevices() { const { data, error } = await sb.rpc('online_devices'); fail(error); return data || []; },
      subscribe(cb, onStatus = () => {}) {
        const ch = sb.channel('lunpia-sinkron');
        ['orders', 'products', 'cash_days', 'cash_out', 'productions'].forEach(table =>
          ch.on('postgres_changes', { event: '*', schema: 'public', table }, () => cb(table)));
        // pembayaran (DP/pelunasan) memengaruhi pesanan & kas
        if (hasPayments) ch.on('postgres_changes', { event: '*', schema: 'public', table: 'order_payments' }, () => cb('orders'));
        ch.subscribe(status => onStatus(status));
        return () => { sb.removeChannel(ch); };
      },
      async backup() {
        const out = {};
        const tables = { products: '*', orders: ORDER_SEL(), stock_moves: '*', cash_days: '*', cash_out: '*',
          productions: '*', staff: '*', hidden_contacts: '*', activity_log: '*' };
        for (const [t, cols] of Object.entries(tables)) {
          try { out[t] = await all(() => sb.from(t).select(cols)); } catch (e) { out[t] = { error: e.message }; }
        }
        return out;
      },

      // Kas keluar (005): semua staf boleh mencatat, pemilik boleh menghapus
      async listCashOut(day) {
        const { data, error } = await sb.from('cash_out').select('*').eq('day', day).order('id'); fail(error); return data;
      },
      async listCashOutFrom(fromDay) { return all(() => sb.from('cash_out').select('day, amount').gte('day', fromDay).order('id')); },
      async addCashOut(day, amount, note) {
        const { error } = await sb.from('cash_out').insert({ day, amount, note }); fail(error);
      },
      async deleteCashOut(id) {
        const { data, error } = await sb.from('cash_out').delete().eq('id', id).select(); fail(error);
        if (!data.length) throw new Error('Hanya pemilik yang bisa menghapus kas keluar.');
      },
      // Ubah / hapus kas di riwayat (pemilik; hapus butuh 004_ubah_hapus_kas_kontak.sql)
      async updateCashDay(day, f) {
        const { data, error } = await sb.from('cash_days').update(f).eq('day', day).select();
        if (error?.code === '23505') throw new Error('Tanggal itu sudah punya catatan kas. Hapus atau ubah catatan tanggal itu dulu.');
        fail(error);
        if (!data.length) throw new Error('Kas tidak bisa diubah. Hanya pemilik yang bisa mengubah kas yang sudah ditutup.');
      },
      // Tanggal kas diganti: kas keluar hari itu ikut pindah
      async moveCashOut(fromDay, toDay) {
        const { error } = await sb.from('cash_out').update({ day: toDay }).eq('day', fromDay); fail(error);
      },
      async deleteCashDay(day) {
        const { data, error } = await sb.from('cash_days').delete().eq('day', day).select();
        if (error?.code === '42501') throw new Error(UPDATE_MSG);
        fail(error);
        if (!data.length) throw new Error('Kas tidak bisa dihapus. Hanya pemilik yang bisa menghapus kas.');
      },
      // Kontak (pemilik): ubah nama/WA di semua transaksi kontak, atau sembunyikan dari daftar
      async listHiddenContacts() {
        const { data, error } = await sb.from('hidden_contacts').select('key, hidden_at');
        return error ? [] : data;   // tabel belum ada (004 belum dijalankan): tidak ada yang disembunyikan
      },
      async updateContact(key, name, wa) {
        const { data, error } = await sb.rpc('update_contact', { p_key: key, p_name: name, p_wa: wa }); fail(error); return data;
      },
      async hideContact(key) {
        const { error } = await sb.from('hidden_contacts').upsert({ key, hidden_at: new Date().toISOString() }, { onConflict: 'key' });
        if (error?.code === '42501') throw new Error('Hanya pemilik yang bisa menghapus kontak.');
        fail(error);
      },
      // Mulai ulang kas satu hari (pemilik): uang awal, hitungan, catatan, dan status tutup dikosongkan.
      async resetCash(day) {
        const base = { opening: 0, expected: null, counted: null, note: '', closed_at: null, closed_by: null };
        const run = row => sb.from('cash_days').update(row).eq('day', day).select();
        let { data, error } = await run({ ...base, opening_detail: null, counted_detail: null });
        if (error?.code === 'PGRST204') ({ data, error } = await run(base));
        fail(error);
        if (!data.length) throw new Error('Kas tidak bisa dimulai ulang. Hanya pemilik yang bisa melakukannya.');
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
    const dmyStr = d => d.split('-').reverse().join('/');
    const demoProdStock = (db, oldOut, newOut, note, oldHome = false, newHome = false) => {
      const d = new Map(), h = new Map(), add = (m, k, v) => m.set(k, (m.get(k) || 0) + v);
      newOut.forEach(o => { add(d, o.product_id, o.qty); if (newHome) add(h, o.product_id, o.qty); });
      oldOut.forEach(o => { add(d, o.product_id, -o.qty); if (oldHome) add(h, o.product_id, -o.qty); });
      new Set([...d.keys(), ...h.keys()]).forEach(id => {
        const p = db.products.find(x => x.id === id), delta = d.get(id) || 0, hd = h.get(id) || 0; if (!p || (!delta && !hd)) return;
        p.stock += delta; p.stock_home = Math.max(0, (p.stock_home || 0) + hd);
        (db.moves ||= []).push({ product_id: id, delta, home_delta: hd, note, created_by: 'contoh@lunpia.local', created_at: new Date().toISOString() });
      });
    };
    // Catatan aktivitas di mode contoh (meniru pemicu di database, 011)
    const notaLabel = o => `(${o.year}) ${String(o.seq).padStart(5, '0')}`;
    // Sama dengan prepare_payments() di 018
    const preparePayments = (p, due, full) => {
      const n = v => Number(v) || 0;
      if (!Array.isArray(p.payments)) {
        const m = p.pay_method || 'tunai', tendered = m === 'tunai' ? n(p.paid) : due;
        if (tendered < due) throw new Error('Uang yang dibayar kurang dari total');
        return { pays: due > 0 ? [{ method: m, amount: due }] : [], method: m, paid: tendered, change: tendered - due };
      }
      const pays = p.payments.filter(x => n(x.amount) !== 0).map(x => {
        if (!['tunai', 'qris', 'transfer'].includes(x.method) || n(x.amount) < 0) throw new Error('Cara bayar tidak valid');
        return { method: x.method, amount: n(x.amount) };
      });
      const sum = pays.reduce((s, x) => s + x.amount, 0), cash = pays.filter(x => x.method === 'tunai').reduce((s, x) => s + x.amount, 0);
      if (sum > due) throw new Error(`Pembayaran (${sum}) melebihi total yang harus dibayar (${due})`);
      if (full && sum < due) throw new Error('Penjualan langsung harus dibayar lunas');
      const tendered = p.tendered ? n(p.tendered) : cash;
      if (tendered < cash) throw new Error('Uang tunai yang diterima kurang');
      const ms = [...new Set(pays.map(x => x.method))];
      return { pays, method: ms.length > 1 ? 'campuran' : ms[0] || 'belum', paid: sum - cash + tendered, change: tendered - cash };
    };
    const cleanPacking = pk => (Array.isArray(pk) ? pk : []).map(x => ({ size: Number(x.size), count: Number(x.count) }))
      .filter(x => [10, 5, 1].includes(x.size) && x.count >= 1 && x.count <= 999);
    const demoLog = (db, action, ref, detail) =>
      (db.log ||= []).push({ id: db.nextId++, at: new Date().toISOString(), actor: 'contoh@lunpia.local', action, ref, detail });
    let demoDevice = null;
    let signedIn = true;
    let authCb = () => {};
    // HPP per pcs seperti product_cost() di database: dari resep, kalau tidak ada dari HPP manual
    const demoCost = (db, id) => {
      const rows = (db.recipes || []).filter(r => r.product_id === id);
      if (rows.length) return Math.round(rows.reduce((s, r) => s + r.qty * ((db.ingredients || []).find(i => i.id === r.ingredient_id)?.price || 0), 0));
      return db.products.find(p => p.id === id)?.cost ?? null;
    };

    return {
      demo: true,
      async session() { return signedIn ? { user: { email: 'contoh@lunpia.local' } } : null; },
      onAuth(cb) { authCb = cb; },
      async signIn() { signedIn = true; authCb({ user: { email: 'contoh@lunpia.local' } }); },
      async heartbeat(device, info) { demoDevice = { device_id: device, email: 'contoh@lunpia.local', role: 'pemilik', ...info,
        since: demoDevice?.since || new Date().toISOString(), last_seen: new Date().toISOString() }; },
      async heartbeatEnd() { demoDevice = null; },
      async onlineDevices() { return demoDevice ? [{ ...demoDevice, now_at: new Date().toISOString() }] : []; },
      async signOut() { signedIn = false; },
      // Mode contoh selalu pemilik (untuk mencoba tampilan kasir: localStorage lunpiaPosDemoRole = 'kasir')
      async myRole() { try { return localStorage.getItem('lunpiaPosDemoRole') || 'pemilik'; } catch { return 'pemilik'; } },
      async ping() { return navigator.onLine; },
      permDefaults: PERM_DEFAULTS, permParent: PERM_PARENT,
      // Wewenang saat mencoba sebagai kasir diambil dari akun contoh di daftar staf
      async myPerms(role) { return permsFor(role, (load().staff || []).find(x => x.email === 'contoh@lunpia.local')?.perms); },
      async setStaffPerms(email, perms, opts = {}) {
        const st = (load().staff || []).find(x => x.email === email); if (!st) throw new Error('Email ini tidak ada di daftar staf');
        st.perms = permsFor('kasir', perms);
        if (opts.cash_out_max != null) st.cash_out_max = opts.cash_out_max;
        if (opts.cancel_reason_required != null) st.cancel_reason_required = opts.cancel_reason_required;
        save();
      },
      async myOptions() {
        if (await this.myRole() === 'pemilik') return { cash_out_max: 0, cancel_reason_required: false };
        const st = (load().staff || []).find(x => x.email === 'contoh@lunpia.local') || {};
        return { cash_out_max: st.cash_out_max || 0, cancel_reason_required: st.cancel_reason_required ?? true };
      },
      async listActivity(fromIso) { return clone((load().log || []).filter(x => x.at >= fromIso).reverse()); },

      async listProducts() { return clone(load().products).sort((a, b) => a.sort - b.sort || a.id - b.id); },
      async saveProduct(p) {
        const db = load();
        if (p.id) Object.assign(db.products.find(x => x.id === p.id), p);
        else db.products.push({ ...p, id: db.nextId++, stock: 0 });
        save();
      },
      async addStock(id, delta, note = '', location = 'toko') {
        const db = load(), home = location === 'rumah';
        const prod = db.products.find(x => x.id === id);
        if (home && (prod.stock_home || 0) + delta < 0) throw new Error(`Stok di rumah hanya ${prod.stock_home || 0}`);
        prod.stock += delta; if (home) prod.stock_home = (prod.stock_home || 0) + delta;
        if (delta < 0) demoLog(db, 'stok', `${prod.category} ${prod.name}`, { delta, note });
        (db.moves ||= []).push({ product_id: id, delta, home_delta: home ? delta : 0, note: note + (home ? ' (rumah)' : ''),
          created_by: 'contoh@lunpia.local', created_at: new Date().toISOString() });
        save();
      },
      async moveStock(id, qty, to) {
        const db = load(), p = db.products.find(x => x.id === id), home = p.stock_home || 0;
        if (to === 'toko' && home < qty) throw new Error(`Stok di rumah hanya ${home}`);
        if (to === 'rumah' && p.stock - home < qty) throw new Error(`Stok di toko hanya ${Math.max(p.stock - home, 0)}`);
        p.stock_home = home + (to === 'rumah' ? qty : -qty);
        (db.moves ||= []).push({ product_id: id, delta: 0, home_delta: to === 'rumah' ? qty : -qty,
          note: `Pindah ${to === 'toko' ? 'rumah → toko' : 'toko → rumah'} ${qty}`, created_by: 'contoh@lunpia.local', created_at: new Date().toISOString() });
        save();
      },
      async stockOpname(list) {
        const db = load(); let n = 0;
        list.forEach(x => {
          const p = db.products.find(y => y.id === x.product_id); if (!p) return;
          const oldHome = p.stock_home || 0, oldToko = p.stock - oldHome;
          const home = x.rumah ?? (x.counted != null ? Math.min(oldHome, x.counted) : oldHome);
          const total = x.counted ?? ((x.toko ?? oldToko) + home);
          if (total === p.stock && home === oldHome) return;
          (db.moves ||= []).push({ product_id: p.id, delta: total - p.stock, home_delta: home - oldHome,
            note: `Stok opname · toko ${oldToko}→${total - home}, rumah ${oldHome}→${home}`, created_by: 'contoh@lunpia.local', created_at: new Date().toISOString() });
          p.stock = total; p.stock_home = home; n++;
        });
        save(); return n;
      },

      async logDrawer(note = '') { const db = load(); demoLog(db, 'buka_laci', '', { catatan: note }); save(); },
      async addPayment(id, method, amount, tendered = null) {
        const db = load(), o = db.orders.find(x => x.id === id);
        if (!o) throw new Error('Nota tidak ditemukan');
        if (o.status === 'batal') throw new Error('Nota yang dibatalkan tidak bisa dibayar');
        if (!['tunai', 'qris', 'transfer'].includes(method)) throw new Error('Cara bayar tidak valid');
        amount = Number(amount) || 0;
        if (amount <= 0) throw new Error('Isi jumlah pembayaran');
        o.order_payments ||= [];
        const due = o.total - o.order_payments.reduce((s, x) => s + x.amount, 0);
        if (due <= 0) throw new Error('Nota ini sudah lunas');
        if (amount > due) throw new Error(`Pembayaran melebihi sisa (Rp ${due.toLocaleString('id-ID')})`);
        if (method === 'tunai' && (tendered ?? amount) < amount) throw new Error('Uang tunai yang diterima kurang');
        o.order_payments.push({ id: db.nextId++, order_id: id, at: new Date().toISOString(), method, amount, created_by: 'contoh@lunpia.local' });
        o.paid += amount;
        if (method === 'tunai') o.change = (tendered ?? amount) - amount;
        const ms = [...new Set(o.order_payments.map(x => x.method))];
        o.pay_method = ms.length > 1 ? 'campuran' : ms[0] || 'belum';
        demoLog(db, 'bayar_nota', notaLabel(o), { cara: method, jumlah: amount, sisa: due - amount });
        save(); return clone(o);
      },
      async listPayments(fromIso, toIso) {
        return load().orders.flatMap(o => (o.order_payments || (o.total ? [{ at: o.created_at, method: o.pay_method, amount: o.total }] : []))
          .filter(x => x.at >= fromIso && x.at < toIso)
          .map(x => ({ order_id: o.id, at: x.at, method: x.method, amount: x.amount,
            orders: { status: o.status, fulfillment: o.fulfillment, ongkir: o.ongkir, created_at: o.created_at, pay_method: o.pay_method, total: o.total } })));
      },
      async createOrder(p) {
        const db = load();
        if (!p.items.length) throw new Error('Keranjang masih kosong');
        const items = p.items.map(it => {
          const prod = db.products.find(x => x.id === it.product_id);
          if (!prod) throw new Error('Produk tidak ditemukan');
          return { product_id: prod.id, category: prod.category, name: prod.name, qty: it.qty, price: prod.price, subtotal: prod.price * it.qty, cost: demoCost(db, prod.id) };
        });
        const total = items.reduce((s, i) => s + i.subtotal, 0);
        const pp = preparePayments(p, total, (p.fulfillment || 'langsung') === 'langsung');
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
          total, pay_method: pp.method, paid: pp.paid, change: pp.change, packing: cleanPacking(p.packing),
          status: ful === 'langsung' ? 'selesai' : 'menunggu',
          note: p.note || '', cancelled_at: null, cashier: 'contoh@lunpia.local',
          address: ful === 'kirim' ? p.address || '' : '',
          order_items: items,
        };
        order.order_payments = pp.pays.map(x => ({ id: db.nextId++, order_id: order.id, at: order.created_at, ...x, created_by: 'contoh@lunpia.local' }));
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
          return { product_id: prod.id, category: prod.category, name: prod.name, qty: it.qty, price, subtotal: price * it.qty, cost: demoCost(db, prod.id) };
        });
        const total = items.reduce((s, i) => s + i.subtotal, 0);
        const oldPays = o.order_payments || (o.total ? [{ id: db.nextId++, at: o.created_at, method: o.pay_method, amount: o.total }] : []);
        const later = oldPays.filter(x => x.at > o.created_at), laterSum = later.reduce((s, x) => s + x.amount, 0);
        if (laterSum > total) throw new Error('Total baru lebih kecil dari pelunasan yang sudah diterima');
        const pp = preparePayments(p, total - laterSum, (p.fulfillment || 'langsung') === 'langsung' && !laterSum);
        o.order_items.forEach(i => { const pr = db.products.find(x => x.id === i.product_id); if (pr) pr.stock += i.qty; });
        items.forEach(i => { db.products.find(x => x.id === i.product_id).stock -= i.qty; });
        const ful = p.fulfillment || 'langsung';
        const seq = Number(p.seq) || o.seq;
        if (seq !== o.seq && db.orders.some(x => x.year === o.year && x.seq === seq))
          throw new Error(`Nomor nota (${o.year}) ${String(seq).padStart(5, '0')} sudah dipakai`);
        const was = { nota: notaLabel(o), total: o.total, pay_method: o.pay_method, paid: o.paid, customer: o.customer_name };
        o.seq = seq;
        db.counters ||= {}; db.counters[o.year] = db.orders.filter(x => x.year === o.year).reduce((m, x) => Math.max(m, x.seq), 0);
        Object.assign(o, {
          customer_name: p.customer_name || '', customer_wa: p.customer_wa || '',
          fulfillment: ful, fulfill_date: p.fulfill_date || null, fulfill_time: p.fulfill_time || null,
          ongkir: ful === 'kirim' ? Number(p.ongkir) || 0 : 0,
          total, paid: pp.paid + laterSum, change: pp.change, note: p.note || '',
          packing: 'packing' in p ? cleanPacking(p.packing) : (o.packing || []),
          order_payments: [...pp.pays.map(x => ({ id: db.nextId++, order_id: o.id, at: o.created_at, ...x })), ...later],
          address: ful === 'kirim' ? p.address || '' : '',
          status: ful === 'langsung' ? 'selesai' : o.fulfillment === 'langsung' ? 'menunggu' : o.status,
          edited_at: new Date().toISOString(), order_items: items,
        });
        { const ms = [...new Set(o.order_payments.map(x => x.method))]; o.pay_method = ms.length > 1 ? 'campuran' : ms[0] || 'belum'; }
        demoLog(db, 'ubah_nota', notaLabel(o), { sebelum: was,
          sesudah: { nota: notaLabel(o), total: o.total, pay_method: o.pay_method, paid: o.paid, customer: o.customer_name } });
        save(); return clone(o);
      },
      async notaSeqs(year) { return load().orders.filter(o => o.year === year).map(o => o.seq).sort((a, b) => a - b); },
      async listOrders(fromIso, toIso) {
        return clone(load().orders.filter(o => o.created_at >= fromIso && o.created_at < toIso).reverse());
      },
      async listPending() {
        return clone(load().orders.filter(o => o.status === 'menunggu'))
          .sort((a, b) => (a.fulfill_date || '9').localeCompare(b.fulfill_date || '9') || (a.fulfill_time || '').localeCompare(b.fulfill_time || ''));
      },
      async recentOrders(limit = 30) { return clone(load().orders.slice(-limit).reverse()); },
      async listCustomers() {
        return clone(load().orders).map(({ order_items, ...o }) => o);
      },
      async markDone(id) { const o = load().orders.find(x => x.id === id); if (o?.status === 'menunggu') o.status = 'selesai'; save(); },
      async cancelOrder(id, reason = '') {
        const db = load(); const o = db.orders.find(x => x.id === id);
        if (!reason.trim() && (await this.myOptions()).cancel_reason_required) throw new Error('Isi alasan pembatalan');
        if (o && o.status !== 'batal') {
          o.order_items.forEach(i => { const pr = db.products.find(x => x.id === i.product_id); if (pr) pr.stock += i.qty; });
          o.status = 'batal'; o.cancelled_at = new Date().toISOString(); o.cancel_reason = reason.trim();
          demoLog(db, 'batal_nota', notaLabel(o), { total: o.total, pay_method: o.pay_method, customer: o.customer_name, alasan: o.cancel_reason });
          save();
        }
      },
      async deleteOrder(id) {
        const before = clone(load().orders.find(o => o.id === id) || null);
        if (before && before.status !== 'batal') {
          const db = load(), o = db.orders.find(x => x.id === id);
          o.order_items.forEach(i => { const pr = db.products.find(x => x.id === i.product_id); if (pr) pr.stock += i.qty; });
        }
        const db = load(), year = before?.year;
        if (before) demoLog(db, 'hapus_nota', notaLabel(before), before);
        db.orders = db.orders.filter(o => o.id !== id);
        // nota berikutnya melanjutkan dari nomor terakhir yang masih tercatat
        if (year) (db.counters ||= {})[year] = db.orders.filter(o => o.year === year).reduce((m, o) => Math.max(m, o.seq), 0);
        save();
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
      async updateCashDay(day, f) {
        const db = load(), c = db.cash?.[day]; if (!c) return;
        if (f.day && f.day !== day) {
          if (db.cash[f.day]) throw new Error('Tanggal itu sudah punya catatan kas. Hapus atau ubah catatan tanggal itu dulu.');
          delete db.cash[day]; db.cash[f.day] = c;
        }
        Object.assign(c, f); save();
      },
      async moveCashOut(fromDay, toDay) { const db = load(); (db.cashOut || []).forEach(x => { if (x.day === fromDay) x.day = toDay; }); save(); },
      async listCashOut(day) { return clone((load().cashOut || []).filter(x => x.day === day)); },
      async listCashOutFrom(fromDay) { return clone((load().cashOut || []).filter(x => x.day >= fromDay)); },
      async listStaff() { return clone(load().staff ||= [{ email: 'contoh@lunpia.local', name: 'Contoh', role: 'pemilik' }]); },
      async saveStaff(email, name, role) {
        const db = load(), list = db.staff ||= [{ email: 'contoh@lunpia.local', name: 'Contoh', role: 'pemilik' }];
        const e = email.trim().toLowerCase(), cur = list.find(x => x.email === e);
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error('Email tidak valid');
        if (cur?.role === 'pemilik' && role === 'kasir' && list.filter(x => x.role === 'pemilik').length <= 1) throw new Error('Harus ada minimal satu pemilik');
        if (cur) Object.assign(cur, { name: name.trim(), role }); else list.push({ email: e, name: name.trim(), role });
        save();
      },
      async deleteStaff(email) {
        const db = load(), e = email.trim().toLowerCase();
        if (e === 'contoh@lunpia.local') throw new Error('Tidak bisa menghapus akun sendiri');
        db.staff = (db.staff || []).filter(x => x.email !== e); save();
      },
      async materialUsed(fromDay, toDay) {
        return Math.round((load().productions || []).filter(x => x.day >= fromDay && x.day <= toDay).flatMap(x => x.purchases || [])
          .reduce((s, b) => s + (Number(b.qty) > 0 ? Number(b.price) * Math.max(0, Number(b.qty) - Number(b.leftover || 0)) / Number(b.qty) : Number(b.price) || 0), 0));
      },
      async listProductions(fromDay, toDay) {
        return clone((load().productions || []).filter(x => x.day >= fromDay && x.day <= toDay)
          .sort((a, b) => b.day.localeCompare(a.day) || b.id - a.id));
      },
      // Sama dengan save_production/delete_production di database: stok bertambah sebesar selisihnya
      async saveProduction(x) {
        const db = load(), list = db.productions ||= [];
        const row = { day: x.day, purchases: x.purchases, outputs: x.outputs, note: x.note, stocked: x.stocked !== false,
          location: x.location === 'rumah' ? 'rumah' : 'toko' };
        const old = x.id ? list.find(p => p.id === x.id) : null;
        demoProdStock(db, old?.stocked ? old.outputs : [], row.stocked ? row.outputs : [],
          `Produksi ${dmyStr(row.day)}${old ? ' (diubah)' : row.location === 'rumah' ? ' (rumah)' : ''}`, old?.location === 'rumah', row.location === 'rumah');
        if (old) Object.assign(old, row);
        else list.push({ id: db.nextId++, ...row, created_by: 'contoh@lunpia.local', created_at: new Date().toISOString() });
        save();
      },
      async deleteProduction(id) {
        const db = load(), old = (db.productions || []).find(p => p.id === id); if (!old) return;
        if (old.stocked) demoProdStock(db, old.outputs, [], `Produksi ${dmyStr(old.day)} (dihapus)`, old.location === 'rumah', false);
        db.productions = db.productions.filter(p => p.id !== id); save();
      },
      async setStaffPassword(email, password) {
        if (password.length < 6) throw new Error('Password minimal 6 karakter');
        const db = load(); (db.logins ||= ['contoh@lunpia.local']); if (!db.logins.includes(email)) db.logins.push(email); save();
      },
      async staffLogins() { return new Set(load().logins || ['contoh@lunpia.local']); },
      // Mode contoh: cadangan dari mode contoh menggantikan data contoh
      async restore(data) {
        if (!data || !Array.isArray(data.products) || data.nextId == null)
          throw new Error('Di mode contoh hanya bisa memulihkan cadangan dari mode contoh.');
        mem = clone(data); save();
        return { produk: mem.products.length, nota: mem.orders.length };
      },
      async backup() { return clone(load()); },
      async lastBackup() { return load().lastBackup || null; },
      async markBackup() { load().lastBackup = new Date().toISOString(); save(); },
      // Mode contoh: perubahan dari tab browser lain di perangkat yang sama
      subscribe(cb, onStatus = () => {}) {
        const h = e => { if (e.key === KEY) { mem = null; cb('orders'); cb('products'); cb('cash_days'); cb('productions'); } };
        window.addEventListener('storage', h); onStatus('SUBSCRIBED');
        return () => window.removeEventListener('storage', h);
      },
      async addCashOut(day, amount, note) {
        const db = load(); (db.cashOut ||= []).push({ id: db.nextId++, day, amount, note, created_by: 'contoh@lunpia.local', created_at: new Date().toISOString() }); save();
      },
      async deleteCashOut(id) {
        const db = load(), x = (db.cashOut || []).find(c => c.id === id);
        if (x) demoLog(db, 'kas_keluar', x.day, { hapus: true, amount: x.amount, note: x.note, by: x.created_by });
        db.cashOut = (db.cashOut || []).filter(c => c.id !== id); save();
      },
      async deleteCashDay(day) { const db = load(); if (db.cash) { delete db.cash[day]; save(); } },
      async listHiddenContacts() { return clone(Object.entries(load().hidden || {}).map(([key, hidden_at]) => ({ key, hidden_at }))); },
      async updateContact(key, name, wa) {
        const num = s => String(s || '').replace(/\D/g, '').replace(/^0/, '62');
        const k = o => num(o.customer_wa) || 'n:' + (o.customer_name || '').trim().toLowerCase();
        let n = 0;
        load().orders.forEach(o => { if (k(o) === key) { o.customer_name = name.trim(); o.customer_wa = wa.trim(); n++; } });
        save(); return n;
      },
      async hideContact(key) { const db = load(); (db.hidden ||= {})[key] = new Date().toISOString(); save(); },
      async resetCash(day) {
        const c = load().cash?.[day]; if (!c) return;
        Object.assign(c, { opening: 0, opening_detail: null, expected: null, counted: null, counted_detail: null, note: '', closed_at: null, closed_by: null });
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
