export default function Loading() {
  return (
    <div className="px-6 md:px-10 pt-10 pb-16">
      <section className="grid lg:grid-cols-[1fr_320px] gap-5 mb-10">
        <div className="apex-glass-soft rounded-panel min-h-[340px] animate-pulse" />
        <div className="apex-glass-soft rounded-panel min-h-[340px] animate-pulse" />
      </section>
      <div className="h-5 w-28 rounded apex-glass-soft animate-pulse mb-2" />
      <div className="h-4 w-64 rounded apex-glass-soft animate-pulse mb-[18px]" />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 8 }).map((_, index) => (
          <div
            key={index}
            className="apex-glass-soft rounded-card h-[220px] animate-pulse"
          />
        ))}
      </div>
    </div>
  );
}
