# BitChord FLAC Addon (Internet Archive)

Addon BitChord yang bagi **FLAC lossless sebenar** dari Internet Archive. Bukan convert MP3/AAC jadi FLAC (tu tak jadi lossless pun).

- Semak header FLAC sebelum bagi pada BitChord, dan baca sample rate / bit depth betul-betul (contoh: `Lossless · 16-bit / 44.1 kHz`, atau `Hi-Res Lossless · 24-bit / 96 kHz`).
- Fail audio terus dari archive.org, tak lalu server kau.
- Tiada dependency. Perlu Node 20+.

## Apa yang korang akan jumpa

Internet Archive banyak: rakaman konsert live (etree), klasik, jazz lama, netlabel/indie Creative Commons, public domain.
Dia **tak ada** lagu pop komersial terkini. Kalau tak jumpa, BitChord auto jatuh ke source lain (YouTube Music dan sebagainya).

## Jalankan di PC (cuba dulu)

```
node server.mjs
```

Buka `http://localhost:8787/manifest.json` untuk check. Cuba `http://localhost:8787/search?q=beethoven`.

## Tambah dalam BitChord

BitChord Android wajib HTTPS. BitChord PC/desktop (fork Inventor365) mungkin terima `http://localhost:8787` terus, cuba paste dulu:

**Settings > Sources > Add an addon** > paste `http://localhost:8787`

Kalau ditolak (atau untuk Android), kau perlukan URL HTTPS. Dua cara senang:

1. **Cloudflare Tunnel** (percuma, tanpa deploy):
   `cloudflared tunnel --url http://localhost:8787` > dia bagi URL `https://xxxx.trycloudflare.com`. PC kena hidup masa dengar.
2. **Render / Railway / Fly** (jalan 24 jam): push folder ni ke GitHub, buat Web Service, Start Command `npm start`. Free tier Render tidur bila lama tak guna, request pertama lambat sikit.

Lepas add, **seret addon ni ke paling atas** dalam senarai Sources supaya dia dicuba dulu.

## Tetapan (environment variable)

| Variable | Default | Fungsi |
| --- | --- | --- |
| `PORT` | 8787 | Port server |
| `ALLOW_DOWNLOADS` | 1 | `0` = stream sahaja, tak boleh download |
| `CHECK_VALID_LOSSLESS` | 0 | `1` = guna addon ni hanya bila ada output lossless (wired, USB DAC, LDAC). Android sahaja |
| `SERVE_FLAC_ON_LOW` | 0 | `1` = bagi FLAC walaupun BitChord minta tier LOW (data terhad) |
| `EXCLUDE_WORDS` | jazz,classical,concert,etree,gratefuldead,symphony,orchestra,opera,live at,live in,live from | Item Internet Archive yang tajuk/subject/koleksinya ada perkataan ni dilangkau. Asing dengan koma. `none` = matikan penapis |
| `ADDON_ID` / `ADDON_NAME` | ada | Tukar kalau nak |
| `BITCHORD_AUTH` | 0 | Lihat bahagian bawah |

## Kunci addon untuk app BitChord rasmi sahaja (pilihan)

Default-nya mati, supaya addon boleh guna di Android dan PC. **Kalau kau hidupkan, versi PC/desktop dan fork tak boleh guna addon ni** (docs BitChord: hanya app Android rasmi boleh buat proof tu).

Kalau nak juga:
1. Download `bitchord-addon-auth.mjs` dari https://bitchord.kushagrasingh.in/docs (bahagian Addon auth), letak sebelah `server.mjs`. Jangan edit.
2. Set `BITCHORD_AUTH=1` dan `PUBLIC_HOST=nama.host.kau` (tanpa https://, tanpa port).

## Tak jumpa lagu?

- Cuba cari guna nama artis + tajuk dalam English.
- Test terus: `/search?q=nama`.
- Log server tunjuk kalau archive.org down.

## Pengesahan Lossless (v1.1.0)

- BitChord kini memaparkan pemilih **Audio quality**: Lossless (FLAC), High (FLAC fallback), dan Low (guna source lain).
- Carian hanya memulangkan trek yang lulus semakan header FLAC sebenar (marker `fLaC` dan blok STREAMINFO 34-byte).
- Endpoint stream membuat pengesahan semula sebelum memulangkan URL audio. Jika pengesahan gagal atau tidak dapat dicapai, addon menolak stream supaya audio yang belum disahkan tidak dilabel Lossless.
- Sample rate dan bit depth dibaca daripada STREAMINFO, bukan diteka daripada nama fail.

**Had penting:** addon ini mencari fail FLAC sebenar di Internet Archive. Ia tidak menukar MP3, AAC, Opus atau audio YouTube menjadi Lossless. Ketersediaan lagu komersial semasa adalah terhad.
