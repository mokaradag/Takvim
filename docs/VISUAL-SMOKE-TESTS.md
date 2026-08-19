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
- Basit Mod opens successfully.
- Basit Mod Takvim opens on the **Takvim** tab; **Hızlı Görev Tanımı** remains a separate tab.
- Basit Mod **Yeni proje** button creates a project without any task and selects it in the project field.
- Gelişmiş Mod opens successfully and mode switching does not alter project/task data.

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
- **İlişkiler ve bağımlılıklar** has `Öncüller` and `Ardıllar` tabs. Adding a
  successor updates the other task; a selection that would create a cycle is not
  offered in the list.
- At **font scale 125 %** (Ayarlar → Yazı tipi boyutu → Çok büyük): `Sil` and
  `Tamam` stay fully on screen, and the `+ Öncül görev seçin` dropdown opens
  upward without any part leaving the viewport.

## Calendar

- Monthly calendar renders in both themes.
- Date-filter/day-detail popovers layer correctly.
- Weekend/holiday presentation remains readable.
- Basit Mod quick-entry tasks appear in the existing calendar flow.

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

## Boot curtain (first data load)

- While the first snapshot loads, the card is centered horizontally and vertically — not clipped into a narrow left column.
- Brand row, title, description, progress sweep and step chips all render in both themes.
- `MERGEN Rota` reads as the card's identity (logo plus a full-size wordmark), not
  as a small caption. The same holds for the Veri Modu and Nasıl çalışmak
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
- The theme button still works and, in Gerçek Sistem, a compact logout button is present; logging out returns to an unauthenticated state.
- Avatars render photographs across Görevler, Takvim, Kanban, Ekip, task drawers, dashboard, Gantt, reports, project workspace and simple mode, with initials as the fallback.

## Basit Mod

- The sidebar exposes Görevler, Takvim, Gantt, Kullanım Rehberi and Ayarlar.
- Gantt renders the portfolio timeline, identical to Gelişmiş Mod's portfolio Gantt.
- Görevler shows the simplified table only: Proje, Görev, Kısa açıklama,
  Sorumlular, Öncelik, Durum, Termin. No progress bar, effort/hours, start date,
  baseline, dependency or WBS column appears anywhere on the page.
- Search, the status segments, the priority filter and the sort selector all
  narrow/reorder the list; clearing them restores the full list.
- Clicking a row opens the simplified task panel, which edits only those same
  fields and saves without touching advanced planning data.
- Öncelik appears in Hızlı Görev Tanımı, in the table, in the panel and in the
  filter — with the same four labels and badge colours as Gelişmiş Mod.
- Switching to Gelişmiş Mod still shows the full Görevler table unchanged.

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
