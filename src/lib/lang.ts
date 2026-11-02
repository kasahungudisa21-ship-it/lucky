/**
 * The two languages the screen speaks, without any server-only import, so the
 * header switcher can use them from the browser too.
 */
import type { Lang } from "@/lib/ui";

export const LANGS: Lang[] = ["am", "en"];
export const LANG_COOKIE = "lucky_lang";

/** A language named by its own people, so the switcher needs no translation.
 * The Amharic entry is the syllabary composition `glottal_a-maa-re-nyaa`
 * (codepoints 12a0 121b 122d 129b), rendered and read back through
 * scripts/amharic.mjs rather than typed. */
export const LANG_LABELS: Record<Lang, string> = { am: "አማርኛ", en: "English" };

export function isLang(value: unknown): value is Lang {
  return typeof value === "string" && (LANGS as string[]).includes(value);
}

/** The other language, which is what a switcher offers. */
export const otherLang = (lang: Lang): Lang => (lang === "am" ? "en" : "am");
