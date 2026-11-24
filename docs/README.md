# Saha Harita: frontend

Statik bir PWA. Derleme adımı yok. HTML, CSS ve JavaScript (ES modülleri) kullanır.

## Yerelde çalıştırma

ES modülleri `file://` üzerinden açılmadığı için `docs` klasörünü bir yerel sunucuyla açın:

```bash
cd docs
python3 -m http.server 8000
```

Tarayıcıda `http://localhost:8000` adresini açın. Konum ve servis çalışanı için
`https` veya `localhost` gerekir. Hesap gerektirmeyen demo modu varsayılandır (`config.js`).

## Ekranlar

- **Üst çubuk:** seçili ilçe ve mahalle, senkron durumu.
- **Konum çubuğu:** İlçe ve mahalle seçimi (son seçim IndexedDB'de hatırlanır), arama düğmesi.
- **Harita:** sokaklar (yeşil gezildi, kırmızı gezilmedi), işletmeler (renk durumdan gelir),
  gezi rotası, sabit renk açıklaması. "Adaylar" düğmesi OSM'deki restoran, fast food ve kafeleri
  gri halka olarak gösterir; "İşletme olarak ekle" ile listeye kopyalanır.
- **Liste:** İşletmeler (ilçe, mahalle, durum, platform filtresi; ada, son ziyarete veya takip
  tarihine göre sıralama; CSV indirme), Sokaklar, Mahalleler.
- **Panel:** bugünkü ziyaretler, günlük hedef (varsayılan 15), mahalle ve ilçe kapsamı, huni,
  dönüşüm oranı, bugün ve geciken takipler, günlük rapor (CSV).
- **Ayarlar:** takip ve kayıt ayarları, OSM verisi indirme, aday işletmeleri yenileme, dosyadan
  içe aktarma, mahalle ekleme, hesap.

Renkler: yeşil = gezildi / panel kuruldu, turuncu = ilgileniyor / kayıt / tekrar ziyaret,
kırmızı = gezilmedi / ziyaret edilmedi, gri = ilgilenmiyor.

## Mahalle verisi

- **Ayarlar > Seçili mahalle verisini indir (OSM):** sokakları ve aday işletmeleri OpenStreetMap
  verisinden (Overpass API) indirir ve bu cihazda saklar. İnternet gerekir.
- **Ayarlar > Dosyadan içe aktar:** `backend/import_osm.mjs` ile üretilen JSON dosyasını yükler.
- **Ayarlar > Mahalle ekle:** listede olmayan bir mahalleyi ilçesiyle birlikte ekler.
- Ümraniye'nin 37 mahallesi hazırdır. Üsküdar listesi henüz boştur; mahalleleri Ayarlar'dan ekleyin.

## Dışa aktarma

CSV dosyaları UTF-8 (BOM'lu) ve noktalı virgül ayraçlıdır. Excel'de Türkçe karakterler doğru
görünür. Liste ekranındaki "CSV indir" o anki filtreli listeyi, Panel'deki "CSV indir" seçilen
günün ziyaret, sokak ve gezi kayıtlarını indirir.

## Supabase'e bağlama

1. `config.js` dosyasında `SUPABASE_URL` ve `SUPABASE_ANON_KEY` değerlerini doldurun
   (yalnızca anon anahtarı, service role asla).
2. `DEMO_MODE` değerini `false` yapın.
3. Uygulamayı açın, e-postanıza gelen bağlantıyla giriş yapın, ekibinizi seçin.

**Önemli:** İşletmelere iki isteğe bağlı sütun eklendi (`follow_up_tarih`, `son_ziyaret`).
Bağlamadan önce Supabase'de bir kez çalıştırın, yoksa gönderim kuyruğu takılır:

```sql
alter table public.isletmeler
  add column if not exists follow_up_tarih date null,
  add column if not exists son_ziyaret timestamptz null;
```

Veri önce IndexedDB'ye yazılır, sonra gönderim kuyruğuna (outbox) eklenir. Çevrimiçiyken
kuyruk Supabase'e gönderilir. Durum rozeti: çevrimdışı, bekleyen değişiklik sayısı veya senkron.

## Yayınlama (statik host)

Tüm `docs` klasörü statik olarak yayınlanabilir (GitHub Pages, Cloudflare Pages, Netlify).
Build komutu gerekmez. Dosyalar değiştiğinde `sw.js` içindeki `SHELL_VERSION` değerini artırın.
Böylece cihazlar yeni sürümü alır.

## Testler

```bash
cd docs
npm test
```

Testler `node:test` ile yazılmıştır: geometri, outbox sırası, durum geçişleri, GPS kayıt aralığı,
Overpass ayrıştırma, içe aktarma, ilçe ve mahalle seçimi, takip tarihleri, günlük hedef, huni,
dönüşüm, benzer işletme kontrolü, filtre ve sıralama, CSV kaçışları ve BOM, günlük rapor satırları.
