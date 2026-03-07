# Nieman's Detailing Website

## Color Palette

The site should stay on a dark detailing-oriented palette and avoid pale lavender card backgrounds.

### Core colors

| Token | Value | Use |
| --- | --- | --- |
| `--nd-bg-0` | `#02050D` | Deepest page background |
| `--nd-bg-1` | `#08112A` | Primary page gradient |
| `--nd-bg-2` | `#040814` | Lower page gradient / depth |
| `--nd-surface` | `#0F1832` | Base dark surface |
| `--nd-surface-elevated` | `#162142` | Raised panels and overlays |
| `--nd-surface-strong` | `#0B1228` | Strongest dark surface |
| `--nd-accent-0` | `#341F67` | Plum anchor for nav/CTA gradients |
| `--nd-accent-1` | `#5534A8` | Primary purple accent |
| `--nd-accent-2` | `#BBA6FF` | Text accent / headings / links |
| `--nd-highlight-0` | `#F09D2C` | Pricing / money highlight start |
| `--nd-highlight-1` | `#DA6B1F` | Pricing / money highlight end |
| `--nd-text-on-dark` | `#F2F0FF` | Main text on page background |
| `--nd-text-on-surface` | `#F4F1FF` | Main text on cards and panels |
| `--nd-text-muted` | `#C8C2DB` | Secondary text on dark surfaces |
| `--nd-text-subtle` | `#A7A2BC` | Low-emphasis helper text |

### Usage rules

- Backgrounds should stay in the `--nd-bg-*` range with deep navy/ink gradients.
- Cards, panels, chips, and overlays should use dark translucent surfaces, not pale glass panels.
- Purple is the primary accent for navigation, active states, and CTAs.
- Amber is reserved for pricing and monetary cues.
- Use `--nd-text-on-surface` or `--nd-text-muted` on dark surfaces; avoid dark text inside cards.

### Current implementation

The homepage palette tokens and dark surface treatments currently live in `public/styles/home.css`.
