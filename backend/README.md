# Saha Harita - Backend kurulumu (adım adım)

Bu klasör veritabanı (Supabase), sokak verisi indirme komutu ve mahalle listesini içerir.
Hiçbir adım için programcılık bilgisi gerekmez. Her adımı sırayla yapın.

## Ne var, ne işe yarar

| Dosya | Ne işe yarar |
|---|---|
| `migrations/001_init.sql` | Veritabanı tablolarını, güvenlik kurallarını ve otomatik alanları kurar. Supabase'de bir kez çalıştırılır. |
| `seed/umraniye_mahalleler.csv` | Ümraniye mahalle listesi (37 ad). |
| `import_osm.mjs` | Bir mahallenin sokaklarını OpenStreetMap'ten indirir ve `out/` klasörüne yazar. İstenirse Supabase'e de yükler. |
| `out/` | İndirilen sokak dosyaları (otomatik oluşur, git'e girmez). |

> **Mahalle listesi hakkında not:** `seed/umraniye_mahalleler.csv` içindeki liste İngilizce Wikipedia maddesi ile bir internet portalından derlendi. Ümraniye Belediyesi'nin resmi listesiyle **doğrulanmadı**. Mahalle adlarında yazım farkı olabilir. Sonradan resmi listeyle karşılaştırın.

---

## Adım 1: Node.js kurun (bilgisayarınızda, bir kez)

Sokak verisini indirme komutu Node.js ile çalışır.

1. https://nodejs.org adresine gidin.
2. **LTS** sürümünü indirip kurun (sürüm 18 veya üstü olmalı).
3. Kontrol için bir terminal (Windows: PowerShell, Mac: Terminal) açıp şunu yazın:
   ```
   node --version
   ```
   `v18` veya daha yüksek bir sürüm görmelisiniz.

---

## Adım 2: Ücretsiz Supabase projesi oluşturun

1. https://supabase.com adresine gidin ve ücretsiz hesap açın.
2. **New project** düğmesine basın.
3. Bir proje adı verin (ör. `saha-harita`), bir **veritabanı şifresi** belirleyin ve güvenli bir yere kaydedin.
4. Size en yakın bölgeyi seçin ve projenin hazır olmasını bekleyin (birkaç dakika).

> Ücretsiz planda bir proje uzun süre kullanılmazsa Supabase onu duraklatabilir. Duraklarsa panelden yeniden başlatın.

---

## Adım 3: Veritabanı tablolarını oluşturun (migration 001)

1. Supabase panelinde sol menüden **SQL Editor** seçin, sonra **New query**.
2. Bilgisayarınızda `backend/migrations/001_init.sql` dosyasını bir metin editörüyle açın, **tüm içeriğini kopyalayın**.
3. SQL Editor'e yapıştırın ve **Run** düğmesine basın.
4. Altta "Success" benzeri bir mesaj görmelisiniz.

Hata alırsanız dosyayı yeniden çalıştırmak güvenlidir. Komutlar bir kez daha çalışsa da zarar vermez.

---

## Adım 4: Kendi kullanıcınızı oluşturun

Uygulamaya giriş yapmak için bir e-posta ve şifreniz olmalı.

1. Sol menüden **Authentication** → **Users** → **Add user** → **Create new user**.
2. E-postanızı ve bir şifre girin.
3. **Auto Confirm User** kutusunu işaretleyin ve kaydedin.

---

## Adım 5: Takım oluşturun ve kendinizi takıma ekleyin

Uygulama, verileri takım bazında gösterir. Takımı ve üyeliğinizi SQL ile bir kez oluşturun.

1. **SQL Editor** → **New query**. Aşağıdaki satırı çalıştırın (takım adını dilediğiniz gibi değiştirebilirsiniz):

   ```sql
   insert into public.teams (name) values ('Saha Ekibi') returning id;
   ```

2. Sonuç tablosunda çıkan `id` değerini kopyalayın. Bu sizin **TEAM_ID**'nizdir. Bir yere not edin.

3. Kendi kullanıcı kimliğinizi bulun. `SENIN@EPOSTAN.COM` yerine Adım 4'te kullandığınız e-postayı yazın:

   ```sql
   select id from auth.users where email = 'SENIN@EPOSTAN.COM';
   ```

   Çıkan `id` değerini kopyalayın.

4. Kendinizi takımın yöneticisi olarak ekleyin. Yukarıdaki iki değeri yerlerine yazın:

   ```sql
   insert into public.team_members (team_id, user_id, role)
   values ('TAKIM-ID-BURAYA', 'KULLANICI-ID-BURAYA', 'admin');
   ```

Bu adımları bir kez yapmanız yeterli. Takım satırını ikinci kez eklemeyin, aksi halde iki ayrı takım oluşur.

---

## Adım 6: Anahtarları frontend'e koyun (anon key)

1. Supabase panelinde **Project Settings** (dişli simge) → **API** sayfasına gidin.
2. Şu iki değeri kopyalayın:
   - **Project URL** (ör. `https://xxxx.supabase.co`)
   - **anon public** anahtarı (`anon` / `public` yazan olan)
3. Bilgisayarınızda `app/config.js` dosyasını açın ve şu alanları doldurun:
   ```js
   window.SAHA_CONFIG = {
     SUPABASE_URL: "https://xxxx.supabase.co",
     SUPABASE_ANON_KEY: "buraya-anon-anahtari",
     TEAM_ID: "buraya-TEAM_ID",
     DEMO_MODE: false   // gerçek senkronizasyon için false
   };
   ```
   `DEMO_MODE: true` iken uygulama yalnızca cihazda çalışır, Supabase'e bağlanmaz.

Anon anahtarı herkese açık olabilir. Güvenliği tablo kuralları sağlar.

---

## Adım 7: Servis anahtarı (service role key) nereye konur

Sokak verisini Supabase'e yüklemek için **service_role** anahtarı gerekir. Bu anahtar tam yetkilidir ve kuralları atlar.

1. **Project Settings** → **API** → **service_role** satırındaki anahtarı kopyalayın.
2. `backend/` klasöründe `.env` adında bir dosya oluşturun ve şunu yazın:

   ```
   SUPABASE_URL=https://xxxx.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=buraya-service-role-anahtari
   TEAM_ID=buraya-TEAM_ID
   ```

**Kurallar:**
- Bu anahtarı **asla** `app/` klasörüne, `config.js` dosyasına, bir web sayfasına veya herhangi bir ekran görüntüsüne koymayın.
- `.env` dosyası `.gitignore` ile git'ten dışlanmıştır. Yine de bu dosyayı kimseyle paylaşmayın ve başka bir yere kopyalamayın.
- Anahtar yanlışlıkla sızarsa Supabase panelinden anahtarı yenileyin ve `.env` dosyasını güncelleyin.

---

## Adım 8: Mahalle sokaklarını indirin

Terminali `backend` klasöründe açın. Windows'ta klasörü Dosya Gezgini'nde açıp adres çubuğuna `cmd` yazarsanız terminal o klasörde açılır.

**Yalnızca bilgisayara kaydetmek için:**
```
node import_osm.mjs "Atakent"
```
Sonuç: `out/atakent.json` dosyası.

**Hem bilgisayara hem Supabase'e yüklemek için:**
```
node import_osm.mjs "Atakent" --supabase
```
`.env` dosyası dolu olmalıdır (Adım 7).

Her mahalle için bu komutu çalıştırın. Mahalle adları `seed/umraniye_mahalleler.csv` içindeki adlarla aynı yazılmalıdır, tırnak içinde yazın. Örnek: `"Yukarı Dudullu"`, `"Fatih Sultan Mehmet"`.

Notlar:
- İndirme, OpenStreetMap'in herkese açık Overpass sunucusundan yapılır. Her komut 10-60 saniye sürebilir.
- Art arda çok hızlı komut çalıştırmayın. **"hız sınırı (HTTP 429)"** hatası alırsanız birkaç dakika bekleyip aynı komutu tekrar çalıştırın. Betik kendisi de kısa süre bekleyip bir kez daha dener.
- "sınırı bulunamadı" hatası alırsanız mahalle adını CSV'deki yazımla karşılaştırın (ör. "Atakent Mahallesi" gibi).
- Bir mahalleyi yeniden indirmek güvenlidir. Daha önce **gezildi** olarak işaretlenmiş sokaklar korunur, yalnızca harita verisi güncellenir.

Supabase'de kontrol: **Table Editor** → `mahalleler` ve `sokaklar` tablolarında satırları görmelisiniz.

---

## Sorun giderme

| Görülen hata | Anlamı ve çözümü |
|---|---|
| `node` tanınmıyor | Node.js kurulumu (Adım 1) eksik ya da terminali yeniden açmanız gerekiyor. |
| `--supabase için şu ortam değişkenleri eksik` | `backend/.env` dosyası yok ya da boş. Adım 7'yi kontrol edin. |
| `TEAM_ID geçerli bir UUID değil` | `.env` içindeki TEAM_ID'yi Adım 5'teki değerle karşılaştırın. |
| `permission denied` ya da satır eklenmiyor | Kullanıcınız takıma eklenmemiş. Adım 5'i kontrol edin. |
| `Overpass hız sınırına takıldı` | Birkaç dakika bekleyin, tekrar deneyin. |

---

## Çevrimdışı senkron

Uygulama çevrimdışıyken yapılan değişiklikler cihazda bir kuyrukta (outbox) bekler, internet gelince gönderilir. Aynı satır başka bir cihazda daha sonra değiştiyse hangisinin geçerli olacağı **düzenleme zamanına** göre belirlenir (son yazan kazanır, LWW).

Sözleşme (frontend için):
- Her outbox kaydı, değişikliğin yapıldığı anın zamanını `updated_at` olarak göndermelidir (ISO 8601, UTC, ör. `2026-11-23T10:00:00.000Z`). Sunucu zamanı yalnızca değer hiç gönderilmemişse kullanılır.
- Sunucudaki satırın `updated_at` değeri gönderilen değerden yeniyse veya eşitse, güncelleme sessizce atlanır. Hata dönmez, satır değişmez. Yeni sunucu değeri realtime ile cihaza gelir.
- Gönderilen zaman sunucu saatinden ileriyse sunucu kendi zamanını yazar.
- `ziyaretler` tablosunda `updated_at` yoktur, bu kural ona uygulanmaz (yalnızca ekleme yapılır).

Bu kural `sokaklar` ve `isletmeler` tablolarında geçerlidir. Veritabanı kontrolü `guard_last_write_wins` tetikleyicisiyle yapılır.

## Sonraki adım: sertacgungor.com ile entegrasyon (şimdilik kapsam dışı)

Bu entegrasyon bu aşamada yapılmayacak. Gerektiğinde yapılacaklar şunlardır:
- `app/` klasörünün statik dosyaları sertacgungor.com üzerinde bir alt klasöre yüklenir (uygulama HTML/JS olduğu için sunucu kodu gerekmez).
- Supabase panelinde **Authentication** → **URL Configuration** bölümüne sitenin adresi eklenir (girişten sonra yönlendirme için).
- Uygulama HTTPS üzerinden sunulmalıdır; service worker (çevrimdışı çalışma) için bu zorunludur.

---

## Güvenlik özeti

- `anon` anahtarı: frontend'de (`app/config.js`) kullanılır, herkese açık olabilir.
- `service_role` anahtarı: yalnızca `backend/.env` dosyasında, yalnızca import betiği için. Asla frontend'e ya da git'e girmez.
- Veri erişimi tablo kuralları (RLS) ile takım üyeliğine göre kısıtlanmıştır. Bir takımın verisini başka takım göremez.
