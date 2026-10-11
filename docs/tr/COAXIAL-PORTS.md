# Deneysel koaksiyel TEM portları

Bu uygulama taslak bir yetenektir; genel kullanımı doğrulanmış bir port modeli değildir.
Doğrudan `openEMS.AddCoaxialPort` kullanır, ayrık portla değiştirmez. Windows'ta oluşturma ve
sınırlı hava dolgulu hat kontrolleri denenmiştir. macOS, GPU motorları, dielektrik dolgulu hatlar
ve genel RF yapıları yayımdan önce ayrıca doğrulanmalıdır.

Çalıştırma API'si koaksiyel port içeren GPU çalıştırmalarını reddeder. CUDA veya Metal'in mevcut
olması radyal uyarım ve iletim hattı problarının eşdeğerliğini doğrulamaz. CPU yolu da deneyseldir;
yerel API'nin bulunması yalnızca bir yetenek kontrolüdür, doğruluk onayı değildir.

## Sözleşme

Düzenlenebilir `coaxial` port ekseni, merkez çizgisi uçlarını, iç iletken yarıçapı `r_i`, kılıfın
iç/dış yarıçapları `r_o`/`r_os`, PEC malzeme referansını, isteğe bağlı dielektrik referansını,
uyarım durumunu, besleme/ölçüm kaydırmalarını ve `open`/`short` sonlandırmasını saklar.
Uzunluklar tasarımdaki milimetre birimindedir. `0 < r_i < r_o < r_os` koşulu gerekir; uçlar tek
eksen üzerinde olmalıdır. Kaydırmalar, ters yönlü hatlarda da başlangıçtan bitişe doğru ölçülür.

Port iletken, kılıf ve dielektrik geometrisini oluşturur. Önce geometri mesh için hazırlanır,
ardından son mesh üzerinde yerel iletim hattı probları oluşturulur. Halkasal boşlukta en az üç,
iç yarıçapta en az iki hücre gerekir; bu alt sınır yakınsama garantisi değildir. Üç komşu ölçüm
düzlemi port içinde ve PML dışında olmalıdır. Uyarım ölçümden önce ve PML dışında kalmalıdır.
Pakete gerçek mesh'e oturtulmuş ölçüm düzlemi yazılır.

Sonlu besleme direnci üst projede desteklenmediğinden reddedilir. `open`/`short`, fiziksel
besleme sonlandırmasıdır; uyumlu soğurucu yük anlamına gelmez. Geçiş hattı genellikle soğurucu
sınıra uzatılır. Dispersif dolgu, sonlu iletkenlikli iletken, silindirik mesh, gruplu beslemeler
ve özel kompleks referans empedansı bu taslağın dışındadır. Yerel API yoksa başka kaynak
kullanılmak yerine anlaşılır hata verilir.

Çıkış dalgaları, besleme sonlandırmasından bağımsız pozitif gerçek kayıpsız TEM referansı
`Zref = eta0/(2*pi) * sqrt(mu_r/eps_r) * ln(r_o/r_i)` kullanır. Yerel diferansiyel iletim hattı
kompleks empedansı `native_tem_z_re`/`native_tem_z_im` alanlarında korunur. Fiziksel yükleme,
sayısal empedans tahmini ve çıkış normalizasyonu birbirinden ayrılır.

CST uyumlu makro dışa aktarımı üretilen malzeme geometrisini korur; yerel koaksiyel portun
atlanacağını açıkça bildirir. Makro eşdeğer çalışan simülasyon değildir. Makro çalıştırma veya
çözücüler arası eşdeğerlik doğrulanmamıştır.

## Tekrarlanabilir kontroller

`scripts/validate-coaxial-native.py`, 1/3/3,5 mm yarıçaplı, 100 mm uzunluklu hava dolgulu PEC
koaksiyeli 1–2 GHz bandında, iki CPU iş parçacığı ve -50 dB enerji ölçütüyle kurar. Manifest,
ham çözüm klasörü ve kompleks CSV değerlerini saklar. Her çalıştırmada yeni klasör kullanın:

```sh
python scripts/validate-coaxial-native.py --case through --step .25 --out /yol/yeni/calisma
```

Kontroller geçiş, açık (PMC uç düzlemi) ve kısa devredir (PEC uç düzlemi). Yorumlamadan önce
iki enine mesh çözünürlüğünü ve bilinen TEM hat fazını karşılaştırın. `--reuse-solve` saklanan
probları yeni çözüm başlatmadan işler ve kaynak klasörünü kaydeder.

İlk geçiş hattı inceltmesi analitik hatta göre kompleks hatayı azalttı; kalan faz ve empedans
hatası hâlâ önemlidir. Bu bulgular yayım kabulü değildir. Eksen/enine inceltme, referans düzlemi
kaydırma, sınır ve dolgulu hat kontrolleri gereklidir. Pasiflik, yakınsama ve çözücünün bitmesi
ayrı ayrı değerlendirilmelidir.

İncelenen çalışma zamanı: openEMS Python `0.37.0rc3`, `ports.py` SHA-256:
`0daec44373d6a06395f1c47b252b004df4e99ee2fca5525b486e934451dcc1c1`.
Sürüm metni tek başına başka pakette API bulunduğunu kanıtlamaz.

Üst proje API'si: <https://docs.openems.de/en/latest/python/openEMS/ports.html#coaxial-port>.
