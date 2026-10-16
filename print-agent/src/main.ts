import { app, dialog, safeStorage } from "electron";
import messages from "../messages/id.json";
import { startDesktop } from "./application";

app.setName("OmniSeller Agen Cetak");
if (!app.requestSingleInstanceLock()) app.quit();
else
  void startDesktop({
    assets: __dirname,
    directory: app.getPath("userData"),
    secure: {
      available: () => safeStorage.isEncryptionAvailable() && process.platform !== "linux",
      encrypt: (value) => safeStorage.encryptString(value),
      decrypt: (value) => safeStorage.decryptString(value),
    },
  }).catch(() => {
    dialog.showErrorBox(messages.app, messages.errors.storage);
    app.exit(1);
  });
