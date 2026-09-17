"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { defaultThemeColor, themeColorContent } from "@/lib/ui/theme-color";

type ShellSettings = {
  siteTitle: string;
  avatarUrl: string;
  themeColor: string;
  showNintendoSwitch?: boolean;
  showPlayStation?: boolean;
  showPsPlusCatalog?: boolean;
  showMemberships?: boolean;
};
type ShellAccess = {
  authenticated: boolean;
  registrationOpen: boolean;
  username: string | null;
};
type NavItem = {
  href: string;
  label: string;
  compactLabel?: string;
  icon: NavIconName;
  admin?: boolean;
  visible?: boolean;
};
type NavIconName =
  | "overview"
  | "switch"
  | "playstation"
  | "catalog"
  | "membership"
  | "history"
  | "settings";
type NavGroup = {
  id: string;
  label: string;
  items: NavItem[];
};

export const shellAuthChangedEvent = "gamenote:auth-changed";
export const shellAuthRequestedEvent = "gamenote:auth-requested";
export const shellSettingsChangedEvent = "gamenote:settings-changed";

export function AppIdentity({ siteTitle }: { siteTitle: string }) {
  return (
    <div className="ledger-brand">
      <span>GN</span>
      <div>
        <strong>{siteTitle}</strong>
        <small>游戏收藏记录</small>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [settings, setSettings] = useState<ShellSettings>({
    siteTitle: "GameNote",
    avatarUrl: "",
    themeColor: defaultThemeColor,
    showNintendoSwitch: true,
    showPlayStation: false,
    showPsPlusCatalog: false,
    showMemberships: true,
  });
  const [access, setAccess] = useState<ShellAccess>({
    authenticated: false,
    registrationOpen: false,
    username: null,
  });

  useEffect(() => {
    let cancelled = false;
    async function refreshShell() {
      const [settingsResponse, accessResponse] = await Promise.all([
        fetch("/api/settings", { cache: "no-store" }),
        fetch("/api/access", { cache: "no-store" }),
      ]);
      const [nextSettings, nextAccess] = await Promise.all([
        settingsResponse.json(),
        accessResponse.json(),
      ]);
      if (cancelled) return;
      setSettings((current) => ({ ...current, ...nextSettings }));
      setAccess({
        authenticated: Boolean(nextAccess.authenticated),
        registrationOpen: Boolean(nextAccess.registrationOpen),
        username: nextAccess.username || null,
      });
      if (nextSettings.themeColor) applyTheme(nextSettings.themeColor);
      if (nextSettings.siteTitle) document.title = nextSettings.siteTitle;
    }
    void refreshShell().catch(() => undefined);
    window.addEventListener(shellAuthChangedEvent, refreshShell);
    window.addEventListener(shellSettingsChangedEvent, refreshShell);
    return () => {
      cancelled = true;
      window.removeEventListener(shellAuthChangedEvent, refreshShell);
      window.removeEventListener(shellSettingsChangedEvent, refreshShell);
    };
  }, []);

  const navigation = useMemo<NavGroup[]>(
    () => [
      {
        id: "library",
        label: "游戏库",
        items: [
          { href: "/dashboard", label: "概览", compactLabel: "概览", icon: "overview" },
          {
            href: "/",
            label: "Nintendo Switch",
            compactLabel: "NS 游戏",
            icon: "switch",
            visible: settings.showNintendoSwitch !== false,
          },
          {
            href: "/playstation",
            label: "PlayStation",
            compactLabel: "PS 游戏",
            icon: "playstation",
            visible: settings.showPlayStation !== false,
          },
        ],
      },
      {
        id: "services",
        label: "工具",
        items: [
          {
            href: "/ps-plus-catalog",
            label: "PS Plus 游戏库",
            compactLabel: "PS Plus",
            icon: "catalog",
            visible: settings.showPlayStation !== false && settings.showPsPlusCatalog !== false,
          },
          {
            href: "/memberships",
            label: "会员记录",
            compactLabel: "会员",
            icon: "membership",
            admin: true,
            visible: settings.showMemberships !== false,
          },
        ],
      },
      {
        id: "play",
        label: "游玩记录",
        items: [
          {
            href: "/play/history",
            label: "历史游玩",
            compactLabel: "历史",
            icon: "history",
            admin: true,
          },
        ],
      },
      {
        id: "manage",
        label: "管理",
        items: [
          {
            href: "/settings",
            label: "设置 / 数据源",
            compactLabel: "设置",
            icon: "settings",
            admin: true,
          },
        ],
      },
    ],
    [settings],
  );
  const visibleNavigation = navigation
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => item.visible !== false),
    }))
    .filter((group) => group.items.length);

  async function signOut() {
    await fetch("/api/access", { method: "DELETE" });
    window.dispatchEvent(new Event(shellAuthChangedEvent));
    router.replace("/");
    router.refresh();
  }

  const heading = pageHeading(pathname, settings);
  return (
    <main className="ledger-page app-shell-page min-h-screen text-base-content">
      <div className="ledger-shell app-shell-grid">
        <aside className="ledger-sidebar ledger-sidebar-left">
          <AppIdentity siteTitle={settings.siteTitle} />
          <ShellNavigation
            groups={visibleNavigation}
            pathname={pathname}
            authenticated={access.authenticated}
          />
          <AccountSummary access={access} onSignOut={signOut} />
        </aside>
        <div className="ledger-main-column app-shell-main">
          <header className="ledger-header app-shell-header">
            <div className="header-primary-row">
              <div>
                <h1>{heading.title}</h1>
                <p>{heading.description}</p>
              </div>
              <AccountAvatar access={access} settings={settings} onSignOut={signOut} />
            </div>
            <ShellNavigation
              groups={visibleNavigation}
              pathname={pathname}
              authenticated={access.authenticated}
              compact
            />
          </header>
          <div className="app-shell-content">{children}</div>
        </div>
      </div>
    </main>
  );
}

