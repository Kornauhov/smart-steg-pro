export default function Segmented({ value, onChange, options }) {
  return (
    <div className="flex gap-2 p-1 bg-slate-100 rounded-2xl">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={`flex-1 py-3 rounded-xl text-[10px] font-black uppercase transition-all ${
            value === opt.value ? "bg-white shadow-sm text-slate-900" : "text-slate-400"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
