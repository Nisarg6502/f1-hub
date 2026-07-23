export default function PitwallLoading() {
  return (
    <div className="px-6 md:px-10 pt-8 pb-16 animate-pulse">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end mb-8 gap-6">
        <div>
          <div className="h-3 w-32 rounded apex-glass-soft" />
          <div className="h-12 w-72 rounded-lg apex-glass-soft mt-3" />
          <div className="h-3 w-48 rounded apex-glass-soft mt-3" />
        </div>
        <div className="h-[46px] w-36 rounded-[11px] apex-glass-soft" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-6">
        <aside className="flex flex-col gap-2.5">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-[54px] rounded-2xl apex-glass-soft" />
          ))}
        </aside>
        <div className="h-[500px] rounded-2xl apex-glass-soft" />
      </div>
    </div>
  );
}
