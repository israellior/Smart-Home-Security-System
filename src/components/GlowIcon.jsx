/**
 * The small "camera/aperture" glyph used inside the hero glow ring
 * on the Home page. Kept as its own component so it can be reused
 * (e.g. in a future "no signal" state elsewhere) without duplicating
 * the SVG markup.
 */
export function GlowIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" stroke="currentColor" fill="none" strokeWidth="1.6">
      <path d="M12 3v2M12 19v2M5 12H3M21 12h-2M6.3 6.3L4.9 4.9M19.1 19.1l-1.4-1.4M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4" />
      <circle cx="12" cy="12" r="4" />
    </svg>
  );
}
