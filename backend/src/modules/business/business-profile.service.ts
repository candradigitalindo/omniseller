import { Inject, Injectable } from "@nestjs/common";
import { newId } from "@omniseller/shared";
import type { RequestContext } from "../../common/context/request-context";
import { ConflictError } from "../../common/errors/domain-errors";
import { type ExportSheet, singlePage } from "../../common/export-sheet";
import { sniffFileType } from "../../common/file-type";
import { provinceOf } from "../../common/region";
import { localDate } from "../../common/time-zone";
import type { DbHandle, Tx } from "../../db/client";
import type {
  BusinessAddress,
  BusinessDocumentKind,
  DocumentReminderStage,
  InvoiceBillTo,
  NibReminderStage,
} from "../../db/schema";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import type { DownloadTarget } from "../files/files.service";
import { FilesService } from "../files/files.service";
import { TenantsService } from "../identity/tenants.service";
import { NotificationInboxService } from "../notification/inbox.service";
import {
  businessDocumentNotFound,
  documentDates,
  fileInvalid,
  futureDate,
  logoNotFound,
  nibAndProcess,
} from "./business.errors";
import { type BusinessDocumentRow, type BusinessProfileRow, BusinessRepository } from "./business.repository";
import {
  type DocumentStatus,
  daysBetween,
  documentStatus,
  dueDocumentStage,
  dueNibStage,
  type LegalTask,
  legalTasks,
  type NibStatus,
  nibDeadline,
  nibStatus,
} from "./business-plan";

const MAX_LOGO_BYTES = 1_000_000;
const MAX_DOCUMENT_BYTES = 5_000_000;

/** What a document is called when the seller gives it no title of its own. */
export const DOCUMENT_TITLES: Record<BusinessDocumentKind, string> = {
  nib: "NIB",
  npwp: "NPWP",
  sppkp: "SPPKP",
  deed: "Akta pendirian",
  business_license: "Izin usaha",
  other: "Dokumen lain",
};

export interface DocumentView {
  id: string;
  kind: BusinessDocumentKind;
  title: string;
  number: string | null;
  issuedOn: string | null;
  validUntil: string | null;
  status: DocumentStatus;
  daysLeft: number | null;
  fileName: string;
  createdAt: Date;
}

export interface BusinessProfileView {
  /** 0 until the profile is first saved; the ETag of `PATCH /v1/business-profile`. */
  rowVersion: number;
  name: string;
  timezone: string;
  address: BusinessAddress;
  phone: string | null;
  hasLogo: boolean;
  nib: string | null;
  nibInProcessSince: string | null;
  nibStatus: NibStatus;
  nibDeadline: string | null;
  nibDaysLeft: number | null;
  npwp: string | null;
  pkp: boolean;
  documents: DocumentView[];
  /** The business's local date the statuses are computed for. */
  today: string;
}

export interface ProfilePatch {
  name?: string;
  timezone?: string;
  address?: BusinessAddress;
  phone?: string | null;
  nib?: string | null;
  nibInProcessSince?: string | null;
  npwp?: string | null;
  pkp?: boolean;
}

export interface DocumentInput {
  kind: BusinessDocumentKind;
  title?: string | undefined;
  number?: string | null | undefined;
  issuedOn?: string | null | undefined;
  validUntil?: string | null | undefined;
  fileName: string;
  content: string;
}

export type DocumentPatch = Partial<Pick<DocumentInput, "title" | "number" | "issuedOn" | "validUntil">>;

const stale = () => new ConflictError("row.stale", "Data sudah diubah orang lain. Muat ulang lalu coba lagi.");
const actorOf = (ctx: RequestContext) => (ctx.actor.type === "user" ? ctx.actor.id : null);

/**
 * The business profile and its legal documents (PRD 6.13 and 12, Permendag 19/2026; UI L47; backend doc
 * 8.29): name, address, logo, NIB or an NIB in process (six months at most), NPWP, PKP, and documents with
 * how long they are valid. Reminders before an NIB deadline or a document's end date go to whoever keeps
 * the business's papers (settings:billing), in the app and by email.
 */
