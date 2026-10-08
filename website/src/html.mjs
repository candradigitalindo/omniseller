/**
 * HTML written with tagged templates: every interpolated value is escaped unless it is itself HTML made by
 * `html` or marked with `raw`, so a business name with "&" or "<" can never break a page.
 */
class Html {
  constructor(text) {
    this.text = text;
  }
  toString() {
    return this.text;
  }
}

/** Trusted markup, inserted as it is. */
export const raw = (text) => new Html(text);

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function render(value) {
  if (value instanceof Html) return value.text;
  if (Array.isArray(value)) return value.map(render).join("");
  if (value === null || value === undefined || value === false) return "";
  return escapeHtml(value);
}

export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((value, i) => {
    out += render(value) + strings[i + 1];
  });
  return new Html(out);
}

/** "Rp 899.000"; 0 is "Gratis". */
export function rupiah(amount) {
  return amount === 0 ? "Gratis" : `Rp ${new Intl.NumberFormat("id-ID").format(amount)}`;
}

/** "1.000" */
export const count = (n) => new Intl.NumberFormat("id-ID").format(n);

/** Text still waiting for the business's own details. */
export const PLACEHOLDER = /\[ISI:[^\]]*\]/g;
