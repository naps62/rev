import { homedir } from "node:os";
import { TUNING } from "#shared/tuning";

export function expandHome(p: string): string {
  return p.startsWith("~") ? homedir() + p.slice(1) : p;
}

export const config = {
  port: Number(process.env.REV_PORT ?? TUNING.PORT),
  roots: (process.env.REV_ROOTS?.split(":") ?? TUNING.DEFAULT_ROOTS).map(expandHome),
  depth: Number(process.env.REV_DEPTH ?? TUNING.DISCOVERY_MAX_DEPTH),
  dbPath: expandHome(process.env.REV_DB ?? TUNING.DB_PATH),
  personalHosts: process.env.REV_PERSONAL_HOSTS?.split(",").map((h) => h.trim()).filter(Boolean)
    ?? [...TUNING.PERSONAL_HOSTS],
  personalOwners: process.env.REV_PERSONAL_OWNERS?.split(",").map((o) => o.trim().toLowerCase()).filter(Boolean)
    ?? [...TUNING.PERSONAL_OWNERS],
};
