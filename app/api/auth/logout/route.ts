import { clearSession } from "@/lib/postgres/auth";
import { NextResponse } from "next/server";

export async function POST() {
  await clearSession();
  return NextResponse.json({ ok: true });
}
