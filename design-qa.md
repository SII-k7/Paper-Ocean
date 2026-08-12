# Scheme A design QA · v0.3.1

Final comparison viewport: **1680 × 980**.

- Reference: `output/design-qa/scheme-a-source.png`
- Implementation: `output/design-qa/scheme-a-implementation-final.png`
- Side-by-side comparison: `output/design-qa/scheme-a-comparison-final.jpg`
- Responsive captures: `output/design-qa/implementation-1280x720.png`, `output/design-qa/implementation-1180x720.png`

## Fidelity review

- Layout: the 46 / 31 / 23 three-pane workspace, 64 px header, 40 px paper strip, native tabs, chat top bar, bottom composer, floating model panel, and compact discovery cards match Scheme A's hierarchy and density.
- Typography and spacing: the implementation keeps the compact research-workspace scale while raising muted-text contrast and minimum control sizes for actual use. Dynamic paper titles truncate cleanly.
- Color and surfaces: near-black navy panels, mint status color, one-pixel separators, restrained glass, rounded model cards, and discovery-card elevation map to the selected design.
- Assets and icons: all action icons use Lucide; the generated Paper Ocean raster brand asset is used in the application and packaging. There are no emoji, placeholder glyph icons, handcrafted SVG assets, or missing target imagery.
- Responsive behavior: 1680 × 980, 1280 × 720, and the supported minimum 1180 × 720 retain all three usable panes with no overlapping controls or clipped composer/model settings.

## Interaction review

- Local PDF opens into a continuous 15-page reader; page 10 jump succeeded and only four nearby canvases were retained.
- A recommendation opens as a second left-side tab.
- Current-paper and all-papers chat scopes are independently selectable.
- Model and reasoning settings persist independently for each paper scope and the all-papers scope.
- Sol and Terra expose six live efforts; Luna exposes five and correctly omits `ultra`.
- Chat send produced a streamed answer; Stop changed the pending answer to “回答已停止。” and restored the send control.
- Keyboard and accessibility semantics cover paper tabs, model radios, scope buttons, dialogs, errors, PDF toolbar, labeled icon actions, and chat completion states. Focus indicators, AA text contrast, and reduced-motion behavior are present.

## Severity pass

- P0: none.
- P1: none.
- P2: source mock uses placeholder PDF blocks and sample paper counts; the implementation intentionally renders the real PDF and live recommendation data. This is dynamic-content variance, not a fidelity defect.

final result: passed
