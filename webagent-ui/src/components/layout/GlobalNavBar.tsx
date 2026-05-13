// components/layout/GlobalNavBar.tsx - 全局导航栏（48px顶栏）

import { useAppStore } from '../../stores';
import { ThemeSwitcher } from '../ui/ThemeSwitcher';
import {
  Search,
  Bell,
  Brain,
  Settings2,
  SlidersHorizontal,
} from 'lucide-react';

interface GlobalNavBarProps {
  onOpenManagement?: () => void;
  onOpenModelSettings?: () => void;
}

export function GlobalNavBar({
  onOpenManagement,
  onOpenModelSettings,
}: GlobalNavBarProps) {
  const { toggleCommandPalette } = useAppStore();

  return (
    <div className="h-12 border-b border-border/30 bg-card/50 backdrop-blur-sm flex items-center justify-between px-4">
      {/* Left section: Logo */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Brain className="w-5 h-5 text-primary" />
          <span>AI分析师</span>
        </div>
        <div className="hidden md:flex items-center gap-2 rounded-md border border-border/30 bg-secondary/20 px-2.5 py-1 text-xs text-muted-foreground">
          <Brain className="w-4 h-4 text-primary" />
          <span>灵感工作台</span>
        </div>
      </div>

      {/* Right section: Actions */}
      <div className="flex items-center gap-2">
        {/* Search (⌘K) */}
        <button
          onClick={toggleCommandPalette}
          className="p-2 rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
          title="全局搜索 (⌘K)"
        >
          <Search className="w-4 h-4" />
        </button>

        {/* Notifications */}
        <button
          className="p-2 rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors relative"
          title="通知"
        >
          <Bell className="w-4 h-4" />
          <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-red-500 rounded-full" />
        </button>

        <button
          className="p-2 rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
          onClick={onOpenModelSettings}
          title="模型设置"
          type="button"
        >
          <SlidersHorizontal className="w-4 h-4" />
        </button>

        <button
          className="p-2 rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
          onClick={onOpenManagement}
          title="工作区设置"
          type="button"
        >
          <Settings2 className="w-4 h-4" />
        </button>

        {/* Theme switcher */}
        <ThemeSwitcher />
      </div>
    </div>
  );
}
