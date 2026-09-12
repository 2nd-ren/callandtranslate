export const LANGUAGES = [
  { code: "en", name: "English" },
  { code: "es", name: "Spanish" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
  { code: "it", name: "Italian" },
  { code: "pt", name: "Portuguese" },
  { code: "nl", name: "Dutch" },
  { code: "pl", name: "Polish" },
  { code: "ru", name: "Russian" },
  { code: "uk", name: "Ukrainian" },
  { code: "ar", name: "Arabic" },
  { code: "zh", name: "Chinese" },
  { code: "ja", name: "Japanese" },
  { code: "ko", name: "Korean" },
  { code: "hi", name: "Hindi" },
  { code: "bn", name: "Bengali" },
  { code: "tr", name: "Turkish" },
  { code: "vi", name: "Vietnamese" },
  { code: "th", name: "Thai" },
  { code: "id", name: "Indonesian" },
  { code: "ms", name: "Malay" },
  { code: "fil", name: "Filipino" },
  { code: "sv", name: "Swedish" },
  { code: "da", name: "Danish" },
  { code: "no", name: "Norwegian" },
  { code: "fi", name: "Finnish" },
  { code: "el", name: "Greek" },
  { code: "he", name: "Hebrew" },
  { code: "cs", name: "Czech" },
  { code: "ro", name: "Romanian" },
  { code: "hu", name: "Hungarian" },
  { code: "bg", name: "Bulgarian" },
  { code: "hr", name: "Croatian" },
  { code: "sk", name: "Slovak" },
  { code: "sl", name: "Slovenian" },
  { code: "sr", name: "Serbian" },
  { code: "ca", name: "Catalan" },
  { code: "ta", name: "Tamil" },
  { code: "ur", name: "Urdu" },
  { code: "fa", name: "Persian" },
  { code: "sw", name: "Swahili" },
];

const LANGUAGE_MAP = new Map(LANGUAGES.map((row) => [row.code, row]));

export function getLanguage(code) {
  const key = String(code || "").trim().toLowerCase();
  return LANGUAGE_MAP.get(key) || LANGUAGE_MAP.get("en");
}

export function languageName(code) {
  return getLanguage(code).name;
}

export function isLanguageCode(code) {
  return LANGUAGE_MAP.has(String(code || "").trim().toLowerCase());
}

export function normalizeLanguageCode(code, fallback = "en") {
  const key = String(code || "").trim().toLowerCase();
  if (LANGUAGE_MAP.has(key)) return key;
  const short = key.split("-")[0];
  if (LANGUAGE_MAP.has(short)) return short;
  return fallback;
}
