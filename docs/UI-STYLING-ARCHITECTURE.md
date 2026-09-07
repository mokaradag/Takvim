# MERGEN Rota UI Styling Architecture

This document defines the ownership model for MERGEN Rota presentation code. The goal is to keep the current visual contract understandable without reconstructing the pull-request history that produced it.

## 1. Style ownership model

Styles are organized by responsibility, not by chronology. A rule should live with the component or feature whose visual contract it defines. The root layout loads a small stable sequence of semantic style owners; no stylesheet exists merely to load last and override an earlier patch.

Current root sequence:

1. `src/app/globals.css` — global tokens, reset/base rules and long-standing shared primitives.
2. `src/app/styles/components.css` — shared visual component chrome, forms/inputs, table behavior and shared filter popovers.
3. `src/app/styles/shell.css` — application shell, sidebar, topbar, project identity and export menu.
4. `src/app/styles/dashboard.css` — Dashboard/Özet structural layout and status-donut presentation.
5. `src/app/styles/features.css` — Gantt, WBS and Task Detail feature layout contracts.
6. `src/app/styles/simple-mode.css` — Temel Kip quick-entry and calendar-tab presentation.
7. `src/app/styles/experience.css` — mode chooser, settings-mode cards and help/onboarding surfaces.

## 2. Ownership map

| Area | Authoritative owner |
| --- | --- |
| Global tokens/base/reset | `src/app/globals.css` |
| Application shell/topbar/sidebar/export | `src/app/styles/shell.css` |
| Boot/data-loading curtain (`.app-boot*`) | `src/app/styles/shell.css` |
| Dashboard/Özet | `src/app/styles/dashboard.css` |
| Forms/inputs/DateInput | `src/app/styles/components.css` |
| Tables/shared filter popovers | `src/app/styles/components.css` |
| Tasks/Kanban toolbar and organization filter overflow | `src/app/styles/components.css` |
| Kanban page sizing and Gantt assignee lists | `src/app/styles/features.css` |
| Gantt | `src/app/styles/features.css` (`Gantt` section) |
| WBS (toolbar, tree controls, tree table) | `src/app/styles/features.css` (`Proje Yapısı` section) |
| Team directory (`.team-*`) | `src/app/styles/features.css` (`Ekip` section) |
| Task Detail drawer | `src/app/styles/features.css` (`Task Detail` section) |
| Simple Mode | `src/app/styles/simple-mode.css` |
| Shared component chrome | `src/app/styles/components.css` |
| Mode chooser/settings/help presentation | `src/app/styles/experience.css` |
| Loading indicators (`.app-spinner`, `.saving-overlay`) | `src/app/styles/components.css` |
| Toggle switch (`.toggle-field`, `.toggle-switch`) | `src/app/styles/components.css` |
| Gantt outline controls (`.gantt-outline-*`, `.gantt-level-*`) | `src/app/styles/components.css` |
| Sidebar hover/keyboard expansion, pin and segmented kip selector (`.sidebar-mode-toggle`) | `src/app/styles/shell.css` |

A feature may use shared tokens and primitives, but its structural layout remains owned by the feature's stylesheet section.

### 2.1 Viewport height under the font-size scale

