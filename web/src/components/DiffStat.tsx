export function DiffStat({ add, del, dim = false }: { add: number; del: number; dim?: boolean }) {
  if (add <= 0 && del <= 0) return null;
  return (
    <>
      {add > 0 && <span className={dim ? "text-add/80" : "text-add"}>+{add}</span>}
      {add > 0 && del > 0 && " "}
      {del > 0 && <span className={dim ? "text-del/80" : "text-del"}>−{del}</span>}
    </>
  );
}
