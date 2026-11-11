// The classic-console glyph swap (src/ui/console-glyphs.ts) turns on when no terminal announces itself, which is
// the case on the Windows CI runner: frames then show stand-ins and every wait for a real symbol times out.
// Tests expect the real symbols; the stand-in test sets ORCHESTRA_BASIC_SYMBOLS=1 for itself.
process.env.ORCHESTRA_BASIC_SYMBOLS ??= "0"
