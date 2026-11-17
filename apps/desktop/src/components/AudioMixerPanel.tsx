import { FormEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  AudioLines,
  ChevronDown,
  CircleSlash,
  Gauge,
  Headphones,
  Mic,
  MonitorUp,
  Music,
  Plus,
  Power,
  RotateCcw,
  Save,
  Settings2,
  ShieldCheck,
  Signal,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Volume2,
  AudioWaveform,
} from "lucide-react";
import {
  AudioMixerState,
  AudioMeterUpdate,
  MeterState,
  AppAudioSource,
  AudioInputDevice,
  AudioOutputDevice,
  AudioPresetDefinition,
  AudioPresetTarget,
  ChannelHealthState,
  NativeAudioCapabilityReport,
  AudioProcessorState,
  AudioProcessorKind,
  AudioParameterValue,
  AudioSourceState,
  AudioSourceRuntimeState,
  AudioSourceType,
  GainDb,
  NoiseSuppressionRuntime,
  PublishedTrackMetadata,
  RemoteAudioTrackState,
  RemoteAutoLevelState,
  WebRtcAudioProcessingSettings,
  audioCommands,
  subscribeAudioMeterChanged,
  subscribeAudioStateChanged,
} from "@/lib/audio";
import { setAutoLevel } from "@/lib/autoLevelPreference";
import {
  commitOutputVolume,
  OUTPUT_VOLUME_MAX_DB,
  OUTPUT_VOLUME_MIN_DB,
  OUTPUT_VOLUME_STEP_DB,
  previewOutputVolume,
} from "@/lib/outputVolume";
import { cn } from "@/lib/utils";
import { NoiseSuppressionDepthRow, NoiseSuppressionRow } from "@/components/NoiseSuppressionRow";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Drawer } from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs } from "@/components/ui/tabs";

const GAIN_MIN_DB = -60;
const GAIN_MAX_DB = 12;
const GAIN_STEP_DB = 1;
/** Spacing of fader updates while a fader is being dragged. */
const GAIN_LIVE_INTERVAL_MS = 40;
/** Spacing of processor-parameter updates while a control is being dragged. */
const PARAMETER_LIVE_INTERVAL_MS = 60;
const DBFS_METER_TICKS = [-90, -60, -45, -36, -30, -24, -18, -12, -9, -6, -3, 0] as const;
const FADER_GAIN_TICKS = [-60, -45, -36, -30, -24, -18, -12, -9, -6, -3, 0, 3, 6, 9, 12] as const;

const sourceTypes: AudioSourceType[] = [
  "microphone",
  "systemAudio",
  "appAudio",
  // "fileAudio",
  "testTone",
];

const supportedProcessorKinds: AudioProcessorKind[] = [
  // Gain, Mute, and Meter are intrinsic channel-strip controls (the fader, the mute button,
  // and the always-on meter) — not separate processing tools. Commented out (not removed) so
  // the per-kind parameter/validation code paths stay intact.
  // "gain",
  // "mute",
  // "meter",
  "highPassFilter",
  "lowPassFilter",
  "limiter",
  "noiseGate",
  "eq",
  "compressor",
];

const presetTargets: AudioPresetTarget[] = [
  "localMicrophone",
  "localScreenAudio",
  "localMusic",
  "remoteVoice",
  "remoteMusic",
  "anyAudioChannel",
];

const emptyMixerState: AudioMixerState = {
  localParticipantId: null,
  localSources: [],
  remoteTracks: [],
  remoteParticipants: [],
  trackEvents: [],
  session: {
    connectionStatus: "disconnected",
    playbackStatus: "stopped",
    eligibleRemoteTrackCount: 0,
    activeRemoteTrackCount: 0,
    error: null,
    playbackError: null,
    outputDeviceName: null,
    outputFallback: false,
    outputMuted: false,
    deafenKeepsSatellites: false,
    outputVolumeDb: 0,
    outputVolumeSaved: false,
    outputMeter: { peakDb: -90, rmsDb: -90, clipping: false },
    connectionLost: null,
    publishRevoked: false,
    subscribeRevoked: false,
  },
  autoLevel: { enabled: false },
};

type ChannelStripView =
  | {
      mode: "local";
      id: string;
      title: string;
      sourceType: AudioSourceType;
      captureDeviceId: string | null;
      runtime: AudioSourceRuntimeState;
      enabled: boolean;
      gainDb: GainDb;
      muted: boolean;
      meterPeakDb: GainDb;
      meterRmsDb: GainDb;
      health: ChannelHealthState;
      safetyLimiterCeilingDb: GainDb;
      webrtcProcessing: WebRtcAudioProcessingSettings;
      presetId: string | null;
      processors: AudioProcessorState[];
      publishedTrack: PublishedTrackMetadata | null;
      publishing: boolean;
      appIconDataUrl: string | null;
      appExeName: string | null;
      outputDeviceName: string | null;
      inputDeviceName: string | null;
    }
  | {
      mode: "remote";
      id: string;
      remoteParticipantId: string;
      remoteTrackId: string;
      participantTitle: string;
      title: string;
      sourceType: AudioSourceType;
      enabled: boolean;
      noiseCleanup: boolean;
      autoLevel: RemoteAutoLevelState;
      gainDb: GainDb;
      muted: boolean;
      meterPeakDb: GainDb;
      meterRmsDb: GainDb;
      health: ChannelHealthState;
      safetyLimiterCeilingDb: GainDb;
      presetId: string | null;
      processors: AudioProcessorState[];
      publishedTrack: PublishedTrackMetadata;
      publishing: boolean;
      appIconDataUrl: string | null;
      appExeName: string | null;
      outputDeviceName: string | null;
      inputDeviceName: string | null;
    };