function ShellNavigation({
  groups,
  pathname,
  authenticated,
  compact = false,
}: {
  groups: NavGroup[];
  pathname: string;
  authenticated: boolean;
  compact?: boolean;
}) {
  const items = groups.flatMap((group) => group.items);
  const activeItemRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    if (!compact) return;
    const activeItem = activeItemRef.current;
    const navigation = activeItem?.closest<HTMLElement>(".app-shell-nav-mobile");
    if (!activeItem || !navigation) return;

    const frame = window.requestAnimationFrame(() => {
      const navigationBounds = navigation.getBoundingClientRect();
      const itemBounds = activeItem.getBoundingClientRect();
      const itemIsVisible =
        itemBounds.left >= navigationBounds.left && itemBounds.right <= navigationBounds.right;
      if (!itemIsVisible) activeItem.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [compact]);

  if (compact) {
    return (
      <nav className="app-shell-nav-mobile" aria-label="移动导航">
        <div className="app-shell-nav-mobile-track">
          {items.map((item) => (
            <ShellNavigationLink
              item={item}
              pathname={pathname}
              authenticated={authenticated}
              compact
              linkRef={isNavItemActive(item, pathname) ? activeItemRef : undefined}
              key={item.href}
            />
          ))}
        </div>
      </nav>
    );
  }

  return (
    <nav className="app-shell-nav" aria-label="主导航">
      {groups.map((group) => (
        <section className="app-shell-nav-group" key={group.id} aria-label={group.label}>
          <p>{group.label}</p>
          <div>
            {group.items.map((item) => (
              <ShellNavigationLink
                item={item}
                pathname={pathname}
                authenticated={authenticated}
                key={item.href}
              />
            ))}
          </div>
        </section>
      ))}
    </nav>
  );
}

function ShellNavigationLink({
  item,
  pathname,
  authenticated,
  compact = false,
  linkRef,
}: {
  item: NavItem;
  pathname: string;
  authenticated: boolean;
  compact?: boolean;
  linkRef?: Ref<HTMLAnchorElement>;
}) {
  const active = isNavItemActive(item, pathname);
  const locked = Boolean(item.admin && !authenticated);
  const href = locked ? `/?auth=login&next=${encodeURIComponent(item.href)}` : item.href;

  return (
    <Link
      className={`${active ? "active" : ""}${locked ? " is-locked" : ""}`}
      aria-current={active ? "page" : undefined}
      href={href}
      onClick={() => {
        if (locked) window.dispatchEvent(new Event(shellAuthRequestedEvent));
      }}
      ref={linkRef}
    >
      <span>
        <NavIcon name={item.icon} />
      </span>
      <strong>{compact ? item.compactLabel || item.label : item.label}</strong>
      {!compact && locked ? <small>登录</small> : null}
    </Link>
  );
}

function isNavItemActive(item: NavItem, pathname: string) {
  return item.href === "/"
    ? pathname === "/" || pathname.startsWith("/nintendo-switch")
    : pathname.startsWith(item.href);
}

function NavIcon({ name }: { name: NavIconName }) {
  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    strokeWidth: 1.8,
  };

  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" {...common}>
      {name === "overview" ? (
        <>
          <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
          <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
          <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
          <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
        </>
      ) : name === "switch" ? (
        <>
          <rect x="3" y="5" width="18" height="14" rx="4" />
          <path d="M8.5 5v14M15.5 5v14" />
          <circle cx="6" cy="10" r="1" />
          <circle cx="18" cy="14" r="1" />
        </>
      ) : name === "playstation" ? (
        <>
          <path d="M7 18V5.5l7.3 2.1v9.8" />
          <path d="M7 14.2 3.5 16v2.2L9.8 21l10.7-4.9-4-1.5" />
        </>
      ) : name === "catalog" ? (
        <>
          <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4H20v15.5H6.5A2.5 2.5 0 0 1 4 17V6.5Z" />
          <path d="M4 17a2.5 2.5 0 0 1 2.5-2.5H20M12 7v5M9.5 9.5h5" />
        </>
      ) : name === "membership" ? (
        <>
          <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
          <circle cx="9" cy="11" r="2" />
          <path d="M6.5 16c.6-1.5 1.5-2.3 2.5-2.3s1.9.8 2.5 2.3M14 9h3.5M14 12h3.5" />
        </>
      ) : name === "history" ? (
        <>
          <path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.5" />
          <path d="M4 4.5v4h4M12 8v4.5l3 1.7" />
        </>
      ) : (
        <>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" />
        </>
      )}
    </svg>
  );
}

