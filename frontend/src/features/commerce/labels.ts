"use client";

import { useMessages } from "next-intl";

export type CommerceDictionary = Record<string, string>;
const patterns = new WeakMap<CommerceDictionary, RegExp>();

/** Business labels are translated; request field names and enum values retain their original wire value. */
export function localizeCommerceLabel(value: string, dictionary: CommerceDictionary): string {
  let pattern = patterns.get(dictionary);
  if (!pattern) {
    const phrases = Object.keys(dictionary)
      .sort((left, right) => right.length - left.length)
      .map((phrase) => phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    pattern = new RegExp(`\\b(?:${phrases.join("|")})\\b`, "gi");
    patterns.set(dictionary, pattern);
  }
  const normalized = value
    .replace(/([a-z])([A-Z])(?=[a-z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(
      /^(lihat|buat|ubah|hapus|batalkan|kirim|tambah)\s+(?:get|search|create|update|delete|cancel|send|add)\s+/i,
      "$1 ",
    );
  let matched = false;
  const translated = normalized.replace(pattern, (phrase) => {
    matched = true;
    return dictionary[phrase.toLowerCase()] ?? phrase;
  });
  return matched ? translated.replace(/^./, (letter) => letter.toUpperCase()) : value;
}

export function useCommerceLabel() {
  const dictionary = useMessages().commerce.dictionary;
  return (value: string) => localizeCommerceLabel(value, dictionary);
}