export function AudioMixerPanel({ deafen }: { deafen?: { deafened: boolean; onToggle: () => void } } = {}) {
  const [mixerState, setMixerState] = useState<AudioMixerState>(emptyMixerState);
  // The volume follows the hand while it is down; the engine value takes over after.
  const [draftVolumeDb, setDraftVolumeDb] = useState<number | null>(null);
  const [presets, setPresets] = useState<AudioPresetDefinition[]>([]);
  const [inputDevices, setInputDevices] = useState<AudioInputDevice[]>([]);
  const [outputDevices, setOutputDevices] = useState<AudioOutputDevice[]>([]);
  const [appAudioSources, setAppAudioSources] = useState<AppAudioSource[]>([]);
  const [capabilities, setCapabilities] = useState<NativeAudioCapabilityReport | null>(null);
  const [status, setStatus] = useState<"loading" | "connected" | "error">("loading");
  const [error, setError] = useState("");
  const [busySourceIds, setBusySourceIds] = useState<Set<string>>(new Set());
  const [draftGains, setDraftGains] = useState<Record<string, GainDb>>({});
  const [draftProcessorParams, setDraftProcessorParams] = useState<Record<string, AudioParameterValue>>({});
  const liveParameterSends = useRef<Record<string, { timer: number; pending: AudioParameterValue | null }>>({});
  const gainTimers = useRef<Record<string, number>>({});
  const pendingGains = useRef<Record<string, GainDb>>({});
  const [addSourceOpen, setAddSourceOpen] = useState(false);

  const setSourceBusy = (sourceId: string, busy: boolean) => {
    setBusySourceIds((current) => {
      const next = new Set(current);
      if (busy) next.add(sourceId);
      else next.delete(sourceId);
      return next;
    });
  };

  const applyCanonicalState = (nextState: AudioMixerState) => {
    setMixerState(nextState);
    setStatus("connected");
    setError("");
    setDraftGains((current) => {
      const next = { ...current };
      for (const source of nextState.localSources) {
        if (next[source.id] === source.channelStrip.gainDb) delete next[source.id];
      }
      for (const track of nextState.remoteTracks) {
        const key = remoteTrackKey(track.track.participantId, track.track.trackId);
        if (next[key] === track.receiverChannelStrip.gainDb) delete next[key];
      }
      return next;
    });
    // Reconcile processor-parameter drafts instead of wiping them. A draft is a slider value
    // the user is dragging; clearing it on every state emit (meters fire ~10x/sec) snapped the
    // control back mid-gesture. Keep each draft until the server's committed value catches up.
    setDraftProcessorParams((current) => {
      if (Object.keys(current).length === 0) return current;
      const committed = new Map<string, AudioParameterValue>();
      const collect = (stripId: string, processors: AudioProcessorState[]) => {
        for (const proc of processors) {
          for (const [paramName, value] of Object.entries(proc.parameters)) {
            if (typeof value === "number" || typeof value === "boolean") {
              committed.set(processorParameterKey(stripId, proc.id, paramName), value);
            }
          }
          // EQ bands are addressed as `band<n>.<field>`.
          (proc.parameters.eqBands ?? []).forEach((band, index) => {
            committed.set(processorParameterKey(stripId, proc.id, `band${index}.frequencyHz`), band.frequencyHz);
            committed.set(processorParameterKey(stripId, proc.id, `band${index}.gainDb`), band.gainDb);
            committed.set(processorParameterKey(stripId, proc.id, `band${index}.q`), band.q);
          });
        }
      };
      for (const source of nextState.localSources) {
        collect(source.id, source.channelStrip.processorChain.processors);
      }
      for (const track of nextState.remoteTracks) {
        collect(
          remoteTrackKey(track.track.participantId, track.track.trackId),
          track.receiverChannelStrip.processorChain.processors,
        );
      }
      const next: Record<string, AudioParameterValue> = {};
      for (const [key, draftValue] of Object.entries(current)) {
        if (committed.get(key) !== draftValue) next[key] = draftValue;
      }
      return next;
    });
  };

  useEffect(() => {
    let mounted = true;
    let unsubscribeState: (() => void) | undefined;

    audioCommands
      .getCapabilities()
      .then((report) => {
        if (mounted) setCapabilities(report);
      })
      .catch(() => undefined);

    audioCommands
      .getState()
      .then((state) => {
        if (mounted) applyCanonicalState(state);
      })
      .catch((err) => {
        if (!mounted) return;
        setStatus("error");
        setError(formatCommandError(err));
      });

    audioCommands
      .listPresets()
      .then((nextPresets) => {
        if (mounted) setPresets(nextPresets);
      })
      .catch((err) => {
        if (!mounted) return;
        setStatus("error");
        setError(formatCommandError(err));
      });

    // Rust/CPAL owns microphone capture. Its device identifiers are intentionally
    // used here too; browser MediaDeviceInfo ids belong to a different namespace
    // and would make native capture miss the selection and open the default input.
    audioCommands
      .listInputDevices()
      .then((devices) => {
        if (mounted) setInputDevices(devices);
      })
      .catch(() => undefined);

    audioCommands
      .listOutputDevices()
      .then((devices) => {
        if (mounted) setOutputDevices(devices);
      })
      .catch(() => undefined);

    audioCommands
      .listAppAudioSources()
      .then((apps) => { if (mounted) setAppAudioSources(apps); })
      .catch(() => undefined);

    subscribeAudioStateChanged((state) => {
      if (mounted) applyCanonicalState(state);
    })
      .then((unlisten) => {
        if (!mounted) unlisten();
        else unsubscribeState = unlisten;
      })
      .catch((err) => {
        if (!mounted) return;
        setStatus("error");
        setError(formatCommandError(err));
      });

    return () => {
      mounted = false;
      unsubscribeState?.();
      Object.values(gainTimers.current).forEach((timer) => window.clearInterval(timer));
      Object.values(liveParameterSends.current).forEach((send) => window.clearInterval(send.timer));
    };
  }, []);

  const runMutation = async (action: () => Promise<AudioMixerState | void>, sourceId?: string) => {
    if (sourceId) setSourceBusy(sourceId, true);
    try {
      const next = await action();
      if (next) applyCanonicalState(next);
    } catch (err) {
      setStatus("error");
      setError(formatCommandError(err));
    } finally {
      if (sourceId) setSourceBusy(sourceId, false);
    }
  };

  // A fader is heard while it moves: the first change is sent at once and further ones
  // at a steady rate carrying the latest position (the engine ramps between them), rather
  // than waiting for the hand to stop.
  const scheduleGain = (sourceId: string, gainDb: GainDb) => {
    setDraftGains((current) => ({ ...current, [sourceId]: gainDb }));
    if (gainTimers.current[sourceId]) {
      pendingGains.current[sourceId] = gainDb;
      return;
    }
    void runMutation(() => setChannelGainCommand(sourceId, gainDb));
    gainTimers.current[sourceId] = window.setInterval(() => {
      const next = pendingGains.current[sourceId];
      if (next === undefined) {
        window.clearInterval(gainTimers.current[sourceId]);
        delete gainTimers.current[sourceId];
        return;
      }
      delete pendingGains.current[sourceId];
      void runMutation(() => setChannelGainCommand(sourceId, next));
    }, GAIN_LIVE_INTERVAL_MS);
  };

  const flushGain = (sourceId: string, gainDb: GainDb) => {
    if (gainTimers.current[sourceId]) {
      window.clearInterval(gainTimers.current[sourceId]);
      delete gainTimers.current[sourceId];
    }
    delete pendingGains.current[sourceId];
    void runMutation(() => setChannelGainCommand(sourceId, gainDb), sourceId);
  };

  const draftProcessorParameter = (
    sourceId: string,
    processorId: string,
    parameterName: string,
    value: AudioParameterValue,
  ) => {
    const key = processorParameterKey(sourceId, processorId, parameterName);
    setDraftProcessorParams((current) => ({ ...current, [key]: value }));

    // Audition the change while the control is still being dragged. The engine applies
    // parameter edits to the running chain in place, so this is cheap and click-free;
    // sends are spaced out and always end with the latest value.
    const live = liveParameterSends.current[key];
    if (live) {
      live.pending = value;
      return;
    }
    void runMutation(() => updateProcessorParameterCommand(sourceId, processorId, parameterName, value));
    const entry: { timer: number; pending: AudioParameterValue | null } = { timer: 0, pending: null };
    entry.timer = window.setInterval(() => {
      if (entry.pending === null) {
        window.clearInterval(entry.timer);
        if (liveParameterSends.current[key] === entry) delete liveParameterSends.current[key];
        return;
      }
      const next = entry.pending;
      entry.pending = null;
      void runMutation(() => updateProcessorParameterCommand(sourceId, processorId, parameterName, next));
    }, PARAMETER_LIVE_INTERVAL_MS);
    liveParameterSends.current[key] = entry;
  };

  const flushProcessorParameter = (
    sourceId: string,
    processorId: string,
    parameterName: string,
    value: AudioParameterValue,
  ) => {
    const key = processorParameterKey(sourceId, processorId, parameterName);
    const live = liveParameterSends.current[key];
    if (live) {
      window.clearInterval(live.timer);
      delete liveParameterSends.current[key];
    }
    void runMutation(
      () => updateProcessorParameterCommand(sourceId, processorId, parameterName, value),
      sourceId,
    );
  };

  const setChannelGainCommand = (stripId: string, gainDb: GainDb) => {
    const remote = parseRemoteTrackKey(stripId);
    if (remote) return audioCommands.setRemoteTrackGain(remote.participantId, remote.trackId, gainDb);
    return audioCommands.setLocalChannelGain(stripId, gainDb);
  };

  const setChannelMuteCommand = (stripId: string, muted: boolean) => {
    const remote = parseRemoteTrackKey(stripId);
    if (remote) return audioCommands.setRemoteTrackMute(remote.participantId, remote.trackId, muted);
    return audioCommands.setLocalChannelMute(stripId, muted);
  };

  const setLocalWebRtcProcessingCommand = (
    sourceId: string,
    processing: WebRtcAudioProcessingSettings,
  ) => audioCommands.setLocalWebRtcProcessing(sourceId, processing);

  const setProcessorEnabledCommand = (stripId: string, processorId: string, enabled: boolean) => {
    const remote = parseRemoteTrackKey(stripId);
    if (remote) return audioCommands.setRemoteProcessorEnabled(remote.participantId, remote.trackId, processorId, enabled);
    return audioCommands.setProcessorEnabled(stripId, processorId, enabled);
  };

  const addProcessorCommand = (stripId: string, kind: AudioProcessorKind) => {
    const remote = parseRemoteTrackKey(stripId);
    if (remote) return audioCommands.addProcessorToRemoteTrack(remote.participantId, remote.trackId, kind);
    return audioCommands.addProcessorToLocalChannel(stripId, kind);
  };

  const removeProcessorCommand = (stripId: string, processorId: string) => {
    const remote = parseRemoteTrackKey(stripId);
    if (remote) return audioCommands.removeProcessorFromRemoteTrack(remote.participantId, remote.trackId, processorId);
    return audioCommands.removeProcessorFromLocalChannel(stripId, processorId);
  };

  const reorderProcessorsCommand = (stripId: string, orderedProcessorIds: string[]) => {
    const remote = parseRemoteTrackKey(stripId);
    if (remote) return audioCommands.reorderRemoteProcessors(remote.participantId, remote.trackId, orderedProcessorIds);
    return audioCommands.reorderProcessors(stripId, orderedProcessorIds);
  };

  const updateProcessorParameterCommand = (
    stripId: string,
    processorId: string,
    parameterName: string,
    value: AudioParameterValue,
  ) => {
    const remote = parseRemoteTrackKey(stripId);
    if (remote) {
      return audioCommands.updateRemoteProcessorParameter(
        remote.participantId,
        remote.trackId,
        processorId,
        parameterName,
        value,
      );
    }
    return audioCommands.updateProcessorParameter(stripId, processorId, parameterName, value);
  };

  const applyPresetCommand = (stripId: string, presetId: string) => {
    const remote = parseRemoteTrackKey(stripId);
    if (remote) return audioCommands.applyPresetToRemoteTrack(remote.participantId, remote.trackId, presetId);
    return audioCommands.applyPresetToLocalChannel(stripId, presetId);
  };

  const resetProcessorChainCommand = (stripId: string) => {
    const remote = parseRemoteTrackKey(stripId);
    if (remote) return audioCommands.resetRemoteTrackProcessorChain(remote.participantId, remote.trackId);
    return audioCommands.resetLocalChannelProcessorChain(stripId);
  };

  const resetSafeDefaultsCommand = (stripId: string) => {
    const remote = parseRemoteTrackKey(stripId);
    if (remote) return audioCommands.resetRemoteTrackToSafeDefaults(remote.participantId, remote.trackId);
    return audioCommands.resetLocalChannelToSafeDefaults(stripId);
  };

  const setSafetyLimiterCeilingCommand = (stripId: string, ceilingDb: GainDb) => {
    const remote = parseRemoteTrackKey(stripId);
    if (remote) return audioCommands.setRemoteSafetyLimiterCeiling(remote.participantId, remote.trackId, ceilingDb);
    return audioCommands.setLocalSafetyLimiterCeiling(stripId, ceilingDb);
  };

  const savePresetCommand = async (
    stripId: string,
    name: string,
    description: string,
    target: AudioPresetTarget,
  ) => {
    const remote = parseRemoteTrackKey(stripId);
    const nextPresets = remote
      ? await audioCommands.saveRemoteTrackAsPreset(remote.participantId, remote.trackId, name, description, target)
      : await audioCommands.saveLocalChannelAsPreset(stripId, name, description, target);
    setPresets(nextPresets);
  };

  const deletePresetCommand = async (presetId: string) => {
    const nextPresets = await audioCommands.deleteUserPreset(presetId);
    setPresets(nextPresets);
  };

  const renamePresetCommand = async (presetId: string, name: string) => {
    const nextPresets = await audioCommands.renameUserPreset(presetId, name);
    setPresets(nextPresets);
  };

  const remoteGroups = remoteParticipantGroups(mixerState);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <AudioWaveform className="h-4 w-4 shrink-0 text-muted-foreground" />
          <h2 className="truncate text-title-sm font-semibold">Sources</h2>
          <BridgeStatus status={status} />
        </div>
        <Button size="sm" variant="secondary" disabled={status === "loading"} onClick={() => setAddSourceOpen(true)}>
          <Plus className="h-4 w-4" />
          Add a source
        </Button>
      </div>
      {error ? <div role="alert" className="rounded-control bg-destructive/10 px-3 py-2 text-small text-destructive">{error}</div> : null}
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto pr-1">
        <Dialog
          open={addSourceOpen}
          onOpenChange={setAddSourceOpen}
          title="Add a source"
          description="Each source gets its own channel and is sent as its own sound."
        >
          <AddSourceForm
            disabled={status === "loading"}
            capabilities={capabilities}
            appAudioSources={appAudioSources}
            inputDevices={inputDevices}
            outputDevices={outputDevices}
            onRefreshAppSources={() =>
              audioCommands.listAppAudioSources().then(setAppAudioSources).catch(() => undefined)
            }
            onRefreshOutputDevices={() =>
              audioCommands.listOutputDevices().then(setOutputDevices).catch(() => undefined)
            }
            onAdd={(sourceType, displayName, captureDeviceId) => {
              setAddSourceOpen(false);
              void runMutation(() =>
                audioCommands.addLocalSource(sourceType, displayName, captureDeviceId ?? null)
              );
            }}
          />
        </Dialog>
        <MixerSection
          title="What you send"
          description="Each source has its own level and processing, and is sent separately."
          emptyText="No microphone is set up. Add a source to send sound."
        >
          {mixerState.localSources.map((source) => (
            <ChannelStrip
              key={source.id}
              strip={localSourceToStrip(source, appAudioSources, outputDevices, inputDevices)}
              presets={presets}
              inputDevices={inputDevices}
              outputDevices={outputDevices}
              busy={busySourceIds.has(source.id)}
              draftGainDb={draftGains[source.id]}
              onGainChange={scheduleGain}
              onGainCommit={flushGain}
              onMute={(sourceId, muted) => runMutation(() => setChannelMuteCommand(sourceId, muted), sourceId)}
              onRename={(sourceId, displayName) =>
                runMutation(() => audioCommands.renameLocalSource(sourceId, displayName), sourceId)
              }
              onEnabledChange={(sourceId, enabled) =>
                runMutation(() => audioCommands.setLocalSourceEnabled(sourceId, enabled), sourceId)
              }
              onCaptureDeviceChange={(sourceId, captureDeviceId) =>
                runMutation(() => audioCommands.setLocalSourceCaptureDevice(sourceId, captureDeviceId), sourceId)
              }
              onPublish={(sourceId) =>
                runMutation(() => audioCommands.publishAudioSource(sourceId), sourceId)
              }
              onUnpublish={(sourceId) =>
                runMutation(() => audioCommands.unpublishAudioSource(sourceId), sourceId)
              }
              onRemove={(sourceId) => runMutation(() => audioCommands.removeLocalSource(sourceId), sourceId)}
              onProcessorToggle={(sourceId, processorId, enabled) =>
                runMutation(() => setProcessorEnabledCommand(sourceId, processorId, enabled), sourceId)
              }
              onProcessorAdd={(sourceId, kind) =>
                runMutation(() => addProcessorCommand(sourceId, kind), sourceId)
              }
              onProcessorRemove={(sourceId, processorId) =>
                runMutation(() => removeProcessorCommand(sourceId, processorId), sourceId)
              }
              onProcessorReorder={(sourceId, orderedProcessorIds) =>
                runMutation(() => reorderProcessorsCommand(sourceId, orderedProcessorIds), sourceId)
              }
              onPresetApply={(sourceId, presetId) =>
                runMutation(() => applyPresetCommand(sourceId, presetId), sourceId)
              }
              onPresetSave={(sourceId, name, description, target) =>
                runMutation(() => savePresetCommand(sourceId, name, description, target), sourceId)
              }
              onPresetDelete={(presetId) => runMutation(() => deletePresetCommand(presetId))}
              onPresetRename={(presetId, name) => runMutation(() => renamePresetCommand(presetId, name))}
              onProcessorChainReset={(sourceId) =>
                runMutation(() => resetProcessorChainCommand(sourceId), sourceId)
              }
              onSafeDefaultsReset={(sourceId) =>
                runMutation(() => resetSafeDefaultsCommand(sourceId), sourceId)
              }
              onSafetyLimiterCeilingChange={(sourceId, ceilingDb) =>
                runMutation(() => setSafetyLimiterCeilingCommand(sourceId, ceilingDb), sourceId)
              }
              onWebRtcProcessingChange={(sourceId, processing) =>
                runMutation(() => setLocalWebRtcProcessingCommand(sourceId, processing), sourceId)
              }
              onProcessorParameterChange={draftProcessorParameter}
              onProcessorParameterCommit={flushProcessorParameter}
              draftProcessorParams={draftProcessorParams}
            />
          ))}
        </MixerSection>
        <MixerSection
          title="What you hear"
          description={
            mixerState.autoLevel.enabled
              ? "Everything you hear sets how loud Raven is. The faders beside it set the balance between people, and Auto-level evens out their microphones as they talk. Move a fader to set someone yourself. Nobody else hears the difference."
              : "Everything you hear sets how loud Raven is. The faders beside it set the balance between people. Nobody else hears the difference."
          }
          emptyText="Nobody else is sending sound right now."
          lead={
            <OutputStrip
              volumeDb={mixerState.session.outputVolumeDb}
              deafened={deafen ? deafen.deafened : mixerState.session.outputMuted}
              draftDb={draftVolumeDb}
              meter={mixerState.session.outputMeter}
              onVolumeInput={(volumeDb) => {
                setDraftVolumeDb(volumeDb);
                previewOutputVolume(volumeDb);
              }}
              onVolumeCommit={(volumeDb) => {
                setDraftVolumeDb(volumeDb);
                void commitOutputVolume(volumeDb)
                  .then(applyCanonicalState)
                  .catch(() => undefined)
                  .finally(() => setDraftVolumeDb(null));
              }}
              onToggleDeafen={() =>
                deafen
                  ? deafen.onToggle()
                  : void runMutation(() => audioCommands.setOutputMuted(!mixerState.session.outputMuted))
              }
            />
          }
          action={
            <label className="flex items-center gap-2 text-small font-medium">
              Auto-level
              <Switch
                checked={mixerState.autoLevel.enabled}
                disabled={status === "loading"}
                onCheckedChange={(enabled) => void runMutation(() => setAutoLevel(enabled))}
              />
            </label>
          }
        >
          {remoteGroups.map((participant) => (
            <div key={participant.participantId} className="flex shrink-0 flex-col gap-2 rounded-lg border bg-secondary/30 p-2">
              <div className="flex items-center justify-between gap-2 px-1">
                <div className="text-xs font-medium">{participant.displayName ?? shortId(participant.participantId)}</div>
                <Badge variant="outline">{participant.tracks.length}</Badge>
              </div>
              <div className="flex gap-2">
              {participant.tracks.map((track) => {
                const strip = remoteTrackToStrip(track, participant.displayName ?? shortId(participant.participantId));
                return (
                  <ChannelStrip
                    key={strip.id}
                    strip={strip}
                    presets={presets}
                    inputDevices={inputDevices}
                    outputDevices={outputDevices}
                    busy={busySourceIds.has(strip.id)}
                    draftGainDb={draftGains[strip.id]}
                    onGainChange={scheduleGain}
                    onGainCommit={flushGain}
                    onMute={(stripId, muted) => runMutation(() => setChannelMuteCommand(stripId, muted), stripId)}
                    onProcessorToggle={(stripId, processorId, enabled) =>
                      runMutation(() => setProcessorEnabledCommand(stripId, processorId, enabled), stripId)
                    }
                    onProcessorAdd={(stripId, kind) => runMutation(() => addProcessorCommand(stripId, kind), stripId)}
                    onProcessorRemove={(stripId, processorId) =>
                      runMutation(() => removeProcessorCommand(stripId, processorId), stripId)
                    }
                    onProcessorReorder={(stripId, orderedProcessorIds) =>
                      runMutation(() => reorderProcessorsCommand(stripId, orderedProcessorIds), stripId)
                    }
                    onPresetApply={(stripId, presetId) =>
                      runMutation(() => applyPresetCommand(stripId, presetId), stripId)
                    }
                    onPresetSave={(stripId, name, description, target) =>
                      runMutation(() => savePresetCommand(stripId, name, description, target), stripId)
                    }
                    onPresetDelete={(presetId) => runMutation(() => deletePresetCommand(presetId))}
                    onPresetRename={(presetId, name) => runMutation(() => renamePresetCommand(presetId, name))}
                    onProcessorChainReset={(stripId) =>
                      runMutation(() => resetProcessorChainCommand(stripId), stripId)
                    }
                    onSafeDefaultsReset={(stripId) =>
                      runMutation(() => resetSafeDefaultsCommand(stripId), stripId)
                    }
                    onSafetyLimiterCeilingChange={(stripId, ceilingDb) =>
                      runMutation(() => setSafetyLimiterCeilingCommand(stripId, ceilingDb), stripId)
                    }
                    onNoiseCleanupChange={(participantId, trackId, enabled) =>
                      runMutation(() => audioCommands.setRemoteNoiseCleanup(participantId, trackId, enabled), strip.id)
                    }
                    onResumeAutoLevel={(participantId) =>
                      runMutation(() => audioCommands.resumeAutoLevel(participantId), strip.id)
                    }
                    onProcessorParameterChange={draftProcessorParameter}
                    onProcessorParameterCommit={flushProcessorParameter}
                    draftProcessorParams={draftProcessorParams}
                  />
                );
              })}
              </div>
            </div>
          ))}
        </MixerSection>
      </div>
    </div>
  );
}

