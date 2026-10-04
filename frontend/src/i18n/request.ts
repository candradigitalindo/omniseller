import { getRequestConfig } from "next-intl/server";

/**
 * Indonesian only for now (technology doc 9: next-intl, `id-ID` by default, `en` later). There is no
 * locale in the URL: when English comes, the locale is read from the user's profile (`/v1/me`
 * `user.locale`) through a cookie here.
 */
export default getRequestConfig(async () => {
  const locale = "id";
  return {
    locale,
    timeZone: "Asia/Jakarta",
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
