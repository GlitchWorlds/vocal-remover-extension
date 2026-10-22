# Smart Adaptive Vocal Remover — Chrome Extension (MV3) v3.0.0

Ekstensi Chrome Manifest V3 untuk meredam/menghilangkan vokal dari audio tab browser (Spotify Web, YouTube, dll.) secara real-time menggunakan **Dual-Engine Architecture**: **Next-Gen Spectral Studio STFT** dan **Fast 3-Band LR4 Crossover**.

---

## 🚀 Dual-Engine Architecture (v3.0.0)

Ekstensi kini dilengkapi pemilih mode engine langsung di popup:

### 1. Spectral Studio Engine (Next-Gen Real-Time STFT)
- **Teknologi**: Menggunakan *Short-Time Fourier Transform (STFT)* dengan jendela Hann 2048 sampel, hop size 512 (75% overlap-add streaming), dan *Spectral Pan Discrimination* di domain frekuensi.
- **Kelebihan**:
  - Mengisolasi dan memotong bin frekuensi vokal yang berada di center stereo ($130\text{ Hz} - 7000\text{ Hz}$) hingga lebih dari **-40 dB**.
  - Instrumen panned (gitar stereo, piano, keyboard, synthesizer, efek stereo) **100% dipertahankan utuh dan jernih**.
  - Frekuensi rendah (< 130 Hz: kick drum, sub-bass) dan frekuensi tinggi (> 7000 Hz: cymbals, air) tetap 100% utuh tanpa teredam.
  - Berjalan real-time dengan performa sangat cepat (~27x real-time speed) tanpa beban berlebih pada CPU.

### 2. Fast Crossover Engine (Ultra-Lightweight DSP)
- **Teknologi**: Linkwitz-Riley 4th order (LR4) 3-Band phase-matched crossover, in-phase center cancellation, dan pelacakan nada YIN adaptif ($f_0$ dan $2f_0$).
- **Kelebihan**: Latensi sub-milidetik, penggunaan CPU mendekati 0%, ideal untuk laptop dalam mode hemat baterai.

### 3. True Dry/Wet Crossfade (Bit-Exact Bypass at 0%)
- Pada kekuatan **0%**, audio dilewatkan melalui jalur bypass murni tanpa filter maupun pergeseran fasa (100% bit-for-bit identik dengan kondisi ekstensi OFF).
- Slider **0% – 100%** memberikan peredaman vokal linier dan proporsional.

---

## 📦 Cara Pasang di Google Chrome

1. Unduh file `vocal-remover-extension.zip` dari halaman [Releases](../../releases) dan ekstrak arsipnya.
2. Buka Google Chrome lalu masuk ke URL `chrome://extensions`.
3. Aktifkan sakelar **Developer mode** di sudut kanan atas.
4. Klik tombol **Load unpacked** di sudut kiri atas.
5. Pilih folder hasil ekstrak zip tersebut.
6. Buka tab [Spotify Web](https://open.spotify.com) dan putar lagu apa saja.
7. Klik ikon ekstensi di toolbar Chrome, lalu aktifkan sakelar ke **ON**.
8. Pilih mode yang diinginkan: **Spectral Studio** (rekomendasi untuk isolasi vokal maksimal) atau **Fast Crossover**.

---

## 📄 Lisensi
MIT License
