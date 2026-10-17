// Accent-, case- and whitespace-insensitive form of a string, used for matching and search.
export const foldText = (value: string): string =>
  value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
