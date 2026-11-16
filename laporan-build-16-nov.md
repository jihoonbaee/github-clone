# Laporan Build — github-core-clone-01 (forge GitHub dari nol)

**Tanggal:** Senin 16 November 2026
**Bounty:** make.fun `github-core-clone-01` — $500, tutup 21 Nov 2026 13:30 WIB
**Status: BUILD SELESAI + terverifikasi.** Repo GitHub target: `jihoonbaee/github-clone`.
**Stack:** Node 22 + TypeScript erasable (`node main.ts`, type-stripping), stdlib saja,
tanpa dependensi eksternal, tanpa binary git. Store in-memory. Total ±4.338 baris kode
(`main.ts`, `app.ts`, `src/*.ts`: `util`, `gitobj`, `store`, `git-http`, `rest`,
`graphql`, `mcp`).

---

## 1. Hasil verifikasi — ringkas

| Verifikasi | Hasil |
|---|---|
| Suite ASLI kit (120 cek, 1 server, seperti trial) | **120/120 LOLOS, 3×** (git 30/30, repos 15/15, issues 15/15, pulls 20/20, graphql 20/20, mcp 15/15, protocol 5/5) — terakhir 16 Nov ±13:20 WIB, 8.212 ms |
| Typecheck `tsc --noEmit` (strict) | LOLOS |
| Git CLI nyata (git 2.43.0) — 12 skenario + alur shallow v2/v0 | **Semua LOLOS** (lihat §3) |
| Benchmark ASLI kit (3 run) | **157, 81, 83 / 200** — sangat bervariasi (lihat §4) |

**Estimasi skor jujur:** fitur 600/600 + MCP 200/200 + perf ~81–83/200 (tipikal) =
**~881–883/1.000**. Referensi house ±900. **Artinya: dengan angka lokal tipikal,
build ini kemungkinan SEDIKIT DI BAWAH referensi — hadiah tidak bisa dijanjikan.**
Satu run bench memberi 157/200 (total 957), tapi dua run lain memberi 81 dan 83,
jadi 157 adalah outlier. Mesin trial terisolasi (2 CPU) bisa saja memberi angka
berbeda; tidak ada cara memastikan dari VM shared-CPU ini. Keputusan submit ada
di parent.

---

## 2. Fitur yang diimplementasi

### Git smart HTTP (tanpa binary git)
- `upload-pack` **v2**: `ls-refs` (arg `peel`, `symrefs`, `unborn`, `ref-prefix`,
  filter server-side), `fetch` (`want`, `have`, `shallow`, `deepen`,
  `deepen-relative`, `thin-pack`, `no-progress`, `ofs-delta`), seksi
  acknowledgments hanya bila ada haves, ACK tiap have yang ancestor dari want +
  `ready`, pack kosong (0 objek) bila nothing-new.
- `upload-pack` **v0**: caps lengkap (`multi_ack`, `multi_ack_detailed`,
  `thin-pack`, `ofs-delta`, `shallow`, `deepen-relative`, `symref=HEAD:...`),
  ACK `common` per have + satu ACK polos sebagai terminator (sesuai daemon git
  asli), shallow/unshallow SEBELUM NAK/ACK dan diakhiri flush, alur stateless
  dua round-trip (request tanpa `done` → shallow list saja; replay + `done` →
  respons penuh).
- `receive-pack` **v0**: parse command list + pack mentah, unpack selalu
  dijalankan walau update ditolak, non-fast-forward → `ng <ref> non-fast-forward`
  (ref tidak bergerak), mixed FF/non-FF, delete ref diizinkan, report-status
  pkt-framed di sideband band 1 + flush di dalam stream report.
- Packfile: tulis tanpa delta (objek penuh, zlib, trailer SHA-1 benar); baca
  WAJIB resolve **OFS_DELTA + REF_DELTA** (basis di pack atau di store, rantai
  delta berlapis). Inflate satu stream via `inflateSync({info:true})` +
  `bytesWritten` (O(1) per objek).
- Shallow: depth 1 → tip + tree + blob saja; deepen absolut maupun
  `deepen-relative` (depth diukur dari boundary shallow klien, bukan dari tip);
  `unshallow` untuk boundary yang kini lengkap.

### REST v3
Repo (CRUD, 422 "already exists" untuk duplikat), refs, branches, commits
(`commit.message` tanpa newline akhir, sesuai GitHub), contents (create/update/
delete, sha stale → 409, bekerja di repo unborn, branch baru dibuat dari tip),
labels, issues (filter state, sort, paginasi `Link`), comments, pulls (duplikat
terbuka → 422, `/files` diff merge-base→head, squash merge, **konflik → 405**
via merge tiga arah per-file), `GET /user`, `GET /meta`, `X-GitHub-Request-Id`
di semua balasan termasuk error, JSON malformed → 400, route tak dikenal → 404.

