import { useSyncExternalStore } from "react";
import type { Announcements, Modifier, UniqueIdentifier } from "@dnd-kit/core";

// How the dock is arranged and how it behaves, kept on this device. Not part of
// /v1/preferences: that is a contract with the API, and these are per-machine habits.

export const DOCK_CONTROL_IDS = ["mic", "camera", "screen", "hear", "hand"] as const;
export type DockControlId = (typeof DOCK_CONTROL_IDS)[number];
export const DEFAULT_DOCK_ORDER: readonly DockControlId[] = DOCK_CONTROL_IDS;

export const DOCK_CONTROL_NAMES: Record<DockControlId, string> = {
  mic: "Microphone",
  camera: "Camera",
  screen: "Screen share",
  hear: "Hearing",
  hand: "I’d like to speak",
};

const ORDER_KEY = "raven.dock.order";
const CONFIRM_LEAVE_KEY = "raven.dock.confirmLeave";
const SHOW_HAND_KEY = "raven.dock.showHand";

function isDockControlId(value: unknown): value is DockControlId {
  return typeof value === "string" && (DOCK_CONTROL_IDS as readonly string[]).includes(value);
}

/**
 * Any stored value made into a full order: unknown ids and repeats are dropped, and
 * controls the value does not mention are added at the end in their default order. A
 * control added in a later version then appears without undoing anyone's arrangement.
 */
export function normalizeDockOrder(value: unknown): DockControlId[] {
  const order: DockControlId[] = [];
  if (Array.isArray(value)) {
    for (const id of value) {
      if (isDockControlId(id) && !order.includes(id)) order.push(id);
    }
  }
  for (const id of DEFAULT_DOCK_ORDER) {
    if (!order.includes(id)) order.push(id);
  }
  return order;
}

export function parseDockOrder(raw: string | null): DockControlId[] {
  if (raw == null) return [...DEFAULT_DOCK_ORDER];
  try {
    return normalizeDockOrder(JSON.parse(raw));
  } catch {
    return [...DEFAULT_DOCK_ORDER];
  }
}

export function isDefaultDockOrder(order: readonly DockControlId[]) {
  return order.length === DEFAULT_DOCK_ORDER.length && order.every((id, index) => id === DEFAULT_DOCK_ORDER[index]);
}

export function moveDockControl(order: readonly DockControlId[], id: DockControlId, offset: number): DockControlId[] {
  const from = order.indexOf(id);
  const to = from + offset;
  if (from < 0 || to < 0 || to >= order.length) return [...order];
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

export function reorderDockControls(order: readonly DockControlId[], activeId: DockControlId, overId: DockControlId): DockControlId[] {
  const from = order.indexOf(activeId);
  const to = order.indexOf(overId);
  if (from < 0 || to < 0) return [...order];
  return moveDockControl(order, activeId, to - from);
}

// ---- arranging -------------------------------------------------------------------------

/** Keeps a dragged control in its row. */
export const restrictToRow: Modifier = ({ transform }) => ({ ...transform, y: 0 });

export const DOCK_ARRANGE_INSTRUCTIONS =
  "Press Space or Enter to pick up this button. Use the Left and Right arrow keys to move it, Space or Enter to drop it, or Escape to put it back.";

/** What a screen reader hears while a control is moved. */
export function dockAnnouncements(order: readonly DockControlId[]): Announcements {
  const name = (id: UniqueIdentifier) => (isDockControlId(id) ? DOCK_CONTROL_NAMES[id] : String(id));
  const position = (id: UniqueIdentifier | undefined) => `position ${order.indexOf(id as DockControlId) + 1} of ${order.length}`;
  return {
    onDragStart: ({ active }) => `Picked up ${name(active.id)}, ${position(active.id)}.`,
    onDragOver: ({ active, over }) => (over ? `${name(active.id)} is now at ${position(over.id)}.` : undefined),
    onDragEnd: ({ active, over }) => (over ? `Dropped ${name(active.id)} at ${position(over.id)}.` : `Dropped ${name(active.id)}.`),
    onDragCancel: ({ active }) => `Put ${name(active.id)} back at ${position(active.id)}.`,
  };
}

// ---- storage ---------------------------------------------------------------------------

type Settings = { order: DockControlId[]; confirmLeave: boolean; showHand: boolean };

const listeners = new Set<() => void>();
let current: Settings | null = null;

function load(): Settings {
  let order: DockControlId[] = [...DEFAULT_DOCK_ORDER];
  let confirmLeave = false;
  let showHand = true;
  try {
    order = parseDockOrder(localStorage.getItem(ORDER_KEY));
    confirmLeave = localStorage.getItem(CONFIRM_LEAVE_KEY) === "true";
    showHand = localStorage.getItem(SHOW_HAND_KEY) !== "false";
  } catch {
    // Storage can be unavailable; the defaults still work.
  }
  return { order, confirmLeave, showHand };
}

function snapshot(): Settings {
  current ??= load();
  return current;
}

function update(patch: Partial<Settings>) {
  current = { ...snapshot(), ...patch };
  try {
    if (patch.order) localStorage.setItem(ORDER_KEY, JSON.stringify(patch.order));
    if (patch.confirmLeave !== undefined) localStorage.setItem(CONFIRM_LEAVE_KEY, String(patch.confirmLeave));
    if (patch.showHand !== undefined) localStorage.setItem(SHOW_HAND_KEY, String(patch.showHand));
  } catch {
    // Kept for this run only; nothing else depends on it.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function writeDockOrder(order: readonly DockControlId[]) {
  update({ order: normalizeDockOrder(order) });
}

export function writeConfirmLeave(confirmLeave: boolean) {
  update({ confirmLeave });
}

/** The dock's order, shared live between the dock and Settings. */
export function useDockOrder(): DockControlId[] {
  return useSyncExternalStore(subscribe, () => snapshot().order);
}

export function useConfirmLeave(): boolean {
  return useSyncExternalStore(subscribe, () => snapshot().confirmLeave);
}

/** Whether the bar shows "I'd like to speak". Its hotkey works either way. */
export function writeShowHand(showHand: boolean) {
  update({ showHand });
}

export function useShowHand(): boolean {
  return useSyncExternalStore(subscribe, () => snapshot().showHand);
}
