// Pengaturan toko dan koneksi database.
// SUPABASE_URL dan SUPABASE_ANON_KEY diambil dari Supabase: Project Settings → API.
// Kalau dikosongkan, aplikasi berjalan dalam MODE CONTOH (data hanya di perangkat ini).
window.APP_CONFIG = {
  SUPABASE_URL: '',
  SUPABASE_ANON_KEY: '',

  store: {
    name: 'Lunpia Amoy',
    address: 'Jl. Jagalan 70, Semarang',
    phone: '085 64000 7170',
  },
};
