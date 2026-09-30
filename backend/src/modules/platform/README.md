# Modul platform

## Tanggung jawab
Hal lintas modul milik platform: health check proses, feature flag, dan (nanti) UI admin internal.

## Tabel yang dimiliki
- `feature_flag` (global): definisi flag dan persentase rollout.
- `feature_flag_override`: nilai flag per tenant.
- `file_object`: metadata berkas di R2 (dipakai modul lain lewat service publik modul `files` saat modul itu dibuat).

## Service publik
Belum ada. Evaluasi feature flag menyusul bersama fitur pertama yang memakainya.

## Event
- Diterbitkan: tidak ada.
- Dikonsumsi: tidak ada.

## Endpoint
| Metode | Path | Izin |
|---|---|---|
| GET | `/healthz` | publik; proses hidup |
| GET | `/readyz` | publik; basis data dan kedua Redis terjangkau, 503 bila tidak |

## Job
Tidak ada.

## Keputusan khusus modul
`/readyz` dipakai health check ALB. Endpoint ini tidak memeriksa marketplace atau layanan luar, karena gangguan pihak ketiga tidak boleh membuat task ECS dianggap tidak sehat.
