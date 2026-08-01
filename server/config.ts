import { homedir } from "node:os";
import { TUNING } from "@shared/tuning";

export function expandHome(p: string): string {
  return p.startsWith("~") ? homedir() + p.slice(1) : p;
}

export const config = {
  port: Number(process.env.REV_PORT ?? TUNING.PORT),
  roots: (process.env.REV_ROOTS?.split(":") ?? TUNING.DEFAULT_ROOTS).map(expandHome),
  dbPath: expandHome(process.env.REV_DB ?? TUNING.DB_PATH),
};
