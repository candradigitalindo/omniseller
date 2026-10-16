# Print agent

Read the root AGENTS.md and this workspace's README first. Node 24, pnpm 10; commands run here. All UI text belongs to `messages/id.json`. API types are generated from `../backend/openapi.json` with `pnpm api:types`.

- Never persist buyer data, document titles, device tokens, signed URLs, or PDF bytes in SQLite/logs. Tokens use OS safeStorage only; temporary PDFs must be removed on every outcome and after restart.
- Journal `(device binding, job id, attempt)` before calling the OS. Interrupted/ambiguous printing requires explicit user resolution, never automatic reprinting. Retry result acknowledgements without printing again.
- Renderer stays sandboxed and isolated without Node, with narrow validated IPC from the main frame of the local app URL only. Marketplace/backend requests run in main, never renderer. Do not forward the Bearer token across a file redirect.
- Never call a real printer from automated tests. The test entry is separate from dist and packaged files. Test injection must never be activated by environment variables in production.
- No automatic publishing. Public release requires signing and HTTPS update feed; keep unsigned internal builds without a feed. Keep the SumatraPDF version, hash, notices, licenses, and matching source together when upgrading.
