// Icons for the library's scopes and picker sections, so headings and chips read at a glance.

import { Clock, Globe, Inbox, LayoutGrid, Reply, Star, User, Users, type LucideIcon } from "lucide-react";

export const SCOPE_ICONS: Record<string, LucideIcon> = { all: LayoutGrid, personal: User, tree: Users, public: Globe };

export const SECTION_ICONS: Record<string, LucideIcon> = {
  suggested: Reply,
  favourites: Star,
  recent: Clock,
  uncollected: Inbox,
  space: Users,
  personal: User,
  tree: Users,
  public: Globe,
};
