# Changelog

## Unreleased

- Improve critical rendering path and LCP by preloading hero image and converting key images to `<picture>` with WebP sources.
- Add explicit width/height and `decoding="async"` to all images; reserve slideshow space via CSS `aspect-ratio`.
- Defer third-party scripts and load Instagram, Pixlee, and Google Maps only when their sections enter the viewport.
- Guard Google Analytics calls and wrap DOM code in `DOMContentLoaded` handlers.
- Add preload and preconnect hints for fonts and external services.
- Provide image optimization scripts under `tools/`.

### Tools

- `tools/optimize_images.sh` – convert images to WebP (`bash tools/optimize_images.sh`).
- `tools/update_html_for_webp.mjs` – update HTML to use `<picture>` where WebP files exist (`node tools/update_html_for_webp.mjs`).