function AccountSummary({
  access,
  onSignOut,
}: {
  access: ShellAccess;
  onSignOut: () => Promise<void>;
}) {
  return (
    <div className="sidebar-account">
      <strong>{access.username || "访客"}</strong>
      <small>{access.authenticated ? "管理员" : "只读浏览"}</small>
      {access.authenticated ? (
        <button type="button" onClick={onSignOut}>
          退出登录
        </button>
      ) : (
        <Link
          href="/?auth=login"
          onClick={() => window.dispatchEvent(new Event(shellAuthRequestedEvent))}
        >
          {access.registrationOpen ? "注册管理员" : "管理员登录"}
        </Link>
      )}
    </div>
  );
}

function AccountAvatar({
  access,
  settings,
  onSignOut,
}: {
  access: ShellAccess;
  settings: ShellSettings;
  onSignOut: () => Promise<void>;
}) {
  return (
    <div className="shell-account-header">
      {settings.avatarUrl ? (
        <img className="header-avatar" src={settings.avatarUrl} alt="" />
      ) : (
        <span className="header-avatar-fallback">{access.username?.[0]?.toUpperCase() || "G"}</span>
      )}
      <div>
        <strong>{access.username || "访客"}</strong>
        <small>{access.authenticated ? "管理员" : "只读浏览"}</small>
      </div>
      {access.authenticated ? (
        <button type="button" onClick={onSignOut}>
          退出
        </button>
      ) : (
        <Link
          href="/?auth=login"
          onClick={() => window.dispatchEvent(new Event(shellAuthRequestedEvent))}
        >
          登录
        </Link>
      )}
    </div>
  );
}

function applyTheme(color: string) {
  document.documentElement.style.setProperty("--color-primary", color);
  document.documentElement.style.setProperty("--color-primary-content", themeColorContent(color));
}

function pageHeading(pathname: string, settings: ShellSettings) {
  if (pathname === "/dashboard") return { title: "全局概览", description: "收藏与游玩数据总览" };
  if (pathname === "/" || pathname.startsWith("/nintendo-switch"))
    return {
      title: "NS 游戏",
      description: "管理购买、版本、封面与流转状态",
    };
  if (pathname === "/playstation")
    return {
      title: "PlayStation 游戏",
      description: "管理实体版与数字版记录",
    };
  if (pathname === "/ps-plus-catalog")
    return {
      title: "PS Plus 游戏库",
      description: "浏览港区升级与高级会员游戏目录",
    };
  if (pathname === "/memberships")
    return {
      title: "会员记录",
      description:
        settings.showPlayStation === false
          ? "记录 Nintendo Switch Online 会员状态和到期时间"
          : "记录 NS 与 PS 会员状态和到期时间",
    };
  if (pathname === "/settings")
    return {
      title: "设置与数据源",
      description: "管理身份、主题、服务与安全导入",
    };
  if (pathname.includes("/recent"))
    return { title: "最近游玩", description: "按时间窗口查看近期游玩记录" };
  if (pathname.includes("/history"))
    return {
      title: "历史游玩",
      description: "统一查看累计、每日记录、最近动态与收藏关联",
    };
  if (pathname.includes("/unlinked"))
    return {
      title: "关联收藏",
      description: "把 Nintendo 游玩记录与游戏库中的收藏对应起来",
    };
  return { title: "GameNote", description: "统一管理购买收藏与游玩档案" };
}