@Injectable()
export class BusinessProfileService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(BusinessRepository) private readonly repo: BusinessRepository,
    @Inject(TenantsService) private readonly tenants: TenantsService,
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(NotificationInboxService) private readonly inbox: NotificationInboxService,
  ) {}

  get(ctx: RequestContext): Promise<BusinessProfileView> {
    return withTenantTx(this.db, ctx, (tx) => this.viewIn(tx, ctx));
  }

  async viewIn(tx: Tx, ctx: RequestContext): Promise<BusinessProfileView> {
    const { name, timezone } = await this.tenants.profileIn(tx, ctx);
    const today = localDate(timezone, new Date());
    const p = await this.repo.profile(tx);
    const since = p?.nibInProcessSince ?? null;
    const deadline = !p?.nib && since ? nibDeadline(since) : null;
    return {
      rowVersion: p?.rowVersion ?? 0,
      name,
      timezone,
      address: p?.address ?? {},
      phone: p?.phone ?? null,
      hasLogo: !!p?.logoFileId,
      nib: p?.nib ?? null,
      nibInProcessSince: since,
      nibStatus: nibStatus({ nib: p?.nib ?? null, nibInProcessSince: since }),
      nibDeadline: deadline,
      nibDaysLeft: deadline ? daysBetween(today, deadline) : null,
      npwp: p?.npwp ?? null,
      pkp: p?.pkp ?? false,
      documents: (await this.repo.documents(tx)).map((d) => documentView(d, today)),
      today,
    };
  }

  /**
   * Who OmniSeller's invoices to this business are billed to (backend doc 8.32): its name, address, and
   * NPWP as the profile holds them now. Billing copies it into an invoice when the invoice is paid.
   */
  async billToIn(tx: Tx, ctx: RequestContext): Promise<InvoiceBillTo> {
    const { name } = await this.tenants.profileIn(tx, ctx);
    const p = await this.repo.profile(tx);
    return { name, address: p?.address ?? {}, npwp: p?.npwp ?? null };
  }

  /** Saves the profile; `ifMatch` is the `rowVersion` read (0 before the first save). */
  async update(ctx: RequestContext, patch: ProfilePatch, ifMatch?: number): Promise<BusinessProfileView> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const current = await this.repo.profile(tx, true);
      if (ifMatch !== undefined && ifMatch !== (current?.rowVersion ?? 0)) throw stale();
      const { timezone } = await this.tenants.profileIn(tx, ctx);
      const today = localDate(patch.timezone ?? timezone, new Date());
      if (patch.nibInProcessSince && patch.nibInProcessSince > today) throw futureDate("nibInProcessSince");
      // an NIB ends the process, and a process means there is no NIB yet
      const nib = patch.nib !== undefined ? patch.nib : (current?.nib ?? null);
      const since =
        patch.nibInProcessSince !== undefined
          ? patch.nibInProcessSince
          : patch.nib
            ? null
            : (current?.nibInProcessSince ?? null);
      if (nib && since) throw nibAndProcess();
      await this.tenants.updateProfileIn(tx, ctx, {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
      });
      const values: Partial<BusinessProfileRow> = {
        ...(patch.address !== undefined ? { address: canonicalAddress(patch.address) } : {}),
        ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
        ...(patch.nib !== undefined || patch.nibInProcessSince !== undefined ? { nib, nibInProcessSince: since } : {}),
        // a new start date means the reminders start again
        ...(since !== (current?.nibInProcessSince ?? null) ? { nibRemindedStage: null } : {}),
        ...(patch.npwp !== undefined ? { npwp: patch.npwp } : {}),
        ...(patch.pkp !== undefined ? { pkp: patch.pkp } : {}),
      };
      if (current) {
        // name and time zone live on tenant: the profile's version still moves, so one ETag covers both
        if (!(await this.repo.updateProfile(tx, current.id, values, current.rowVersion))) throw stale();
      } else {
        await this.repo.insertProfile(tx, { id: newId(), tenantId: ctx.tenantId, ...values });
      }
      return this.viewIn(tx, ctx);
    });
  }

  /** A PNG, JPEG, or WebP of at most 1 MB; the old logo's file expires. */
  async setLogo(ctx: RequestContext, content: string): Promise<BusinessProfileView> {
    const bytes = new Uint8Array(Buffer.from(content, "base64"));
    const type = sniffFileType(bytes);
    if (!type || type.mime === "application/pdf" || bytes.length > MAX_LOGO_BYTES) {
      throw fileInvalid("content", "Logo berupa PNG, JPG, atau WebP, paling besar 1 MB.");
    }
    const file = await this.files.save(ctx, {
      purpose: "logo",
      bytes,
      mime: type.mime,
      ext: type.ext,
      expiresAt: null,
      createdBy: actorOf(ctx),
    });
    return withTenantTx(this.db, ctx, async (tx) => {
      const current = await this.repo.profile(tx, true);
      if (current) {
        await this.repo.updateProfile(tx, current.id, { logoFileId: file.id });
        if (current.logoFileId) await this.files.expireIn(tx, [current.logoFileId]);
      } else {
        await this.repo.insertProfile(tx, { id: newId(), tenantId: ctx.tenantId, logoFileId: file.id });
      }
      return this.viewIn(tx, ctx);
    });
  }

  async removeLogo(ctx: RequestContext): Promise<BusinessProfileView> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const current = await this.repo.profile(tx, true);
      if (current?.logoFileId) {
        await this.repo.updateProfile(tx, current.id, { logoFileId: null });
        await this.files.expireIn(tx, [current.logoFileId]);
      }
      return this.viewIn(tx, ctx);
    });
  }

  async logo(ctx: RequestContext): Promise<DownloadTarget> {
    const p = await withTenantTx(this.db, ctx, (tx) => this.repo.profile(tx));
    if (!p?.logoFileId) throw logoNotFound();
    return this.files.download(ctx, p.logoFileId, ["logo"], { filename: "logo" });
  }

  /** A PDF, PNG, or JPEG of at most 5 MB, uploaded before its row is written. */
  async addDocument(ctx: RequestContext, input: DocumentInput): Promise<DocumentView> {
    const bytes = new Uint8Array(Buffer.from(input.content, "base64"));
    const type = sniffFileType(bytes);
    if (!type || type.mime === "image/webp" || bytes.length > MAX_DOCUMENT_BYTES) {
      throw fileInvalid("content", "Dokumen berupa PDF, JPG, atau PNG, paling besar 5 MB.");
    }
    checkDates(input);
    const file = await this.files.save(ctx, {
      purpose: "legal_document",
      bytes,
      mime: type.mime,
      ext: type.ext,
      expiresAt: null,
      createdBy: actorOf(ctx),
    });
    return withTenantTx(this.db, ctx, async (tx) => {
      const id = newId();
      await this.repo.insertDocument(tx, {
        id,
        tenantId: ctx.tenantId,
        kind: input.kind,
        title: input.title?.trim() || DOCUMENT_TITLES[input.kind],
        number: input.number ?? null,
        issuedOn: input.issuedOn ?? null,
        validUntil: input.validUntil ?? null,
        fileObjectId: file.id,
        fileName: input.fileName,
        createdBy: actorOf(ctx),
      });
      return this.documentIn(tx, ctx, id);
    });
  }

  async updateDocument(ctx: RequestContext, id: string, patch: DocumentPatch): Promise<DocumentView> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const d = await this.repo.document(tx, id, true);
      if (!d) throw businessDocumentNotFound();
      checkDates({
        issuedOn: patch.issuedOn !== undefined ? patch.issuedOn : d.issuedOn,
        validUntil: patch.validUntil !== undefined ? patch.validUntil : d.validUntil,
      });
      await this.repo.updateDocument(tx, id, {
        ...(patch.title !== undefined ? { title: patch.title.trim() || DOCUMENT_TITLES[d.kind] } : {}),
        ...(patch.number !== undefined ? { number: patch.number } : {}),
        ...(patch.issuedOn !== undefined ? { issuedOn: patch.issuedOn } : {}),
        // renewed: the reminders start again for the new end date
        ...(patch.validUntil !== undefined && patch.validUntil !== d.validUntil
          ? { validUntil: patch.validUntil, remindedStage: null }
          : {}),
      });
      return this.documentIn(tx, ctx, id);
    });
  }

  /** Removes the document; its file expires and the hourly cleanup deletes it. */
  async removeDocument(ctx: RequestContext, id: string): Promise<void> {
    await withTenantTx(this.db, ctx, async (tx) => {
      const d = await this.repo.document(tx, id, true);
      if (!d) throw businessDocumentNotFound();
      await this.repo.deleteDocument(tx, id);
      await this.files.expireIn(tx, [d.fileObjectId]);
    });
  }

  async documentFile(ctx: RequestContext, id: string): Promise<DownloadTarget> {
    const d = await withTenantTx(this.db, ctx, (tx) => this.repo.document(tx, id));
    if (!d) throw businessDocumentNotFound();
    return this.files.download(ctx, d.fileObjectId, ["legal_document"], { filename: d.fileName });
  }

  /** "Perlu tindakan" on the dashboard, in the caller's transaction (only for settings:billing). */
  async legalTasksIn(tx: Tx, today: string): Promise<LegalTask[]> {
    const p = await this.repo.profile(tx);
    return legalTasks(
      { nib: p?.nib ?? null, nibInProcessSince: p?.nibInProcessSince ?? null },
      await this.repo.documents(tx),
      today,
    );
  }

  /**
   * The reminders due today (worker, job `business.legal_alert`): each document's 30-day, 7-day, and
   * expired reminder and the NIB deadline's, once each, to every holder of settings:billing, in the app
   * and by email. Returns how many reminders went out.
   */
  async alertLegal(ctx: RequestContext, now = new Date()): Promise<number> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const { timezone } = await this.tenants.profileIn(tx, ctx);
      const today = localDate(timezone, now);
      const reminders: {
        title: string;
        body: string;
        severity: "info" | "warning" | "critical";
        data: Record<string, unknown>;
      }[] = [];
      for (const d of await this.repo.documents(tx)) {
        const stage = dueDocumentStage(d.validUntil, today, d.remindedStage);
        if (!stage) continue;
        await this.repo.updateDocument(tx, d.id, { remindedStage: stage });
        reminders.push(documentReminder(d, stage, today));
      }
      const p = await this.repo.profile(tx, true);
      const nibStage = p ? dueNibStage(p, today) : null;
      if (p && nibStage) {
        await this.repo.updateProfile(tx, p.id, { nibRemindedStage: nibStage });
        reminders.push(nibReminder(nibDeadline(p.nibInProcessSince!), nibStage, today));
      }
      for (const r of reminders) {
        await this.inbox.notifyScopedIn(
          tx,
          ctx,
          "settings:billing",
          [{}],
          () => ({ kind: "legal.reminder", severity: r.severity, title: r.title, body: r.body, data: r.data }),
          { email: true },
        );
      }
      return reminders.length;
    });
  }

  private async documentIn(tx: Tx, ctx: RequestContext, id: string): Promise<DocumentView> {
    const { timezone } = await this.tenants.profileIn(tx, ctx);
    const d = await this.repo.document(tx, id);
    if (!d) throw businessDocumentNotFound();
    return documentView(d, localDate(timezone, new Date()));
  }

  exportSheets(): ExportSheet[] {
    return [
      {
        file: "profil_bisnis.csv",
        description: "Profil bisnis: alamat, telepon, NIB atau NIB dalam proses, NPWP, dan status PKP.",
        columns: [
          "alamat",
          "kecamatan",
          "kota",
          "provinsi",
          "kode_pos",
          "telepon",
          "nib",
          "nib_dalam_proses_sejak",
          "npwp",
          "pkp",
        ],
        pages: (tx) =>
          singlePage(async () => {
            const p = await this.repo.profile(tx);
            if (!p) return [];
            const a = p.address;
            return [
              [
                a.line1,
                a.district,
                a.city,
                a.province,
                a.postalCode,
                p.phone,
                p.nib,
                p.nibInProcessSince,
                p.npwp,
                p.pkp,
              ],
            ];
          }),
      },
      {
        file: "dokumen_legalitas.csv",
        description: "Dokumen legalitas usaha yang diunggah: jenis, nomor, dan masa berlaku. Berkasnya tidak ikut.",
        columns: ["id", "jenis", "judul", "nomor", "tanggal_terbit", "berlaku_sampai", "nama_berkas", "dibuat_pada"],
        pages: (tx) =>
          singlePage(async () =>
            (await this.repo.documents(tx)).map((d) => [
              d.id,
              d.kind,
              d.title,
              d.number,
              d.issuedOn,
              d.validUntil,
              d.fileName,
              d.createdAt,
            ]),
          ),
      },
    ];
  }
}

