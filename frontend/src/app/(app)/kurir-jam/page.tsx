import type { Metadata } from "next";
import { CourierHoursView } from "@/features/courier-hours/courier-hours-view";

export const metadata: Metadata = { title: "Kurir & Jam Operasional" };

export default function CourierHoursPage() {
  return <CourierHoursView />;
}
