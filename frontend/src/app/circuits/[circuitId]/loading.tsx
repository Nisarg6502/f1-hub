export default function Loading() {
  return (
    <div className="px-6 md:px-10 pt-10 pb-16">
      <div className="h-4 w-24 rounded apex-glass-soft animate-pulse mb-5" />
      <div className="h-6 w-52 rounded-lg apex-glass-soft animate-pulse mb-3" />
      <div className="h-11 w-[min(560px,80%)] rounded-lg apex-glass-soft animate-pulse mb-2" />
      <div className="h-4 w-[min(420px,70%)] rounded apex-glass-soft animate-pulse mb-6" />
      <div className="flex flex-col gap-4">
        <div className="apex-glass-soft rounded-panel h-[clamp(360px,58vh,660px)] animate-pulse" />
        <div className="apex-glass-soft rounded-card h-[76px] animate-pulse" />
        <div className="apex-glass-soft rounded-card h-[300px] animate-pulse" />
      </div>
    </div>
  );
}
