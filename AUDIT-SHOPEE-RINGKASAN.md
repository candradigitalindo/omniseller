# Cakupan endpoint Shopee — hasil inventaris

Sumber sekunder: https://github.com/nhutplus/marketplace-api-docs/tree/300344af94cf347268b50847baf14b9c28aaf1ae/shopee. Tanggal snapshot: 2026-05-15; portal resmi tidak dapat diakses dari lingkungan audit (HTTP 403).

428 endpoint dokumentasi, 28 modul, 48 panduan. 54 endpoint dokumentasi memiliki referensi literal pada connector; 374 belum memiliki referensi. Jumlah path unik kode adalah 54. Angka tersebut mengukur referensi kode, bukan fitur lengkap atau keberhasilan sandbox.

| Modul | Endpoint snapshot | Ada referensi connector | Belum ada referensi |
|---|---:|---:|---:|
| AccountHealth | 6 | 0 | 6 |
| Add-On Deal | 14 | 0 | 14 |
| Ads | 23 | 0 | 23 |
| AMS | 36 | 1 | 35 |
| Bundle Deal | 10 | 0 | 10 |
| Discount | 12 | 0 | 12 |
| FBS | 4 | 0 | 4 |
| FirstMile | 16 | 0 | 16 |
| Follow Prize | 6 | 0 | 6 |
| GlobalProduct | 34 | 0 | 34 |
| Livestream | 25 | 1 | 24 |
| Logistics | 46 | 14 | 32 |
| Media | 6 | 4 | 2 |
| MediaSpace | 6 | 4 | 2 |
| Merchant | 6 | 0 | 6 |
| Order | 21 | 4 | 17 |
| Payment | 18 | 0 | 18 |
| Product | 57 | 13 | 44 |
| Public | 6 | 2 | 4 |
| Push | 4 | 2 | 2 |
| Returns | 15 | 6 | 9 |
| SBS | 5 | 0 | 5 |
| Shop | 9 | 3 | 6 |
| ShopCategory | 7 | 0 | 7 |
| ShopFlashSale | 11 | 0 | 11 |
| TopPicks | 4 | 0 | 4 |
| Video | 15 | 0 | 15 |
| Voucher | 6 | 0 | 6 |

Path kode yang belum ditemukan dalam snapshot:
Tidak ada.

Deteksi menggunakan AST TypeScript pada berkas produksi connector; komentar, tes dan metadata katalog tidak dihitung. Executor commerce umum dicatat terpisah dalam matriks operasi; deklarasi method/path tidak membuktikan alur khusus. Metode HTTP berasal dari penanda eksplisit Markdown yang dicocokkan dengan path, lalu contoh request sebagai fallback. Pemanggilan dinamis yang tidak berupa string literal membutuhkan tinjauan terpisah. Alur backend/UI dicantumkan pada level domain dan harus ditinjau per operasi; nama halaman tidak membuktikan seluruh endpoint domain sudah digunakan. Tidak ada klaim kesetaraan terhadap seluruh katalog Shopee terkini.
