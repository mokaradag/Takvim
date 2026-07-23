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
- Selecting a donut slice preserves the translate/bounce interaction; deselection returns it normally.
- No donut segment is forcibly pinned with `transform: none`.
- Legend rows remain clickable and hover/detail behavior works.
- Narrow layout stacks without horizontal clipping.
- Bottom Dashboard cards keep their intended alignment.

## Tasks and DateInput

- Project/person searchable selectors remain usable.
- Task table headers remain sticky while scrolling.
- Column filters open above the table and are not clipped.
- DateInput displays and edits `gg/aa/yyyy` correctly.
- Calendar button, invalid-state border and narrow-width DateInput remain usable.

## Task Detail

- Drawer opens from the right and is not hidden behind the topbar or popovers.
- Backdrop covers the intended page area.
- Project/WBS, date and relationship fields fit at desktop widths and stack at narrow widths.
- Buttons remain real buttons, keyboard reachable and focusable.

## Calendar

- Monthly calendar renders in both themes.
- Date-filter/day-detail popovers layer correctly.
- Weekend/holiday presentation remains readable.
- Basit Mod quick-entry tasks appear in the existing calendar flow.

## WBS

- WBS tree remains horizontally scrollable on constrained widths.
- Sticky WBS header remains aligned with rows.
- Expand/collapse and row actions remain reachable.

## Gantt

- Gantt uses internal vertical/horizontal scrolling rather than forcing the whole page to scroll.
- Left rail/header and right timeline remain aligned.
- Column filters and Gantt column popovers open above chart content without clipping.
- Holiday stripes and dependency overlays retain their intended local paint order.
- WBS Gantt and responsible-person/CPM views remain usable.

## Kanban, Reports, Settings and persistence status

- Kanban columns/cards render and remain scrollable.
- Reports render without layout regression.
- Settings controls remain readable in both themes.
- Appearance/emblem/mode settings visibly apply as expected.
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
