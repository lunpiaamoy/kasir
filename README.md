# Kasir Lunpia Amoy

Aplikasi kasir dan stok berbasis web untuk Lunpia Amoy, Jl. Jagalan 70, Semarang. Bisa dibuka dari laptop, tablet, atau HP lewat browser, dan datanya tersimpan online di Supabase, jadi semua perangkat melihat data yang sama.

## Fitur

- **Kasir**: pilih produk per jenis (Lunpia Basah, Goreng, Frozen, Ngoyang), isi nama, WA, dan catatan pembeli, pilih **Langsung / Ambil nanti / Kirim**, bayar **Tunai** (dengan kembalian) atau **QRIS**, lalu cetak struk atau kirim **nota lewat WhatsApp**: chat pembeli terbuka dengan isi nota sudah terketik, tinggal tekan Enter (di laptop lewat tab WhatsApp Web baru, di HP langsung aplikasi WhatsApp). Di atas halaman kasir muncul pengingat: uang awal belum diisi, pesanan terlewat, dan pesanan hari ini/besok.
- **Struk thermal 58 mm** mengikuti format nota toko: nomor nota berurutan per tahun, misalnya `(2026) 00001`. Kalau nota dihapus, nota berikutnya melanjutkan dari nomor terakhir yang masih tercatat. Saat mengubah nota, nomornya bisa diganti untuk mengisi nomor yang terloncat (aplikasi menampilkan nomor yang terloncat). Ongkir dicatat terpisah dan tidak masuk total.
- **Pesanan**: daftar pesanan yang akan diambil atau dikirim, dikelompokkan per tanggal, dengan tanda "Hari ini" dan "Terlewat". Pesanan bisa ditandai selesai, dicetak ulang, atau dibatalkan (stok dikembalikan). Pemilik juga bisa **mengubah** dan **menghapus** nota.
- **Pengaturan** (pemilik, tombol di bilah atas): kelola **staf** (tambah kasir, ganti peran, **wewenang per kasir**, **ganti password** tiap akun, hapus), **unduh cadangan semua data**, dan **pulihkan dari cadangan** (data di file yang tidak ada di kasir ditambahkan kembali; data yang ada tidak diubah atau dihapus; daftar staf tidak ikut).
- **Kontak**: daftar pembeli yang disusun otomatis dari nama & nomor WA di transaksi (satu kontak per nomor), lengkap dengan jumlah transaksi, total belanja, dan tanggal terakhir beli. Bisa dicari, diurutkan, dan tombol **Pesan baru** langsung mengisi nama & WA di kasir, dan tombol **WhatsApp** membuka chat pembeli dengan salam "Hai Kak {nama}.".
- **Stok**: tambah stok, koreksi stok, **stok opname** (isi hitungan fisik, lihat selisihnya, lalu stok sistem disamakan), tambah atau ubah produk, dan peringatan stok menipis. Tombol **Kartu stok** di tiap produk menampilkan mutasi stok (masuk, terjual, batal, koreksi) per tanggal lengkap dengan saldo, untuk bulan ini, bulan lalu, 3 bulan, atau rentang tanggal pilihan.
- **Laporan**: penjualan hari ini, kemarin, 7 hari, bulan ini, tahun ini, tahun lalu, atau rentang tanggal pilihan, dengan grafik, **jam ramai** (transaksi per jam dengan tanda Ramai/Sepi), tunai dan QRIS terpisah, produk terlaris, rekap per hari/bulan, dan **unduh Excel (CSV)**. **Laba** (penjualan − bahan terpakai dari tab Produksi) juga tampil di Laporan untuk yang berwenang.
- **Produksi** (tab tersendiri): catat belanja bahan (kulit, telur, rebung, ayam, udang, …) dengan harga dan sisanya, serta berapa pcs tiap produk yang jadi. Tampilan berurutan: **1. pembelian bahan**, **2. produksi** (diproduksi vs terjual), **3. sisa bahan sekarang**, lalu catatan per tanggal. Hasil produksi langsung menambah stok; sisa bahan otomatis dibawa ke catatan berikutnya sebagai baris "sisa lalu".
- **Kas** (tab tersendiri): isi uang awal saat buka dan hitung uang di laci saat **tutup kasir**, keduanya **per pecahan** (100.000 sampai 1.000; koin ratusan tidak dihitung). Catat **kas keluar** (beli bahan, bensin, bayar kurir) supaya selisih jujur. Aplikasi menghitung uang yang seharusnya ada (uang awal + penjualan tunai + ongkir yang dibayar tunai − kas keluar) dan selisihnya. **Riwayat kas** bisa dilihat per **hari** (31 hari), **minggu**, **bulan**, atau **tahun** (jumlah hari, lebih/kurang, total selisih, kas keluar).