function documentView(d: BusinessDocumentRow, today: string): DocumentView {
  const { status, daysLeft } = documentStatus(d.validUntil, today);
  return {
    id: d.id,
    kind: d.kind,
    title: d.title,
    number: d.number,
    issuedOn: d.issuedOn,
    validUntil: d.validUntil,
    status,
    daysLeft,
    fileName: d.fileName,
    createdAt: d.createdAt,
  };
}

function checkDates(d: { issuedOn?: string | null | undefined; validUntil?: string | null | undefined }) {
  if (d.issuedOn && d.validUntil && d.validUntil < d.issuedOn) throw documentDates();
}

/** The province in its canonical spelling when OmniSeller knows it, as for warehouses. */
function canonicalAddress(a: BusinessAddress): BusinessAddress {
  const province = a.province ? (provinceOf(a.province)?.name ?? a.province) : undefined;
  return { ...a, ...(province ? { province } : {}) };
}

const dayText = (n: number) => (n === 0 ? "hari ini" : `${n} hari lagi`);
const longDate = (date: string) =>
  new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${date}T00:00:00Z`),
  );

function documentReminder(d: BusinessDocumentRow, stage: DocumentReminderStage, today: string) {
  const until = d.validUntil!;
  if (stage === "expired") {
    return {
      severity: "critical" as const,
      title: `${d.title} sudah habis berlaku`,
      body: `${d.title} berlaku sampai ${longDate(until)}. Unggah dokumen yang sudah diperpanjang di Profil Bisnis.`,
      data: { type: "document_expired", documentId: d.id },
    };
  }
  return {
    severity: "warning" as const,
    title: `${d.title} segera habis berlaku`,
    body: `${d.title} berlaku sampai ${longDate(until)} (${dayText(daysBetween(today, until))}). Perpanjang lalu unggah dokumen barunya di Profil Bisnis.`,
    data: { type: "document_expiring", documentId: d.id },
  };
}

function nibReminder(deadline: string, stage: NibReminderStage, today: string) {
  if (stage === "passed") {
    return {
      severity: "critical" as const,
      title: "Batas 6 bulan proses NIB sudah lewat",
      body: `Batasnya ${longDate(deadline)}. Marketplace dapat menolak penjual tanpa NIB (Permendag 19/2026). Isi NIB di Profil Bisnis begitu terbit.`,
      data: { type: "nib_deadline_passed" },
    };
  }
  return {
    severity: "warning" as const,
    title: "Batas proses NIB segera berakhir",
    body: `NIB harus terbit paling lambat ${longDate(deadline)} (${dayText(daysBetween(today, deadline))}). Isi NIB di Profil Bisnis begitu terbit.`,
    data: { type: "nib_deadline" },
  };
}
