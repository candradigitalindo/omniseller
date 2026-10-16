import messages from "../../messages/id.json";
import type { Action } from "../contracts";
import type { AgentSnapshot } from "../core/types";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
for (const element of document.querySelectorAll<HTMLElement>("[data-i18n]"))
  element.textContent = String(messages[element.dataset.i18n as keyof typeof messages]);
let state: AgentSnapshot;
let printerSignature = "";
let preferencesDirty = false;
function confirmChoice(text: string): Promise<boolean> {
  const dialog = $<HTMLDialogElement>("confirm");
  $("confirm-text").textContent = text;
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "yes"), { once: true });
    dialog.showModal();
  });
}
async function act(action: Action) {
  const result = await window.printAgent.act(action);
  if (!result.ok) {
    $("notice").hidden = false;
    $("notice").textContent = messages.errors[result.error];
  }
  return result.ok;
}
function render(next: AgentSnapshot) {
  state = next;
  $("pairing").hidden = state.paired;
  $("paired").hidden = !state.paired;
  $("connection").textContent = state.paused
    ? messages.paused
    : state.connected
      ? messages.connected
      : messages.offline;
  $("connection").className = `badge${state.connected && !state.paused ? " online" : ""}`;
  $("notice").hidden = !state.error;
  $("notice").textContent = state.error ? messages.errors[state.error] : "";
  $("agent-name").textContent = state.name;
  $("pause").textContent = state.paused ? messages.resume : messages.pause;
  $("version").textContent = `${messages.version} ${state.version}`;
  $("update-status").textContent = messages[state.update as keyof typeof messages] as string;
  const signature = JSON.stringify(state.printers.map((p) => p.name));
  if (signature !== printerSignature) {
    for (const id of ["label-printer", "document-printer"]) {
      const select = $<HTMLSelectElement>(id);
      select.replaceChildren(new Option(messages.defaultPrinter, ""));
      for (const printer of state.printers) select.add(new Option(printer.name, printer.name));
    }
    printerSignature = signature;
  }
  if (!preferencesDirty) {
    $<HTMLInputElement>("computer-name").value = state.name;
    $<HTMLSelectElement>("label-printer").value = state.preferences.labelPrinter ?? "";
    $<HTMLSelectElement>("document-printer").value = state.preferences.documentPrinter ?? "";
  }
  $("printer-summary").textContent =
    `${state.preferences.labelPrinter ?? messages.defaultPrinter} · ${state.preferences.documentPrinter ?? messages.defaultPrinter}`;
  $("no-printers").hidden = state.printers.length > 0;
  const jobs = state.jobs.slice(0, 50);
  $("queue-count").textContent = String(jobs.filter((j) => !["printed", "cancelled"].includes(j.state)).length);
  $("empty").hidden = jobs.length > 0;
  const list = $("jobs");
  const jobSignature = JSON.stringify(jobs);
  if (list.dataset.signature !== jobSignature) {
    list.replaceChildren();
    for (const job of jobs) {
      const item = document.createElement("li");
      item.className = `job ${job.state}`;
      const line = document.createElement("div");
      line.className = "job-top";
      const title = document.createElement("strong");
      title.textContent = `${messages.job} · ${job.id.slice(-6)}`;
      const status = document.createElement("span");
      status.className = "job-state";
      status.textContent = messages[job.state];
      line.append(title, status);
      const info = document.createElement("small");
      info.textContent = `${messages.attempt} ${job.attempt} · ${job.copies} ${messages.copies} · ${job.reported ? messages.reported : messages.pendingReport}`;
      item.append(line, info);
      if (job.state === "uncertain") {
        const hint = document.createElement("p");
        hint.textContent = messages.uncertainHint;
        item.append(hint);
        const actions = document.createElement("div");
        actions.className = "actions";
        for (const [result, label] of [
          ["printed", messages.markPrinted],
          ["failed", messages.markFailed],
        ] as const) {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = label;
          button.onclick = async () => {
            if (await confirmChoice(messages.resultConfirm))
              await act({ type: "resolve", id: job.id, attempt: job.attempt, status: result });
          };
          actions.append(button);
        }
        item.append(actions);
      }
      if (job.state === "failed") {
        const retry = document.createElement("button");
        retry.type = "button";
        retry.textContent = messages.retry;
        retry.onclick = async () => {
          if (await confirmChoice(messages.retryConfirm)) await act({ type: "retry", id: job.id });
        };
        item.append(retry);
      }
      list.append(item);
    }
    list.dataset.signature = jobSignature;
  }
}
$("pair-form").onsubmit = async (event) => {
  event.preventDefault();
  const button = $<HTMLButtonElement>("pair-button");
  button.disabled = true;
  button.textContent = messages.pairing;
  try {
    if (
      await act({
        type: "pair",
        origin: $<HTMLInputElement>("origin").value,
        token: $<HTMLInputElement>("token").value.trim(),
      })
    )
      $<HTMLInputElement>("token").value = "";
  } finally {
    button.disabled = false;
    button.textContent = messages.pair;
  }
};
for (const id of ["label-printer", "document-printer", "computer-name"])
  $(id).onchange = () => {
    preferencesDirty = true;
    $("saved").textContent = "";
  };
$("printers-form").onsubmit = async (event) => {
  event.preventDefault();
  if (
    await act({
      type: "printers",
      preferences: {
        name: $<HTMLInputElement>("computer-name").value.trim(),
        labelPrinter: $<HTMLSelectElement>("label-printer").value || null,
        documentPrinter: $<HTMLSelectElement>("document-printer").value || null,
      },
    })
  ) {
    preferencesDirty = false;
    $("saved").textContent = messages.saved;
  }
};
$("test-print").onclick = async () => {
  if (await act({ type: "test-print" })) $("saved").textContent = messages.testQueued;
};
$("pause").onclick = () => {
  void act({ type: "pause", paused: !state.paused });
};
$("refresh").onclick = () => {
  void act({ type: "refresh" });
};
$("unpair").onclick = async () => {
  if (await confirmChoice(messages.unpairConfirm)) await act({ type: "unpair" });
};
$("update").onclick = () => {
  void act({ type: "update" });
};
$("quit").onclick = () => {
  void act({ type: "quit" });
};
window.printAgent.subscribe(render);
void window.printAgent.snapshot().then(render);
