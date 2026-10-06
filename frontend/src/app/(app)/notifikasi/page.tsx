import type { Metadata } from "next";
import { NotificationSettingsView } from "@/features/settings/notification-settings";

export const metadata: Metadata = { title: "Notifikasi" };

export default function NotificationSettingsPage() {
  return <NotificationSettingsView />;
}
