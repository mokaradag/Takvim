# MERGEN Rota Manual Visual Smoke Tests

This is a repeatable **manual** visual checklist. It is not an automated browser/E2E suite and should not be reported as one.

Run the checklist against a production build when presentation, persistence status, authentication/loading/error surfaces or global layering changes.

## Test matrix

Repeat the high-risk checks in both **Dark Theme** and **Light Theme** at:

- Wide desktop: about 1440 px or wider.
- Medium/narrow desktop: around 1280 px and around 1080 px.
- Narrow/mobile viewport: around 760 px or below where the application supports the layout.

Record browser, OS, build commit and viewport dimensions with the result.

## Startup and modes

- Initial mode chooser appears without the underlying application shell bleeding through.
- Temel Kip opens successfully.
- Temel Kip Takvim opens on the **Takvim** tab; **Hızlı Görev Tanımı** remains a separate tab.
- Temel Kip **Yeni proje** button creates a project without any task and selects it in the project field.
- Kapsamlı Kip opens successfully and mode switching does not alter project/task data.

## Shell, workspace and topbar

- Sidebar scrolls correctly and footer remains usable.
- Portfolio/project workspace switching updates the visible context.
- Topbar page title/subtitle remain readable.
- Selected project identity is visually centered in the actual topbar.
- Project code and project name remain visually distinct.
- Rotating top-right heptagon keeps the accepted visible slice and rotation behavior.
- **Marka amblemi** preference hides both sidebar and topbar emblems.
- Decorative emblem does not intercept pointer events.
- `Dışa aktar` opens below the topbar without clipping and remains keyboard reachable.
- Theme, the Temel Kip/Kapsamlı Kip segmented selector and sign-out sit in
  the sidebar footer; they are not duplicated in the topbar.
- Focus indicators are visible on keyboard-reachable controls.

## Dashboard / Özet

- KPI cards align without overflow.
- Trend/status row follows the accepted wide layout.
- At 1280 px, Tamamlama trendi and Durum dağılımı move to full-row placement as intended.
- Durum dağılımı donut keeps the accepted size, legend width and spacing.
- **Every slice is one continuous arc.** No slice appears in two places on the
  ring, and the gaps between slices are equal. Hovering or selecting a slice
  thickens it inward without detaching it from the ring.
- The four KPI cards agree with the donut: `Tamamlanan + Devam eden + Yapılacak +
  Geciken` equals `Toplam görev`, and an overdue in-progress task is counted only
  under `Geciken`.
- Legend rows remain clickable and hover/detail behavior works.
- **Tamamlanma eğilimi axis labels are ordinary text size** at every card width —
  they must not grow with the card.
- `Gecikme yaşlandırması` and `Plan bütünlüğü` cards render; hovering a bucket or
  a check lists the underlying tasks, and clicking a task opens its drawer.
- Narrow layout stacks without horizontal clipping.
- Bottom Dashboard cards keep their intended alignment.

## Tasks and DateInput

- Project/person searchable selectors remain usable.
- Task table headers remain sticky while scrolling.
- Column filters open above the table and are not clipped; near the bottom of the
  screen they flip upward and stay fully inside the viewport.
- DateInput displays and edits `gg/aa/yyyy` correctly.
- Calendar button, invalid-state border and narrow-width DateInput remain usable.
- Applying a filter in one column narrows the option lists of the other columns
  to the values still visible; the column's own menu keeps offering its other
  values, and an already selected value never disappears from its own menu.
- The rightmost action column stays pinned while the table scrolls sideways: the
  mail and delete buttons are reachable at every width. At **font scale 125 %**
  the row-number column drops out and the header labels never wrap.

## Task Detail

- Drawer opens from the right and is not hidden behind the topbar or popovers.
- Backdrop covers the intended page area.
- Project/WBS, date and relationship fields fit at desktop widths and stack at narrow widths.
- Buttons remain real buttons, keyboard reachable and focusable.
- Each section carries its own icon and accent colour; titles are sentence case,
  never all caps.
- **Öncelik** section sets the task priority and the choice is reflected in the
  Görevler and Kanban lists.
- **Tekrar**: choosing `Haftalık` lets every weekday be selected *and*
  deselected — including the planned start's own weekday. The summary states how
  many occurrences the series has and how many new tasks will be created, and the
  occurrence calendar lists up to eight dates with the template's own day marked.
- **Kilometre taşı** switch in *Güncel plan*: turning it on hides the planned
  finish field, renames the start field, states that the duration is zero, and
  the task is drawn as a diamond in both Gantt views. One click toggles once.
- An assignee who did not create the task can edit planned/actual dates but not
  **Hedef bitiş**; `Yeni tarih öner` then asks for the target finish only.
- **İlişkiler ve bağımlılıklar** has `Öncüller` and `Ardıllar` tabs. Adding a
  successor updates the other task; a selection that would create a cycle is not
  offered in the list.
