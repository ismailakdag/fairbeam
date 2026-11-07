# Yapay zekâ asistanları (MCP)

`fairbeam mcp`, Claude Desktop, Claude Code ve diğer [Model Context Protocol](https://modelcontextprotocol.io)
istemcileri gibi yapay zekâ asistanlarının Fairbeam ile çalışmasını sağlar. Asistan tasarımları
listeleyip okuyabilir, başlangıç şablonlarından veya örneklerden tasarım oluşturabilir, parametreleri
değiştirebilir, tasarımı denetleyebilir, simülasyon çalıştırabilir ve sonuçları okuyabilir. Her şey
bilgisayarınızda kalır. Sunucu MCP'yi stdio üzerinden konuşur, yalnızca Python'un standart
kütüphanesine ihtiyaç duyar ve [çalıştırma sunucusu](RUN-SERVER.md) API'sini kullanır.

## Asistanı bağlama

En kolay yol uygulamadaki **Ayarlar › Yapay zekâ asistanları (MCP)** bölümüdür. Bu kurulum için tam
komutu ve yapılandırmayı Kopyala düğmeleriyle gösterir.

- **Claude Code:** kopyaladığınız komutu terminalde çalıştırın. Şuna benzer:

  ```bash
  claude mcp add fairbeam --scope user --env PYTHONPATH="…/Fairbeam.app/Contents/Resources/python" --env OPENEMS_INSTALL_PATH="…/runtime/openEMS" -- "…/runtime/venv/bin/python" -m fairbeam mcp
  ```

- **Claude Desktop ve diğer istemciler:** kopyaladığınız JSON'u istemcinin MCP yapılandırmasına ekleyin
  (Claude Desktop'ta: Settings › Developer › Edit config) ve istemciyi yeniden başlatın:

  ```json
  {"mcpServers": {"fairbeam": {"command": "…/python", "args": ["-m", "fairbeam", "mcp"],
                               "env": {"PYTHONPATH": "…", "OPENEMS_INSTALL_PATH": "…"}}}}
  ```

Kaynak koddan çalışırken `python -m fairbeam mcp --print-config`, çalıştırdığınız Python için aynı
yapılandırmayı yazdırır. Yollar tek bir kuruluma işaret eder. Fairbeam'i taşıdıktan veya yeniden
kurduktan sonra yeniden kopyalayın.

## Hangi çalıştırma sunucusunu kullanır

- **Açık Fairbeam uygulaması** (`server.json` kaydıyla bulunur). Asistanın başlattığı çalıştırmalar
  uygulamanın kuyruğunda bekler ve Son çalıştırmalar altında görünür. Oluşturduğu tasarımlar Başlangıç
  › Tasarımlarınız altında görünür. Hepsini uygulamadan izleyebilir, durdurabilir veya açabilirsiniz.
- **Uygulama açık değilse `fairbeam mcp` içinde başlatılan bir sunucu.** Boş bir portta, aynı çalışma
  klasörleri üzerinde çalışır (`~/Documents/Fairbeam` veya `FAIRBEAM_WORKSPACE`; kaynak koddan çalışırken
  de). Kendi iş klasörünü kullandığı için uygulamayı sonradan açmak engellenmez. Bunu
  istemiyorsanız ve uygulamanın açık olmasını şart koşmak istiyorsanız `--no-embedded` verin.
- **`--server URL`** (veya `FAIRBEAM_SERVER`) belirtilen çalıştırma sunucusunu kullanır.

## Araçlar

Tüm değerler Fairbeam'in standart birimlerini kullanır: uzunluklar mm, frekanslar GHz (7,1 MHz
`0.0071`'dir).

| Araç | Ne yapar |
| --- | --- |
| `status` | Sürüm, kullanılan çalıştırma sunucusu, motorlar, CPU, çalışma klasörleri, kuyruk |
| `list_designs` | Kullanıcının tasarımları ve salt okunur örnekler (isteğe bağlı süzgeç) |
| `get_design` | Bir tasarımın JSON'u ve özeti (hash) |
| `design_format_guide` | Tasarım dosyası biçimine kısa bir rehber |
| `create_design` | Başlangıç şablonundan, bir tasarımın veya örneğin kopyasından ya da tam bir tasarım JSON'undan yeni tasarım |
| `update_design` | Düzenlenmiş tasarımı kaydeder; `base_hash` ile uygulamada yapılan daha yeni düzenlemelerin üzerine yazılmaz |
| `set_parameters` | Parametre değerlerini veya ifadelerini değiştirip kaydeder |
| `check_design` | Simüle etmeden oluşturur: hatalar, uyarılar, notlar ve mesh boyutu |
| `run_simulation` | Çalıştırmayı kuyruğa ekler ve varsayılan olarak bitmesini bekleyip sonuç özetini döndürür |
| `run_status`, `list_runs`, `cancel_run` | Çalıştırmaları izler, listeler veya durdurur |
| `parameter_sweep` | Bir veya iki parametrenin her değeri için bir çalıştırma |
| `list_results`, `get_results` | Sonuç dosyaları; en küçük S11, −10 dB bantları, Zin, VSWR, kazanç ve verimlilik özeti, isteğe bağlı eğriler |
| `export_touchstone` | Sonucun yanına veya verilen yola `.s1p` / `.sNp` yazar |

Sunucu, tasarım biçimi rehberini bir kaynak olarak da sunar (`fairbeam://guide/design-format`). İki
istem de vardır: `design_antenna` (bir frekans için oluştur, denetle, simüle et ve ayarla) ve
`review_result` (bir sonucu RF mühendisi için açıkla).

## Örnek

> Fairbeam'de 7,1 MHz için yarım dalga dipol tasarla, hızlıca çalıştır ve nerede rezonansa girdiğini söyle.

Asistan şunları yapabilir:
1. HF dipol örneğini kopyalar (`create_design`, `from_design: "hf_dipole_7mhz"`);
2. denetler (`check_design`);
3. hızlı bir bitiş ölçütüyle çalıştırır (`run_simulation`, `end_criteria_db: -40`);
4. `get_results` ile 7 MHz yakınındaki en küçük S11'i ve −10 dB bandını bildirir.

Çalıştırma sürerken uygulamada görünür.

## Sınırlar

- Simülasyonlar bilgisayarınızda, birer birer çalışır ve uygulamadan başlatıldıkları kadar sürer. Asistan
  `timeout_s` kadar (varsayılan 900 s) bekler, sonra çalıştırma kimliğini döndürür; çalıştırma devam eder.
- Sonuçlar ölçüm değil, openEMS simülasyonudur. Sayıların ne kadar güvenilir olduğunu mesh yakınsaması ve
  sınır mesafesi belirler; özetler bunu belirtir.
- Asistan bu araçlarla yalnızca çalışma klasöründeki tasarımları ve sonuçları değiştirebilir;
  `export_touchstone`'a verdiğiniz yol dışında başka klasörlere erişemez.
