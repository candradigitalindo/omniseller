import type messages from "../messages/id.json";

/** Message keys and the locale are checked at compile time (next-intl `AppConfig`). */
declare module "next-intl" {
  interface AppConfig {
    Locale: "id";
    Messages: typeof messages;
  }
}