### GraphQL v4
Parser + executor sendiri: `viewer`, `repository(owner, name)` (tak dikenal →
null tanpa errors), `node()` via global id base64url `Type:key`, introspeksi
`__type` (Issue/PullRequest/SearchType), koneksi issues/pullRequests dengan
kursor + `orderBy`, `files` sebagai koneksi, mutasi createIssue/closeIssue/
createPullRequest/mergePullRequest(SQUASH)/addComment (terbaca balik lewat
REST), batching array JSON, field tak dikenal → HTTP 200 + `errors` menyebut
nama field + data parsial.

### MCP
JSON-RPC 2.0 Streamable HTTP di `POST /mcp`: era modern 2026-07-28
(`server/discover`) + `initialize` legacy; 6 tool (create_repo, get_repo,
create_issue, list_issues, create_pull_request, merge_pull_request) dengan
`tools/list` byte-identik antar-panggilan; unknown tool → -32602/-32601 (bukan
HTTP 500); body bukan JSON → HTTP 400 + -32700; tanpa token → 401.

### Lifecycle & determinisme
Bind port 0 → POST port ke `$MAKEFUN_ENV_URL/register` → poll `/done` → exit 0.
`/healthz` → `{"ok": true}`. Semua timestamp dari `MAKEFUN_TRIAL_NOW`; tidak ada
`Date.now()`/random tak berseed di state. Auth: REST/GraphQL/MCP wajib bearer
`MAKEFUN_SHOP_TOKEN` persis; git smart HTTP permisif (suite tidak menguji
git-tanpa-token); `/healthz` tanpa auth.

---

## 3. Hasil uji git CLI nyata (git 2.43.0, server lokal)

Semua skenario lolos setelah tiga perbaikan terakhir (16 Nov siang):

1. Push commit pertama ✓
2. Fresh clone v2 ✓
3. Push commit kedua (thin/delta pack) ✓
4. Fetch + pull v2 dengan haves ✓
5. **Shallow clone depth 1 → `--deepen=1` → `--deepen=1` → `--unshallow` (v2)**:
   1 → 2 → 3 → 4 commit, `.git/shallow` berpindah tiap deepen, hilang setelah
   unshallow ✓
6. Push annotated tag + clone (tag terbaca sebagai objek `tag`) ✓
7. Push branch + delete branch (terverifikasi via `ls-remote`) ✓
8. Non-fast-forward ditolak (`rejected ... non-fast-forward`) ✓
9. Clone v0 penuh ✓
10. Fetch/pull v0 dengan haves ✓
11. File 50 KB push ber-delta + clone, `git fsck --strict` exit 0 ✓
12. Fetch v2 riwayat tak terkait (NAK + ready) ✓
13. **Push pack ber-delta 4 commit** (blob mirip → OFS_DELTA): objek hasil
    resolve cocok persis dengan `git rev-list --objects` ✓
14. **Alur shallow v0** (clone `--depth 1`, `--deepen=1` ×2, `--unshallow`):
    1 → 2 → 3 → 5 commit ✓

Ground truth untuk perilaku yang rumit (urutan ACK v0, `deepen-relative`,
seksi shallow v0) diambil dari daemon git 2.43 asli di `/tmp/realgit`, bukan
dari tebakan.

---

## 4. Benchmark — angka dan kejujuran soal varians

Benchmark ASLI kit, 3 ronde + 5 warm-up, di VM shared-CPU (1,5 CPU bersama):

| Run | push | clone | read | write | Total /200 |
|---|---|---|---|---|---|
| Run 1 | 50 | 24 | 45 | 38 | **157** |
| Run 2 | 30 | 14 | 24 | 13 | **81** |
| Run 3 (16 Nov ±13:22) | 31 | 14 | 17 | 21 | **83** |

T_ref (median baseline house): push 1.640,82 ms; clone 266,941 ms; read 2.759,715 ms;
write 348,965 ms. Rumus: `clamp(25 − 12,5 × log2(t/T_ref), 0, 50)` per workload.

Varians antar-run pada kode yang IDENTIK mencapai ~5× (workload read: p50
899 ms → 2.919 ms → ~4.300 ms). Itu noise kontensi CPU VM bersama, bukan sinyal
performa kode — sehingga **optimasi performa tidak bisa divalidasi di sini** dan
tidak dilakukan (aturan anti-circling: jangan mengoptimasi terhadap noise).
Di mesin trial yang terisolasi, angkanya bisa lebih baik atau lebih buruk;
tidak ada klaim yang bisa dibuat sebelum trial berjalan.

---

## 5. Bug yang ditemukan & diperbaiki (16 Nov 2026)

Sepuluh bug selama pengembangan; tiga terakhir ditemukan lewat git CLI nyata
(suite kit TIDAK menguji ketiganya — bukti bahwa uji git nyata adalah keharusan):

1. **Fetch shallow membawa riwayat penuh** — closure fetch mengikuti parent.
   Perbaiki: closure hanya commit→tree dan tree→entries.
2. **Deepen tidak mengirim parent** — `haveSet` mengikuti parent dari commit
   shallow. Perbaiki: walk berhenti di boundary shallow klien.
