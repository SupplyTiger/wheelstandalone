import "server-only";

import type { AccountSnapshot, WheelPosition } from "@/lib/types";
import { promises as fs } from "fs";
import path from "path";

type LocalSnapshot = {
  account: AccountSnapshot;
  positions: WheelPosition[];
  warning?: string | null;
};

const snapshotPath = path.join(process.cwd(), ".wheel-local-snapshot.json");

export async function readLocalSnapshot(): Promise<LocalSnapshot | null> {
  try {
    const raw = await fs.readFile(snapshotPath, "utf8");
    const parsed = JSON.parse(raw) as LocalSnapshot;
    if (!parsed.account || !Array.isArray(parsed.positions)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeLocalSnapshot(snapshot: LocalSnapshot) {
  await fs.writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}