- At **font scale 125 %** (Ayarlar → Yazı tipi boyutu → Çok büyük): `Sil` and
  `Kaydet` stay fully on screen, and the `+ Öncül görev seçin` dropdown opens
  upward without any part leaving the viewport.

## Calendar

- Monthly calendar renders in both themes.
- Date-filter/day-detail popovers layer correctly.
- Weekend/holiday presentation remains readable.
- Temel Kip quick-entry tasks appear in the existing calendar flow.

## Project structure (Proje Yapısı)

- Project selector header, search field and project-type quick-select buttons stay frozen while only the project list scrolls.
- The **Daha fazla göster** button scrolls with the list, not with the frozen header.
- **Yeni Proje** opens the dialog; creating a project closes the dialog and keeps the application shell mounted — no welcome screen, no apparent restart.
- Saving **Değişiklikleri kaydet** on an existing project keeps the current page and shows the success message in place.

## WBS

- **The İş Dağılım Ağacı tab opens for every project without a client-side
  exception.** This is the primary regression check for the missing
  `wbsDragPolicy` import.
- Dragging a row by its handle reorders/reparents it; releasing the handle
  somewhere else leaves the row selectable again.
- WBS tree remains horizontally scrollable on constrained widths.
- Sticky WBS header remains aligned with rows **and stays visible while rows scroll**; the toolbar above it does not scroll away.
- The tree opens at level 2 by default, not fully expanded.
- `Tümünü aç`, `Tümünü kapat` and `Hiyerarşi` are visible as one control group in the toolbar; the hierarchy menu closes on outside click and on `Esc`.
- `Görev taşı` toggles the move panel; the panel is closed on entry and on project switch.
- Corporate project (Gerçek Sistem): the CN43N note is visible as a single-line note, row actions are hidden, rows show level/PYP/type/status, and the Task move panel still works.
- Manual project: Alt ekle / Ad / Taşı / Sil all work and the new node appears with the expected code.

## Gantt

- Gantt uses internal vertical/horizontal scrolling rather than forcing the whole page to scroll.
- Left rail/header and right timeline remain aligned.
- Column filters and Gantt column popovers open above chart content without clipping.
- Holiday stripes and dependency overlays retain their intended local paint order.
- WBS Gantt and responsible-person/CPM views remain usable.
- Toolbar labels are Turkish: **Yakınlaştırma** with `Dar / Orta / Geniş`.
- **Genişlet / Daralt** open and close every group (portfolio) or branch (WBS);
  the **Seviye** buttons appear only in the WBS Gantt and expand the hierarchy
  down to the chosen level, with no level highlighted after manual expansion.
- A milestone task is drawn as a diamond, not a bar.

## Boot curtain (first data load)

- While the first snapshot loads, the card is centered horizontally and vertically — not clipped into a narrow left column.
- Brand row, title, description, progress sweep and step chips all render in both themes.
- `MERGEN Rota` reads as the card's identity (logo plus a full-size wordmark), not
  as a small caption. The same holds for the Veri Kipi and Nasıl çalışmak
  istersiniz? dialogs.
- Step chips highlight in sequence; with `Hareketi azalt` on, they stop animating.
- The load-failure state shows `Yeniden Dene` and, outside Demo mode, the Demo escape button.

## Team (Ekip)

- The `Kurumsal ekip dizini` card and the table header stay visible while the person list scrolls.
- The default summary view includes a `Direktörlük tanımsız` card when such people exist; clicking it filters to exactly those people.
- The directorate dropdown offers `Direktörlük tanımsız` alongside the named directorates.
- Selecting a directorate in the top card immediately marks the `Direktörlük` column header as filtered, and vice versa. The same holds for `Müdürlük` and `Birim`.
- Only one value can be active per organizational level; choosing a different directorate replaces the previous one and clears a now-invalid müdürlük/birim.
- Every column header opens a sort/filter popover: Personel, Unvan, Direktörlük, Müdürlük, Birim, Toplam, Devam, Geciken, Yakın görevler.
- The clear action reads **Filtreleri temizle** (never `Süzgeçleri temizle`) and resets the search box, the dropdowns and the header filters together.
- Person rows show the corporate photograph, falling back to initials when no photo exists; the table stays readable at narrower desktop widths.
- Clicking a person's name opens the detail dialog: identity, workload metrics,
  priority breakdown and the full `Yakın görevler` list. `Esc` and the backdrop
  close it; clicking a task closes the dialog and opens that task's drawer.
- The dialog fits the viewport at every font scale and scrolls internally when
  the task list is long.

## Authentication and sidebar identity

