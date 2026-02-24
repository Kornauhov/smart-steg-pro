import Icon from "./Icon.jsx";

export default function NavBtn({ active, onClick, icon, label, color = "yellow" }) {
  const activeColors = {
    yellow: "bg-yellow-500 text-slate-900",
    emerald: "bg-emerald-500 text-white",
    rose: "bg-rose-500 text-white",
    blue: "bg-blue-500 text-white",
  };

  return (
    <button
      onClick={onClick}
      className={`flex flex-col items-center gap-1.5 px-4 py-3 rounded-3xl transition-all duration-200 active:scale-95 ${
        active
          ? activeColors[color] + " shadow-2xl scale-[1.03]"
          : "text-slate-300/80 hover:text-white"
      }`}
    >
      <Icon name={icon} size={22} />
      <span className="text-[9px] font-black uppercase tracking-tight">{label}</span>
    </button>
  );
}
