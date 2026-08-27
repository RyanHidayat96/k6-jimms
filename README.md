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

UI lalu membuka progress stream:

```http
GET /v1/regular-inspection/export/{jobId}/progress-stream
Accept: text/event-stream
```

Saat selesai, stream mengembalikan `downloadUrl`:

```http
GET /v1/regular-inspection/export/{jobId}/download
```

Pada script ini, runner Node menyiapkan `jobId` dan `downloadUrl` sebelum K6 dimulai. K6 lalu hanya mengukur request file ZIP.

### Target Performance

Endpoint yang diukur saat VU berjalan:

```http
GET /v1/regular-inspection/export/{jobId}/download
Authorization: Bearer <accessToken>
x-api-key: <JIMMS_API_KEY>
```

Default `JIMMS_DOWNLOAD_RESPONSE_TYPE=none`, jadi body ZIP tidak disimpan ke memory, tetapi request tetap mengunduh file dan metrik `duration`/`data_received` tetap tercatat.

Jumlah job ZIP yang disiapkan:

```env
JIMMS_DOWNLOAD_PREPARE_JOBS=1
JIMMS_PREPARE_DOWNLOAD_BEFORE_RUN=true
JIMMS_SETUP_TIMEOUT=5m
```

`1` berarti semua VU download ZIP yang sama. Isi lebih besar jika ingin VU rotate beberapa `downloadUrl`.

File JSON lama di `test-results/reports/k6/download-results` adalah manifest export job dari mode lama. Mode aktif sekarang tidak memerlukannya.

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

Default load test menjalankan variasi ini bergilir per iteration:

```env
JIMMS_DOWNLOAD_ARCHIVE_SCENARIOS=all,preparation,administration,inspection,documentation,stripmap,maintenance
```

| Scenario | Checkbox |
| --- | --- |
| `all` | Semua checkbox aktif |
| `preparation` | Form JSA + Form Persiapan |
| `jsa` | Form JSA |
| `preparation-form` | Form Persiapan |
| `administration` | Data Administrasi |
| `inspection` | Data Inspeksi Rutin |
| `documentation` | Dokumentasi Inspeksi Rutin |
| `stripmap` | Stripmap Inspeksi Rutin |
| `maintenance` | Data Penanganan + Stripmap Penanganan |
| `maintenance-data` | Data Penanganan Inspeksi Rutin |
| `maintenance-stripmap` | Stripmap Penanganan Inspeksi Rutin |

Jalankan satu kondisi saja:

```powershell
$env:JIMMS_DOWNLOAD_ARCHIVE_SCENARIOS="all"
npm run load
```

Custom raw archive juga bisa:

```powershell
$env:JIMMS_DOWNLOAD_ARCHIVE_SCENARIOS="jsa_form+inspection+stripmap"
npm run load
```

## Data Test

Default flow sekarang:

1. Runner login.
2. Runner ambil list dengan `status_id[]=27`.
3. Runner POST export sesuai scenario checkbox.
4. Runner ambil `downloadUrl` dari `progress-stream`.
5. K6 `setup()` login dan baca `downloadUrl` yang sudah siap.
6. VU/iteration hanya hit `GET /v1/regular-inspection/export/{jobId}/download`.

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

Metric utama:

| Metric | Arti |
| --- | --- |
| `jimms_valid_response_rate` | Rate response yang sukses secara HTTP + response body |
| `jimms_load_error_rate` | Rate error kapasitas/load seperti timeout, 429, dan 5xx |
| `jimms_valid_req_duration` | Durasi request valid, dipakai untuk threshold SLA |
| `data_received` | Byte ZIP yang benar-benar diterima selama test |
| `jimms_export_job_created` | Export job yang dibuat saat setup |
| `jimms_export_payload_archives` | Jumlah item `archive[]` yang dikirim saat setup |
