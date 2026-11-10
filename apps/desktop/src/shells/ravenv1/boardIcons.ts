import { BellOff, Book, Clock, Coffee, Flag, Gamepad2, Hand, Headphones, Heart, Lock, MessageCircle, MicOff, Moon, Shield, Sparkles, Users, type LucideIcon } from "lucide-react";

/**
 * The icons a house rule can carry. The ids are stored by the server, which checks them
 * against the same list (`treeRuleIcons` in services/api/internal/http/board_rules.go).
 */
export const BOARD_ICONS: ReadonlyArray<{ id: string; label: string; icon: LucideIcon }> = [
  { id: "heart", label: "Heart", icon: Heart },
  { id: "moon", label: "Moon", icon: Moon },
  { id: "mic-off", label: "Muted microphone", icon: MicOff },
  { id: "clock", label: "Clock", icon: Clock },
  { id: "shield", label: "Shield", icon: Shield },
  { id: "hand", label: "Hand", icon: Hand },
  { id: "message", label: "Message", icon: MessageCircle },
  { id: "headphones", label: "Headphones", icon: Headphones },
  { id: "coffee", label: "Coffee", icon: Coffee },
  { id: "gamepad", label: "Gamepad", icon: Gamepad2 },
  { id: "book", label: "Book", icon: Book },
  { id: "lock", label: "Lock", icon: Lock },
  { id: "bell-off", label: "Muted bell", icon: BellOff },
  { id: "users", label: "People", icon: Users },
  { id: "sparkle", label: "Sparkle", icon: Sparkles },
  { id: "flag", label: "Flag", icon: Flag },
];

export const DEFAULT_BOARD_ICON = "heart";

export function boardIcon(id: string): LucideIcon {
  return BOARD_ICONS.find((entry) => entry.id === id)?.icon ?? Flag;
}

export const MAX_RULES = 8;
export const MAX_RULE_LENGTH = 80;

/** "1 house rule", "3 house rules". */
export function houseRulesCount(count: number): string {
  return `${count} house ${count === 1 ? "rule" : "rules"}`;
}
