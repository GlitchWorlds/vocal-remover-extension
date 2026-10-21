# Smart Adaptive Vocal Remover — Chrome Extension (MV3) v2.0.0

Ekstensi Chrome Manifest V3 untuk menghapus vokal dari audio tab browser (Spotify Web, YouTube, dll.) secara real-time dengan teknologi **Hybrid 3-Band Linkwitz-Riley (LR4) Crossover, Center Channel Cancellation, dan Haas Stereo Decorrelation**.

## Mengapa Versi v1 Bermasalah & Apa Solusinya di v2?

### Permasalahan pada v1:
1. **Suara Musik Keganggu / Tipis / Pecah**:
   - Pada v1, channel Mid disaring melalui belasan biquad peaking filter bertingkat (*cascaded*). Setiap filter memutar fasa audio hingga puluhan derajat.
   - Saat channel Mid digabung kembali dengan channel Side yang tidak disaring, terjadi bentrokan fasa parah (*phase cancellation* destruktif). Akibatnya instrumen stereo (gitar, synth, piano) terdengar hampa, melayang, dan kehilangan artikulasi.
2. **Suara Vokal Masih Ada**:
   - Filter notch harmonik sempit hanya memotong frekuensi pas di garis tipis nada $f_0$. Karakter vokal modern memiliki lebar formant, vibrato, dan reverb panned yang tidak tertangkap oleh filter sempit, sehingga vokal masih bocor terdengar.

### Solusi Total di v2.0.0:
1. **3-Band Linkwitz-Riley (LR4) Phase-Aligned Crossover**:
   - **Bass Band (< 140 Hz)**: Seluruh dentuman kick drum dan bass guitar dilewatkan **100% utuh dalam stereo asli**. Tidak ada pemotongan frekuensi rendah, sehingga beat musik tetap bertenaga, punchy, dan solid.
   - **Treble / Air Band (> 7200 Hz)**: Desis simbal, hi-hats, dan sparkle frekuensi tinggi dilewatkan **100% utuh**.
   - **Vocal Band (140 Hz s/d 7200 Hz)**: Area di mana vokal manusia berada diproses secara terisolasi. Seluruh sinyal melewati filter LR4 24 dB/oktaf yang identik sehingga fasa antara Left dan Right **100% sejajar tanpa distorsi fasa**.
2. **Symmetric Vocal Band Center Suppression**:
   - Pada Vocal Band, sinyal dipecah menjadi:
     $$\text{Center} = \frac{L_{\text{mid}} + R_{\text{mid}}}{2}, \quad \text{Side} = \frac{L_{\text{mid}} - R_{\text{mid}}}{2}$$
   - Vokal utama yang dipan di tengah ditiadakan secara drastis: $\text{Center}' = \text{Center} \times (1 - \text{strength})$.
3. **Adaptive Residual Pitch Notch**:
   - Detektor pitch YIN mendeteksi nada vokal penyanyi ($f_0$) setiap 75 ms.
   - Filter notch adaptif dipasang pada bus Center untuk menyapu sisa-sisa resonansi vokal fundamental dan harmoniknya tanpa menyentuh instrumen stereo.
4. **Haas Effect Stereo Decorrelation (Anti-Hollow)**:
   - Pada pembatalan vokal biasa ($L = S, R = -S$), telinga manusia mengalami sensasi tekanan kepala yang aneh karena fasa 180 derajat terbalik.
   - Di v2.0, jalur Right Side diberi delay mikro Haas sebesar **0.33 ms** (16 sampel pada 48kHz). Ini memecah phase-lock sehingga instrumen pengiring (gitar, piano, keyboard) terdengar lebar, hangat, alami, dan bebas rasa hampa.

---

## Cara Install di Chrome

1. Buka Google Chrome dan masuk ke `chrome://extensions`.
2. Aktifkan sakelar **Developer mode** di pojok kanan atas.
3. Klik tombol **Load unpacked** di pojok kiri atas.
4. Pilih folder:
   `D:\OpenClaw\master-manager-agent\projects\vocal-remover-extension`
5. Buka tab [open.spotify.com](https://open.spotify.com) dan putar lagu apa saja.
6. Klik ikon ekstensi di toolbar Chrome, lalu aktifkan toggle switch ke posisi **ON**.

---

## Kontrol & Fitur

- **ON / OFF Switch**: Mengaktifkan atau menonaktifkan penghapusan vokal.
- **Removal Strength Slider (0–100%)**: Default diset ke **95%** untuk peredaman vokal maksimal dengan bass dan beat instrumen yang tetap utuh.
- **Detected Vocal Pitch Meter**: Menampilkan not musik, frekuensi real-time (Hz), serta tingkat keyakinan deteksi pitch secara live.
- **Output Level Meter**: Indikator kekuatan level suara yang keluar.
