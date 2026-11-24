import type { CallStatePatch, ParticipantSummary, SessionSummary } from "@/lib/api";

/**
 * The server shares two per-person markers with everyone in a call: "Back in a
 * bit" (`away`, a plain marker with no time or duration) and `deafened`. An
 * older server doesn't send them, so a participant carrying the `away` field is
 * how the client knows the call-state route exists.
 */
export function callStateSupported(session: Pick<SessionSummary, "participants"> | null | undefined) {
  return (session?.participants ?? []).some((participant) => typeof participant.away === "boolean");
}

/** A server that sends a hand order also takes `hand` in a call-state patch. */
export function raisedHandSupported(session: Pick<SessionSummary, "participants"> | null | undefined) {
  return (session?.participants ?? []).some((participant) => typeof participant.handOrder === "number");
}

/** A server that sends these also has the route to change them. */
export function voiceModerationSupported(session: Pick<SessionSummary, "participants"> | null | undefined) {
  return (session?.participants ?? []).some((participant) => typeof participant.serverMuted === "boolean");
}

/** The markers a person sets for themselves. */
export interface CallMarkers {
  away: boolean;
  deafened: boolean;
  /** "I'd like to speak". */
  hand: boolean;
}

export interface ParticipantCallState extends CallMarkers {
  serverMuted: boolean;
  serverDeafened: boolean;
  /** The space's owner lets them hear this call and send nothing to it. */
  listenOnly: boolean;
  /** Place in line while the hand is up (1 is first), 0 when it is down. Never a time. */
  handOrder: number;
}

function callStateOf(participant: ParticipantSummary | undefined): ParticipantCallState {
  return {
    away: participant?.away === true,
    deafened: participant?.deafened === true,
    serverMuted: participant?.serverMuted === true,
    serverDeafened: participant?.serverDeafened === true,
    listenOnly: participant?.listenOnly === true,
    hand: (participant?.handOrder ?? 0) > 0,
    handOrder: participant?.handOrder ?? 0,
  };
}

export function participantCallState(
  participants: ParticipantSummary[] | undefined,
  userId: string,
): ParticipantCallState {
  return callStateOf((participants ?? []).find((candidate) => candidate.userId === userId));
}

/**
 * Everyone's markers, by user id, for the stage. Your own comes from what you just set
 * rather than from the server's echo, so your place in the room answers at once. A hand
 * you just raised goes to the back of the line until the server says where it is.
 */
export function callStatesByUser(
  participants: ParticipantSummary[] | undefined,
  local?: { userId: string } & CallMarkers,
): ReadonlyMap<string, ParticipantCallState> {
  const states = new Map<string, ParticipantCallState>();
  for (const participant of participants ?? []) {
    states.set(participant.userId, callStateOf(participant));
  }
  if (local) {
    const server = { ...callStateOf(undefined), ...states.get(local.userId) };
    const hand = local.hand && !local.away;
    if (!hand && server.handOrder > 0) {
      // Lowered here before the server said so: everyone behind moves up.
      for (const [userId, state] of states) {
        if (state.handOrder > server.handOrder) states.set(userId, { ...state, handOrder: state.handOrder - 1 });
      }
    }
    const handOrder = !hand ? 0 : server.handOrder > 0 ? server.handOrder : raisedCount(states, local.userId) + 1;
    states.set(local.userId, { ...server, away: local.away, deafened: local.deafened, hand, handOrder });
  }
  return states;
}

function raisedCount(states: Map<string, ParticipantCallState>, except: string) {
  let count = 0;
  for (const [userId, state] of states) if (userId !== except && state.handOrder > 0) count += 1;
  return count;
}

/**
 * What to send after registering in a call so the server's copy matches ours. A fresh
 * participation starts clear, but someone who rejoins after a dropped connection is still
 * deafened or away, or still waiting to speak (their place in line may move to the back).
 * Null when they already agree.
 */
export function callStateCatchUp(server: CallMarkers, want: CallMarkers): CallStatePatch | null {
  const patch: CallStatePatch = {};
  if (want.deafened !== server.deafened) patch.deafened = want.deafened;
  if (want.away !== server.away) patch.away = want.away;
  if (want.hand !== server.hand) patch.hand = want.hand;
  return Object.keys(patch).length > 0 ? patch : null;
}