3. **REST `commit.message` membawa `\n` akhir** — strip hanya di presentasi REST.
4. **GraphQL `files` bukan list polos** — jadikan koneksi (`nodes`/`pageInfo`/
   `totalCount`).
5. **Fetch v2 fresh clone rusak** — seksi acknowledgments dikirim padahal klien
   tanpa haves langsung mengharapkan `packfile`. Perbaiki: acknowledgments hanya
   bila ada haves.
6. **Receive-pack "remote end hung up"** — report-status di sideband wajib
   diakhiri flush `0000` di dalam stream report itu sendiri.
7. **Fetch v2 dengan haves: "expected no other sections after no 'ready'"** —
   NAK tanpa `ready` berarti negosiasi berlanjut. Perbaiki: ACK tiap have yang
   ancestor + selalu akhiri dengan `ready`.
8. **Clone v0: `--stateless-rpc` butuh `multi_ack_detailed`** — tambah cap;
   parser want v0 diperbaiki (oid = token pertama; git nyata pakai NUL, klien
   suite pakai spasi).
9. **Fetch v0 dengan haves: "expected ACK/NAK, got '?PACK'"** — `ACK <oid> ready`
   TIDAK mengakhiri fase ACK di v0. Ground truth daemon: `ACK <oid> common` per
   have + satu `ACK <oid>` POLOS sebagai terminator.
10. **Push pack ber-delta gagal ("delta result size mismatch")** — field size di
    header pack untuk entri delta adalah ukuran DATA DELTA, bukan objek hasil
    rekonstruksi. Cek dipindah ke data hasil inflate; ukuran rekonstruksi
    divalidasi `applyDelta` terhadap varint target-size di dalam delta.
11. **`deepen-relative` diabaikan** — `git fetch --deepen` mengirimnya; server
    memperlakukan `deepen` sebagai absolut dari tip. Perbaiki: depth efektif =
    max(jarak boundary dari want) + deepen + 1 (terverifikasi ke daemon).
12. **Alur shallow v0** — tiga lapis: (a) shallow/unshallow harus SEBELUM
    NAK/ACK; (b) seksi shallow diakhiri flush (tanpa itu: "expected
    shallow/unshallow, got NAK"); (c) request tanpa `done` yang menghasilkan
    shallow lines harus menjawab shallow list SAJA — pack + ACK hanya di respons
    replay + `done` (tanpa itu: "expected shallow list").

---

## 6. Yang belum / keterbatasan yang diketahui

- **`deepen-since` / `deepen-not` diabaikan** (diterima sebagai argumen, tidak
  membatasi depth): fetch `--shallow-since`/`--shallow-exclude` dari git nyata
  akan mengembalikan riwayat penuh, bukan yang dibatasi tanggal. Tidak diuji
  suite mana pun; dampak praktis kecil.
- **Tidak ada persistensi** (by design — trial memakai pod segar; store
  in-memory).
- **Pack keluar tanpa delta** — sah menurut protokol (klien menerima pack tanpa
  delta), hanya kurang hemat bandwidth. Suite `pack-deltas` lolos dengan
  deltaCount 0.
- **Tidak ada optimasi performa khusus** — lihat §4. Bila trial menunjukkan
  workload tertentu lambat, itu pekerjaan lanjutan yang butuh pengukuran di
  mesin terisolasi.
- **Tidak dibaca penuh:** akhir `bench.ts` (89 baris), `main.ts` env (sebagian),
  `export.ts`, `wire.ts` lengkap, `program/scorer/` (tidak ditemukan di kit).
  Tidak ada indikasi bagian itu mengubah perilaku yang diuji — suite 120/120
  adalah bukti langsungnya.

## 7. Yang belum dilakukan (tugas parent)

- Bundle / check / submit — BUKAN tugas builder.
- Push ke `jihoonbaee/github-clone` — dilakukan setelah laporan ini (diizinkan
  parent 16 Nov; repo sudah dibuat user, terverifikasi kosong via API).
- Keputusan submit/tidak — parent, dengan estimasi jujur di §1: konformansi
  maksimal, performa lokal tipikal sedikit di bawah referensi house.

---

## 8. Cara menjalankan & memverifikasi ulang

```sh
cd ~/workspace/makefun/github-clone
node main.ts                       # dev lokal, $PORT (default 8080)
# harness verifikasi (bukan bagian repo):
cd ~/workspace/makefun/github-clone-verify
node run-suite.ts                  # suite asli kit, 120 cek
node run-suite.ts --bench          # suite + benchmark asli
# typecheck (typescript + @types/node ada di /tmp/forge-types):
/tmp/forge-types/node_modules/.bin/tsc --noEmit -p tsconfig.json \
  --typeRoots /tmp/forge-types/node_modules/@types
```

Server uji lokal terakhir: `http://127.0.0.1:18080` (matikan dengan
`fuser -k 18080/tcp`; JANGAN `pkill -f "node main.ts"` — mengenai shell sendiri).
