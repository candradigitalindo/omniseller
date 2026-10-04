import type { Env } from "../../config/env.schema";
import type { ImageFetchConfig } from "./image-fetch";

/** Where product images may be downloaded from (worker), built from PRODUCT_IMAGE_HOSTS and NODE_ENV. */
export const IMAGE_FETCH = Symbol("IMAGE_FETCH");

export function imageFetchConfig(env: Env): ImageFetchConfig {
  const hosts = "PRODUCT_IMAGE_HOSTS" in env ? env.PRODUCT_IMAGE_HOSTS : "";
  return {
    extraHosts: hosts
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean),
    allowHttp: env.NODE_ENV === "local" || env.NODE_ENV === "test",
  };
}
