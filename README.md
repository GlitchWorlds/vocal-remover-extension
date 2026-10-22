# Smart Adaptive Vocal Remover — Chrome Extension (MV3)

Ekstensi Chrome Manifest V3 untuk meredam vokal dari audio tab browser (Spotify Web, YouTube, dll.) secara real-time menggunakan arsitektur **3-Band Phase-Matched Crossover, In-Phase Center Cancellation, dan True Dry/Wet Crossfade**.

## Fitur Utama

1. **True Dry/Wet Crossfade (Zero Difference at 0%)**:
   - Jalur Dry murni melewatkan audio asli tanpa filter atau pergeseran fasa.
   - Pada kekuatan 0%, output audio identik dengan kondisi ekstensi mati (bypass).
   - Pengaturan persentase redaman (0% – 100%) bekerja secara linier dan proporsional.

2. **In-Phase Difference Processing (Instrumen Tetap Utuh)**:
   - **Bass Band (< 130 Hz)**: Kick drum dan bass guitar dilewatkan 100% utuh dalam stereo asli.
   - **Treble Band (> 7000 Hz)**: Simbal dan hi-hats dilewatkan 100% utuh dalam stereo asli.
   - **Vocal Band (130 Hz s/d 7000 Hz)**: Vokal center ditiadakan menggunakan selisih in-phase `(L - R) / 2` ke kedua kanal. Tidak ada phase-cancellation destruktif di speaker ruangan maupun headphone, sehingga instrumen pengiring tetap tebal, jernih, dan bertenaga.

3. **Adaptive Pitch Tracking**:
   - Detektor pitch YIN mendeteksi nada vokal penyanyi ($f_0$) secara berkala untuk meredam sisa resonansi vokal pada jalur Wet.

---

## Cara Pasang di Google Chrome

1. Unduh arsip `vocal-remover-extension.zip` dari halaman [Releases](../../releases) dan ekstrak filenya.
2. Buka Google Chrome lalu masuk ke URL `chrome://extensions`.
3. Aktifkan sakelar **Developer mode** di sudut kanan atas.
4. Klik tombol **Load unpacked** di sudut kiri atas.
5. Pilih folder hasil ekstrak zip tersebut.
6. Buka tab [Spotify Web](https://open.spotify.com) dan putar lagu.
7. Klik ikon ekstensi pada toolbar Chrome, lalu aktifkan sakelar ke posisi **ON**.

---

## Lisensi
MIT License
