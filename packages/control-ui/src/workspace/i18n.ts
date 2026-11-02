import { createInstance } from "i18next";
import en from "./locales/en.json";
import zh from "./locales/zh-CN.json";

export type MessageKey = keyof typeof en;
export type Translator = (
  key: MessageKey,
  values?: Record<string, string | number>,
) => string;
export function translator(locale: string): Translator {
  const i18n = createInstance();
  void i18n.init({
    lng: locale,
    fallbackLng: "en",
    initAsync: false,
    resources: { en: { translation: en }, "zh-CN": { translation: zh } },
    interpolation: { escapeValue: false },
  });
  return (key, values) => i18n.t(key, values);
}
