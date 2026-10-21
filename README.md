# Smart Adaptive Vocal Remover — Chrome Extension (MV3)

Ekstensi Chrome Manifest V3 untuk menghapus vokal musik di tab browser (Spotify Web, YouTube, dll.) secara real-time dengan **pitch tracking adaptif**. Algoritma secara otomatis menyesuaikan frekuensi filter dengan rentang vokal dan nada penyanyi (bass, bariton, tenor, alto, sopran) tanpa merusak beat dan bass instrumen.

## Arsitektur Audio DSP (5 Lapis)

1. **Mid / Side Matrix Split**:
   - Audio stereo tab didekomposisi menjadi `Mid = (L + R) / 2` (posisi center di mana vokal utama berada) dan `Side = (L - R) / 2` (instrumen panned stereo seperti gitar, synth, dan reverb).
   - Jalur Side dilewatkan 100% utuh tanpa modifikasi, mempertahankan lebar panggung stereo instrumen.
2. **Vocal Sidechain Pre-Filter untuk Pitch Tracking**:
   - Sinyal Mid dialirkan ke rangkaian filter isolasi vokal (Highpass 110 Hz 4th order + Lowpass 1300 Hz) sebelum masuk ke penganalisis.
   - Sub-bass, dentuman kick drum, dan desis simbal dieliminasi dari jalur analisa, memastikan detektor pitch mengunci nada fundamental penyanyi ($f_0$) murni.
3. **YIN Pitch Detection & Auto-Tracking**:
   - Mendeteksi frekuensi fundamental ($f_0$) dalam rentang 75 Hz – 1100 Hz setiap 75 ms.
   - Smooth tracking membedakan antara vibrato halus dan lompatan melodi nada baru.
4. **Dynamic Harmonic Comb Filter (14 Harmonik) & Formant Suppression**:
   - 14 notch filter biquad digerakkan otomatis ke frekuensi harmonik ($f_0, 2f_0, 3f_0, \dots, 14f_0$) dengan kedalaman adaptif.
   - Redaman vokal Mid band diperdalam (-20 dB s/d -30 dB).
   - Dilengkapi *Bass Restoration Low-Shelf* (<130 Hz) agar dentuman kick drum dan alur bass gitar tetap bertenaga, serta *High-Shelf* (>7500 Hz) untuk menjaga artikulasi treble.
5. **Stereo Reconstruction & Transparent Limiter**:
   - Audio digabungkan kembali: `Out_L = Mid' + Side` dan `Out_R = Mid' - Side`.
   - Limiter `DynamicsCompressor` di ujung output mencegah terjadinya distorsi atau clipping audio.

## Cara Install di Chrome

1. Buka browser Google Chrome dan buka alamat `chrome://extensions`.
2. Aktifkan sakelar **Developer mode** di pojok kanan atas.
3. Klik tombol **Load unpacked** di pojok kiri atas.
4. Pilih folder:
   `D:\OpenClaw\workspace\master-manager-agent\projects\vocal-remover-extension`
5. Buka tab Spotify Web di [open.spotify.com](https://open.spotify.com) dan putar lagu.
6. Klik ikon ekstensi di toolbar browser, lalu aktifkan toggle switch ke posisi **ON**.

## Kontrol & Fitur

- **ON / OFF Switch**: Mengaktifkan atau menonaktifkan proses penghapusan vokal.
- **Removal Strength Slider (0–100%)**: Mengatur seberapa dalam vokal diredam (default 85%).
- **Detected Vocal Pitch Meter**: Menampilkan not musik, frekuensi real-time (Hz), serta tingkat keyakinan deteksi pitch.
- **Output Level Meter**: Indikator kekuatan level suara yang keluar.

## Catatan Teknis & Batasan Transparan

- Pendekatan DSP real-time Web Audio API memotong vokal center secara drastis, namun backing vocal stereo lebar atau ekor reverb studio yang dipan ke kiri/kanan ekstrem secara fisik masih dapat terdengar samar.
- Pada Spotify Web, pastikan tab Spotify memutar audio secara aktif. Jika Chrome Anda menerapkan isolasi DRM Widevine ketat pada tabCapture, coba putar lagu di YouTube sebagai pembanding kontrol.
