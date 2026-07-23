export default function RaceDetailLoading() {
  return (
    <div className="px-6 md:px-10 pt-8 pb-16 animate-pulse">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end mb-7 gap-6">
        <div>
          <div className="h-6 w-40 rounded-lg apex-glass-soft mb-3" />
          <div className="h-12 w-80 rounded-lg apex-glass-soft" />
          <div className="h-3 w-52 rounded apex-glass-soft mt-3" />
        </div>
        <div className="flex items-stretch gap-3">
          <div className="h-[46px] w-40 rounded-[11px] apex-glass-soft" />
          <div className="h-[46px] w-44 rounded-[11px] apex-glass-soft" />
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3.5 mb-6">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-[74px] rounded-[14px] apex-glass-soft" />
        ))}
      </div>

      <div className="h-11 w-full max-w-md rounded-xl apex-glass-soft mb-5" />
      <div className="flex flex-col gap-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-14 rounded-xl apex-glass-soft" />
        ))}
      </div>
    </div>
  );
}