- With no session in Gerçek Sistem the boot screen shows **Kurumsal oturum aç** instead of partially loaded data; Demo mode remains a deliberate separate choice.
- After signing in, the sidebar shows the authenticated user's photograph, full name and Keycloak department — not a hard-coded example user or role.
- A long department name wraps onto multiple lines in a small font and never overflows the sidebar.
- A long full name wraps onto a second line rather than being truncated to
  `MEHMET O…`.
- The sidebar footer has no `Kullanım rehberi` shortcut, while the Yardım navigation item still opens the help page.
- The footer orders theme, the Temel Kip/Kapsamlı Kip segmented selector and logout in one control row; none of those controls is duplicated in the topbar.
- The sidebar starts pinned and expanded. Unpinning resizes the main content to a 72 px rail. Hover and keyboard navigation expand it. Click a page, then move outside the displayed sidebar: it collapses despite the clicked button retaining focus. Tab navigation remains usable; pinning and reload preserve the preference.
- The footer version line reads only `MERGEN Rota · Sürüm 1.0`; the mode is shown by the switch itself.
- The lower-left rotating heptagon exposes a visibly larger quadrant without competing with the footer controls.
- The theme button still works and, in Gerçek Sistem, a compact logout button is present; logging out returns to an unauthenticated state.
- Avatars render photographs across Görevler, Takvim, Kanban, Ekip, task drawers, dashboard, Gantt, reports, project workspace and simple mode, with initials as the fallback.
- A direct assignee sees the task creator's avatar, full name and creation date/time under the explicit **Görevi tanımlayan** label; the same task opened by that creator shows the same identity.
- In Kapsamlı Kip, clicking **Yeni Görev** opens an unsaved drawer. Closing it creates nothing; only **Kaydet** persists the Task.

## Temel Kip

- The sidebar exposes Görevler, Takvim, Gantt, Kullanım Rehberi and Ayarlar.
- Gantt renders the portfolio timeline, identical to Kapsamlı Kip's portfolio Gantt.
- Görevler shows the simplified table only: Proje, Görev, Kısa açıklama,
  Sorumlular, Öncelik, Durum, Termin. No progress bar, effort/hours, start date,
  baseline, dependency or WBS column appears anywhere on the page.
- Search, the status segments, the priority filter and the sort selector all
  narrow/reorder the list; clearing them restores the full list.
- Clicking a row opens the simplified task panel, which edits only those same
  fields and saves without touching advanced planning data.
- Öncelik appears in Hızlı Görev Tanımı, in the table, in the panel and in the
  filter — with the same four labels and badge colours as Kapsamlı Kip.
- Switching to Kapsamlı Kip still shows the full Görevler table unchanged.

## Görev hatırlatma

- A compact envelope button sits next to the Delete button on task rows and in
  the task panel footer, in both modes, with a tooltip and an aria-label.
- Pressing it shows a pending state, then either a success message naming the
  recipient count or an explicit error; it never reports success without an
  accepted send.
- The button is disabled while a send is in flight, so a double click cannot
  produce two messages.
- Sending does not modify or delete the task: the row's values are unchanged
  afterwards.
- The button works while automatic reminders are disabled.
- The **Hatırlatma** page appears in the sidebar only for administrators; a
  non-administrator navigating to it sees a refusal rather than the editor.
- The template editor's toolbar (bold/italic/list/link) applies formatting, the
  placeholder list inserts tokens, and the preview renders real task values.
- Saving the automatic policy shows the human-readable schedule summary
  ("termine 7 gün kala başlar ve 2 günde bir yinelenir").

## Kanban, Reports, Settings and persistence status

- Kanban columns/cards render and remain scrollable; dropping a card back into the
  column it came from produces no save request.
- Reports render without layout regression; the CFD axis labels sit above the
  legend rather than on top of it, and the `Gecikme yaşlandırması` card matches
  the Özet card's totals.
- Settings controls remain readable in both themes.
- The accent-colour catalog reads `Kehribar` (not `Amber`).
- **Tarih biçimi** switches every date on screen between `gg/aa/yyyy` and
  `18 Ağu 2026` without a reload — **including editable date fields**: the Task
  Detail / Hızlı Görev Tanımı date boxes show the selected format, their
  placeholder and validation message match it, and typing `18 Ağu 2026` or
  `18/08/2026` both commit correctly in either mode.
- **Yüksek karşıtlık** visibly darkens borders and secondary text in both themes.
- Appearance/emblem/mode settings visibly apply as expected.
- At every font scale from 90 % to 140 %, no button, dropdown, tooltip or dialog
  is rendered outside the visible area on any page.
- The Gerçek Sistem / Demo switch is present in the Settings **Veri kaynağı** card and absent from the sidebar.
- Persistence status indicator appears above normal content when saving/error/saved state is simulated by existing test/dev mechanisms.

## Export output

- **Excel çalışma kitabı** opens in Excel **without** the "file format and
  extension don't match" warning, and contains Özet, Görevler, İş Dağılım Ağacı
  (plus Projeler for a portfolio export).
