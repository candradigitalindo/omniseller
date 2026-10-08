import { MockXendit, XENDIT_TEST_KEY, XENDIT_TEST_TOKEN } from "./mock-xendit";

/**
 * `pnpm mock:xendit`: the fake Xendit as a standing process, for the e2e run (CI) and local smoke runs.
 * The Invoice API and its payment pages listen on MOCK_XENDIT_PORT (57480); the page's "Bayar (simulasi)"
 * button sends the paid callback to MOCK_XENDIT_CALLBACK_URL (the webhook process) with
 * MOCK_XENDIT_CALLBACK_TOKEN, then returns the browser to the app, as Xendit's test mode does. The backend
 * points at it with XENDIT_API_BASE_URL=http://127.0.0.1:57480, XENDIT_SECRET_KEY set to the key printed
 * on start, and XENDIT_WEBHOOK_TOKEN set to the callback token.
 */
async function main(): Promise<void> {
  const mock = new MockXendit({
    callback: {
      url: process.env.MOCK_XENDIT_CALLBACK_URL ?? "http://127.0.0.1:3001/webhooks/xendit",
      token: process.env.MOCK_XENDIT_CALLBACK_TOKEN ?? XENDIT_TEST_TOKEN,
    },
    // the ids of this run never repeat those of an earlier one kept in the same database
    idPrefix: `mockinv${Date.now().toString(36)}`,
  });
  await mock.start(Number(process.env.MOCK_XENDIT_PORT ?? 57480));
  console.log(`fake Xendit at ${mock.url} (secret key ${XENDIT_TEST_KEY})`);
  const stop = () => void mock.close().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
