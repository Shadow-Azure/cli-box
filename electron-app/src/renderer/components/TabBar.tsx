interface TabBarProps {
  activeTabId: string | null;
  onRefresh?: () => void;
}

export default function TabBar({ activeTabId, onRefresh }: TabBarProps) {
  return (
    <div className="flex items-center h-9 bg-neutral-800 border-b border-neutral-700 px-2">
      <div className="flex-1" />
      <button
        onClick={() => onRefresh?.()}
        className="text-xs text-neutral-400 hover:text-neutral-200 px-2 py-1"
      >
        Refresh
      </button>
    </div>
  );
}
