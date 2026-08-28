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

Script selalu memakai real-user flow: tiap iteration membuat export job queued, menunggu ZIP siap lewat `progress-stream`, lalu hit endpoint download dan validasi body ZIP.

### Target Performance

Endpoint utama yang diukur saat VU berjalan:

```http
POST /v1/regular-inspection/export/{inspectionId}
GET /v1/regular-inspection/export/{jobId}/progress-stream
GET /v1/regular-inspection/export/{jobId}/download
Authorization: Bearer <accessToken>
x-api-key: <JIMMS_API_KEY>
```

Body ZIP benar-benar dibaca oleh K6 sebagai binary dan dicek magic bytes `PK`. Default file ZIP tidak disimpan; report berisi bukti sukses/gagal dari checks dan metric `data_received`.

Jika ingin menyimpan file ZIP yang sukses ke folder report:

```env
JIMMS_SAVE_DOWNLOADED_ZIP=true
```

Folder output ZIP:

```text
test-results/reports/k6/download-results/zip/<nama-report>-<timestamp>
```

Catatan: penyimpanan ZIP dilakukan oleh runner setelah K6 selesai, hanya untuk job yang sudah terbukti sukses di flow K6.

Timeout export/download file dibuat internal. Timeout dan attempts untuk menunggu worker bisa diatur dari `.env`:

```env
JIMMS_DOWNLOAD_PROGRESS_TIMEOUT=80s
JIMMS_DOWNLOAD_PROGRESS_ATTEMPTS=60
JIMMS_SAVE_DOWNLOADED_ZIP=false
```

## Command

Dari folder ini:

```powershell
npm run smoke
npm run test
```

Generate dan open report:

```powershell
npm run report
```

Atau pisah generate dan open:

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

`JIMMS_DOWNLOAD_ALL_ARCHIVE=true` selalu mengabaikan parameter per checkbox.

## Data Test

Flow test download:

1. K6 setup login sekali dan ambil token.
2. Tiap VU/iteration ambil `inspectionId` dari `JIMMS_DOWNLOAD_INSPECTION_IDS` atau list status_id[]=27.
3. Tiap VU/iteration `POST /v1/regular-inspection/export/{inspectionId}`.
4. Tiap VU/iteration tunggu job queued lewat `progress-stream` sampai `downloadUrl` ada atau attempts habis.
5. Tiap VU/iteration validasi ZIP: status 200, header file, body terunduh, magic bytes `PK`.

Jika data filter kosong atau ingin pin data tertentu, isi:

```env
JIMMS_DOWNLOAD_INSPECTION_IDS=113,112,101
```

Row strategy:

```env
JIMMS_DOWNLOAD_ROW_STRATEGY=rotate
```

Gunakan `first` kalau semua iteration ingin memakai row pertama.

## Test Profile

`npm run test` memakai parameter ini.

Default `.env.example` dibuat kecil agar aman:

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

Threshold juga satu untuk smoke dan test:

```env
JIMMS_CHECK_RATE=1
JIMMS_HTTP_ERROR_RATE=0
JIMMS_P95_THRESHOLD_MS=3600000
JIMMS_P99_THRESHOLD_MS=3600000
JIMMS_PER_ENDPOINT_P95_THRESHOLD_MS=3600000
```

Setting ini cocok untuk fokus berhasil/gagal: satu download utama gagal langsung `FAIL`, sedangkan speed tidak dijadikan penentu.

## Report

Summary JSON dan HTML disimpan di:

```text
test-results/reports/k6
```

HTML utama:

```text
test-results/reports/k6/index.html
```

Report HTML dibuat satu file/satu halaman: ringkasan, detail request, header, response sample, checks, thresholds, dan metric tampil langsung tanpa klik nama report.

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
