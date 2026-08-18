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
6. `src/app/styles/simple-mode.css` — Basit Mod quick-entry and calendar-tab presentation.
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
| Gantt | `src/app/styles/features.css` (`Gantt` section) |
| WBS (toolbar, tree controls, tree table) | `src/app/styles/features.css` (`Proje Yapısı` section) |
| Team directory (`.team-*`) | `src/app/styles/features.css` (`Ekip` section) |
| Task Detail drawer | `src/app/styles/features.css` (`Task Detail` section) |
| Simple Mode | `src/app/styles/simple-mode.css` |
| Shared component chrome | `src/app/styles/components.css` |
| Mode chooser/settings/help presentation | `src/app/styles/experience.css` |

A feature may use shared tokens and primitives, but its structural layout remains owned by the feature's stylesheet section.

### 2.1 Full-height pages with sticky headers

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

Do not duplicate competing breakpoints for the same component across unrelated files.

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

The generic `Donut` click/select animation is a shared primitive contract. Dashboard-specific donut sizing and layout belong to `.dashboard-status-chart` and related semantic Dashboard classes.

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