- The header row of every sheet is frozen and carries autofilter arrows; dates
  sort as dates and İlerleme shows as a percentage.
- **CSV paketi** downloads a ZIP whose entries open with Turkish characters
  intact; **Görev listesi** still downloads the single flat CSV.
- While an export is being produced the menu button shows the spinner.

## Result record

Use a short record such as:

```text
Commit:
Browser / OS:
Theme:
Viewport:
Areas checked:
Pass / Fail:
Notes / screenshots:
```

A manual smoke pass complements automated tests; it does not replace them. Any visual regression should be fixed in the authoritative style owner documented in `UI-STYLING-ARCHITECTURE.md`, not by adding a new global override layer.

## Görev arayüzü doğrulaması

- Yeni ve mevcut görev pencerelerinde künye çerçevesizdir; ad ile oluşturma
  tarihi/saat okunur. Kaydet simgesi ve kayıt sırasında bekleme göstergesi
  her iki kipte görünür. Dar ekranda uzun ad ve tarih taşmaz.
- Kenar çubuğunda fazladan ok, Aktif çalışma alanı ve Çalışma alanı başlıkları
  bulunmaz; proje seçicisi marka bloğunun hemen altındadır.
- Temel Kip ve Kapsamlı Kip seçimi mevcut tercihi korur; Ayarlar, karşılama,
  yardım ve veri seçimi ekranları kip ve görev yönetimi ifadelerini kullanır.
- Kanban aramasını bir proje kodu ve Türkçe sorumlu adıyla deneyin. Direktörlük,
  müdürlük ve birim seçimlerini birlikte uygulayın; kolon sayıları, boş sonuç,
  temizleme ve filtreli sürükleme doğru çalışır. Görevler sayfasına geçince
  kurumsal seçim korunur; dar ekran ortak kurumsal filtre menüsünü kullanır.
- Gantt görev ve kilometre taşı ipuçlarında tüm sorumluların fotoğraf/ad
  çiftleri görünür. Aynı davranışı WBS görünümünde doğrulayın. Sorumluya göre
  gruplamada avatarlar doğru Sicile aittir; aynı adlı kişiler birleşmez.
  Fotoğraf bulunmayan kişi baş harflerle gösterilir.


## Talepler, KPI detayları ve tablo davranışı

Açık/koyu tema, normal/büyütülmüş yazı ve dar ekran için kontrol edin:

- Her iki kipte Talepler düz menü öğesidir; üç sekme ok tuşlarıyla ve Home/End ile değişir. Arama/süzgeç sonrası sayfa başa döner.
- Zilde en fazla sekiz kart vardır; karar gerekenler belirgindir. Okundu/temizle geçmişi silmez; açık karar ve dikkat noktası kalır. Yeni karar yeniden okunmamış görünür.
- Özetin beş KPI kartında zengin liste ve Tüm görevleri gör çalışır; pencere doğru küme/sayı ile açılır. Sorumlular Sicil ile ayrılır. Görev paneli kapanınca liste durumu, liste kapanınca Özet bağlamı korunur.
- Temel Kipte Ctrl/Cmd+K ve arama düğmesi çalışır; Gantt sonucu yoktur. Kapsamlı Kipte Gantt vardır.
- Başlık ve Notlar içinde Home/ok tuşlarıyla ortaya gidip Türkçe karakter yazın, seçim yapıp değiştirin, yapıştırın ve silin; imleç sona atlamamalıdır. Kaydet öncesinde kalıcı görev değişmez.
- Geciken todo/in_progress yalnızca Geciken durumunda görünür. Başlangıç/Bitişte gerçekleşen tarih varsa ✓ ile gösterilir; tarih süzgeci ve sıralama aynı değeri izler.
- Tarih açıklaması ve İlk/Önceki/Sonraki/Son tek alt satırı paylaşır. İlk/son sayfa düğmeleri doğru kilitlenir.
- Zil, komut paleti, KPI penceresi ve görev/talep panellerinde Tab/Shift+Tab odağı içeride tutar; Escape ve kapatma odağı uygun denetime döndürür. Kayıt sürerken kapanış kilidi korunur.


### Raporlar → Görev Hareketleri

Her iki temada Performans/Görev Hareketleri sekmelerini ok tuşları ve Home/End ile değiştirin; Performans aralığının korunduğunu kontrol edin. Bugün/Ekibim, özel aralık, kurumsal yol, kişi/proje/hareket türü ve son sayfa kontrollerini deneyin. Çok alanlı işlem ayrıntısını klavyeyle açın; görev çekmecesini kapatınca filtrelerin korunduğunu, silinen görevde açma düğmesi olmadığını doğrulayın. Dar ekranda yalnızca tablonun kendi alanının kaydığını kontrol edin.
