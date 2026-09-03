import { Link, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../../hooks/useAuth";
import { WorkspaceSwitcher } from "../WorkspaceSwitcher";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  MessageSquare,
  Mail,
  UserCircle,
  Users,
  UserPlus,
  Send,
  Settings,
  LogOut,
  Menu,
  Search,
} from "lucide-react";
import { cn } from "../../lib/utils";

const navItems = [
  { path: "/", label: "Comments", icon: MessageSquare },
  { path: "/dm", label: "DM Assistant", icon: Mail },
  { path: "/leads", label: "Engaged Leads", icon: UserCircle },
  { path: "/contacts", label: "Scraped Leads", icon: Users },
  { path: "/manual-leads", label: "Manual Added", icon: UserPlus },
  { path: "/keyword-search", label: "Keyword Search", icon: Search },
  { path: "/outreach", label: "Outreach", icon: Send },
  { path: "/settings", label: "Settings", icon: Settings },
];

export function AppLayout() {
  const { user, signOut } = useAuth();
  const location = useLocation();

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="flex h-14 items-center px-4 sm:px-6">
          <Link to="/" className="mr-2 sm:mr-4 flex items-center gap-2 font-semibold text-lg shrink-0">
            <img src="/favicon.svg" alt="" className="h-6 w-6 rounded-md" />
            <span className="hidden sm:inline">DocEngage</span>
          </Link>

          {/* Always visible, even on mobile — which workspace you're in
              changes what data every page shows, so it shouldn't be hidden
              behind a breakpoint the way the nav and email are. */}
          <div className="mr-2 sm:mr-4 shrink-0">
            <WorkspaceSwitcher />
          </div>

          {/* Desktop nav — hidden below md, where it wouldn't fit (7 items
              plus logo plus account info in one row). */}
          <nav className="hidden md:flex items-center gap-1">
            {navItems.map((item) => {
              const isActive =
                item.path === "/"
                  ? location.pathname === "/"
                  : location.pathname.startsWith(item.path);
              return (
                <Link key={item.path} to={item.path}>
                  <Button
                    variant={isActive ? "secondary" : "ghost"}
                    size="sm"
                    className={cn("gap-2", isActive && "font-medium")}
                  >
                    <item.icon className="h-4 w-4" />
                    {item.label}
                  </Button>
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-2 sm:gap-3">
            <span className="hidden sm:inline text-sm text-muted-foreground truncate max-w-[160px]">
              {user?.email}
            </span>

            {/* Mobile nav — a menu button that opens every page as a
                dropdown, replacing the horizontal nav below md. */}
            <div className="md:hidden">
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="ghost" size="sm" />}>
                  <Menu className="h-5 w-5" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {navItems.map((item) => {
                    const isActive =
                      item.path === "/"
                        ? location.pathname === "/"
                        : location.pathname.startsWith(item.path);
                    return (
                      <DropdownMenuItem key={item.path} render={<Link to={item.path} />}>
                        <item.icon className="h-4 w-4 mr-2" />
                        <span className={cn(isActive && "font-medium")}>{item.label}</span>
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <Button variant="ghost" size="sm" onClick={signOut}>
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>

      <main className="p-4 sm:p-6">
        <Outlet />
      </main>
    </div>
  );
}
