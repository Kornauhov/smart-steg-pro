export default function StatChip({ label, value, tone = "slate" }) {
  const tones = {
    slate: "bg-slate-100 text-slate-700",
    yellow: "bg-yellow-100 text-yellow-800",
    blue: "bg-blue-100 text-blue-800",
    emerald: "bg-emerald-100 text-emerald-800",
    rose: "bg-rose-100 text-rose-800",
  };

  return (
    <div className={`px-3 py-2 rounded-2xl ${tones[tone]} border border-white/40`}>
      <div className="text-[9px] font-black uppercase opacity-70">{label}</div>
      <div className="text-sm font-black">{value}</div>
    </div>
  );
}
