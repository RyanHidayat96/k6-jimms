# JIMMS K6 Performance Testing

Folder ini berisi K6 performance test untuk fitur download dokumen:

```text
TAMS > Perkerasan > Rutin > filter status Verifikasi Tindak Lanjut - ME > icon download kolom Aksi
```

Strukturnya mengikuti template `k6-travoygo/`, tetapi endpoint dan flow dibuat khusus untuk JIMMS.

## Hasil Inspeksi API

Tanggal inspeksi: 27 Agustus 2026.

### Login

FE:

```text
http://jimms-fe-performance-jimms-v2.apps.ocdev.jasamarga.co.id
```

Flow login NextAuth:

```http
GET /api/auth/csrf
POST /api/auth/callback/credentials
GET /api/auth/session
```

Body login:

```text
username=spv_tes
password=123
redirect=false
csrfToken=<csrfToken dari /api/auth/csrf>
callbackUrl=http://jimms-fe-performance-jimms-v2.apps.ocdev.jasamarga.co.id/login
json=true
```

Token API diambil dari:

```text
/api/auth/session -> user.accessToken
```

### List Perkerasan Rutin

API base:

```text
https://api-gateway.jasamarga.co.id/dev/jimms-pavement/api
```

Request setelah filter status `Verifikasi Tindak Lanjut - ME`:

```http
GET /v1/regular-inspection?status_id%5B%5D=27&page=1&per_page=5
Authorization: Bearer <accessToken>
x-api-key: <JIMMS_API_KEY>
```

Status id hasil inspeksi:

```text
Verifikasi Tindak Lanjut - ME => status_id[]=27
```

Pada data filter ini semua checkbox download aktif.

### Persiapan Download ZIP

Endpoint:

```http
POST /v1/regular-inspection/export/{inspectionId}
Authorization: Bearer <accessToken>
x-api-key: <JIMMS_API_KEY>
Content-Type: multipart/form-data
```

Body saat semua checkbox dicentang:

```text
archive[]=jsa_form
archive[]=preparation_form
archive[]=administration_form
archive[]=documents
archive[]=maintenance_data
archive[]=maintenance_stripmap
archive[]=inspection
archive[]=stripmap
```

Response sukses:

```json
{
  "success": true,
  "message": "Export process queued successfully",
  "data": {
    "jobId": "<uuid>",
    "filename": "<nama ruas> - <timestamp>.zip"
  }
}
```

UI biasanya lalu membuka progress stream untuk menunggu ZIP selesai dibuat:

```http
GET /v1/regular-inspection/export/{jobId}/progress-stream
Accept: text/event-stream
```

Saat selesai, stream mengembalikan `downloadUrl`:

```http
GET /v1/regular-inspection/export/{jobId}/download
```

Default script memakai `JIMMS_DOWNLOAD_FLOW_MODE=real-user`: tiap iteration membuat export job queued, menunggu ZIP siap, lalu hit endpoint download dan validasi body ZIP.

### Target Performance

Endpoint yang diukur saat VU berjalan:

```http
GET /v1/regular-inspection/export/{jobId}/download
Authorization: Bearer <accessToken>
x-api-key: <JIMMS_API_KEY>
```

Default `JIMMS_DOWNLOAD_RESPONSE_TYPE=binary`, jadi body ZIP benar-benar dibaca oleh K6 dan dicek sebagai file ZIP. File tidak disimpan ke folder report; report berisi bukti sukses/gagal dari checks dan metric `data_received`.

Jumlah job ZIP yang disiapkan:

```env
JIMMS_DOWNLOAD_FLOW_MODE=real-user
JIMMS_DOWNLOAD_DIRECT_URLS=
JIMMS_DOWNLOAD_JOB_IDS=
JIMMS_DOWNLOAD_PREPARE_JOBS=1
JIMMS_PREPARE_DOWNLOAD_BEFORE_RUN=false
JIMMS_SETUP_TIMEOUT=5m
```

`real-user` mengikuti UI: `POST export` -> job queued -> tunggu `progress-stream` -> `GET download`. Jika `progress-stream` stuck dan tidak memberi `downloadUrl` sampai `JIMMS_DOWNLOAD_PROGRESS_TIMEOUT`, test gagal. `download-only` dipakai jika ingin langsung hit URL download dari `JIMMS_DOWNLOAD_DIRECT_URLS` atau `JIMMS_DOWNLOAD_JOB_IDS`.

## Command

Dari folder ini:

```powershell
npm run smoke
npm run load
```

Stress test diblokir sampai explicit allow:

```powershell
$env:JIMMS_ALLOW_STRESS="true"
npm run stress
```

Generate report HTML:

```powershell
npm run report:html
npm run report:open
```

## Variasi Checkbox

Default `.env` mencentang semua dokumen:

```env
JIMMS_DOWNLOAD_ALL_ARCHIVE=true
```

Jika ingin pilih checkbox satu per satu, set `JIMMS_DOWNLOAD_ALL_ARCHIVE=false`, lalu isi `true` untuk centang dan `false` untuk uncheck:

```env
JIMMS_DOWNLOAD_ALL_ARCHIVE=false
JIMMS_DOWNLOAD_CHECK_FORM_JSA=true
JIMMS_DOWNLOAD_CHECK_FORM_PERSIAPAN=false
JIMMS_DOWNLOAD_CHECK_DATA_ADMINISTRASI=true
JIMMS_DOWNLOAD_CHECK_DATA_INSPEKSI=true
JIMMS_DOWNLOAD_CHECK_DOKUMENTASI=false
JIMMS_DOWNLOAD_CHECK_STRIPMAP_INSPEKSI=true
JIMMS_DOWNLOAD_CHECK_STRIPMAP_PENANGANAN=false
JIMMS_DOWNLOAD_CHECK_DATA_PENANGANAN=false
```

