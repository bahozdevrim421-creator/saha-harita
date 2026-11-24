# Saha Harita: frontend

Statik bir PWA. Derleme adımı yok. HTML, CSS ve JavaScript (ES modülleri) kullanır.

## Yerelde çalıştırma

ES modülleri `file://` üzerinden açılmadığı için klasörü bir yerel sunucuyla açın:

```bash
cd app
python3 -m http.server 8000
```

Tarayıcıda `http://localhost:8000` adresini açın. Konum ve servis çalışanı için
`https` veya `localhost` gerekir.

Hesap gerektirmeyen demo modu varsayılandır (`config.js` içinde `DEMO_MODE: true`).
Mahalle listesi (37 mahalle) otomatik yüklenir, sokaklar yoktur. "+ Sokak" ile haritaya
dokunarak test sokağı ekleyebilirsiniz. Sokaklar yeşil (gezildi) veya kırmızı (gezilmedi) görünür.

## Mahalle verisi

- **Ayarlar > Seçili mahalle verisini indir (OSM):** OpenStreetMap verisini Overpass API
  üzerinden tarayıcıdan indirir ve bu cihazda saklar. İnternet gerekir.
- **Ayarlar > Dosyadan içe aktar:** `backend/import_osm.mjs` ile üretilen JSON dosyasını yükler.

## Supabase'e bağlama

1. `config.js` dosyasında `SUPABASE_URL` ve `SUPABASE_ANON_KEY` değerlerini doldurun
   (yalnızca anon anahtarı, service role asla).
2. `DEMO_MODE` değerini `false` yapın.
3. Uygulamayı açın, e-postanıza gelen bağlantıyla giriş yapın, ekibinizi seçin.

Veri önce IndexedDB'ye yazılır, sonra gönderim kuyruğuna (outbox) eklenir. Çevrimiçiyken
kuyruk Supabase'e gönderilir. Durum rozeti: çevrimdışı, bekleyen değişiklik sayısı veya senkron.

## Yayınlama (statik host)

Tüm `app/` klasörü statik olarak yayınlanabilir: Cloudflare Pages, Netlify veya sertacgungor.com
altındaki bir klasör. Build komutu gerekmez, çıkış klasörü `app` olur.

Dosyalar değiştiğinde `sw.js` içindeki `SHELL_VERSION` değerini artırın. Böylece cihazlar
yeni sürümü alır.

## Testler

```bash
cd app
npm test
```

Testler `node:test` ile yazılmıştır ve geometri, outbox sırası, durum geçişleri, GPS
kayıt aralığı, Overpass ayrıştırma ve içe aktarma kurallarını kapsar.
