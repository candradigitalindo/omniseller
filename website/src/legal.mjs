import { html } from "./html.mjs";

/**
 * A legal document: title, last update, a short summary, a table of contents, and numbered sections.
 * `sections` are `{ id, title, body }`, `body` written with `html`.
 */
export function legalBody(site, { title, summary, sections }) {
  return html`<article class="section legal">
  <div class="wrap narrow">
    <h1>${title}</h1>
    <p class="muted">Terakhir diperbarui ${site.legal.updated}</p>
    <div class="summary">${summary}</div>
    <nav class="toc" aria-label="Daftar isi">
      <h2>Daftar isi</h2>
      <ol>${sections.map((s) => html`<li><a href="#${s.id}">${s.title}</a></li>`)}</ol>
    </nav>
    ${sections.map((s, i) => html`<section aria-labelledby="${s.id}">
      <h2 id="${s.id}">${i + 1}. ${s.title}</h2>
      ${s.body}
    </section>`)}
  </div>
</article>`;
}
