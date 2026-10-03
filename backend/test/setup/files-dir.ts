import { resolve } from "node:path";

/** Local file storage shared by the api and worker of one test run (labels, documents), removed after the run. */
export function testFilesDir(keyPrefix: string): string {
  return resolve(__dirname, "../../.local/test-files", keyPrefix.replace(/[^a-zA-Z0-9_-]/g, "_"));
}