The font-size preference is applied as `document.body.style.zoom`. Zoom multiplies
the coordinate frame of the body and of every `position: fixed` descendant, but
`vh` units are **not** rescaled consistently across browsers. A rule such as
`height: 100vh` therefore renders taller than the screen once the user enlarges
text, and anything anchored to the bottom of that element (the Task Detail
drawer's Sil/Kaydet bar, for example) is pushed out of the visible area.

`useApplyTweaks` publishes the corrected height as a custom property:

```css
--app-viewport-h: calc(100vh / <scale>);
```

**Full-viewport heights must use `var(--app-viewport-h, 100vh)`, never bare `vh`.**
This applies to `height`, `max-height` and viewport-proportional padding across
`globals.css`, `features.css`, `shell.css` and `experience.css`. The rule is
covered by a regression test
(`test/plan-health-and-overlay-bounds.test.mjs`).

Full-height flex containers additionally need `min-height: 0` on the scrolling
child and `flex: 0 0 auto` on the fixed header/footer; without it the body grows
to its content height and pushes the footer off-screen regardless of the
container height.

### 2.2 Overlay placement is a pure function

Popovers, dropdown panels and column-filter boxes are portalled to `document.body`
so that a sidebar's `overflow: hidden` and stacking contexts cannot clip them.
Escaping the clip is not enough: the overlay must also be **bounded by the
viewport**, and it must convert coordinates out of the zoomed frame.

Two pure modules own that arithmetic and are unit-tested independently of React:

| Module | Owns |
| --- | --- |
| `src/components/searchableSelectPlacement.js` | `SearchableSelect` panel side, width, `panelMaxHeight` and `listMaxHeight` |
| `src/components/overlayPlacement.js` | Column-filter boxes: clamped `left`/`top`, flip direction and `maxHeight` |

Both take a trigger rectangle, the overlay size and the viewport size, and both
guarantee the result fits. The available space is measured **honestly**: an
overlay is never given a floor height larger than the space that actually exists,
and the panel chrome (search row, footer) is subtracted before the list gets its
height. Callers divide measured rectangles and `window.inner*` by `appZoom()`
before handing them over.

### 2.3 Full-height pages with sticky headers

Pages whose table "runs the show" (Görevler, Ekip, Proje Yapısı → İş Dağılım Ağacı) do not scroll `.content`. They fill its height and delegate scrolling to the table shell:

```text
.content (fixed height, overflow auto)
└── <feature>-page          height: 100%; min-height: 0; display: flex/column
    ├── header card/toolbar  flex: 0 0 auto
    └── <feature>-table-card flex: 1 1 0; min-height: 0; overflow: hidden
        └── <feature>-table-scroll  flex: 1 1 0; min-height: 0; overflow: auto
```

`position: sticky` resolves against the nearest scroll container, so the header row must live inside the element that actually scrolls — an `overflow-x: auto` wrapper without a height constraint silently breaks sticky headers. Sticky header cells also need an opaque background, otherwise rows show through during horizontal scrolling.

## 3. Rules for adding styles

Start from ownership: identify the component or feature that owns the behavior, then edit that owner. Prefer an existing semantic class over increasing selector specificity. Add a new semantic class when CSS would otherwise need to infer meaning from DOM position, inline-style text or unrelated descendants.

**DO NOT CREATE A NEW GLOBAL "FIXES" STYLESHEET FOR A LOCAL COMPONENT PROBLEM.** Fix the authoritative style owned by that component or feature.

A temporary emergency patch, if unavoidable, must have a named follow-up consolidation plan and must not become permanent architecture.

## 4. Inline-style policy

Inline styles remain appropriate for runtime values such as project colors, computed progress widths, selected colors and coordinates calculated by visual primitives.

Static structure should normally use semantic CSS classes. Examples include `display`, grid tracks, fixed gaps, alignment, overflow and responsive behavior. Static layout must not be duplicated inline and then fought by global CSS.

## 5. Dynamic versus static styles

Use this decision rule:

- Dynamic presentation value → inline style may be appropriate.
- Static component structure → semantic class is preferred.

The Dashboard status legend, for example, keeps its runtime selected background/border inline while its grid, spacing, cursor and transition belong to `dashboard.css`.

## 6. Specificity policy

Use the lowest specificity that expresses ownership clearly. Prefer a semantic class over `nth-child()`, serialized `[style*=...]` matching or a deep positional chain. `:has()` is not forbidden, but it must not substitute for a missing semantic class in application structure.

Major shell contracts such as `.topbar`, `.topbar-emblem-clip` and `.topbar-project-context` must have one normal authoritative owner.

## 7. `!important` policy

`!important` is not a layering mechanism. Do not use it to make a later stylesheet defeat an earlier one.

Remaining uses must be structurally justified, such as an explicit reduced-motion override or an interaction state that must defeat descendant cursor rules. When ownership or semantic markup can remove the need, prefer that solution.

## 8. Responsive breakpoint ownership

A component's responsive rules belong beside its base rules in the same owner. Dashboard behavior at 1280, 1080 and 760 pixels is therefore defined in `dashboard.css`; Simple Mode responsiveness is in `simple-mode.css`; Task Detail and Gantt/WBS behavior is in `features.css`.

The shared Tasks toolbar remains one row at normal desktop widths: search, the three organization selectors, information/clear controls, count and **Yeni Görev** share the same flex line. At viewport widths up to 1280 px the three direct selectors are replaced by the compact **Kurumsal filtre** disclosure; only genuinely narrow widths may wrap the toolbar. Both mode-specific Tasks views consume the same `TaskOrganizationFilterControls` markup and the responsive owner is `components.css`.

Do not duplicate competing breakpoints for the same component across unrelated files.

### 8.1 Container queries for zoom-driven narrowing

The font-size preference is applied as `body { zoom }`. Media queries evaluate
against the viewport, which zoom does **not** change, so `@media (max-width: …)`
cannot see the space a table actually lost when the user enlarges the type. The
Tasks table therefore declares `container-type: inline-size` on
`.tasks-table-card` and narrows itself with `@container gorevler-tablosu (…)`:
the index column is dropped and cell padding shrinks. Browsers without container
query support simply keep the wide layout — the sticky action column already
guarantees the row actions stay reachable, so the rule is a progressive
enhancement, never a correctness dependency.

The Tasks action column is `position: sticky; right: 0` with an opaque
background and a hover rule (`tr:hover .tasks-actions-cell`), because a sticky
cell paints over the scrolled row beneath it and would otherwise show the page
through the row highlight.

## 9. z-index/layering contract

Global layer tokens live in `globals.css`:

- `--z-base`: ordinary content.
- `--z-sticky`: sticky table/header content.
- `--z-chrome`: application chrome and persistent floating chrome.
- `--z-popover`: dropdowns, filters and non-modal popovers.
- `--z-drawer-backdrop`: drawer backdrop.
- `--z-drawer`: Task Detail drawer.
- `--z-command`: command-palette layer.
- `--z-modal`: blocking modal/onboarding surfaces.
- `--z-tooltip`: topmost non-interactive tooltip layer.

Small local z-index values are acceptable inside an isolated component for internal paint order. Do not solve a stacking problem by escalating to unexplained values such as `10020` or `10050`.

The topbar itself keeps `overflow: visible`; only `.topbar-emblem-clip` clips the rotating decorative emblem. Filter popovers use the shared popover layer, while the Task Detail drawer remains above popovers.

## 10. Shared visual primitive ownership

Reusable primitives live under `src/components/ui.jsx`, `src/components/ui-extras.jsx` and related shared components. Their general behavior must not be changed to solve one feature-specific layout problem.

Dashboard-specific donut sizing and layout belong to `.dashboard-status-chart`
and related semantic Dashboard classes; the `Donut` primitive itself owns only
how a ring is drawn.

**Donut slices are closed paths, not dashed strokes.** The earlier implementation
drew each slice as a full circle with `stroke-dasharray` plus a negative
`stroke-dashoffset`. A dash pattern **repeats** around the circumference, so a
rounding remainder pushing the total a hair past `2πr` wrapped the pattern and
made one slice appear as two fragments in different places on the ring. Lifting
the selected slice outward with a translate produced the same "split" reading by
detaching it from the ring.

Geometry now lives in `src/components/charts/donutGeometry.js`, a pure module:

- `donutSegments()` normalizes values (non-finite and negative → 0), gives the
  last slice the remaining angle so the total is exactly 360°, and applies an
  even, deliberate gap that can never consume a small slice.
- `donutSlicePath()` emits a closed outer-arc → inner-arc path, so a slice is
  geometrically incapable of exceeding the ring. A full turn is expressed as two
  half-turns because a single arc cannot close on itself.

Emphasis (hover/selection) only moves the **inner** radius; the outer diameter is
fixed, so a slice is never clipped and never overlaps its neighbour.

### 10.1 Chart axis labels

Axis labels are HTML, not SVG `<text>`. The chart SVGs scale to card width
(`width: 100%`, and the CFD additionally uses `preserveAspectRatio="none"`), so a
`font-size` written inside the SVG scales with the card: on a wide dashboard the
labels rendered nearly twice their intended size, and under `none` they also
stretched horizontally. `.chart-axis-labels` positions real text at percentage
offsets over the plot area, immune to the SVG transform. The label container must
wrap **only** the plot, otherwise the labels land on top of a legend rendered
below it.

## 11. Feature-specific styling ownership

Feature layout should be discoverable from the feature name. Dashboard layout is in `dashboard.css`; Gantt/WBS/Task Detail sections are in `features.css`; Simple Mode is in `simple-mode.css`. Feature JSX should expose semantic classes when the layout has meaningful regions.

## 12. Avoiding patch CSS accumulation

Do not add `final-fixes.css`, `latest-overrides.css`, `followup-fixes.css`, `polish.css` or similar chronological layers. Git history already records the sequence of experiments. The source tree should describe the current system.

When replacing an old rule, remove the superseded rule rather than leaving both versions active. A regression test should protect the visible or semantic contract, not the fact that one patch file loads after another.

## 13. Fixing visual regressions

1. Reproduce the affected component and identify its authoritative owner.
2. Confirm the intended visual contract and responsive states.
3. Fix the owner or add semantic markup if the selector is structurally fragile.
4. Remove any rule that existed only to undo the now-corrected rule.
5. Add or update a regression test for the behavior/semantic contract.
6. Run the automated quality suite and the relevant checks in `docs/VISUAL-SMOKE-TESTS.md`.

Exact CSS values may be tested when they intentionally define an accepted visual regression contract, such as the topbar emblem position and Dashboard status-card dimensions.

## 14. Typography contract

Headings and labels are written in **sentence case**; `text-transform: uppercase`
is not used anywhere in the application stylesheets or in inline styles. Wide
letter-spacing that existed to make all-caps micro-labels legible was reduced to
`0.02em` at the same time, and the smallest kicker labels were enlarged, because
lowercase text at 9.5px with 0.13em tracking is harder to read than the caps it
replaced.

Page titles use a solid `var(--text)` fill with a short accent rule beneath.
Gradient-filled text (`background-clip: text` + `-webkit-text-fill-color:
transparent`) was removed: it lowers contrast at small sizes, washes out in the
light theme, and breaks selection highlighting.

Both contracts are covered by
`test/module-binding-and-recurrence-editing.test.mjs`.


## Açılış ekranı ve kurum logosu

Açılış ekranı koyu lacivert zemin, hafif ışık geçişleri, birbirinden bağımsız hareket eden yıldız katmanları ve sade bir marka kartı kullanır. Hareket ilk saniyelerden itibaren görülebilir. İşletim sistemi veya uygulamanın hareket azaltma tercihi yıldızları, arka planı ve ilerleme animasyonunu durdurur.

Kurum logosu `/api/mergen-rota/company-logo` üzerinden alınır. `MERGEN_ROTA_COMPANY_LOGO_PATH` sunucunun erişebildiği UNC, Windows veya mutlak SVG yoludur. Node hizmet hesabının paylaşım ve dosya okuma yetkisi bulunmalıdır; Linux kurulumunda paylaşım bağlanıp yerel bağlama yolu kullanılmalıdır. Eski `NEXT_PUBLIC_MERGEN_ROTA_COMPANY_LOGO_URL` ayarı HTTPS adresi veya UNC SVG yolu içeriyorsa da çalışır. Yeni dosya yolu ayarı sunucuda okunur ve tarayıcıya gönderilmez. Ayar değişince hizmet yeniden başlatılır; değişen görsel beş dakikaya kadar önbellekte kalabilir. Logo 220 × 64 piksel alanda `object-fit: contain` ile gösterilir. Ayar boş veya dosya okunamıyorsa logo gizlenir; açılış engellenmez.

Temel Kipte eylem sütununun başlığı da diğer başlıklarla birlikte yapışkandır ve opak zemin kullanır; kaydırılan zarf/silme simgeleri başlığın üstüne çıkmaz. Tarih talebi rozetleri sabit 24 piksel yüksekliğe sahiptir; ızgara satırlarının yüksekliğine uzamaz. Kilometre taşının gerçekleşen tarihi ortak tarih ızgarasında yer alır.

Daralan kenar çubuğunda kullanıcı metni ve kip etiketlerinin gizli satırları yükseklik tüketmez. Menü kalan yüksekliği alır; fotoğraf ve araçlar altta kalır. Genişlik/padding geçişleri aynı 420 ms yumuşak hız eğrisini kullanır; hareket azaltma tercihi tüm geçişleri kapatır.