## Pemilik dan kasir

Pemilik selalu boleh semuanya. Wewenang tiap kasir diatur pemilik **per tab** di **Pengaturan → Staf → Wewenang**: centang tab yang boleh dibuka, lalu pilihan di dalamnya. Bawaannya:

| Tab | Boleh dibuka (bawaan) | Pilihan di dalam tab (bawaan) |
|---|:-:|---|
| Kasir | ✅ selalu | transaksi, cetak struk, kirim nota WA |
| Pesanan | ✅ | ✅ batalkan · ❌ ubah nota (termasuk nomor) · ❌ hapus nota |
| Kas | ✅ | ✅ uang awal · ✅ tutup kasir · ✅ kas keluar · ❌ ubah kas yang sudah ditutup · ❌ hapus riwayat kas |
| Produksi | ❌ | ❌ catat & ubah · ❌ hapus |
| Stok | ✅ | ✅ tambah stok masuk · ❌ kurangi stok · ❌ stok opname · ❌ tambah produk · ❌ ubah produk & harga |
| Laporan | ✅ | ✅ unduh Excel · ❌ lihat laba |
| Kontak | ✅ | ❌ ubah kontak · ❌ hapus kontak |

Pengaturan (staf, wewenang, password, cadangan) khusus pemilik.

Batasan ini dipasang di database, bukan hanya dengan menyembunyikan tombol (kecuali membuka tab Pesanan/Stok/Laporan/Kontak, unduh Excel, dan lihat laba, yang diatur di aplikasi).

## Mode contoh

Kalau `config.js` belum diisi, aplikasi berjalan dalam **mode contoh**: data hanya tersimpan di browser perangkat itu. Mode ini cocok untuk mencoba-coba.

## Menyambungkan ke Supabase

1. Buat project baru di [supabase.com](https://supabase.com). Pilih region **Southeast Asia (Singapore)**.
2. Buka **SQL Editor → New query**, tempel seluruh isi [`supabase/schema.sql`](supabase/schema.sql), lalu klik **Run**.
3. Daftarkan email pemilik. Tetap di SQL Editor, jalankan:
   ```sql
   insert into public.staff (email, name) values ('email-kamu@gmail.com', 'Nama');
   ```
4. Jalankan juga seluruh isi [`supabase/002_pembaruan.sql`](supabase/002_pembaruan.sql), lalu [`supabase/003_pecahan_kas.sql`](supabase/003_pecahan_kas.sql), [`supabase/004_ubah_hapus_kas_kontak.sql`](supabase/004_ubah_hapus_kas_kontak.sql), [`supabase/005_alamat_kas_keluar_staf_hpp.sql`](supabase/005_alamat_kas_keluar_staf_hpp.sql), [`supabase/006_pembelian_produksi.sql`](supabase/006_pembelian_produksi.sql), [`supabase/007_produksi_ke_stok.sql`](supabase/007_produksi_ke_stok.sql), [`supabase/008_wewenang_staf.sql`](supabase/008_wewenang_staf.sql), [`supabase/009_wewenang_detail_nomor_nota.sql`](supabase/009_wewenang_detail_nomor_nota.sql), dan [`supabase/010_laba_di_laporan.sql`](supabase/010_laba_di_laporan.sql), dengan cara yang sama (kosongkan editor, tempel seluruh isi file, pastikan tidak ada teks yang terpilih, lalu Run). Staf yang sudah terdaftar saat file 002 dijalankan menjadi **pemilik**.
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
