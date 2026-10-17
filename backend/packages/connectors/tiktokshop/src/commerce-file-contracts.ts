import type { CommerceOperation } from "@omniseller/connector-core";

const images = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/bmp"];
const chatImages = ["image/jpeg", "image/gif", "image/webp", "image/png"];
const videos = [
  "video/mp4",
  "video/quicktime",
  "video/x-matroska",
  "video/x-ms-wmv",
  "video/webm",
  "video/x-msvideo",
  "video/3gpp",
  "video/x-flv",
  "video/mpeg",
];
const uploads: Record<string, { maxBytes: number; accept: string[] }> = {
  "/product/202309/images/upload": { maxBytes: 10_000_000, accept: images },
  "/product/202309/files/upload": { maxBytes: 100_000_000, accept: ["application/pdf", ...videos] },
  "/fulfillment/202309/files/upload": { maxBytes: 10_000_000, accept: ["application/pdf"] },
  "/fulfillment/202309/images/upload": { maxBytes: 5_000_000, accept: ["image/jpeg", "image/png"] },
  "/customer_service/202309/images/upload": { maxBytes: 10_000_000, accept: chatImages },
  "/affiliate_creator/202505/videos/video_files": { maxBytes: 10_000_000, accept: videos },
  "/affiliate_creator/202511/photos/photo_files": { maxBytes: 10_485_760, accept: images },
  "/affiliate_seller/202511/images/upload": { maxBytes: 10_000_000, accept: chatImages },
  "/affiliate_seller/202608/media/upload": { maxBytes: 10_000_000, accept: chatImages },
};
/** Reviewed multipart contracts; file ids refer to private account-bound local uploads. */
export function commerceFileOperation(operation: CommerceOperation): CommerceOperation {
  if (operation.path === "/open/202512/file/init")
    return {
      ...operation,
      available: false,
      unavailableReason: "Private upload sessions use the dedicated large-video workflow",
    };
  const upload = uploads[operation.path];
  if (upload)
    return {
      ...operation,
      available: true,
      unavailableReason: null,
      transport: "multipart",
      fields: operation.fields.map((field) =>
        field.name === "body.data"
          ? {
              ...field,
              label: "Berkas",
              type: "file",
              ...upload,
              ...(operation.path === "/product/202309/files/upload"
                ? { maxBytesByMime: { "application/pdf": 20_000_000 } }
                : {}),
            }
          : field,
      ),
    };
  if (operation.path === "/affiliate_seller/202603/compass/offline_tasks/{task_id}/file")
    return { ...operation, available: true, unavailableReason: null, transport: "private_download" };
  return operation;
}
/** Prepare a resource for a fixed business endpoint; this never publishes content or sends a message. */
export function largeVideoOperations(operations: readonly CommerceOperation[]): CommerceOperation[] {
  const variants = [
    {
      id: "tiktok_large_creator_video",
      target: "tiktok_69cb362bf76068049e7a08f2",
      title: "Unggah aset video creator berukuran besar",
      maxBytes: 500 * 1024 * 1024,
    },
    {
      id: "tiktok_large_chat_video",
      target: "tiktok_6a1ff121795c140490537a5c",
      title: "Unggah aset video untuk pesan pelanggan",
      maxBytes: 100 * 1024 * 1024,
    },
  ];
  return variants.flatMap((variant) => {
    const target = operations.find((operation) => operation.id === variant.target);
    if (!target) return [];
    return [
      {
        ...target,
        id: variant.id,
        title: variant.title,
        method: "POST" as const,
        path: "/open/202512/file/init",
        write: true,
        transport: "large_upload" as const,
        available: true,
        unavailableReason: null,
        officialUrl: "https://partner.tiktokshop.com/docv2/page/wfi3nz36",
        fields: [
          {
            name: "body.data",
            label: "Berkas video",
            type: "file" as const,
            required: true,
            maxBytes: variant.maxBytes,
            minBytes: 10_000_001,
            accept: ["video/mp4", "video/quicktime", "video/webm"],
            description:
              "Unggah aset video di atas 10 MB. Hasil berupa resource ID untuk operasi tujuan yang ditentukan. Pengunggahan ini belum menerbitkan video atau mengirim pesan.",
          },
        ],
        responseFields: ["resource_id", "target_operation_id"],
      },
    ];
  });
}
export function largeVideoTarget(operationId: string) {
  return operationId === "tiktok_large_creator_video"
    ? "tiktok_69cb362bf76068049e7a08f2"
    : operationId === "tiktok_large_chat_video"
      ? "tiktok_6a1ff121795c140490537a5c"
      : null;
}
