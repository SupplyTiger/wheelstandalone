import { getSnapLoginLink } from "@/lib/integrations/snaptrade";
import { NextResponse } from "next/server";

export async function POST() {
  try {
    return NextResponse.json(await getSnapLoginLink());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