Mapping checkbox ke `archive[]` API:

| Env | Checkbox UI | Value API |
| --- | --- | --- |
| `JIMMS_DOWNLOAD_CHECK_FORM_JSA` | Form JSA | `jsa_form` |
| `JIMMS_DOWNLOAD_CHECK_FORM_PERSIAPAN` | Form Persiapan | `preparation_form` |
| `JIMMS_DOWNLOAD_CHECK_DATA_ADMINISTRASI` | Data Administrasi | `administration_form` |
| `JIMMS_DOWNLOAD_CHECK_DATA_INSPEKSI` | Data Inspeksi Rutin | `inspection` |
| `JIMMS_DOWNLOAD_CHECK_DOKUMENTASI` | Dokumentasi Inspeksi Rutin | `documents` |
| `JIMMS_DOWNLOAD_CHECK_STRIPMAP_INSPEKSI` | Stripmap Inspeksi Rutin | `stripmap` |
| `JIMMS_DOWNLOAD_CHECK_STRIPMAP_PENANGANAN` | Stripmap Penanganan Inspeksi Rutin | `maintenance_stripmap` |
| `JIMMS_DOWNLOAD_CHECK_DATA_PENANGANAN` | Data Penanganan Inspeksi Rutin | `maintenance_data` |

`JIMMS_DOWNLOAD_ALL_ARCHIVE=true` selalu mengabaikan parameter per checkbox. Legacy `JIMMS_DOWNLOAD_ARCHIVE_SCENARIOS` masih didukung jika dibutuhkan, tetapi tidak perlu dipakai untuk flow checkbox biasa.

## Data Test

Default real-user flow:

1. K6 setup login sekali dan ambil token.
2. Tiap VU/iteration ambil `inspectionId` dari `JIMMS_DOWNLOAD_INSPECTION_IDS` atau list status_id[]=27.
3. Tiap VU/iteration `POST /v1/regular-inspection/export/{inspectionId}`.
4. Tiap VU/iteration tunggu job queued lewat `progress-stream`.
5. Tiap VU/iteration validasi ZIP: status 200, header file, body terunduh, magic bytes `PK`.

Fallback polling `GET /download` hanya aktif jika eksplisit:

```env
JIMMS_DOWNLOAD_ALLOW_POLL_FALLBACK=true
```

Mode download-only:

1. Set `JIMMS_DOWNLOAD_FLOW_MODE=download-only`.
2. Isi `JIMMS_DOWNLOAD_DIRECT_URLS` atau `JIMMS_DOWNLOAD_JOB_IDS`.
3. VU/iteration hanya hit `GET /v1/regular-inspection/export/{jobId}/download`.

Jika data filter kosong atau ingin pin data tertentu, isi:

```env
JIMMS_DOWNLOAD_INSPECTION_IDS=113,112,101
```

Row strategy:

```env
JIMMS_DOWNLOAD_ROW_STRATEGY=rotate
```

Gunakan `first` kalau semua iteration ingin memakai row pertama.

## Load Profile

Default `.env` dibuat kecil agar aman:

```env
JIMMS_EXECUTOR=shared-iterations
JIMMS_VUS=5
JIMMS_ITERATIONS=20
JIMMS_MAX_DURATION=20m
JIMMS_THINK_TIME_SECONDS=1
```

Executor yang didukung:

| Executor | Key utama |
| --- | --- |
| `ramping-vus` | `JIMMS_TARGET_VUS`, `JIMMS_RAMP_UP`, `JIMMS_HOLD`, `JIMMS_RAMP_DOWN` |
| `constant-vus` | `JIMMS_VUS`, `JIMMS_DURATION` |
| `shared-iterations` | `JIMMS_VUS`, `JIMMS_ITERATIONS`, `JIMMS_MAX_DURATION` |
| `per-vu-iterations` | `JIMMS_VUS`, `JIMMS_ITERATIONS`, `JIMMS_MAX_DURATION` |

## Report

Summary JSON dan HTML disimpan di:

```text
test-results/reports/k6
```

Kriteria status report:

| Status | Arti |
| --- | --- |
| `PASS` | API utama download lulus: `POST export`, `GET progress-stream`, dan `GET download` valid. |
| `FAIL` | API utama download gagal, misalnya job stuck `WAITING`, tidak ada `downloadUrl`, HTTP error, atau body ZIP tidak valid. |
| `SKIPPED` | API pendukung/precondition gagal sebelum flow utama bisa dinilai, misalnya login gagal atau data list kosong. |

API pendukung/precondition tidak menentukan `FAIL`:

```text
GET /api/auth/csrf
POST /api/auth/callback/credentials
GET /api/auth/session
GET /v1/regular-inspection filtered-list
```

API utama penentu `PASS/FAIL`:

```text
POST /v1/regular-inspection/export/{id}
GET /v1/regular-inspection/export/{jobId}/progress-stream
GET /v1/regular-inspection/export/{jobId}/download
```

Metric utama:

| Metric | Arti |
| --- | --- |
| `jimms_valid_response_rate` | Rate response yang sukses secara HTTP + response body |
| `jimms_load_error_rate` | Rate error kapasitas/load seperti timeout, 429, dan 5xx |
| `jimms_valid_req_duration` | Durasi request valid, dipakai untuk threshold SLA |
| `data_received` | Byte ZIP yang benar-benar diterima selama test |
