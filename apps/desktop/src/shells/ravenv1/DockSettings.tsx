import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { horizontalListSortingStrategy, SortableContext, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowLeft, ArrowRight, Hand, Headphones, Mic, MonitorUp, Video } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SettingsRows, SettingsSection, SettingsToggleRow } from "./SettingsScaffold";
import {
  DEFAULT_DOCK_ORDER,
  DOCK_ARRANGE_INSTRUCTIONS,
  DOCK_CONTROL_NAMES,
  dockAnnouncements,
  isDefaultDockOrder,
  moveDockControl,
  reorderDockControls,
  restrictToRow,
  useConfirmLeave,
  useDockOrder,
  useShowHand,
  writeConfirmLeave,
  writeDockOrder,
  writeShowHand,
  type DockControlId,
} from "./dockLayout";

const ICONS: Record<DockControlId, ReactNode> = {
  mic: <Mic />,
  camera: <Video />,
  screen: <MonitorUp />,
  hear: <Headphones />,
  hand: <Hand />,
};

/**
 * The order of the bottom bar's device buttons: the same arrangement as right-clicking
 * them in the bar. It applies at once and is kept on this device.
 */
export function DockOrderSection() {
  const order = useDockOrder();
  const showHand = useShowHand();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  return (
    <SettingsSection title="Bottom bar" description="The order of the device buttons at the bottom of the window. It is kept on this device.">
      <SettingsRows>
        <div className="px-4 pb-4 pt-2.5">
          <div className="flex min-h-9 items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="text-body">Device buttons</div>
              <div className="mt-0.5 text-caption text-muted-foreground">
                Drag them into the order you like, or right-click them in the bar.
              </div>
            </div>
            <Button size="sm" variant="secondary" className="shrink-0" disabled={isDefaultDockOrder(order)} onClick={() => writeDockOrder(DEFAULT_DOCK_ORDER)}>
              Reset to default
            </Button>
          </div>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToRow]}
            accessibility={{ announcements: dockAnnouncements(order), screenReaderInstructions: { draggable: DOCK_ARRANGE_INSTRUCTIONS } }}
            onDragEnd={({ active, over }) => {
              if (!over || active.id === over.id) return;
              writeDockOrder(reorderDockControls(order, active.id as DockControlId, over.id as DockControlId));
            }}
          >
            <SortableContext items={order} strategy={horizontalListSortingStrategy}>
              <div className="mt-3 grid grid-cols-5 gap-2">
                {order.map((id, index) => (
                  <ArrangeTile
                    key={id}
                    id={id}
                    index={index}
                    count={order.length}
                    onMove={(offset) => writeDockOrder(moveDockControl(order, id, offset))}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        </div>
        <SettingsToggleRow
          label="Show “I’d like to speak”"
          description="A button in calls that lets everyone know you’d like a turn. Its shortcut works even when the button is hidden."
          checked={showHand}
          onChange={writeShowHand}
        />
      </SettingsRows>
    </SettingsSection>
  );
}

/** Whether Leave in the bar asks first. It applies at once and is kept on this device. */
export function ConfirmLeaveSection() {
  const confirmLeave = useConfirmLeave();
  return (
    <SettingsSection title="Calls">
      <SettingsRows>
        <SettingsToggleRow
          label="Ask before leaving a call"
          description="Leave in the bar asks first, so a stray click does not end your call."
          checked={confirmLeave}
          onChange={writeConfirmLeave}
        />
      </SettingsRows>
    </SettingsSection>
  );
}

function ArrangeTile({
  id,
  index,
  count,
  onMove,
}: {
  id: DockControlId;
  index: number;
  count: number;
  onMove: (offset: -1 | 1) => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id });
  const name = DOCK_CONTROL_NAMES[id];
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn("flex flex-col rounded-card bg-secondary", isDragging && "relative z-10 bg-accent shadow-raised")}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        aria-label={`${name}, ${index + 1} of ${count}`}
        className="flex h-16 cursor-grab touch-none flex-col items-center justify-center gap-1.5 rounded-t-card text-foreground transition-colors hover:bg-accent focus-visible:-outline-offset-2 active:cursor-grabbing [&>svg]:h-[18px] [&>svg]:w-[18px]"
        {...attributes}
        {...listeners}
      >
        {ICONS[id]}
        <span className="text-caption text-muted-foreground">{name}</span>
      </button>
      <div className="flex justify-center gap-1 pb-1.5">
        <Button size="icon-xs" variant="ghost" disabled={index === 0} aria-label={`Move ${name} left`} onClick={() => onMove(-1)}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <Button size="icon-xs" variant="ghost" disabled={index === count - 1} aria-label={`Move ${name} right`} onClick={() => onMove(1)}>
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
