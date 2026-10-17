import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { restrictedNodeTransportMethod } from "./audit-http-evidence.mjs";

function method(body) {
  const source = ts.createSourceFile(
    "get-json-body.ts",
    `const PATH = "/affiliate_creator/202606/toko_product_mappers";
     export function fetcher(input, init) {
       const url = new URL(input);
       ${body}
     }`,
    ts.ScriptTarget.Latest,
    true,
  );
  return restrictedNodeTransportMethod("PATH", source);
}

test("recognizes a pathname-restricted Node GET transport through its method guard and actual request", () => {
  assert.equal(
    method(`if (url.pathname !== PATH || init?.method !== "GET") throw Error();
      return (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {method: "GET"}, response => {});`),
    "GET",
  );
});

test("a path constant and method declaration alone do not prove an HTTP call", () => {
  assert.equal(
    method(`if (url.pathname !== PATH || init?.method !== "GET") throw Error(); return {method: "GET"};`),
    undefined,
  );
});

test("a request without its restrictive path guard does not infer a constant's method", () => {
  assert.equal(
    method(`if (init?.method !== "GET") throw Error(); return httpsRequest(url, {method: "GET"});`),
    undefined,
  );
});

test("contradictory guard and transport methods remain unresolved", () => {
  assert.equal(
    method(
      `if (url.pathname !== PATH || init?.method !== "GET") throw Error(); return httpsRequest(url, {method: "POST"});`,
    ),
    undefined,
  );
});

test("multiple request methods in the guarded scope remain unresolved", () => {
  assert.equal(
    method(`if (url.pathname !== PATH || init?.method !== "GET") throw Error();
    if (condition) return httpsRequest(url, {method: "POST"}); return httpRequest(url, {method: "GET"});`),
    undefined,
  );
});

test("ordinary metadata callbacks and unrelated transports are ignored", () => {
  assert.equal(
    method(`if (url.pathname !== PATH || init?.method !== "GET") throw Error();
    return observer(url, {method: "GET"});`),
    undefined,
  );
});