// Labelled form field wrapper for UX-friendly forms.
function FormField({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-xs font-medium text-foreground">
        {label}
      </label>
      {children}
      {hint ? <p className="text-caption text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function AddSourceForm({
  disabled,
  capabilities,
  appAudioSources,
  inputDevices,
  outputDevices,
  onRefreshAppSources,
  onRefreshOutputDevices,
  onAdd,
}: {
  disabled: boolean;
  capabilities: NativeAudioCapabilityReport | null;
  appAudioSources: AppAudioSource[];
  inputDevices: AudioInputDevice[];
  outputDevices: AudioOutputDevice[];
  onRefreshAppSources: () => void;
  onRefreshOutputDevices: () => void;
  onAdd: (sourceType: AudioSourceType, displayName: string, captureDeviceId?: string) => void;
}) {
  const [sourceType, setSourceType] = useState<AudioSourceType>("microphone");
  const [displayName, setDisplayName] = useState("Main microphone");
  const [selectedProcessId, setSelectedProcessId] = useState<number | null>(null);
  const [selectedOutputDeviceId, setSelectedOutputDeviceId] = useState<string | null>(null);
  const [selectedInputDeviceId, setSelectedInputDeviceId] = useState<string | null>(null);

  const isAppAudio = sourceType === "appAudio";
  const isSystemAudio = sourceType === "systemAudio";
  const isMicrophone = sourceType === "microphone";
  const selectedApp = appAudioSources.find((a) => a.processId === selectedProcessId) ?? null;
  const selectedOutputDevice = outputDevices.find((device) => device.deviceId === selectedOutputDeviceId) ?? null;
  const selectedInputDevice = inputDevices.find((device) => device.deviceId === selectedInputDeviceId) ?? null;
  const availableSourceTypes = useMemo(
    () => sourceTypes.filter((type) => capabilities?.supportedSourceTypes.includes(type) ?? true),
    [capabilities],
  );

  useEffect(() => {
    if (!isSystemAudio || selectedOutputDeviceId || !outputDevices.length) return;
    const defaultDevice = outputDevices.find((device) => device.isDefault) ?? outputDevices[0];
    setSelectedOutputDeviceId(defaultDevice.deviceId);
  }, [isSystemAudio, outputDevices, selectedOutputDeviceId]);

  useEffect(() => {
    if (availableSourceTypes.includes(sourceType)) return;
    const fallback = availableSourceTypes[0] ?? "microphone";
    setSourceType(fallback);
    setDisplayName(defaultSourceName(fallback));
    setSelectedProcessId(null);
    setSelectedOutputDeviceId(null);
    setSelectedInputDeviceId(null);
  }, [availableSourceTypes, sourceType]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const name = isAppAudio ? selectedApp?.displayName ?? defaultSourceName(sourceType) : displayName.trim();
    if (!name) return;
    if (!availableSourceTypes.includes(sourceType)) return;
    if (isAppAudio && selectedProcessId == null) return;
    if (isSystemAudio && !selectedOutputDeviceId) return;
    onAdd(
      sourceType,
      name,
      isAppAudio
        ? String(selectedProcessId)
        : isSystemAudio
          ? selectedOutputDeviceId ?? undefined
          : isMicrophone
            ? selectedInputDeviceId ?? undefined
            : undefined,
    );
    setDisplayName(defaultSourceName(sourceType));
    if (isAppAudio) setSelectedProcessId(null);
    if (isSystemAudio) setSelectedOutputDeviceId(null);
    if (isMicrophone) setSelectedInputDeviceId(null);
  };

  return (
    <form className="grid grid-cols-1 gap-3" onSubmit={submit}>
      <FormField label="Source type" htmlFor="add-source-type">
        <Select
          value={sourceType}
          disabled={disabled}
          onValueChange={(value) => {
            const nextType = value as AudioSourceType;
            setSourceType(nextType);
            setDisplayName(defaultSourceName(nextType));
            setSelectedProcessId(null);
            setSelectedOutputDeviceId(null);
            setSelectedInputDeviceId(null);
          }}
        >
          <SelectTrigger id="add-source-type">
            <SelectValue>{sourceTypeLabel(sourceType)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {availableSourceTypes.map((type) => (
                <SelectItem key={type} value={type}>
                  {sourceTypeLabel(type)}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </FormField>

      {capabilities && !capabilities.supportsAppAudio ? (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-300">
          App audio capture is not available on {capabilities.os}. Use system audio for desktop playback capture.
        </div>
      ) : null}

      {capabilities?.issues?.map((issue) => (
        <div key={issue} className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-300">
          {issue}
        </div>
      ))}

      {isAppAudio ? (
        <FormField label="Application">
          <div className="flex items-center gap-2">
            <Select value={selectedProcessId == null ? "" : String(selectedProcessId)} disabled={disabled}>
              <SelectTrigger className="min-w-0 flex-1 px-2">
                <span className="flex min-w-0 items-center gap-2">
                  <AppAudioIcon app={selectedApp} className="h-5 w-5" />
                  <SelectValue placeholder="Select application">{selectedApp?.displayName}</SelectValue>
                  {selectedApp ? (
                    <span
                      className={cn(
                        "h-2 w-2 shrink-0 rounded-full",
                        selectedApp.hasAudioSession ? "bg-emerald-500" : "bg-muted-foreground/30",
                      )}
                      title={selectedApp.hasAudioSession ? "Audio session detected" : "No audio session yet"}
                    />
                  ) : null}
                </span>
              </SelectTrigger>
              <SelectContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)]">
                <SelectGroup>
                  {appAudioSources.length ? (
                    appAudioSources.map((app) => (
                      <SelectItem
                        key={app.processId}
                        value={String(app.processId)}
                        onSelect={() => {
                          setSelectedProcessId(app.processId);
                          setDisplayName(app.displayName);
                        }}
                      >
                        <AppAudioIcon app={app} className="h-5 w-5" />
                        <span className="min-w-0 flex-1 truncate">{app.displayName}</span>
                        <span
                          className={cn(
                            "h-2 w-2 shrink-0 rounded-full",
                            app.hasAudioSession ? "bg-emerald-500" : "bg-muted-foreground/30",
                          )}
                          title={app.hasAudioSession ? "Audio session detected" : "No audio session yet"}
                        />
                        <span className="shrink-0 tabular-nums text-xs text-muted-foreground">{app.processId}</span>
                      </SelectItem>
                    ))
                  ) : (
                    <SelectItem value="__empty-apps" disabled>No app processes found</SelectItem>
                  )}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={onRefreshAppSources}
              title="Refresh application list"
            >
              <RotateCcw className="h-4 w-4" />
            </Button>
          </div>
          {/* {selectedApp ? (
            <div className="flex items-center gap-2 px-1">
              <AppAudioIcon app={selectedApp} className="h-5 w-5" />
              <span className="truncate text-xs text-muted-foreground">{selectedApp.exeName}</span>
            </div>
          ) : null} */}
        </FormField>
      ) : null}

      {isSystemAudio ? (
        <FormField label="Output device">
          <div className="flex items-center gap-2">
            <Select value={selectedOutputDeviceId ?? ""} disabled={disabled}>
              <SelectTrigger className="min-w-0 flex-1 px-2">
                <span className="flex min-w-0 items-center gap-2">
                  <OutputDeviceIcon className="h-5 w-5" />
                  <SelectValue placeholder="Select output device">{selectedOutputDevice?.name}</SelectValue>
                </span>
              </SelectTrigger>
              <SelectContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)]">
                <SelectGroup>
                  {outputDevices.length ? (
                    outputDevices.map((device) => (
                      <SelectItem
                        key={device.deviceId}
                        value={device.deviceId}
                        onSelect={() => {
                          setSelectedOutputDeviceId(device.deviceId);
                          setDisplayName(device.name);
                        }}
                      >
                        <OutputDeviceIcon className="h-5 w-5" />
                        <span className="min-w-0 flex-1 truncate">{device.name}</span>
                        {device.isDefault ? <Badge variant="outline">default</Badge> : null}
                      </SelectItem>
                    ))
                  ) : (
                    <SelectItem value="__empty-outputs" disabled>No output devices found</SelectItem>
                  )}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={onRefreshOutputDevices}
              title="Refresh output devices"
            >
              <RotateCcw className="h-4 w-4" />
            </Button>
          </div>
        </FormField>
      ) : null}

      {!isAppAudio ? (
        <FormField label="Name" htmlFor="add-source-name">
          <Input id="add-source-name" value={displayName} disabled={disabled} onChange={(event) => setDisplayName(event.target.value)} />
        </FormField>
      ) : null}

      {isMicrophone ? (
        <FormField label="Input device">
          <Select
            value={selectedInputDeviceId ?? "__default-input"}
            disabled={disabled}
            onValueChange={(value) => setSelectedInputDeviceId(value === "__default-input" ? null : value)}
          >
            <SelectTrigger className="w-full min-w-0 px-2">
              <span className="flex min-w-0 items-center gap-2">
                <Mic className="h-5 w-5" />
                <SelectValue>{selectedInputDevice?.name ?? "Default input device"}</SelectValue>
              </span>
            </SelectTrigger>
            <SelectContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)]">
              <SelectGroup>
                <SelectItem value="__default-input">
                  <Mic className="h-5 w-5" />
                  <span className="min-w-0 flex-1 truncate">Default input device</span>
                  {selectedInputDeviceId == null ? <Badge variant="outline">current</Badge> : null}
                </SelectItem>
                {inputDevices.map((device) => (
                  <SelectItem
                    key={device.deviceId}
                    value={device.deviceId}
                  >
                    <Mic className="h-5 w-5" />
                    <span className="min-w-0 flex-1 truncate">{device.name}</span>
                    {device.isDefault ? <Badge variant="outline">default</Badge> : null}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </FormField>
      ) : null}
      <Button
        className="w-full"
        disabled={
          disabled ||
          !availableSourceTypes.length ||
          (!isAppAudio && !isSystemAudio && !displayName.trim()) ||
          (isAppAudio && selectedProcessId == null) ||
          (isSystemAudio && !selectedOutputDeviceId)
        }
        type="submit"
      >
        <Plus className="h-4 w-4" />
        Add Source
      </Button>
    </form>
  );
}

function MixerSection({
  title,
  description,
  emptyText,
  action,
  lead,
  children,
}: {
  title: string;
  description: string;
  emptyText: string;
  /** A control for the whole section, beside its count. */
  action?: React.ReactNode;
  /** A strip that is always there and not one of the section items, set apart from them. */
  lead?: React.ReactNode;
  children: React.ReactNode;
}) {
  const childCount = useMemo(() => {
    if (!Array.isArray(children)) return children ? 1 : 0;
    return children.filter(Boolean).length;
  }, [children]);

  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h3 className="text-title-sm font-semibold">{title}</h3>
          <p className="text-small text-muted-foreground">{description}</p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {action}
          <Badge variant="outline">{childCount}</Badge>
        </div>
      </div>
      {/* scrollbar-gutter:stable reserves the horizontal scrollbar's space at all times, so a
          strip changing width (e.g. revealing the monitor fader) can't toggle the scrollbar and
          squeeze every strip's height via items-stretch. */}
      <div className="flex items-stretch gap-3 overflow-x-auto pb-2 [scrollbar-gutter:stable]">
        {lead}
        {lead ? <div role="separator" aria-orientation="vertical" className="w-px shrink-0 self-stretch bg-border" /> : null}
        {childCount ? children : <EmptyMixerState text={emptyText} />}
      </div>
    </section>
  );
}

/**
 * "Everything you hear": the one volume for all of Raven. It sits after the per-person
 * faders and Auto-level, so it changes how loud Raven is without moving anyone out of
 * balance. Its M button is deafen itself, the same switch as the dock.
 */
function OutputStrip({
  volumeDb,
  deafened,
  draftDb,
  meter,
  onVolumeInput,
  onVolumeCommit,
  onToggleDeafen,
}: {
  volumeDb: number;
  deafened: boolean;
  draftDb: number | null;
  meter: MeterState;
  onVolumeInput: (volumeDb: number) => void;
  onVolumeCommit: (volumeDb: number) => void;
  onToggleDeafen: () => void;
}) {
  const shown = draftDb ?? volumeDb;
  return (
    <div className="group relative flex w-32 shrink-0 flex-col overflow-hidden rounded-lg border bg-background/70 p-2.5">
      <div className="absolute inset-x-0 top-0 h-0.5 bg-foreground/40" />
      <div className="flex items-center gap-1.5">
        <Volume2 className="h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1 px-1 text-xs font-semibold leading-tight" title="Everything you hear">
          Everything you hear
        </div>
      </div>
      <div className="mt-0.5 px-1 text-caption leading-tight text-muted-foreground">All sound from Raven</div>
      <div className="mt-2 flex flex-1 justify-center gap-0.5" style={{ minHeight: 188 }}>
        <div className="flex w-6 shrink-0 flex-col gap-0.5">
          <div className="h-1.5 shrink-0" />
          <div className="relative min-h-0 flex-1">
            {[...DBFS_METER_TICKS].reverse().map((db) => (
              <span
                key={db}
                className="absolute right-0 -translate-y-1/2 text-[9px] leading-none tabular-nums text-muted-foreground/60"
                style={{ top: `${100 - meterPercent(db)}%` }}
              >
                {db}
              </span>
            ))}
          </div>
          <div className="mt-1 h-4 shrink-0" />
        </div>

        <OutputMeter initial={meter} />

        <div className="flex w-7 shrink-0 flex-col items-center">
          <div className="flex min-h-0 w-full flex-1 justify-center">
            <RavenFader
              value={shown}
              min={OUTPUT_VOLUME_MIN_DB}
              max={OUTPUT_VOLUME_MAX_DB}
              step={OUTPUT_VOLUME_STEP_DB}
              unityDb={0}
              ariaLabel="Everything you hear"
              onInput={onVolumeInput}
              onCommit={onVolumeCommit}
              onReset={() => {
                onVolumeInput(0);
                onVolumeCommit(0);
              }}
            />
          </div>
          <span className="mt-1 h-4 w-full text-center text-caption font-medium leading-4 tabular-nums" title={`Volume ${formatDb(shown)}`}>
            {formatDbCompact(shown)}
          </span>
        </div>

        <div className="flex w-7 shrink-0 flex-col items-center">
          <Button
            size="icon"
            variant="ghost"
            className={cn(
              "h-7 w-7 text-sm font-bold",
              deafened ? "text-destructive hover:text-destructive" : "text-muted-foreground hover:text-foreground",
            )}
            onClick={onToggleDeafen}
            aria-label={deafened ? "Hear people again" : "Stop hearing people"}
            title={deafened ? "Hear people again" : "Stop hearing people"}
          >
            M
          </Button>
        </div>
      </div>
    </div>
  );
}

function OutputMeter({ initial }: { initial: MeterState }) {
  const [visual, setVisual] = useState(() => ({
    meter: initial,
    peakHoldDb: Number.NEGATIVE_INFINITY,
  }));

  useEffect(() => {
    let mounted = true;
    let unsubscribe: (() => void) | null = null;
    void subscribeAudioMeterChanged((update) => {
      if (!mounted || !update.output) return;
      setVisual((current) => ({
        meter: update.meter,
        peakHoldDb: Math.max(current.peakHoldDb, update.meter.peakDb),
      }));
    })
      .then((unlisten) => {
        if (!mounted) unlisten();
        else unsubscribe = unlisten;
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, []);

  const held = visual.peakHoldDb === Number.NEGATIVE_INFINITY;
  return (
    <div className="flex w-6 shrink-0 flex-col items-center">
      <div className="flex min-h-0 w-full flex-1 justify-center">
        <VerticalMeter
          peakDb={visual.meter.peakDb}
          rmsDb={visual.meter.rmsDb}
          muted={false}
          clipping={visual.meter.clipping}
        />
      </div>
      <button
        type="button"
        onClick={() => setVisual((current) => ({ ...current, peakHoldDb: Number.NEGATIVE_INFINITY }))}
        title={`Peak hold ${held ? "−∞" : formatDb(visual.peakHoldDb)} — click to reset`}
        className="mt-1 h-4 w-full text-center text-caption font-normal leading-4 tabular-nums text-subtle transition-colors hover:text-foreground"
      >
        {held ? "−∞" : formatDbCompact(visual.peakHoldDb)}
      </button>
    </div>
  );
}

function ChannelStrip({
  strip,
  presets,
  inputDevices,
  outputDevices,
  busy = false,
  draftGainDb,
  onGainChange,
  onGainCommit,
  onMute,
  onRename,
  onEnabledChange,
  onCaptureDeviceChange,
  onPublish,
  onUnpublish,
  onRemove,
  onProcessorToggle,
  onProcessorAdd,
  onProcessorRemove,
  onProcessorReorder,
  onPresetApply,
  onPresetSave,
  onPresetDelete,
  onPresetRename,
  onProcessorChainReset,
  onSafeDefaultsReset,
  onSafetyLimiterCeilingChange,
  onWebRtcProcessingChange,
  onNoiseCleanupChange,
  onResumeAutoLevel,
  onProcessorParameterChange,
  onProcessorParameterCommit,
  draftProcessorParams = {},
}: {
  strip: ChannelStripView;
  presets: AudioPresetDefinition[];
  inputDevices: AudioInputDevice[];
  outputDevices: AudioOutputDevice[];
  busy?: boolean;
  draftGainDb?: GainDb;
  onGainChange?: (sourceId: string, gainDb: GainDb) => void;
  onGainCommit?: (sourceId: string, gainDb: GainDb) => void;
  onMute?: (sourceId: string, muted: boolean) => void;
  onRename?: (sourceId: string, displayName: string) => void;
  onEnabledChange?: (sourceId: string, enabled: boolean) => void;
  onCaptureDeviceChange?: (sourceId: string, captureDeviceId: string | null) => void;
  onPublish?: (sourceId: string) => void;
  onUnpublish?: (sourceId: string) => void;
  onRemove?: (sourceId: string) => void;
  onProcessorToggle?: (sourceId: string, processorId: string, enabled: boolean) => void;
  onProcessorAdd?: (sourceId: string, kind: AudioProcessorKind) => void;
  onProcessorRemove?: (sourceId: string, processorId: string) => void;
  onProcessorReorder?: (sourceId: string, orderedProcessorIds: string[]) => void;
  onPresetApply?: (sourceId: string, presetId: string) => void;
  onPresetSave?: (sourceId: string, name: string, description: string, target: AudioPresetTarget) => void;
  onPresetDelete?: (presetId: string) => void;
  onPresetRename?: (presetId: string, name: string) => void;
  onProcessorChainReset?: (sourceId: string) => void;
  onSafeDefaultsReset?: (sourceId: string) => void;
  onSafetyLimiterCeilingChange?: (sourceId: string, ceilingDb: GainDb) => void;
  onWebRtcProcessingChange?: (sourceId: string, processing: WebRtcAudioProcessingSettings) => void;
  onNoiseCleanupChange?: (participantId: string, trackId: string, enabled: boolean) => void;
  onResumeAutoLevel?: (participantId: string) => void;
  onProcessorParameterChange?: (
    sourceId: string,
    processorId: string,
    parameterName: string,
    value: AudioParameterValue,
  ) => void;
  onProcessorParameterCommit?: (
    sourceId: string,
    processorId: string,
    parameterName: string,
    value: AudioParameterValue,
  ) => void;
  draftProcessorParams?: Record<string, AudioParameterValue>;
}) {
  const [editingName, setEditingName] = useState(strip.title);
  const [toolsOpen, setToolsOpen] = useState(false);
  const gainDb = draftGainDb ?? strip.gainDb;
  const canMutate = !busy;
  const canEditName = strip.mode === "local" && strip.sourceType !== "appAudio" && !busy;

  // Local monitoring (formerly "Monitor self" in the Nest right pane). Mic-only: plays the
  // captured device straight to the local output so you can hear yourself. Enabling it mutes
  // the outgoing channel (so peers don't get a double / echo); disabling restores the prior
  // mute state captured at enable time.
  const isMonitorable = strip.mode === "local" && strip.sourceType === "microphone";
  const monitorDeviceName = strip.mode === "local"
    ? strip.runtime.deviceName ?? strip.captureDeviceId
    : null;
  const [monitorOn, setMonitorOn] = useState(false);
  const [monitorGainDb, setMonitorGainDb] = useState<number>(0);
  const monitorAudioRef = useRef<{ ctx: AudioContext; stream: MediaStream; gain: GainNode } | null>(null);
  const monitorPriorMuteRef = useRef(false);

  useEffect(() => setEditingName(strip.title), [strip.title]);

  // Open/teardown the monitor playback graph. Re-runs when the capture device changes so the
  // loopback follows the strip's selected input. Monitor gain is updated in place (below).
  useEffect(() => {
    if (!isMonitorable || !monitorOn) return;
    let cancelled = false;
    let teardown: (() => void) | undefined;
    void (async () => {
      try {
        const browserDeviceId = monitorDeviceName
          ? await browserInputIdForNativeDevice(monitorDeviceName)
          : null;
        if (monitorDeviceName && !browserDeviceId) {
          throw new Error(`Browser input matching ${monitorDeviceName} was not found`);
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: browserDeviceId ? { deviceId: { exact: browserDeviceId } } : true,
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        const ctx = new AudioContext();
        const source = ctx.createMediaStreamSource(stream);
        const gain = ctx.createGain();
        gain.gain.value = dbToLinear(monitorGainDb);
        source.connect(gain).connect(ctx.destination);
        void ctx.resume();
        monitorAudioRef.current = { ctx, stream, gain };
        teardown = () => {
          source.disconnect();
          gain.disconnect();
          stream.getTracks().forEach((track) => track.stop());
          void ctx.close();
          monitorAudioRef.current = null;
        };
      } catch {
        if (!cancelled) setMonitorOn(false);
      }
    })();
    return () => {
      cancelled = true;
      teardown?.();
    };
    // monitorGainDb is intentionally omitted — it's applied live without rebuilding the graph.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMonitorable, monitorOn, monitorDeviceName]);

  useEffect(() => {
    const node = monitorAudioRef.current?.gain;
    if (node) node.gain.value = dbToLinear(monitorGainDb);
  }, [monitorGainDb]);

  const toggleMonitor = () => {
    if (!monitorOn) {
      monitorPriorMuteRef.current = strip.muted;
      if (!strip.muted) onMute?.(strip.id, true);
      setMonitorOn(true);
    } else {
      // Only issue a mute command when the state actually changes — restoring to the same
      // value (e.g. the mic was already muted) would otherwise round-trip the engine and
      // jolt the layout for no reason.
      if (strip.muted !== monitorPriorMuteRef.current) onMute?.(strip.id, monitorPriorMuteRef.current);
      setMonitorOn(false);
    }
  };

  const commitGain = (value: string) => onGainCommit?.(strip.id, Number(value));

  return (
    <div
      className={cn(
        "group relative flex shrink-0 flex-col overflow-hidden rounded-lg border bg-background/70 p-2.5 transition-colors",
        isMonitorable && monitorOn ? "w-40" : "w-32",
        !strip.enabled && "opacity-65",
        busy && "border-primary/35",
      )}
    >
      {/* Source-type accent */}
      <div className={cn("absolute inset-x-0 top-0 h-0.5", sourceAccentClass(strip.sourceType))} />

      {/* Header — icon + name (full width; actions moved to the footer) */}
      <div className="flex items-center gap-1.5">
        {strip.appIconDataUrl ? (
          <AppAudioIcon appIconDataUrl={strip.appIconDataUrl} appName={strip.appExeName ?? strip.title} className="h-4 w-4" />
        ) : strip.sourceType === "systemAudio" ? (
          <OutputDeviceIcon className="h-4 w-4" />
        ) : (
          sourceTypeIcon(strip.sourceType)
        )}
        {strip.mode === "local" && canEditName ? (
          <input
            className="h-6 min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 text-xs font-semibold focus:border-input focus:bg-card focus:outline-none"
            value={editingName}
            disabled={busy}
            onChange={(event) => setEditingName(event.target.value)}
            onBlur={() => {
              const nextName = editingName.trim();
              if (nextName && nextName !== strip.title) onRename?.(strip.id, nextName);
              else setEditingName(strip.title);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                setEditingName(strip.title);
                event.currentTarget.blur();
              }
            }}
            aria-label="Source name"
          />
        ) : (
          <div className="min-w-0 flex-1 truncate px-1 text-xs font-semibold" title={strip.title}>{strip.title}</div>
        )}
        {/* Status dots — publish + health, right of the name */}
        <div className="flex shrink-0 items-center gap-1 pl-0.5">
          {strip.mode === "local" ? <PublishDot live={Boolean(strip.publishedTrack)} /> : null}
          <LiveHealthDot strip={strip} />
        </div>
      </div>

      {/* Device subtitle — which OS device/app this channel captures from */}
      {stripDeviceLabel(strip) ? (
        <div className="mt-0.5 truncate px-1 text-caption leading-tight text-muted-foreground" title={stripDeviceLabel(strip) ?? undefined}>
          {stripDeviceLabel(strip)}
        </div>
      ) : null}

      {/* Scale · meter · fader · actions. Meter and fader each own their readout label
          in the same fixed-width cell as the bar, so peak/gain align pixel-perfectly. */}
      <div className="mt-2 flex flex-1 justify-center gap-0.5" style={{ minHeight: 188 }}>
        {/* dB scale (bottom spacer keeps marks aligned to the meter bar) */}
        <div className="flex w-6 shrink-0 flex-col gap-0.5">
          <div className="h-1.5 shrink-0" />
          <div className="relative min-h-0 flex-1">
            {[...DBFS_METER_TICKS].reverse().map((db) => (
              <span
                key={db}
                className="absolute right-0 -translate-y-1/2 text-[9px] leading-none tabular-nums text-muted-foreground/60"
                style={{ top: `${100 - meterPercent(db)}%` }}
              >
                {db}
              </span>
            ))}
          </div>
          <div className="mt-1 h-4 shrink-0" />
        </div>

        {/* Meter + peak readout */}
        <LiveChannelMeter strip={strip} muted={strip.muted} />

        {/* Fader + gain readout */}
        <div className="flex w-7 shrink-0 flex-col items-center">
          <div className="flex min-h-0 w-full flex-1 justify-center">
            <RavenFader
              value={gainDb}
              min={GAIN_MIN_DB}
              max={GAIN_MAX_DB}
              step={GAIN_STEP_DB}
              unityDb={0}
              disabled={!canMutate}
              ariaLabel={`${strip.title} gain`}
              onInput={(value) => onGainChange?.(strip.id, value)}
              onCommit={(value) => onGainCommit?.(strip.id, value)}
              onReset={() => {
                onGainChange?.(strip.id, 0);
                onGainCommit?.(strip.id, 0);
              }}
            />
          </div>
          <span className="mt-1 h-4 w-full text-center text-caption font-medium leading-4 tabular-nums" title={`Gain ${formatDb(gainDb)}`}>
            {formatDbCompact(gainDb)}
          </span>
        </div>

        {/* Vertical actions — Mute + Tools at top, Remove pinned to the bottom */}
        <div className="flex w-7 shrink-0 flex-col items-center justify-between">
          <div className="flex flex-col items-center gap-1">
            <Button
              size="icon"
              variant="ghost"
              className={cn(
                "h-7 w-7 text-sm font-bold",
                strip.muted ? "text-destructive hover:text-destructive" : "text-muted-foreground hover:text-foreground",
              )}
              disabled={!canMutate}
              onClick={() => onMute?.(strip.id, !strip.muted)}
              aria-label={strip.muted ? "Unmute" : "Mute"}
            >
              M
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              onClick={() => setToolsOpen(true)}
              aria-label="Channel tools"
            >
              <Settings2 className="h-4 w-4" />
            </Button>
            {isMonitorable ? (
              <Button
                size="icon"
                variant="ghost"
                className={cn(
                  "h-7 w-7",
                  monitorOn ? "text-primary hover:text-primary" : "text-muted-foreground hover:text-foreground",
                )}
                onClick={toggleMonitor}
                aria-label={monitorOn ? "Stop monitoring this mic" : "Monitor this mic locally"}
                title={monitorOn ? "Stop monitoring this mic" : "Monitor this mic locally"}
              >
                <Headphones className="h-4 w-4" />
              </Button>
            ) : null}
          </div>
          {strip.mode === "local" ? (
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-muted-foreground hover:text-destructive"
              disabled={!canMutate}
              onClick={() => onRemove?.(strip.id)}
              aria-label="Remove source"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          ) : null}
        </div>

        {/* Monitor fader + readout — mic only, shown only while monitoring so the strip fits
            its content. The strip rows reserve their scrollbar gutter (see MixerSection), so
            the width change here never toggles a scrollbar that would jolt strip heights. */}
        {isMonitorable && monitorOn ? (
          <div className="flex w-7 shrink-0 flex-col items-center">
            <div className="flex min-h-0 w-full flex-1 justify-center">
              <RavenFader
                value={monitorGainDb}
                min={GAIN_MIN_DB}
                max={GAIN_MAX_DB}
                step={GAIN_STEP_DB}
                unityDb={0}
                disabled={!monitorOn}
                ariaLabel={`${strip.title} monitor gain`}
                onInput={(value) => setMonitorGainDb(value)}
                onCommit={(value) => setMonitorGainDb(value)}
                onReset={() => setMonitorGainDb(0)}
              />
            </div>
            <span
              className="mt-1 h-4 w-full text-center text-caption font-medium leading-4 tabular-nums text-muted-foreground"
              title={`Monitor gain ${formatDb(monitorGainDb)}`}
            >
              {formatDbCompact(monitorGainDb)}
            </span>
          </div>
        ) : null}
      </div>

      {/* Publish — full width */}
      {strip.mode === "local" ? (
        <Button
          size="sm"
          variant="ghost"
          className={cn(
            "mt-2 h-8 w-full gap-1.5",
            strip.publishedTrack ? "text-primary hover:text-primary" : "text-muted-foreground hover:text-foreground",
          )}
          disabled={busy}
          onClick={() => (strip.publishedTrack ? onUnpublish?.(strip.id) : onPublish?.(strip.id))}
          aria-label={strip.publishedTrack ? "Stop publishing to call" : "Publish to call"}
        >
          <span className={cn("h-1.5 w-1.5 rounded-full", strip.publishedTrack ? "bg-primary" : "bg-muted-foreground/50")} />
          {strip.publishedTrack ? "Live" : "Publish"}
        </Button>
      ) : (
        <AutoLevelLine
          status={strip.autoLevel.status}
          disabled={busy}
          onResume={() => onResumeAutoLevel?.(strip.remoteParticipantId)}
        />
      )}
      {/*
        Source On/Off (local capture enable) intentionally omitted — sources always
        capture once added. Restore here if a "run locally without transmitting" mode
        is ever wanted again.
      */}
      <Drawer
        open={toolsOpen}
        onOpenChange={setToolsOpen}
        title={strip.title}
        description={
          strip.mode === "local"
            ? `${sourceTypeLabel(strip.sourceType)} · channel tools`
            : `${strip.participantTitle} · incoming track`
        }
        widthClassName="w-full max-w-[560px]"
      >
        <ChannelToolsPanel
          strip={strip}
          presets={presets}
          inputDevices={inputDevices}
          outputDevices={outputDevices}
          editable={!busy}
          draftProcessorParams={draftProcessorParams}
          onCaptureDeviceChange={onCaptureDeviceChange}
          onWebRtcProcessingChange={onWebRtcProcessingChange}
          onNoiseCleanupChange={onNoiseCleanupChange}
          onProcessorAdd={onProcessorAdd}
          onProcessorRemove={onProcessorRemove}
          onProcessorReorder={onProcessorReorder}
          onProcessorToggle={onProcessorToggle}
          onPresetApply={onPresetApply}
          onPresetSave={onPresetSave}
          onPresetDelete={onPresetDelete}
          onPresetRename={onPresetRename}
          onProcessorChainReset={onProcessorChainReset}
          onSafeDefaultsReset={onSafeDefaultsReset}
          onSafetyLimiterCeilingChange={onSafetyLimiterCeilingChange}
          onProcessorParameterChange={onProcessorParameterChange}
          onProcessorParameterCommit={onProcessorParameterCommit}
        />
      </Drawer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Channel tools drawer
//
// Everything below renders inside a fixed ~560 px drawer column, so the layouts
// are authored for that one width. Tailwind's sm:/md:/lg: prefixes track the
// *viewport*, not this container — reaching for them here is what produced the
// earlier squeezed grids (four-column forms collapsing into slivers, buttons
// wrapping onto rows of their own). Use fixed column counts instead.
// ---------------------------------------------------------------------------

type ChannelToolHandlers = {
  onCaptureDeviceChange?: (sourceId: string, captureDeviceId: string | null) => void;
  onWebRtcProcessingChange?: (sourceId: string, processing: WebRtcAudioProcessingSettings) => void;
  onNoiseCleanupChange?: (participantId: string, trackId: string, enabled: boolean) => void;
  onProcessorAdd?: (sourceId: string, kind: AudioProcessorKind) => void;
  onProcessorRemove?: (sourceId: string, processorId: string) => void;
  onProcessorReorder?: (sourceId: string, orderedProcessorIds: string[]) => void;
  onProcessorToggle?: (sourceId: string, processorId: string, enabled: boolean) => void;
  onPresetApply?: (sourceId: string, presetId: string) => void;
  onPresetSave?: (sourceId: string, name: string, description: string, target: AudioPresetTarget) => void;
  onPresetDelete?: (presetId: string) => void;
  onPresetRename?: (presetId: string, name: string) => void;
  onProcessorChainReset?: (sourceId: string) => void;
  onSafeDefaultsReset?: (sourceId: string) => void;
  onSafetyLimiterCeilingChange?: (sourceId: string, ceilingDb: GainDb) => void;
  onProcessorParameterChange?: (
    sourceId: string,
    processorId: string,
    parameterName: string,
    value: AudioParameterValue,
  ) => void;
  onProcessorParameterCommit?: (
    sourceId: string,
    processorId: string,
    parameterName: string,
    value: AudioParameterValue,
  ) => void;
};

type ChannelToolsProps = ChannelToolHandlers & {
  strip: ChannelStripView;
  presets: AudioPresetDefinition[];
  inputDevices: AudioInputDevice[];
  outputDevices: AudioOutputDevice[];
  editable: boolean;
  draftProcessorParams: Record<string, AudioParameterValue>;
};

/**
 * Two tabs keep the ~30 per-channel controls legible: "Channel" is the signal
 * path you check while talking (device, levels, safety), "Processing" is the
 * DSP chain you edit while setting up.
 */
function ChannelToolsPanel(props: ChannelToolsProps) {
  const [tab, setTab] = useState("channel");
  return (
    <Tabs
      value={tab}
      onValueChange={setTab}
      tabs={[
        { value: "channel", label: "Channel", content: <ChannelTab {...props} /> },
        { value: "processing", label: "Processing", content: <ProcessingTab {...props} /> },
      ]}
    />
  );
}

function ChannelTab({
  strip,
  inputDevices,
  outputDevices,
  editable,
  onCaptureDeviceChange,
  onWebRtcProcessingChange,
  onNoiseCleanupChange,
  onSafetyLimiterCeilingChange,
}: ChannelToolsProps) {
  const health = useLiveChannelHealth(strip);
  return (
    <div className="space-y-3">
      {strip.mode === "local" ? (
        <SourceSection
          strip={strip}
          inputDevices={inputDevices}
          outputDevices={outputDevices}
          editable={editable}
          onCaptureDeviceChange={onCaptureDeviceChange}
        />
      ) : (
        <IncomingTrackSection strip={strip} />
      )}

      <LevelsSection
        strip={strip}
        health={health}
        editable={editable}
        onSafetyLimiterCeilingChange={onSafetyLimiterCeilingChange}
      />

      {strip.mode === "local" && supportsWebRtcProcessing(strip.sourceType) ? (
        <VoiceProcessingSection
          sourceId={strip.id}
          processing={strip.webrtcProcessing}
          noiseSuppression={strip.runtime.noiseSuppression}
          editable={editable}
          onChange={onWebRtcProcessingChange}
        />
      ) : null}

      {strip.mode === "remote" && strip.sourceType === "microphone" ? (
        <NoiseCleanupSection strip={strip} editable={editable} onChange={onNoiseCleanupChange} />
      ) : null}

      {strip.publishedTrack ? <PublishedTrackDetails track={strip.publishedTrack} /> : null}
    </div>
  );
}

function SourceSection({
  strip,
  inputDevices,
  outputDevices,
  editable,
  onCaptureDeviceChange,
}: {
  strip: Extract<ChannelStripView, { mode: "local" }>;
  inputDevices: AudioInputDevice[];
  outputDevices: AudioOutputDevice[];
  editable: boolean;
  onCaptureDeviceChange?: (sourceId: string, captureDeviceId: string | null) => void;
}) {
  const { runtime, captureDeviceId, sourceType } = strip;
  const selectedOutputDevice = outputDeviceForId(captureDeviceId, outputDevices);
  const selectedInputDevice = captureDeviceId
    ? inputDevices.find((device) => device.deviceId === captureDeviceId) ?? null
    : null;

  return (
    <ToolSection
      icon={plainSourceIcon(sourceType)}
      title="Source"
      meta={
        <Badge variant={runtime.status === "running" ? "secondary" : runtime.status === "error" ? "warning" : "outline"}>
          {runtimeStatusLabel(runtime.status)}
        </Badge>
      }
    >
      {sourceType === "microphone" ? (
        <FormField label="Input device">
          <Select
            value={captureDeviceId ?? "__default-input"}
            disabled={!editable}
            onValueChange={(value) => onCaptureDeviceChange?.(strip.id, value === "__default-input" ? null : value)}
          >
            <SelectTrigger aria-label="Input device" className="min-w-0 px-2.5">
              <span className="flex min-w-0 items-center gap-2">
                <Mic className="h-4 w-4 shrink-0 text-muted-foreground" />
                <SelectValue>{selectedInputDevice?.name ?? runtime.deviceName ?? "Default input device"}</SelectValue>
              </span>
            </SelectTrigger>
            <SelectContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)]">
              <SelectGroup>
                <SelectItem value="__default-input">
                  <Mic className="h-4 w-4" />
                  <span className="min-w-0 flex-1 truncate">Default input device</span>
                  {captureDeviceId == null ? <Badge variant="outline">current</Badge> : null}
                </SelectItem>
                {inputDevices.map((device) => (
                  <SelectItem key={device.deviceId} value={device.deviceId}>
                    <Mic className="h-4 w-4" />
                    <span className="min-w-0 flex-1 truncate">{device.name}</span>
                    {device.isDefault ? <Badge variant="outline">default</Badge> : null}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </FormField>
      ) : sourceType === "systemAudio" ? (
        <FormField label="Output device">
          <Select
            value={captureDeviceId ?? ""}
            disabled={!editable}
            onValueChange={(value) => onCaptureDeviceChange?.(strip.id, value)}
          >
            <SelectTrigger aria-label="Output device" className="min-w-0 px-2.5">
              <span className="flex min-w-0 items-center gap-2">
                <OutputDeviceIcon className="h-4 w-4" />
                <SelectValue>{selectedOutputDevice?.name ?? runtime.deviceName ?? "Default output device"}</SelectValue>
              </span>
            </SelectTrigger>
            <SelectContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)]">
              <SelectGroup>
                {outputDevices.length ? (
                  outputDevices.map((device) => (
                    <SelectItem key={device.deviceId} value={device.deviceId}>
                      <OutputDeviceIcon className="h-4 w-4" />
                      <span className="min-w-0 flex-1 truncate">{device.name}</span>
                      {device.isDefault ? <Badge variant="outline">default</Badge> : null}
                    </SelectItem>
                  ))
                ) : (
                  <SelectItem value="__empty-outputs" disabled>No output devices found</SelectItem>
                )}
              </SelectGroup>
            </SelectContent>
          </Select>
        </FormField>
      ) : (
        <InfoRow
          label="Capturing"
          value={
            sourceType === "appAudio"
              ? runtime.deviceName ?? (runtime.deviceId ? `Process ${runtime.deviceId}` : "No app selected")
              : runtime.deviceName ?? runtime.deviceId ?? captureSourceLabel(sourceType)
          }
        />
      )}

      <InfoRow label="Stream" value={formatRuntimeSpec(runtime)} />

      {runtime.error ? (
        <p className="rounded-lg border border-destructive/35 bg-destructive/10 px-3 py-2 text-xs leading-5 text-destructive">
          {runtime.error}
        </p>
      ) : null}
    </ToolSection>
  );
}

function IncomingTrackSection({ strip }: { strip: Extract<ChannelStripView, { mode: "remote" }> }) {
  return (
    <ToolSection
      icon={<Signal />}
      title="Incoming track"
      meta={<Badge variant="outline">{sourceTypeLabel(strip.sourceType)}</Badge>}
    >
      <InfoRow label="From" value={strip.participantTitle} />
      <InfoRow label="Codec" value={strip.publishedTrack.codec ?? "pending"} />
      <InfoRow label="Track" value={shortId(strip.remoteTrackId)} />
      <p className="text-caption leading-4 text-muted-foreground">
        These controls are receiver-local: they change what you hear, not what the sender publishes.
      </p>
    </ToolSection>
  );
}

function LevelsSection({
  strip,
  health,
  editable,
  onSafetyLimiterCeilingChange,
}: {
  strip: ChannelStripView;
  health: ChannelHealthState;
  editable: boolean;
  onSafetyLimiterCeilingChange?: (sourceId: string, ceilingDb: GainDb) => void;
}) {
  const warnings = channelWarnings(health);
  return (
    <ToolSection icon={<Gauge />} title="Levels">
      <HorizontalMeter
        peakDb={health.peakDb}
        rmsDb={health.rmsDb}
        muted={strip.muted}
        clipping={meterClipping(health)}
        safetyCeilingDb={strip.safetyLimiterCeilingDb}
      />

      <div className="grid grid-cols-2 gap-x-5 gap-y-1">
        <MetricRow label="Peak" value={formatDb(health.peakDb)} danger={health.recentClipping || health.nearClipping} />
        <MetricRow label="RMS" value={formatDb(health.rmsDb)} danger={health.tooLoud} />
        <MetricRow label="Latency" value={`${health.latencySamples} smp`} danger={health.latencySamples >= 2400} />
        <MetricRow
          label="DSP load"
          value={health.processorCpuEstimate == null ? "n/a" : `${health.processorCpuEstimate.toFixed(1)}%`}
          danger={health.processorCpuEstimate != null && health.processorCpuEstimate >= 8}
        />
        {health.suppressorCostMs != null ? (
          <MetricRow
            label="Noise suppressor"
            value={`${health.suppressorCostMs.toFixed(1)} ms / 10 ms`}
            danger={health.suppressorCostMs >= 5}
          />
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {strip.muted ? <Badge variant="outline">muted</Badge> : null}
        {warnings.length ? (
          warnings.map((warning) => (
            <Badge key={warning} variant="warning">
              {warning}
            </Badge>
          ))
        ) : (
          <Badge variant="outline">healthy</Badge>
        )}
        {health.safetyLimiterActive ? <Badge variant="secondary">limiting</Badge> : null}
      </div>

      <div className="rounded-xl bg-secondary/50 px-3 py-2.5">
        <SafetyCeilingSlider
          value={strip.safetyLimiterCeilingDb}
          disabled={!editable}
          onCommit={(ceilingDb) => onSafetyLimiterCeilingChange?.(strip.id, ceilingDb)}
        />
        <p className="text-caption leading-4 text-muted-foreground">
          Final limiter, always last in the chain. Catches overshoot the processors let through.
        </p>
      </div>
    </ToolSection>
  );
}

function SafetyCeilingSlider({
  value,
  disabled,
  onCommit,
}: {
  value: GainDb;
  disabled: boolean;
  onCommit?: (value: GainDb) => void;
}) {
  const [draftValue, setDraftValue] = useState<GainDb>(value);
  const draftRef = useRef<GainDb>(value);
  const pendingCommitRef = useRef<GainDb | null>(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    if (pendingCommitRef.current === value) pendingCommitRef.current = null;
    if (!draggingRef.current && pendingCommitRef.current == null) {
      draftRef.current = value;
      setDraftValue(value);
    }
  }, [value]);

  const updateDraft = (next: GainDb) => {
    draftRef.current = next;
    setDraftValue(next);
  };

  const commitDraft = () => {
    const next = draftRef.current;
    draggingRef.current = false;
    if (next === value) {
      pendingCommitRef.current = null;
      return;
    }
    if (pendingCommitRef.current === next) return;
    pendingCommitRef.current = next;
    onCommit?.(next);
  };
  const commitPointerDraft = (event: React.PointerEvent<HTMLInputElement>) => {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
    commitDraft();
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium">Safety ceiling</span>
        <span className="text-xs tabular-nums text-muted-foreground">{formatSafetyCeilingDb(draftValue)}</span>
      </div>
      <input
        className="raven-fader"
        type="range"
        aria-label="Safety limiter ceiling"
        aria-valuetext={formatSafetyCeilingDb(draftValue)}
        min={-6}
        max={-0.5}
        step={0.5}
        value={draftValue}
        disabled={disabled}
        onPointerDown={(event) => {
          draggingRef.current = true;
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onChange={(event) => updateDraft(Number(event.target.value))}
        onPointerUp={commitPointerDraft}
        onPointerCancel={commitPointerDraft}
        onBlur={commitDraft}
      />
    </div>
  );
}

function VoiceProcessingSection({
  sourceId,
  processing,
  noiseSuppression,
  editable,
  onChange,
}: {
  sourceId: string;
  processing: WebRtcAudioProcessingSettings;
  noiseSuppression: NoiseSuppressionRuntime | null | undefined;
  editable: boolean;
  onChange?: (sourceId: string, processing: WebRtcAudioProcessingSettings) => void;
}) {
  const update = (patch: Partial<WebRtcAudioProcessingSettings>) => onChange?.(sourceId, { ...processing, ...patch });
  return (
    <ToolSection icon={<SlidersHorizontal />} title="Voice processing">
      <NoiseSuppressionRow
        className="rounded-xl bg-secondary/50 px-3 py-2"
        value={processing.noiseSuppression}
        runtime={noiseSuppression}
        disabled={!editable}
        onChange={(mode) => update({ noiseSuppression: mode })}
      />
      {processing.noiseSuppression !== "off" ? (
        <NoiseSuppressionDepthRow
          className="rounded-xl bg-secondary/50 px-3 py-2"
          value={processing.noiseSuppressionDepth}
          disabled={!editable}
          onChange={(depth) => update({ noiseSuppressionDepth: depth })}
        />
      ) : null}
      <ToggleRow
        label="Echo cancellation"
        helper="Stops speaker audio feeding back into this mic."
        checked={processing.echoCancellation}
        disabled={!editable}
        onChange={(checked) => update({ echoCancellation: checked })}
      />
      <ToggleRow
        label="Auto gain"
        helper="Levels the mic automatically before the fader."
        checked={processing.autoGainControl}
        disabled={!editable}
        onChange={(checked) => update({ autoGainControl: checked })}
      />
    </ToolSection>
  );
}

function NoiseCleanupSection({
  strip,
  editable,
  onChange,
}: {
  strip: Extract<ChannelStripView, { mode: "remote" }>;
  editable: boolean;
  onChange?: (participantId: string, trackId: string, enabled: boolean) => void;
}) {
  return (
    <ToolSection icon={<SlidersHorizontal />} title="Voice processing">
      <ToggleRow
        label="Clean up noise"
        helper="Only you hear the difference. Adds a slight delay for this person."
        checked={strip.noiseCleanup}
        disabled={!editable}
        onChange={(checked) => onChange?.(strip.remoteParticipantId, strip.remoteTrackId, checked)}
      />
    </ToolSection>
  );
}

function PublishedTrackDetails({ track }: { track: PublishedTrackMetadata }) {
  return (
    <details className="group rounded-lg border border-border bg-secondary/40">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3.5 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
        Published track details
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="grid grid-cols-2 gap-x-5 gap-y-1 border-t border-border px-3.5 py-3">
        <MetricRow label="Track" value={shortId(track.trackId)} />
        <MetricRow label="Participant" value={shortId(track.participantId)} />
        <MetricRow label="Kind" value={track.kind} />
        <MetricRow label="Source" value={sourceTypeLabel(track.sourceType)} />
        <MetricRow label="Codec" value={track.codec ?? "pending"} />
        <MetricRow label="Default gain" value={formatDb(track.defaultGainDb)} />
        <MetricRow label="Controllable" value={track.controllable ? "yes" : "no"} />
        <MetricRow label="Muted" value={track.muted ? "yes" : "no"} />
      </div>
    </details>
  );
}

// --- drawer building blocks ------------------------------------------------

function ToolSection({
  icon,
  title,
  meta,
  children,
}: {
  icon: ReactNode;
  title: string;
  meta?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-lg border border-border bg-secondary/40 p-3.5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex min-w-0 items-center gap-2 text-sm font-semibold">
          <span className="shrink-0 text-primary [&>svg]:h-4 [&>svg]:w-4">{icon}</span>
          <span className="truncate">{title}</span>
        </h3>
        {meta ? <div className="flex shrink-0 items-center gap-2">{meta}</div> : null}
      </div>
      {children}
    </section>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-xs font-medium" title={value}>
        {value}
      </span>
    </div>
  );
}

function MetricRow({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-border/60 pb-1">
      <span className="shrink-0 text-caption text-muted-foreground">{label}</span>
      <span
        className={cn("min-w-0 truncate text-xs font-medium tabular-nums", danger && "text-destructive")}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

const AUTO_LEVEL_LINE: Record<Exclude<RemoteAutoLevelState["status"], "off" | "manual">, { label: string; hint: string }> = {
  listening: { label: "Listening…", hint: "Auto-level waits until it has heard them talk." },
  adjusting: { label: "Leveling…", hint: "Auto-level is moving this fader." },
  leveled: { label: "Auto-level", hint: "Auto-level keeps this fader even with everyone else." },
  atLimit: {
    label: "At the limit",
    hint: "Still quiet at the top of the fader. They could move closer to their mic or turn it up.",
  },
};

/** What Auto-level is doing with an incoming microphone, under its fader. */
function AutoLevelLine({
  status,
  disabled,
  onResume,
}: {
  status: RemoteAutoLevelState["status"];
  disabled?: boolean;
  onResume: () => void;
}) {
  if (status === "off") return null;
  if (status === "manual") {
    return (
      // The strip is too narrow for "Set by you" and a button side by side; the
      // button alone says it, and the tooltip explains.
      <div className="mt-2 flex h-8 items-center justify-center px-1">
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-caption"
          disabled={disabled}
          onClick={onResume}
          title="You set this fader, so Auto-level leaves it alone. Resume hands it back."
          aria-label="You set this fader. Hand it back to Auto-level"
        >
          Resume Auto-level
        </Button>
      </div>
    );
  }
  const { label, hint } = AUTO_LEVEL_LINE[status];
  return (
    <div
      className={cn(
        "mt-2 flex h-8 items-center justify-center truncate px-1 text-caption",
        status === "atLimit" ? "text-muted-foreground" : "text-subtle",
      )}
      title={hint}
    >
      {label}
    </div>
  );
}

function ToggleRow({
  label,
  helper,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  helper?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={cn("flex items-center justify-between gap-3 rounded-xl bg-secondary/50 px-3 py-2", disabled && "opacity-50")}>
      <span className="min-w-0">
        <span className="block text-xs font-medium">{label}</span>
        {helper ? <span className="mt-0.5 block text-caption leading-4 text-muted-foreground">{helper}</span> : null}
      </span>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </label>
  );
}

/**
 * Horizontal level meter for the drawer. Shares the piecewise dBFS scale with
 * the channel strip's vertical meter so the same signal reads at the same
 * position in both places.
 */
function HorizontalMeter({
  peakDb,
  rmsDb,
  muted,
  clipping,
  safetyCeilingDb,
}: {
  peakDb: GainDb;
  rmsDb: GainDb;
  muted: boolean;
  clipping: boolean;
  safetyCeilingDb: GainDb;
}) {
  const peakPercent = muted ? 0 : meterPercent(peakDb);
  const rmsPercent = muted ? 0 : meterPercent(rmsDb);
  const safetyCeilingPercent = meterPercent(safetyCeilingDb);
  return (
    <div className="space-y-1">
      <div
        className="relative h-2.5 overflow-hidden rounded-full bg-background ring-1 ring-inset ring-border"
        title={`Safety ceiling ${formatSafetyCeilingDb(safetyCeilingDb)}`}
      >
        <div
          className="absolute inset-y-0 left-0 bg-cyan-500/85 transition-[width] duration-150 ease-out"
          style={{ width: `${peakPercent}%` }}
        />
        <div
          className="absolute inset-y-0 left-0 bg-emerald-500/85 transition-[width] duration-150 ease-out"
          style={{ width: `${rmsPercent}%` }}
        />
        <div className="absolute inset-y-0 w-px bg-amber-400/70" style={{ left: `${meterPercent(-12)}%` }} />
        <div className="absolute inset-y-0 w-px bg-red-500/80" style={{ left: `${meterPercent(-3)}%` }} />
        <div
          className="absolute inset-y-0 z-10 w-px border-l border-dashed border-amber-200/90"
          style={{ left: `${safetyCeilingPercent}%` }}
          aria-hidden="true"
        />
        {!muted && clipping ? <div className="absolute inset-y-0 right-0 w-1.5 bg-red-500" /> : null}
      </div>
      <div className="flex items-center justify-between text-caption tabular-nums text-subtle">
        <span>−60</span>
        <span className="flex items-center gap-1 text-amber-200/80" title="Safety limiter ceiling">
          <span className="h-2 w-px border-l border-dashed border-amber-200/90" aria-hidden="true" />
          <span>ceiling {formatSafetyCeilingDb(safetyCeilingDb)}</span>
        </span>
        <span>{muted ? "muted" : clipping ? "clipping" : "0 dBFS"}</span>
      </div>
    </div>
  );
}

/**
 * Health snapshots ride the canonical state emits, which only fire when
 * something changes. Meter events arrive ~10x/sec while the source runs, so
 * prefer those once they start flowing and fall back to state otherwise.
 */
function useLiveChannelHealth(strip: ChannelStripView) {
  const [live, setLive] = useState<ChannelHealthState | null>(null);

  useEffect(() => {
    let mounted = true;
    let unsubscribe: (() => void) | null = null;
    setLive(null);
    void subscribeAudioMeterChanged((update) => {
      if (!mounted || !update.health || !meterUpdateMatchesStrip(update, strip)) return;
      setLive(update.health);
    })
      .then((unlisten) => {
        if (!mounted) unlisten();
        else unsubscribe = unlisten;
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
      unsubscribe?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strip.id, strip.mode]);

  return live ?? strip.health;
}

function UserPresetActions({
  preset,
  editable,
  onRename,
  onDelete,
}: {
  preset: AudioPresetDefinition;
  editable: boolean;
  onRename?: (presetId: string, name: string) => void;
  onDelete?: (presetId: string) => void;
}) {
  const [name, setName] = useState(preset.name);

  useEffect(() => setName(preset.name), [preset.name, preset.presetId]);

  return (
    <div className="flex items-center gap-2 rounded-xl bg-secondary/50 px-2.5 py-2">
      <span className="shrink-0 text-caption text-muted-foreground">Your preset</span>
      <Input
        className="h-8 min-w-0 flex-1 text-xs"
        value={name}
        disabled={!editable}
        onChange={(event) => setName(event.target.value)}
        onBlur={() => {
          const nextName = name.trim();
          if (nextName && nextName !== preset.name) onRename?.(preset.presetId, nextName);
          else setName(preset.name);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setName(preset.name);
            event.currentTarget.blur();
          }
        }}
        aria-label="Preset name"
      />
      <Button
        size="icon"
        variant="ghost"
        className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
        disabled={!editable}
        onClick={() => onDelete?.(preset.presetId)}
        aria-label="Delete preset"
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  );
}

function ProcessingTab({
  strip,
  presets,
  editable,
  draftProcessorParams,
  onProcessorAdd,
  onProcessorRemove,
  onProcessorReorder,
  onProcessorToggle,
  onPresetApply,
  onPresetSave,
  onPresetDelete,
  onPresetRename,
  onProcessorChainReset,
  onSafeDefaultsReset,
  onProcessorParameterChange,
  onProcessorParameterCommit,
}: ChannelToolsProps) {
  const sourceId = strip.id;
  const processors = strip.processors;
  const [selectedKind, setSelectedKind] = useState<AudioProcessorKind>("highPassFilter");
  const [selectedPresetId, setSelectedPresetId] = useState(strip.presetId ?? "");
  const [saveOpen, setSaveOpen] = useState(false);
  const applicablePresets = presets.filter((preset) => presetAppliesToChannel(preset, strip.mode, strip.sourceType));
  const selectedPreset = presets.find((preset) => preset.presetId === selectedPresetId) ?? null;

  useEffect(() => setSelectedPresetId(strip.presetId ?? ""), [strip.presetId]);

  const moveProcessor = (index: number, direction: -1 | 1) => {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= processors.length) return;
    const ordered = processors.map((processor) => processor.id);
    const [moved] = ordered.splice(index, 1);
    ordered.splice(nextIndex, 0, moved);
    onProcessorReorder?.(sourceId, ordered);
  };

  return (
    <div className="space-y-3">
      <ToolSection icon={<Sparkles />} title="Preset">
        <div className="flex items-center gap-2">
          <Select value={selectedPresetId} disabled={!editable} onValueChange={setSelectedPresetId}>
            <SelectTrigger aria-label="Preset" className="min-w-0 flex-1">
              <SelectValue placeholder="No preset selected">
                {selectedPreset ? selectedPreset.name : undefined}
              </SelectValue>
            </SelectTrigger>
            <SelectContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)]">
              <SelectGroup>
                <SelectItem value="">No preset selected</SelectItem>
                {applicablePresets.map((preset) => (
                  <SelectItem key={preset.presetId} value={preset.presetId}>
                    <span className="min-w-0 flex-1 truncate">{preset.name}</span>
                    {preset.builtIn ? null : <Badge variant="outline">yours</Badge>}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Button
            className="shrink-0"
            disabled={!editable || !selectedPresetId}
            onClick={() => onPresetApply?.(sourceId, selectedPresetId)}
          >
            Apply
          </Button>
        </div>

        {selectedPreset?.description ? (
          <p className="text-caption leading-4 text-muted-foreground">{selectedPreset.description}</p>
        ) : null}

        {selectedPreset?.userCreated ? (
          <UserPresetActions
            preset={selectedPreset}
            editable={editable}
            onRename={onPresetRename}
            onDelete={onPresetDelete}
          />
        ) : null}

        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <Button
            size="sm"
            variant="outline"
            disabled={!editable}
            onClick={() => onProcessorChainReset?.(sourceId)}
            title="Clear every processor on this channel"
          >
            <RotateCcw className="h-4 w-4" />
            Clear chain
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!editable}
            onClick={() => onSafeDefaultsReset?.(sourceId)}
            title="Restore gain, mute and chain to conservative defaults"
          >
            <ShieldCheck className="h-4 w-4" />
            Safe defaults
          </Button>
          <Button
            size="sm"
            variant={saveOpen ? "secondary" : "ghost"}
            className="ml-auto"
            disabled={!editable}
            onClick={() => setSaveOpen((open) => !open)}
          >
            <Save className="h-4 w-4" />
            Save as…
          </Button>
        </div>

        {saveOpen ? (
          <SavePresetForm
            stripMode={strip.mode}
            sourceType={strip.sourceType}
            editable={editable}
            onCancel={() => setSaveOpen(false)}
            onSave={(name, description, target) => {
              onPresetSave?.(sourceId, name, description, target);
              setSaveOpen(false);
            }}
          />
        ) : null}
      </ToolSection>

      <ToolSection
        icon={<AudioWaveform />}
        title="Processor chain"
        meta={<Badge variant="outline">{processors.length}</Badge>}
      >
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            onProcessorAdd?.(sourceId, selectedKind);
          }}
        >
          <Select
            value={selectedKind}
            disabled={!editable}
            onValueChange={(value) => setSelectedKind(value as AudioProcessorKind)}
          >
            <SelectTrigger aria-label="Processor to add" className="min-w-0 flex-1">
              <SelectValue>{processorKindLabel(selectedKind)}</SelectValue>
            </SelectTrigger>
            <SelectContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)]">
              <SelectGroup>
                {supportedProcessorKinds.map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    {processorKindLabel(kind)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Button className="shrink-0" disabled={!editable} type="submit">
            <Plus className="h-4 w-4" />
            Add
          </Button>
        </form>

        {processors.length ? (
          <div className="space-y-2">
            {processors.map((processor, index) => (
              <ProcessorRow
                key={processor.id}
                sourceId={sourceId}
                processor={processor}
                index={index}
                processorCount={processors.length}
                editable={editable}
                draftProcessorParams={draftProcessorParams}
                onMove={moveProcessor}
                onRemove={onProcessorRemove}
                onToggle={onProcessorToggle}
                onParameterChange={onProcessorParameterChange}
                onParameterCommit={onProcessorParameterCommit}
              />
            ))}
            <p className="pt-0.5 text-caption leading-4 text-muted-foreground">
              Processed top to bottom, before the fader and the safety limiter.
            </p>
          </div>
        ) : (
          <p className="rounded-xl border border-dashed border-border bg-secondary/50 px-3 py-6 text-center text-xs text-muted-foreground">
            No processors yet. Add one above to start shaping this channel.
          </p>
        )}
      </ToolSection>
    </div>
  );
}

function SavePresetForm({
  stripMode,
  sourceType,
  editable,
  onCancel,
  onSave,
}: {
  stripMode: "local" | "remote";
  sourceType: AudioSourceType;
  editable: boolean;
  onCancel: () => void;
  onSave: (name: string, description: string, target: AudioPresetTarget) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [target, setTarget] = useState<AudioPresetTarget>(defaultPresetTarget(stripMode, sourceType));

  return (
    <form
      className="space-y-2.5 rounded-xl bg-secondary/50 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = name.trim();
        if (!trimmed) return;
        onSave(trimmed, description.trim(), target);
      }}
    >
      <p className="text-caption leading-4 text-muted-foreground">
        Saves this channel&apos;s gain, mute and full processor chain as a reusable preset.
      </p>
      <FormField label="Preset name" htmlFor="preset-name">
        <Input
          id="preset-name"
          value={name}
          disabled={!editable}
          placeholder="e.g. Clean voice"
          autoFocus
          onChange={(event) => setName(event.target.value)}
        />
      </FormField>
      <FormField label="Description" htmlFor="preset-description">
        <Input
          id="preset-description"
          value={description}
          disabled={!editable}
          placeholder="Optional"
          onChange={(event) => setDescription(event.target.value)}
        />
      </FormField>
      <FormField label="Available for" htmlFor="preset-target" hint="Which channels this preset shows up on.">
        <Select value={target} disabled={!editable} onValueChange={(value) => setTarget(value as AudioPresetTarget)}>
          <SelectTrigger id="preset-target" className="min-w-0">
            <SelectValue>{presetTargetLabel(target)}</SelectValue>
          </SelectTrigger>
          <SelectContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)]">
            <SelectGroup>
              {presetTargets.map((option) => (
                <SelectItem key={option} value={option}>
                  {presetTargetLabel(option)}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </FormField>
      <div className="flex justify-end gap-2 pt-0.5">
        <Button size="sm" variant="ghost" type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={!editable || !name.trim()} type="submit">
          <Save className="h-4 w-4" />
          Save preset
        </Button>
      </div>
    </form>
  );
}

function ProcessorRow({
  sourceId,
  processor,
  index,
  processorCount,
  editable,
  draftProcessorParams,
  onMove,
  onRemove,
  onToggle,
  onParameterChange,
  onParameterCommit,
}: {
  sourceId: string;
  processor: AudioProcessorState;
  index: number;
  processorCount: number;
  editable: boolean;
  draftProcessorParams: Record<string, AudioParameterValue>;
  onMove: (index: number, direction: -1 | 1) => void;
  onRemove?: (sourceId: string, processorId: string) => void;
  onToggle?: (sourceId: string, processorId: string, enabled: boolean) => void;
  onParameterChange?: (
    sourceId: string,
    processorId: string,
    parameterName: string,
    value: AudioParameterValue,
  ) => void;
  onParameterCommit?: (
    sourceId: string,
    processorId: string,
    parameterName: string,
    value: AudioParameterValue,
  ) => void;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-secondary/50 p-3 transition-opacity",
        !processor.enabled && "opacity-60",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-secondary text-caption font-semibold tabular-nums text-secondary-foreground">
            {index + 1}
          </span>
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium leading-tight">{processor.displayName}</div>
            <div className="truncate text-caption leading-4 text-muted-foreground">
              {processorKindLabel(processor.kind)}
              {processor.latencySamples ? ` · ${processor.latencySamples} smp` : ""}
              {processor.enabled ? "" : " · bypassed"}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center">
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
            disabled={!editable || index === 0}
            onClick={() => onMove(index, -1)}
            aria-label="Move processor up"
          >
            <ArrowUp className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
            disabled={!editable || index === processorCount - 1}
            onClick={() => onMove(index, 1)}
            aria-label="Move processor down"
          >
            <ArrowDown className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className={cn(
              "h-8 w-8",
              processor.enabled ? "text-primary hover:text-primary" : "text-muted-foreground hover:text-foreground",
            )}
            aria-pressed={processor.enabled}
            aria-label={processor.enabled ? "Bypass processor" : "Enable processor"}
            disabled={!editable}
            onClick={() => onToggle?.(sourceId, processor.id, !processor.enabled)}
          >
            <Power className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8 text-muted-foreground hover:text-destructive"
            disabled={!editable}
            onClick={() => onRemove?.(sourceId, processor.id)}
            aria-label="Remove processor"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <ProcessorParameterControls
        sourceId={sourceId}
        processor={processor}
        editable={editable}
        draftProcessorParams={draftProcessorParams}
        onParameterChange={onParameterChange}
        onParameterCommit={onParameterCommit}
      />
    </div>
  );
}

function ProcessorParameterControls({
  sourceId,
  processor,
  editable,
  draftProcessorParams,
  onParameterChange,
  onParameterCommit,
}: {
  sourceId: string;
  processor: AudioProcessorState;
  editable: boolean;
  draftProcessorParams: Record<string, AudioParameterValue>;
  onParameterChange?: (
    sourceId: string,
    processorId: string,
    parameterName: string,
    value: AudioParameterValue,
  ) => void;
  onParameterCommit?: (
    sourceId: string,
    processorId: string,
    parameterName: string,
    value: AudioParameterValue,
  ) => void;
}) {
  const numberValue = (name: string, fallback: number) => {
    const draft = draftProcessorParams[processorParameterKey(sourceId, processor.id, name)];
    return typeof draft === "number" ? draft : Number(processor.parameters[name as keyof typeof processor.parameters] ?? fallback);
  };
  const boolValue = (name: string, fallback: boolean) => {
    const draft = draftProcessorParams[processorParameterKey(sourceId, processor.id, name)];
    return typeof draft === "boolean" ? draft : Boolean(processor.parameters[name as keyof typeof processor.parameters] ?? fallback);
  };

  const slider = (config: {
    name: string;
    label: string;
    min: number;
    max: number;
    step: number;
    fallback: number;
    format?: (value: number) => string;
  }) => (
    <ParameterSlider
      key={config.name}
      sourceId={sourceId}
      processorId={processor.id}
      name={config.name}
      label={config.label}
      value={numberValue(config.name, config.fallback)}
      min={config.min}
      max={config.max}
      step={config.step}
      disabled={!editable}
      format={config.format}
      onChange={onParameterChange}
      onCommit={onParameterCommit}
    />
  );

  let controls: React.ReactNode = null;
  if (processor.kind === "gain") {
    controls = slider({ name: "gainDb", label: "Gain", min: -24, max: 24, step: 1, fallback: 0, format: formatDb });
  } else if (processor.kind === "mute") {
    controls = (
      <button
        className={cn(
          "flex h-10 items-center justify-between rounded-md border px-3 text-sm",
          boolValue("muted", false)
            ? "border-destructive/45 bg-destructive/10 text-destructive"
            : "border-border bg-background",
        )}
        disabled={!editable}
        onClick={() => {
          const next = !boolValue("muted", false);
          onParameterChange?.(sourceId, processor.id, "muted", next);
          onParameterCommit?.(sourceId, processor.id, "muted", next);
        }}
      >
        <span>Muted</span>
        <span className="text-xs">{boolValue("muted", false) ? "On" : "Off"}</span>
      </button>
    );
  } else if (processor.kind === "highPassFilter") {
    controls = slider({
      name: "cutoffHz",
      label: "Cutoff",
      min: 20,
      max: 20_000,
      step: 10,
      fallback: 80,
      format: (value) => `${Math.round(value)} Hz`,
    });
  } else if (processor.kind === "lowPassFilter") {
    controls = slider({
      name: "cutoffHz",
      label: "Cutoff",
      min: 20,
      max: 20_000,
      step: 10,
      fallback: 12_000,
      format: (value) => `${Math.round(value)} Hz`,
    });
  } else if (processor.kind === "limiter") {
    controls = (
      <>
        {slider({ name: "thresholdDb", label: "Ceiling", min: -24, max: 0, step: 1, fallback: -1, format: formatDb })}
        {slider({ name: "releaseMs", label: "Release", min: 0, max: 500, step: 5, fallback: 50, format: (value) => `${Math.round(value)} ms` })}
      </>
    );
  } else if (processor.kind === "noiseGate") {
    controls = (
      <>
        {slider({ name: "thresholdDb", label: "Threshold", min: -90, max: 0, step: 1, fallback: -45, format: formatDb })}
        {slider({ name: "attackMs", label: "Attack", min: 0, max: 250, step: 1, fallback: 5, format: (value) => `${Math.round(value)} ms` })}
        {slider({ name: "releaseMs", label: "Release", min: 0, max: 1000, step: 5, fallback: 80, format: (value) => `${Math.round(value)} ms` })}
      </>
    );
  } else if (processor.kind === "compressor") {
    controls = (
      <>
        {slider({ name: "thresholdDb", label: "Threshold", min: -60, max: 0, step: 1, fallback: -18, format: formatDb })}
        {slider({ name: "ratio", label: "Ratio", min: 1, max: 20, step: 0.5, fallback: 3, format: (value) => `${value.toFixed(1)}:1` })}
        {slider({ name: "attackMs", label: "Attack", min: 0, max: 250, step: 1, fallback: 10, format: (value) => `${Math.round(value)} ms` })}
        {slider({ name: "releaseMs", label: "Release", min: 0, max: 1000, step: 5, fallback: 100, format: (value) => `${Math.round(value)} ms` })}
      </>
    );
  } else if (processor.kind === "meter") {
    controls = <p className="text-caption leading-4 text-muted-foreground">Meter reads signal level and has no editable parameters yet.</p>;
  } else if (processor.kind === "eq") {
    const bands = processor.parameters.eqBands ?? [];
    const bandValue = (index: number, field: "frequencyHz" | "gainDb" | "q", fallback: number) => {
      const name = `band${index}.${field}`;
      const draft = draftProcessorParams[processorParameterKey(sourceId, processor.id, name)];
      return typeof draft === "number" ? draft : Number(bands[index]?.[field] ?? fallback);
    };
    controls = bands.length ? (
      <div className="col-span-2 space-y-3">
        {bands.map((_band, index) => (
          <div key={index} className="grid grid-cols-3 gap-x-3">
            <ParameterSlider
              sourceId={sourceId}
              processorId={processor.id}
              name={`band${index}.frequencyHz`}
              label={`Band ${index + 1}`}
              value={bandValue(index, "frequencyHz", 1000)}
              min={20}
              max={16_000}
              step={10}
              disabled={!editable}
              format={formatHz}
              onChange={onParameterChange}
              onCommit={onParameterCommit}
            />
            <ParameterSlider
              sourceId={sourceId}
              processorId={processor.id}
              name={`band${index}.gainDb`}
              label="Gain"
              value={bandValue(index, "gainDb", 0)}
              min={-18}
              max={18}
              step={0.5}
              disabled={!editable}
              format={formatDb}
              onChange={onParameterChange}
              onCommit={onParameterCommit}
            />
            <ParameterSlider
              sourceId={sourceId}
              processorId={processor.id}
              name={`band${index}.q`}
              label="Width (Q)"
              value={bandValue(index, "q", 0.9)}
              min={0.2}
              max={10}
              step={0.1}
              disabled={!editable}
              format={(value) => value.toFixed(1)}
              onChange={onParameterChange}
              onCommit={onParameterCommit}
            />
          </div>
        ))}
      </div>
    ) : (
      <p className="text-caption leading-4 text-muted-foreground">This EQ has no bands. Remove it and add a new EQ to get editable bands.</p>
    );
  } else {
    controls = <p className="text-caption leading-4 text-muted-foreground">This processor is a placeholder.</p>;
  }

  // Two columns fit the drawer; a lone control (or a placeholder note) stretches
  // across both rather than sitting awkwardly at half width.
  return <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 [&>*:only-child]:col-span-2">{controls}</div>;
}

function formatHz(value: number) {
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)} kHz` : `${Math.round(value)} Hz`;
}

function ParameterSlider({
  sourceId,
  processorId,
  name,
  label,
  value,
  min,
  max,
  step,
  disabled,
  format = (next) => String(next),
  onChange,
  onCommit,
}: {
  sourceId: string;
  processorId: string;
  name: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled: boolean;
  format?: (value: number) => string;
  onChange?: (sourceId: string, processorId: string, parameterName: string, value: AudioParameterValue) => void;
  onCommit?: (sourceId: string, processorId: string, parameterName: string, value: AudioParameterValue) => void;
}) {
  const draftRef = useRef(value);
  const dirtyRef = useRef(false);

  useEffect(() => {
    if (!dirtyRef.current) draftRef.current = value;
  }, [value]);

  const updateDraft = (next: number) => {
    draftRef.current = next;
    dirtyRef.current = true;
    onChange?.(sourceId, processorId, name, next);
  };
  const commit = () => {
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    onCommit?.(sourceId, processorId, name, draftRef.current);
  };
  const commitPointer = (event: React.PointerEvent<HTMLInputElement>) => {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
    commit();
  };

  return (
    <label className="min-w-0">
      <span className="mb-1 flex items-baseline justify-between gap-2">
        <span className="truncate text-caption text-muted-foreground">{label}</span>
        <span className="shrink-0 text-xs font-medium tabular-nums">{format(value)}</span>
      </span>
      <input
        className="raven-fader"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onPointerDown={(event) => event.currentTarget.setPointerCapture?.(event.pointerId)}
        onChange={(event) => updateDraft(Number(event.currentTarget.value))}
        onPointerUp={commitPointer}
        onPointerCancel={commitPointer}
        onBlur={commit}
      />
    </label>
  );
}

function VerticalMeter({
  peakDb,
  rmsDb,
  muted,
  clipping,
}: {
  peakDb: GainDb;
  rmsDb: GainDb;
  muted: boolean;
  clipping: boolean;
}) {
  const peakPercent = muted ? 0 : meterPercent(peakDb);
  const rmsPercent = muted ? 0 : meterPercent(rmsDb);
  const showClipping = !muted && clipping;
  return (
    <div className="flex w-3 shrink-0 flex-col gap-0.5">
      {/* Clip LED — latches red on (near-)clipping */}
      <div
        className={cn("h-1.5 shrink-0 rounded-sm transition-colors", showClipping ? "bg-red-500" : "bg-slate-700/70")}
        title={showClipping ? "Clipping" : undefined}
      />
      <div className="relative min-h-0 flex-1 overflow-hidden rounded bg-slate-800/80">
        {/* peak first (taller), rms drawn over it so the green body + cyan tip both read.
            transition bridges the ~10 Hz state samples into smooth ~60 fps motion. */}
        <div
          className="absolute inset-x-0 bottom-0 bg-cyan-500 transition-[height] duration-150 ease-out"
          style={{ height: `${peakPercent}%` }}
        />
        <div
          className="absolute inset-x-0 bottom-0 bg-emerald-500/80 transition-[height] duration-150 ease-out"
          style={{ height: `${rmsPercent}%` }}
        />
        <div className="absolute inset-x-0 h-px bg-amber-500/70" style={{ top: `${100 - meterPercent(-12)}%` }} />
        <div className="absolute inset-x-0 h-px bg-red-500/70" style={{ top: `${100 - meterPercent(-3)}%` }} />
      </div>
    </div>
  );
}

function LiveChannelMeter({ strip, muted }: { strip: ChannelStripView; muted: boolean }) {
  const [visual, setVisual] = useState(() => ({
    peakDb: strip.meterPeakDb,
    rmsDb: strip.meterRmsDb,
    clipping: meterClipping(strip.health),
    peakHoldDb: Number.NEGATIVE_INFINITY,
  }));

  useEffect(() => {
    let mounted = true;
    let unsubscribe: (() => void) | null = null;
    void subscribeAudioMeterChanged((update) => {
      if (!mounted || !meterUpdateMatchesStrip(update, strip)) return;
      setVisual((current) => ({
        peakDb: update.meter.peakDb,
        rmsDb: update.meter.rmsDb,
        clipping: update.health ? meterClipping(update.health) : update.meter.clipping,
        peakHoldDb: Math.max(current.peakHoldDb, update.meter.peakDb),
      }));
    })
      .then((unlisten) => {
        if (!mounted) unlisten();
        else unsubscribe = unlisten;
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, [strip.id, strip.mode]);

  return (
    <div className="flex w-6 shrink-0 flex-col items-center">
      <div className="flex min-h-0 w-full flex-1 justify-center">
        <VerticalMeter
          peakDb={visual.peakDb}
          rmsDb={visual.rmsDb}
          muted={muted}
          clipping={visual.clipping}
        />
      </div>
      <button
        type="button"
        onClick={() => setVisual((current) => ({ ...current, peakHoldDb: Number.NEGATIVE_INFINITY }))}
        title={`Peak hold ${visual.peakHoldDb === Number.NEGATIVE_INFINITY ? "−∞" : formatDb(visual.peakHoldDb)} — click to reset`}
        className="mt-1 h-4 w-full text-center text-caption font-normal leading-4 tabular-nums text-subtle transition-colors hover:text-foreground"
      >
        {visual.peakHoldDb === Number.NEGATIVE_INFINITY ? "−∞" : formatDbCompact(visual.peakHoldDb)}
      </button>
    </div>
  );
}

function LiveHealthDot({ strip }: { strip: ChannelStripView }) {
  const [warnings, setWarnings] = useState(() => channelWarnings(strip.health));

  useEffect(() => {
    let mounted = true;
    let unsubscribe: (() => void) | null = null;
    void subscribeAudioMeterChanged((update) => {
      if (!mounted || !update.health || !meterUpdateMatchesStrip(update, strip)) return;
      const next = channelWarnings(update.health);
      setWarnings((current) => current.join("|") === next.join("|") ? current : next);
    })
      .then((unlisten) => {
        if (!mounted) unlisten();
        else unsubscribe = unlisten;
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, [strip.id, strip.mode]);

  return <HealthDot warnings={warnings} />;
}

function HealthDot({ warnings }: { warnings: string[] }) {
  const danger = warnings.some((warning) => warning === "clipping" || warning === "near clip");
  const color = danger ? "bg-red-500" : warnings.length ? "bg-amber-400" : "bg-emerald-500/60";
  return (
    <span
      className={cn("h-2 w-2 shrink-0 rounded-full", color, warnings.length > 0 && "animate-pulse")}
      title={warnings.length ? `Warnings: ${warnings.join(", ")}` : "Healthy"}
      aria-label={warnings.length ? `Warnings: ${warnings.join(", ")}` : "Healthy"}
    />
  );
}

function meterUpdateMatchesStrip(update: AudioMeterUpdate, strip: ChannelStripView) {
  if (strip.mode === "local") return update.sourceId === strip.id;
  return update.participantId === strip.remoteParticipantId && update.trackId === strip.remoteTrackId;
}

function meterClipping(health: ChannelHealthState) {
  return health.recentClipping || health.clipping || health.nearClipping;
}

function PublishDot({ live }: { live: boolean }) {
  return (
    <span
      className={cn("h-2 w-2 shrink-0 rounded-full", live ? "animate-pulse bg-primary" : "bg-muted-foreground/40")}
      title={live ? "Live — publishing to call" : "Off-air"}
      aria-label={live ? "Live" : "Off-air"}
    />
  );
}

function sourceAccentClass(sourceType: AudioSourceType) {
  switch (sourceType) {
    case "microphone":
      return "bg-cyan-500/70";
    case "systemAudio":
      return "bg-violet-500/70";
    case "appAudio":
      return "bg-emerald-500/70";
    case "screenAudio":
      return "bg-amber-500/70";
    case "testTone":
      return "bg-pink-500/70";
    default:
      return "bg-slate-500/60";
  }
}

/**
 * Custom vertical gain fader. Uses pointer capture so a drag never cuts out when the
 * cursor leaves the thin track (the failure mode of the native vertical <input range>),
 * and supports keyboard (arrows/Page/Home/End), scroll-wheel fine-tune, and
 * double-click to reset to unity.
 */
function RavenFader({
  value,
  min,
  max,
  step = 1,
  unityDb,
  disabled = false,
  ariaLabel,
  onInput,
  onCommit,
  onReset,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  unityDb?: number;
  disabled?: boolean;
  ariaLabel?: string;
  onInput?: (value: number) => void;
  onCommit?: (value: number) => void;
  onReset?: () => void;
}) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const lastDownRef = useRef(0);
  const [dragging, setDragging] = useState(false);

  const clamp = (next: number) => Math.min(max, Math.max(min, next));
  const quantize = (next: number) => clamp(Number((Math.round((next - min) / step) * step + min).toFixed(4)));
  const scale = dbScaleForRange(min, max);
  const valueFromClientY = (clientY: number) => {
    const el = railRef.current;
    if (!el) return value;
    const rect = el.getBoundingClientRect();
    const ratio = 1 - (clientY - rect.top) / rect.height;
    return quantize(dbFromScalePercent(ratio * 100, scale));
  };

  const handleDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    event.preventDefault();
    // Manual double-press detection: preventDefault() above suppresses the native
    // dblclick event, so reset-to-unity is handled here instead.
    const now = Date.now();
    if (now - lastDownRef.current < 300) {
      lastDownRef.current = 0;
      draggingRef.current = false;
      setDragging(false);
      onReset?.();
      return;
    }
    lastDownRef.current = now;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    draggingRef.current = true;
    setDragging(true);
    onInput?.(valueFromClientY(event.clientY));
  };
  const handleMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    onInput?.(valueFromClientY(event.clientY));
  };
  const handleUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    onCommit?.(valueFromClientY(event.clientY));
  };
  const handleKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    let next = value;
    switch (event.key) {
      case "ArrowUp":
      case "ArrowRight":
        next = quantize(value + step);
        break;
      case "ArrowDown":
      case "ArrowLeft":
        next = quantize(value - step);
        break;
      case "PageUp":
        next = quantize(value + step * 5);
        break;
      case "PageDown":
        next = quantize(value - step * 5);
        break;
      case "Home":
        next = max;
        break;
      case "End":
        next = min;
        break;
      default:
        return;
    }
    event.preventDefault();
    onInput?.(next);
    onCommit?.(next);
  };
  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (disabled) return;
    const next = quantize(value + (event.deltaY < 0 ? step : -step));
    onInput?.(next);
    onCommit?.(next);
  };

  const pct = scalePercent(clamp(value), scale) / 100;
  const unityPct = unityDb != null ? scalePercent(clamp(unityDb), scale) / 100 : null;

  return (
    <div
      role="slider"
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-label={ariaLabel}
      tabIndex={disabled ? -1 : 0}
      className={cn(
        "relative flex w-7 shrink-0 cursor-ns-resize select-none justify-center rounded-md border bg-secondary/50 py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring",
        disabled && "cursor-not-allowed opacity-50",
      )}
      style={{ touchAction: "none" }}
      onPointerDown={handleDown}
      onPointerMove={handleMove}
      onPointerUp={handleUp}
      onPointerCancel={handleUp}
      onKeyDown={handleKey}
      onWheel={handleWheel}
      title="Drag, scroll, or arrow keys · double-click to reset to 0 dB"
    >
      <div ref={railRef} className="relative h-full w-full">
        <div className="absolute inset-y-0 left-1/2 w-1 -translate-x-1/2 rounded-full bg-black/40" />
        <div
          className="absolute bottom-0 left-1/2 w-1 -translate-x-1/2 rounded-full bg-primary/70"
          style={{ height: `${pct * 100}%` }}
        />
        {unityPct != null ? (
          <div className="absolute left-1/2 h-px w-3 -translate-x-1/2 bg-foreground/30" style={{ bottom: `${unityPct * 100}%` }} />
        ) : null}
        <div
          className={cn(
            "absolute left-1/2 h-6 w-5 -translate-x-1/2 translate-y-1/2 rounded-sm border border-primary/50 bg-card shadow-sm transition-colors",
            dragging && "border-primary bg-accent",
          )}
          style={{ bottom: `${pct * 100}%` }}
        >
          <span className="absolute left-1/2 top-1.5 h-px w-3 -translate-x-1/2 bg-foreground/25" />
          <span className="absolute bottom-1.5 left-1/2 h-px w-3 -translate-x-1/2 bg-foreground/20" />
        </div>
      </div>
    </div>
  );
}

function BridgeStatus({ status }: { status: "loading" | "connected" | "error" }) {
  return (
    status === "connected" ? null : (
      <Badge variant={status === "error" ? "warning" : "outline"}>
        {status === "loading" ? "Connecting…" : "Audio engine is not responding"}
      </Badge>
    )
  );
}

function EmptyMixerState({ text }: { text: string }) {
  return (
    <div className="rounded-card bg-secondary/40 px-5 py-5 text-center text-small text-muted-foreground">
      {text}
    </div>
  );
}

function localSourceToStrip(
  source: AudioSourceState,
  appAudioSources: AppAudioSource[],
  outputDevices: AudioOutputDevice[],
  inputDevices: AudioInputDevice[],
): ChannelStripView {
  const app = appAudioSourceForProcess(source.captureDeviceId, appAudioSources);
  const outputDevice = outputDeviceForId(source.captureDeviceId, outputDevices);
  const inputDevice = source.captureDeviceId
    ? inputDevices.find((device) => device.deviceId === source.captureDeviceId) ?? null
    : null;
  return {
    mode: "local",
    id: source.id,
    title: source.displayName,
    sourceType: source.sourceType,
    captureDeviceId: source.captureDeviceId,
    runtime: source.runtime,
    enabled: source.enabled,
    gainDb: source.channelStrip.gainDb,
    muted: source.channelStrip.mute.muted,
    meterPeakDb: source.channelStrip.meter.peakDb,
    meterRmsDb: source.channelStrip.meter.rmsDb,
    health: source.channelStrip.health,
    safetyLimiterCeilingDb: source.channelStrip.safetyLimiterCeilingDb,
    webrtcProcessing: source.channelStrip.webrtcProcessing,
    presetId: source.channelStrip.presetId,
    processors: source.channelStrip.processorChain.processors,
    publishedTrack: source.publishedTrack,
    publishing: source.publishing,
    appIconDataUrl: app?.iconDataUrl ?? source.publishedTrack?.appIconDataUrl ?? null,
    appExeName: app?.exeName ?? source.publishedTrack?.appExeName ?? null,
    outputDeviceName: outputDevice?.name ?? source.runtime.deviceName ?? source.publishedTrack?.deviceName ?? null,
    inputDeviceName: inputDevice?.name ?? null,
  };
}

function remoteTrackToStrip(remoteTrack: RemoteAudioTrackState, participantTitle: string): ChannelStripView {
  return {
    mode: "remote",
    id: remoteTrackKey(remoteTrack.track.participantId, remoteTrack.track.trackId),
    remoteParticipantId: remoteTrack.track.participantId,
    remoteTrackId: remoteTrack.track.trackId,
    participantTitle,
    title: remoteTrack.track.appName ?? remoteTrack.track.displayName,
    sourceType: remoteTrack.track.sourceType,
    enabled: remoteTrack.subscribed,
    noiseCleanup: remoteTrack.receiverChannelStrip.noiseCleanup,
    autoLevel: remoteTrack.receiverChannelStrip.autoLevel ?? { status: "off", speechLoudnessDb: null },
    gainDb: remoteTrack.receiverChannelStrip.gainDb,
    muted: remoteTrack.receiverChannelStrip.mute.muted,
    meterPeakDb: remoteTrack.receiverChannelStrip.meter.peakDb,
    meterRmsDb: remoteTrack.receiverChannelStrip.meter.rmsDb,
    health: remoteTrack.receiverChannelStrip.health,
    safetyLimiterCeilingDb: remoteTrack.receiverChannelStrip.safetyLimiterCeilingDb,
    presetId: remoteTrack.receiverChannelStrip.presetId,
    processors: remoteTrack.receiverChannelStrip.processorChain.processors,
    publishedTrack: remoteTrack.track,
    publishing: true,
    appIconDataUrl: remoteTrack.track.appIconDataUrl,
    appExeName: remoteTrack.track.appExeName,
    outputDeviceName: remoteTrack.track.deviceName,
    inputDeviceName: remoteTrack.track.deviceName,
  };
}

// Device name shown under the channel name: input device for mics, output for system
// audio, executable for app audio. Returns null when it would duplicate the title.
function stripDeviceLabel(strip: ChannelStripView): string | null {
  let label: string | null = null;
  if (strip.sourceType === "microphone") {
    label = strip.inputDeviceName ?? (strip.mode === "local" ? (strip.captureDeviceId ? "Selected input" : "Default input device") : null);
  }
  else if (strip.sourceType === "systemAudio") label = strip.outputDeviceName;
  else if (strip.sourceType === "appAudio") label = strip.appExeName;
  return label && label !== strip.title ? label : null;
}

function appAudioSourceForProcess(captureDeviceId: string | null, appAudioSources: AppAudioSource[]) {
  if (!captureDeviceId) return null;
  const processId = Number(captureDeviceId);
  if (!Number.isFinite(processId)) return null;
  return appAudioSources.find((app) => app.processId === processId) ?? null;
}

function outputDeviceForId(captureDeviceId: string | null, outputDevices: AudioOutputDevice[]) {
  if (!captureDeviceId) return null;
  return outputDevices.find((device) => device.deviceId === captureDeviceId) ?? null;
}

async function browserInputIdForNativeDevice(nativeDeviceName: string): Promise<string | null> {
  let devices = await navigator.mediaDevices.enumerateDevices();
  let inputs = devices.filter((device) => device.kind === "audioinput");
  if (inputs.length && inputs.every((device) => !device.label)) {
    const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
    if (permissionStream) {
      for (const track of permissionStream.getTracks()) track.stop();
      devices = await navigator.mediaDevices.enumerateDevices();
      inputs = devices.filter((device) => device.kind === "audioinput");
    }
  }

  const normalizedName = nativeDeviceName.trim().toLocaleLowerCase();
  return inputs.find((device) => device.label.trim().toLocaleLowerCase() === normalizedName)?.deviceId ?? null;
}

function remoteParticipantGroups(mixerState: AudioMixerState) {
  if (mixerState.remoteParticipants.length) return mixerState.remoteParticipants;
  const groups: AudioMixerState["remoteParticipants"] = [];
  for (const track of mixerState.remoteTracks) {
    const existing = groups.find((group) => group.participantId === track.track.participantId);
    if (existing) existing.tracks.push(track);
    else {
      groups.push({
        participantId: track.track.participantId,
        displayName: null,
        tracks: [track],
      });
    }
  }
  return groups;
}

function remoteTrackKey(participantId: string, trackId: string) {
  return `${participantId}:${trackId}`;
}

function parseRemoteTrackKey(key: string) {
  const [participantId, trackId, extra] = key.split(":");
  if (!participantId || !trackId || extra) return null;
  return { participantId, trackId };
}

function presetAppliesToChannel(
  preset: AudioPresetDefinition,
  mode: "local" | "remote",
  sourceType: AudioSourceType,
) {
  if (preset.target === "anyAudioChannel") return true;
  if (mode === "local") {
    if (preset.target === "localMicrophone") return sourceType === "microphone";
    if (preset.target === "localScreenAudio") return ["screenAudio", "systemAudio", "appAudio"].includes(sourceType);
    // if (preset.target === "localMusic") return sourceType === "fileAudio";
    return false;
  }
  if (preset.target === "remoteVoice") return sourceType === "microphone";
  // if (preset.target === "remoteMusic") return sourceType === "fileAudio";
  return false;
}

function defaultPresetTarget(mode: "local" | "remote", sourceType: AudioSourceType): AudioPresetTarget {
  if (mode === "remote") {
    if (sourceType === "microphone") return "remoteVoice";
    // if (sourceType === "fileAudio") return "remoteMusic";
    return "anyAudioChannel";
  }
  if (sourceType === "microphone") return "localMicrophone";
  if (["screenAudio", "systemAudio", "appAudio"].includes(sourceType)) return "localScreenAudio";
  // if (sourceType === "fileAudio") return "localMusic";
  return "anyAudioChannel";
}

function sourceTypeLabel(sourceType: AudioSourceType) {
  switch (sourceType) {
    case "microphone":
      return "Microphone";
    case "screenAudio":
      return "Screen audio";
    case "systemAudio":
      return "System audio";
    case "appAudio":
      return "App audio";
    // case "fileAudio":
      return "File audio";
    case "testTone":
      return "Test tone";
    default:
      return "Unknown";
  }
}

function supportsWebRtcProcessing(sourceType: AudioSourceType) {
  return sourceType === "microphone";
}

function processorKindLabel(kind: string) {
  return kind.replace(/([A-Z])/g, " $1").replace(/^./, (char) => char.toUpperCase());
}

function defaultSourceName(sourceType: AudioSourceType) {
  switch (sourceType) {
    case "microphone":
      return "Main microphone";
    case "screenAudio":
      return "Screen audio";
    case "systemAudio":
      return "System audio";
    case "appAudio":
      return "Application audio";
    // case "fileAudio":
      return "Music file";
    case "testTone":
      return "Test tone";
    default:
      return "Audio source";
  }
}

// Unstyled twin of `sourceTypeIcon` — the caller (a section header) owns the
// sizing and colour, so these must not carry their own classes.
function plainSourceIcon(sourceType: AudioSourceType) {
  switch (sourceType) {
    case "microphone":
      return <Mic />;
    case "screenAudio":
      return <MonitorUp />;
    case "systemAudio":
      return <Volume2 />;
    case "appAudio":
      return <AudioLines />;
    case "testTone":
      return <AudioWaveform />;
    default:
      return <CircleSlash />;
  }
}

function formatRuntimeSpec(runtime: AudioSourceRuntimeState) {
  const parts: string[] = [];
  if (runtime.sampleRate) {
    const khz = runtime.sampleRate / 1000;
    parts.push(`${Number.isInteger(khz) ? khz : khz.toFixed(1)} kHz`);
  }
  if (runtime.channelCount) {
    parts.push(runtime.channelCount === 1 ? "mono" : runtime.channelCount === 2 ? "stereo" : `${runtime.channelCount} ch`);
  }
  if (runtime.format && runtime.format !== "unknown") parts.push(runtime.format);
  return parts.length ? parts.join(" · ") : "No stream format yet";
}

function sourceTypeIcon(sourceType: AudioSourceType) {
  const className = "h-4 w-4 shrink-0 text-muted-foreground";
  switch (sourceType) {
    case "microphone":
      return <Mic className={className} />;
    case "screenAudio":
      return <MonitorUp className={className} />;
    case "systemAudio":
    case "appAudio":
      return <AudioLines className={className} />;
    // case "fileAudio":
      return <Music className={className} />;
    case "testTone":
      return <AudioWaveform className={className} />;
    default:
      return <CircleSlash className={className} />;
  }
}

function AppAudioIcon({
  app,
  appIconDataUrl,
  appName,
  className,
}: {
  app?: AppAudioSource | null;
  appIconDataUrl?: string | null;
  appName?: string | null;
  className?: string;
}) {
  const src = app?.iconDataUrl ?? appIconDataUrl;
  const label = app?.displayName ?? appName ?? "Application";
  if (src) {
    return (
      <img
        src={src}
        alt=""
        aria-hidden
        className={cn("shrink-0 rounded-sm object-contain", className)}
        title={label}
      />
    );
  }
  return <AudioLines className={cn("shrink-0 text-muted-foreground", className)} aria-hidden />;
}

function OutputDeviceIcon({ className }: { className?: string }) {
  return <Volume2 className={cn("shrink-0 text-muted-foreground", className)} aria-hidden />;
}

function formatDb(value: GainDb) {
  if (value > 0) return `+${Math.round(value)} dB`;
  return `${Math.round(value)} dB`;
}

function formatSafetyCeilingDb(value: GainDb) {
  const normalized = Number(value.toFixed(1));
  return `${normalized > 0 ? "+" : ""}${normalized.toFixed(1)} dB`;
}

// Number-only dB (unit implied) so readouts fit centered under the narrow meter/fader.
function formatDbCompact(value: GainDb) {
  return formatDb(value).replace(" dB", "");
}

function meterPercent(value: GainDb) {
  return scalePercent(value, DBFS_METER_TICKS);
}

function dbScaleForRange(min: number, max: number) {
  const ticks = FADER_GAIN_TICKS.filter((tick) => tick > min && tick < max);
  return [min, ...ticks, max];
}

function scalePercent(value: GainDb, scale: readonly number[]) {
  if (scale.length < 2) return 0;
  const min = scale[0];
  const max = scale[scale.length - 1];
  const clamped = Math.max(min, Math.min(max, value));
  const segmentPercent = 100 / (scale.length - 1);

  for (let index = 0; index < scale.length - 1; index += 1) {
    const start = scale[index];
    const end = scale[index + 1];
    if (clamped >= start && clamped <= end) {
      const local = (clamped - start) / (end - start);
      return (index + local) * segmentPercent;
    }
  }

  return clamped <= min ? 0 : 100;
}

function dbFromScalePercent(percent: number, scale: readonly number[]) {
  if (scale.length < 2) return 0;
  const clamped = Math.max(0, Math.min(100, percent));
  const segmentCount = scale.length - 1;
  const rawIndex = (clamped / 100) * segmentCount;
  const index = Math.min(segmentCount - 1, Math.floor(rawIndex));
  const local = rawIndex - index;
  return scale[index] + (scale[index + 1] - scale[index]) * local;
}

// dB → linear amplitude for the monitor GainNode (0 dB = unity).
function dbToLinear(db: number) {
  return Math.pow(10, db / 20);
}

function captureSourceLabel(sourceType: AudioSourceType) {
  if (sourceType === "testTone") return "Generated test tone";
  if (sourceType === "screenAudio" || sourceType === "systemAudio") return "System loopback";
  // if (sourceType === "fileAudio") return "File source";
  return sourceTypeLabel(sourceType);
}

function runtimeStatusLabel(status: AudioSourceRuntimeState["status"]) {
  switch (status) {
    case "inactive":
      return "inactive";
    case "starting":
      return "starting";
    case "running":
      return "running";
    case "error":
      return "error";
  }
}

function channelWarnings(health: ChannelHealthState) {
  const warnings: string[] = [];
  if (health.recentClipping || health.clipping) warnings.push("clipping");
  if (health.silenceDetected) warnings.push("silence");
  if (health.tooQuiet) warnings.push("too quiet");
  if (health.tooLoud) warnings.push("too loud");
  if (health.nearClipping) warnings.push("near clip");
  if (health.latencySamples >= 2400) warnings.push("latency");
  return warnings;
}

function presetTargetLabel(target: AudioPresetTarget) {
  switch (target) {
    case "localMicrophone":
      return "Local microphone";
    case "localScreenAudio":
      return "Local screen audio";
    case "localMusic":
      return "Local music";
    case "remoteVoice":
      return "Remote voice";
    case "remoteMusic":
      return "Remote music";
    case "anyAudioChannel":
      return "Any audio channel";
  }
}

function processorParameterKey(sourceId: string, processorId: string, parameterName: string) {
  return `${sourceId}:${processorId}:${parameterName}`;
}

function shortId(value: string) {
  return value.length > 8 ? value.slice(0, 8) : value;
}

function formatCommandError(error: unknown) {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "code" in error) {
    return JSON.stringify(error);
  }
  if (error instanceof Error) return error.message;
  return "Audio bridge request failed";
}
