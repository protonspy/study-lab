// troika-three-text ships no types; the concept map only configures its text builder.
declare module "troika-three-text" {
  export function configureTextBuilder(config: { useWorker?: boolean; defaultFontURL?: string | null; unicodeFontsURL?: string | null; sdfGlyphSize?: number }): void
}
