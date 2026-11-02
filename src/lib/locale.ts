/**
 * Which language the screen speaks, on the server.
 *
 * The choice lives in a cookie rather than in the URL so every existing path
 * keeps working. A page asks once with `text()` and its `t("key", [args])` calls
 * then read in that language; a client component is handed the answer as a prop,
 * because reading a cookie there would only work after hydration.
 */
import { cookies } from "next/headers";
import { DEFAULT_LANG, tr, type Lang, type Tr } from "@/lib/ui";
import { LANG_COOKIE, isLang } from "@/lib/lang";

export { LANG_COOKIE, LANG_LABELS, LANGS, isLang, otherLang } from "@/lib/lang";

/** Amharic is the default: it is the language the portal was written in, and a
 * first visit from a shared link must not arrive in a language nobody chose. */
export async function currentLang(): Promise<Lang> {
  const store = await cookies();
  const value = store.get(LANG_COOKIE)?.value;
  return isLang(value) ? value : DEFAULT_LANG;
}

export async function text(): Promise<Tr> {
  return tr(await currentLang());
}
