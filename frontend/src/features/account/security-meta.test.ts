import { describe, expect, it } from "vitest";
import { backupCodesText, deviceName, groupSecret, isPhone, qrDataUrl } from "./security-meta";

describe("two-step verification helpers", () => {
  it("shows the secret in groups of four, as it is typed into an app", () => {
    expect(groupSecret("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP")).toBe("JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP");
    expect(groupSecret("ABCDEF")).toBe("ABCD EF");
  });

  it("puts the api's QR code in an image source, escaped", () => {
    expect(qrDataUrl('<svg a="1"/>')).toBe("data:image/svg+xml;charset=utf-8,%3Csvg%20a%3D%221%22%2F%3E");
  });

  it("writes the backup codes to keep, one per line", () => {
    expect(backupCodesText(["a", "b"], "Kode untuk rina", "Sekali pakai.")).toBe(
      "Kode untuk rina\n\na\nb\n\nSekali pakai.\n",
    );
  });
});

describe("devices", () => {
  const named = (b: string, o: string) => `${b} di ${o}`;
  it("names a device by what is known of it", () => {
    expect(deviceName({ browser: "Chrome", os: "macOS" }, named, "?")).toBe("Chrome di macOS");
    expect(deviceName({ browser: "Firefox", os: null }, named, "?")).toBe("Firefox");
    expect(deviceName({ browser: null, os: "Android" }, named, "?")).toBe("Android");
    expect(deviceName({ browser: null, os: null }, named, "Perangkat tidak dikenal")).toBe("Perangkat tidak dikenal");
  });

  it("tells phones from computers", () => {
    expect(["iOS", "Android", "macOS", "Windows", null].map(isPhone)).toEqual([true, true, false, false, false]);
  });
});
