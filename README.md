# Kasir Lunpia Amoy

Aplikasi kasir dan stok berbasis web untuk Lunpia Amoy, Jl. Jagalan 70, Semarang. Bisa dibuka dari laptop, tablet, atau HP lewat browser, dan datanya tersimpan online di Supabase, jadi semua perangkat melihat data yang sama.

## Fitur

- **Kasir**: pilih produk per jenis (Lunpia Basah, Goreng, Frozen, Ngoyang), isi nama dan WA pembeli, pilih **Langsung / Ambil nanti / Kirim**, bayar **Tunai** (dengan kembalian) atau **QRIS**, lalu cetak struk.
- **Struk thermal 58 mm** mengikuti format nota toko: nomor nota berurutan per tahun, misalnya `(2026) 00001`. Ongkir dicatat terpisah dan tidak masuk total.
- **Pesanan**: daftar pesanan yang akan diambil atau dikirim, dikelompokkan per tanggal, dengan tanda "Hari ini" dan "Terlewat". Pesanan bisa ditandai selesai, dicetak ulang, atau dibatalkan (stok dikembalikan).
- **Stok**: tambah atau koreksi stok, tambah atau ubah produk, dan peringatan stok menipis.
- **Laporan**: penjualan hari ini, kemarin, 7 hari, bulan ini, atau rentang tanggal pilihan. Tunai dan QRIS ditampilkan terpisah, lengkap dengan produk terlaris dan rekap per hari.

## Mode contoh

Kalau `config.js` belum diisi, aplikasi berjalan dalam **mode contoh**: data hanya tersimpan di browser perangkat itu. Mode ini cocok untuk mencoba-coba.

## Menyambungkan ke Supabase

1. Buat project baru di [supabase.com](https://supabase.com). Pilih region **Southeast Asia (Singapore)**.
2. Buka **SQL Editor → New query**, tempel seluruh isi [`supabase/schema.sql`](supabase/schema.sql), lalu klik **Run**.
3. Daftarkan email staf yang boleh memakai kasir. Tetap di SQL Editor, jalankan:
   ```sql
   insert into public.staff (email, name) values ('email-kamu@gmail.com', 'Nama');
   ```
4. Buat akun login untuk setiap staf di **Authentication → Users → Add user → Create new user**, dengan email yang sama dan centang **Auto Confirm User**.
5. Matikan pendaftaran umum di **Authentication → Sign In / Providers**: nonaktifkan **Allow new users to sign up**.
6. Salin **Project URL** dan **anon / publishable key** dari **Project Settings → API** ke `config.js`.

> `anon key` memang dirancang untuk dipakai di browser. **Jangan** pernah memasukkan `service_role` / `secret key` ke aplikasi ini.

## Mencetak struk

Tombol **Cetak** membuka jendela Print bawaan perangkat. Pilih printer thermal, ukuran kertas **58 mm**, dan margin **None**.

- **Laptop/PC + printer USB**: pasang driver printernya, maka printer akan muncul di jendela Print.
- **HP Android + printer Bluetooth**: pasang aplikasi print service seperti *RawBT*, lalu pilih printer itu di jendela Print.

## Teknis

HTML, CSS, dan JavaScript biasa, tanpa proses build, dengan [supabase-js](https://github.com/supabase/supabase-js) dari CDN. Semua perhitungan total, nomor nota, dan pengurangan stok dijalankan di database (`create_order`), jadi aman dipakai beberapa kasir sekaligus.
