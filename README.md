# Kasir Lunpia Amoy

Aplikasi kasir dan stok berbasis web untuk Lunpia Amoy, Jl. Jagalan 70, Semarang. Bisa dibuka dari laptop, tablet, atau HP lewat browser, dan datanya tersimpan online di Supabase, jadi semua perangkat melihat data yang sama.

## Fitur

- **Kasir**: pilih produk per jenis (Lunpia Basah, Goreng, Frozen, Ngoyang), isi nama, WA, dan catatan pembeli, pilih **Langsung / Ambil nanti / Kirim**, bayar **Tunai** (dengan kembalian) atau **QRIS**, lalu cetak struk atau kirim nota lewat **WhatsApp** (di laptop langsung membuka chat pembeli di WhatsApp Web, selalu di tab yang sama; di HP langsung aplikasi WhatsApp). Di atas halaman kasir muncul pengingat: uang awal belum diisi, pesanan terlewat, dan pesanan hari ini/besok.
- **Struk thermal 58 mm** mengikuti format nota toko: nomor nota berurutan per tahun, misalnya `(2026) 00001`, dan tidak pernah dipakai ulang walaupun nota dihapus. Ongkir dicatat terpisah dan tidak masuk total.
- **Pesanan**: daftar pesanan yang akan diambil atau dikirim, dikelompokkan per tanggal, dengan tanda "Hari ini" dan "Terlewat". Pesanan bisa ditandai selesai, dicetak ulang, atau dibatalkan (stok dikembalikan). Pemilik juga bisa **mengubah** dan **menghapus** nota.
- **Stok**: tambah stok, koreksi stok, **stok opname** (isi hitungan fisik, lihat selisihnya, lalu stok sistem disamakan), tambah atau ubah produk, dan peringatan stok menipis. Tombol **Kartu stok** di tiap produk menampilkan mutasi stok (masuk, terjual, batal, koreksi) per tanggal lengkap dengan saldo, untuk bulan ini, bulan lalu, 3 bulan, atau rentang tanggal pilihan.
- **Laporan**: penjualan hari ini, kemarin, 7 hari, bulan ini, tahun ini, tahun lalu, atau rentang tanggal pilihan, dengan grafik, tunai dan QRIS terpisah, produk terlaris, rekap per hari/bulan, dan **unduh Excel (CSV)**.
- **Kas** (tab tersendiri): isi uang awal saat buka dan hitung uang di laci saat **tutup kasir**, keduanya **per pecahan** (100.000 sampai 1.000; koin ratusan tidak dihitung). Aplikasi menghitung uang yang seharusnya ada (uang awal + penjualan tunai) dan selisihnya. **Riwayat kas 14 hari** menampilkan selisih setiap hari.

## Pemilik dan kasir

| | Pemilik | Kasir |
|---|:-:|:-:|
| Transaksi, cetak struk, kirim WA | ✅ | ✅ |
| Tandai selesai, batalkan pesanan | ✅ | ✅ |
| Tambah stok masuk, kartu stok, laporan | ✅ | ✅ |
| Uang awal & tutup kasir | ✅ | ✅ |
| **Ubah** dan **hapus** nota | ✅ | ❌ |
| Tambah/ubah produk dan harga | ✅ | ❌ |
| Koreksi stok (mengurangi) dan stok opname | ✅ | ❌ |
| Mengubah kas yang sudah ditutup | ✅ | ❌ |

Batasan ini dipasang di database, bukan hanya dengan menyembunyikan tombol.

## Mode contoh

Kalau `config.js` belum diisi, aplikasi berjalan dalam **mode contoh**: data hanya tersimpan di browser perangkat itu. Mode ini cocok untuk mencoba-coba.

## Menyambungkan ke Supabase

1. Buat project baru di [supabase.com](https://supabase.com). Pilih region **Southeast Asia (Singapore)**.
2. Buka **SQL Editor → New query**, tempel seluruh isi [`supabase/schema.sql`](supabase/schema.sql), lalu klik **Run**.
3. Daftarkan email pemilik. Tetap di SQL Editor, jalankan:
   ```sql
   insert into public.staff (email, name) values ('email-kamu@gmail.com', 'Nama');
   ```
4. Jalankan juga seluruh isi [`supabase/002_pembaruan.sql`](supabase/002_pembaruan.sql), lalu [`supabase/003_pecahan_kas.sql`](supabase/003_pecahan_kas.sql), dengan cara yang sama. Staf yang sudah terdaftar saat file 002 dijalankan menjadi **pemilik**.
5. Buat akun login untuk setiap staf di **Authentication → Users → Add user → Create new user**, dengan email yang sama dan centang **Auto Confirm User**.
6. Matikan pendaftaran umum di **Authentication → Sign In / Providers**: nonaktifkan **Allow new users to sign up**. Kalau tersedia di paket Anda, nyalakan juga **Leaked password protection**.
7. Salin **Project URL** dan **anon / publishable key** dari **Project Settings → API** ke `config.js`.

> `anon key` memang dirancang untuk dipakai di browser. **Jangan** pernah memasukkan `service_role` / `secret key` ke aplikasi ini.

### Menambah pegawai (kasir)

Di SQL Editor (staf baru otomatis menjadi kasir):
```sql
insert into public.staff (email, name) values ('email-pegawai@gmail.com', 'Nama Pegawai');
```
Lalu buat akun loginnya di **Authentication → Users** seperti langkah 5. Untuk menjadikan seseorang pemilik:
```sql
update public.staff set role = 'pemilik' where email = 'email-pegawai@gmail.com';
```

## Memasang di layar utama

Aplikasi bisa dipasang seperti aplikasi biasa, tanpa bilah alamat browser:

- **Android (Chrome)**: buka situsnya → menu ⋮ → **Tambahkan ke layar utama** / **Instal aplikasi**.
- **iPhone/iPad (Safari)**: buka situsnya → tombol **Bagikan** → **Tambah ke Layar Utama**.
- **Laptop (Chrome/Edge)**: ikon instal di ujung kanan bilah alamat.

## Mencetak struk

Tombol **Cetak** membuka jendela Print bawaan perangkat. Pilih printer thermal, ukuran kertas **58 mm**, dan margin **None**.

- **Laptop/PC + printer USB**: pasang driver printernya, maka printer akan muncul di jendela Print.
- **HP Android + printer Bluetooth**: pasang aplikasi print service seperti *RawBT*, lalu pilih printer itu di jendela Print.

## Teknis

HTML, CSS, dan JavaScript biasa, tanpa proses build, dengan [supabase-js](https://github.com/supabase/supabase-js) dari CDN. Semua perhitungan total, nomor nota, perubahan stok, ubah/hapus nota, dan pengecekan peran dijalankan di database (fungsi `create_order`, `update_order`, `delete_order`, `cancel_order`, `add_stock`, `stock_opname`), jadi aman dipakai beberapa kasir sekaligus.
